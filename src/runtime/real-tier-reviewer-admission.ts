/**
 * The `final-review` reviewer admission for the real tier.
 *
 * Once Verify has passed, the reviewer still needs an owner admission to read the current diff. This
 * resolver binds the current owner head, the approved plan decision and plan binding digest, the
 * current revision and its diff digest, and issues the UC-05 provider receipt through the production
 * evaluator. It is iteration-bounded by the task's remaining review-iteration room and the profile's
 * `reviewerIterations`, and returns `undefined` for any state, purpose or budget it does not cover.
 *
 * It is the unbound review path only: no review context, evidence bundle or prompt is attached here
 * (UC-06's bound review stays gated at `src/uc03/graph-v02.ts`), so the request is minted over the
 * same empty evidence projection the Review node dispatches.
 */
import { randomUUID } from 'node:crypto';
import { evaluateProviderAdmissionV02, type PolicyFactsV02 } from '../approvals/policy.ts';
import { computeCanonicalSha256, computeCheckSetDigest, computeRequestContentDigest } from '../contracts/foundation/uc03.ts';
import type { BugTask, ProviderAdmissionContextV02, ProviderAdmissionTrustedContextV02, ProviderRequest, SourceEvidence, TaskState } from '../contracts/foundation/uc03.ts';
import { reviewerContextDigest } from '../foundation/reviewer.ts';
import { microUsd } from '../foundation/deepseek-transport-request.ts';
import { DEFAULT_POLICY_PROFILE as DEFAULT_PROFILE } from '../persistence/adapters/approval-types.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { UC03ReviewerAdmission } from '../uc03/graph-types.ts';
import { fitTokenReservation } from './real-tier-admission-budgets.ts';
import { currentAuthority, policyFacts } from './real-tier-admissions.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { approvedPlanBindingDigest } from './real-tier-verify-admission.ts';

export interface ReviewerAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
  readonly evidence: readonly SourceEvidence[];
}

/** The plan-bound reviewer proposal a Review turn may make once its plan is approved and verified. */
export function realTierReviewerAdmission(
  assembly: RealTierAssembly,
  task: BugTask,
  port: DurableStatePortV02,
  request: ReviewerAdmissionRequest,
): Promise<UC03ReviewerAdmission | undefined> | UC03ReviewerAdmission | undefined {
  const { state } = request;
  if (state.taskId !== task.taskId || state.node !== 'Review') return undefined;
  return resolveReviewerAdmission(assembly, task, port, request);
}

async function resolveReviewerAdmission(
  assembly: RealTierAssembly,
  task: BugTask,
  port: DurableStatePortV02,
  { state, diff, evidence }: ReviewerAdmissionRequest,
): Promise<UC03ReviewerAdmission | undefined> {
  const plan = state.plan;
  const decisionRef = plan?.decisionRef;
  const planBindingDigest = decisionRef === undefined ? undefined : approvedPlanBindingDigest(task, state, decisionRef);
  if (!plan || !decisionRef || !planBindingDigest) return undefined;
  const owner = await currentAuthority(port, state);
  if (!owner) return undefined;
  // As in coder admission: an approval issued under an older authority generation cannot admit a review.
  const issued = port.readIssuedDecisionBinding(state.taskId, decisionRef);
  if (!issued || issued.decisionAuthorityGeneration !== owner.decisionAuthorityGeneration) return undefined;
  const current = await port.loadTask(state.taskId);
  if (!current?.budgetLedgers) return undefined;
  // A review may use only the review-iteration room this task has left; none left is a refusal.
  const iterationLedgers = current.budgetLedgers.filter(ledger => ledger.kind === 'iteration' || ledger.kind === 'review_iteration');
  const iterationRoom = Math.min(
    ...(iterationLedgers.length > 0
      ? iterationLedgers.map(ledger => ledger.limit - ledger.consumed - ledger.reservations.reduce((sum, reservation) => sum + reservation.amount, 0))
      : [task.budgetLimits.maxReviewIterations]),
  );
  const maxReviewerIterations = Math.min(assembly.profile.limits.reviewerIterations, task.budgetLimits.maxReviewIterations);
  if (!Number.isSafeInteger(maxReviewerIterations) || maxReviewerIterations <= 0 || !Number.isSafeInteger(iterationRoom) || iterationRoom <= 0) return undefined;
  // The reviewer request is minted over exactly the evidence projection the Review node dispatches.
  const contextDigest = reviewerContextDigest(task, diff.diff, evidence, state.repositoryRevisionDigest, {
    runId: state.runId,
    expectedTaskStateVersion: state.stateVersion,
    clarification: state.clarification,
  });
  if (contextDigest === null) return undefined;
  const { limits, pricing, runLimits } = assembly.profile;
  const costLedgers = current.budgetLedgers.filter(ledger => ledger.kind === 'cost');
  const tokenLedgers = current.budgetLedgers.filter(ledger => ledger.kind === 'tokens');
  const remainingCost = Math.min(
    ...(costLedgers.length > 0
      ? costLedgers.map(ledger => ledger.limit - ledger.consumed - ledger.reservations.reduce((sum, reservation) => sum + reservation.amount, 0))
      : [task.budgetLimits.maxCostUsd]),
    task.budgetLimits.maxCostUsd,
  );
  const remainingTokens = Math.min(
    ...(tokenLedgers.length > 0
      ? tokenLedgers.map(ledger => ledger.limit - ledger.consumed - ledger.reservations.reduce((sum, reservation) => sum + reservation.amount, 0))
      : [task.budgetLimits.maxTokens]),
    task.budgetLimits.maxTokens,
  );
  const maxInputCeiling = Math.min(limits.inputTokensPerRequest, runLimits.perRunInputTokens, task.budgetLimits.maxTokens);
  const maxOutputCeiling = Math.min(limits.outputTokensPerRequest, runLimits.perRunOutputTokens, task.budgetLimits.maxTokens);
  const fittedTokens = fitTokenReservation(remainingTokens, maxInputCeiling, maxOutputCeiling);
  if (!fittedTokens) return undefined;
  const { maxInputTokens, maxOutputTokens, maxBillableTokens } = fittedTokens;
  const maxCostUsd = Math.min(remainingCost, task.budgetLimits.maxCostUsd, microUsd(pricing, maxInputTokens, maxOutputTokens, maxInputTokens) / 1_000_000);
  if (!(maxCostUsd > 0)) return undefined;
  const providerRequestId = `reviewer-${randomUUID()}`;
  const providerRequest: ProviderRequest = {
    providerRequestId,
    taskId: state.taskId,
    runId: state.runId,
    role: 'reviewer',
    purpose: 'final-review',
    ...assembly.providerIdentity,
    configId: owner.policyIdentity.configId,
    pricingPolicyId: owner.policyIdentity.policyId,
    contextDigest,
    timeoutMs: limits.providerTimeoutMs,
    maxInputTokens,
    maxOutputTokens,
    maxBillableTokens,
    maxCostUsd,
    reservationRef: `res-${providerRequestId}`,
    dispatchState: 'reserved',
  };
  const ownerIdentity = owner.policyIdentity;
  const criteriaDigest = computeCanonicalSha256(task.acceptanceCriteria);
  const facts: PolicyFactsV02 = {
    ...policyFacts(task, state, owner, 'final-review'),
    role: 'reviewer',
    registeredActionDigest: computeCanonicalSha256({ taskId: state.taskId, stateVersion: state.stateVersion, purpose: 'final-review' }),
    plan: {
      binding: {
        decisionId: decisionRef,
        actionKind: 'fix_plan',
        normalizedActionDigest: computeCanonicalSha256({
          actionId: decisionRef,
          kind: 'approve_fix_plan',
          planVersion: plan.planVersion,
          strategyDigest: plan.strategyDigest,
          diagnosisEvidenceRefs: plan.evidenceRefs,
          checkSetDigest: plan.checkSetDigest,
        }),
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        policyId: ownerIdentity.policyId,
        policyVersion: ownerIdentity.policyVersion,
        planVersion: plan.planVersion,
        strategyDigest: plan.strategyDigest,
        baselineRef: plan.baselineRef,
        evidenceRefs: [...plan.evidenceRefs],
        criteriaDigest,
        checkSetDigest: plan.checkSetDigest,
        status: 'approved',
      },
      context: {
        currentTaskId: state.taskId,
        currentWorkspaceId: state.workspaceId,
        currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
        currentPolicyId: ownerIdentity.policyId,
        currentPolicyVersion: ownerIdentity.policyVersion,
        currentNormalizedActionDigest: computeCanonicalSha256({
          actionId: decisionRef,
          kind: 'approve_fix_plan',
          planVersion: plan.planVersion,
          strategyDigest: plan.strategyDigest,
          diagnosisEvidenceRefs: plan.evidenceRefs,
          checkSetDigest: plan.checkSetDigest,
        }),
        currentPlanVersion: plan.planVersion,
        currentStrategyDigest: plan.strategyDigest,
        currentBaselineRef: plan.baselineRef,
        currentEvidenceRefs: [...plan.evidenceRefs],
        currentCriteriaDigest: criteriaDigest,
        currentCheckSetDigest: plan.checkSetDigest,
      },
      materialChange: false,
      replanSlot: null,
    },
    planApplicability: 'approved-plan',
    diagnosticPurpose: null,
    taskCriteriaDigest: null,
    planBindingDigest,
    planDecisionRef: decisionRef,
    testPath: null,
    checkId: null,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    providerRequest,
  } as PolicyFactsV02;
  const result = evaluateProviderAdmissionV02(policyFor(assembly, task, facts), providerRequest, facts, {
    decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
    role: 'reviewer',
    planApplicability: 'approved-plan',
    planBindingDigest,
    planDecisionRef: decisionRef,
  });
  if (!result.ok || computeCanonicalSha256((await currentAuthority(port, state)) ?? null) !== computeCanonicalSha256(owner)) return undefined;
  const providerIdentity = {
    ...assembly.providerIdentity,
    configId: ownerIdentity.configId,
    configVersion: ownerIdentity.configVersion,
    pricingPolicyId: ownerIdentity.policyId,
    pricingPolicyVersion: ownerIdentity.policyVersion,
    issuerKeyRef: ownerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
  };
  const common = {
    subjectKind: 'provider-request' as const,
    taskStateSchemaVersion: '0.2.0',
    controlSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    expectedControlVersion: owner.controlVersion,
    expectedEpoch: owner.epoch,
    taskId: state.taskId,
    runId: state.runId,
    runnableNode: 'Review',
    planApplicability: 'approved-plan' as const,
    planBindingDigest,
    planDecisionRef: decisionRef,
    role: 'reviewer' as const,
    providerRequestId,
    requestContentDigest: computeRequestContentDigest(providerRequest),
    providerIdentity,
    requestReservationReceipt: providerRequest.reservationRef,
    // Five refs: token and cost for the task and the run, then the task review-iteration slot.
    budgetRefs: ['task-tokens', 'task-cost', 'run-tokens', 'run-cost', 'task-iteration'].map(kind => `${kind}-${providerRequestId}`),
  };
  const finiteBounds = { maxInputTokens, maxOutputTokens, maxBillableTokens, maxCostUsd, maxReviewerIterations };
  const receipt = result.receipt;
  const providerAdmissionReceipt = {
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
    providerRequestId,
    role: receipt.role,
    requestContentDigest: receipt.requestContentDigest,
    ...assembly.providerIdentity,
    configId: receipt.configId,
    configVersion: receipt.configVersion,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
  };
  const context = { ...common, schemaVersion: '0.2.0', providerRequest, providerAdmissionReceipt, finiteBounds } as unknown as ProviderAdmissionContextV02;
  const trustedContext = {
    ...common,
    providerAdmissionReceiptRef: result.receipt.receiptId,
    providerAdmissionReceiptDigest: result.receipt.receiptDigest,
    requestLimits: { timeoutMs: providerRequest.timeoutMs, ...finiteBounds },
  } as unknown as ProviderAdmissionTrustedContextV02;
  return { request: providerRequest, context, trustedContext };
}

/** The UC-05 profile with the task's configured command rules, as the evaluator's `commandRules` reads them. */
function policyFor(assembly: RealTierAssembly, task: BugTask, facts: PolicyFactsV02): Record<string, unknown> {
  return {
    ...DEFAULT_PROFILE,
    profileVersion: assembly.profile.approvalPolicy.profileVersion,
    policyIdentity: facts.policyIdentity,
    commandRules: task.requiredChecks.map(check => ({
      ruleId: check.checkId,
      executableRef: check.executable,
      argvPrefix: [...check.argv],
      workingDirectoryRef: 'repository-root',
      timeoutMs: check.timeoutMs,
      maxOutputBytes: check.maxOutputBytes,
    })),
  };
}
