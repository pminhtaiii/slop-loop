/**
 * The approved-plan coder admission for the real tier (`Patch`/`Repair` proposal turns).
 *
 * Once a plan is approved the coder still needs an owner admission to propose the patch that
 * implements it. This resolver binds the current owner head, the approved plan decision and plan
 * binding digest, the coder request and its context digest, and issues the UC-05 provider receipt
 * through the production evaluator. It returns `undefined` for any state or purpose it does not
 * cover, so a Diagnostic or an Investigate turn never reaches it.
 */
import { randomUUID } from 'node:crypto';
import { evaluateProviderAdmissionV02, type PolicyFactsV02 } from '../approvals/policy.ts';
import { computeCanonicalSha256, computeCheckSetDigest, computeRequestContentDigest } from '../contracts/foundation/uc03.ts';
import type { BugTask, ProviderAdmissionContextV02, ProviderAdmissionTrustedContextV02, ProviderRequest, SourceEvidence, TaskState } from '../contracts/foundation/uc03.ts';
import { computeContextDigest } from '../foundation/model.ts';
import { microUsd } from '../foundation/deepseek-transport-request.ts';
import { DEFAULT_POLICY_PROFILE as DEFAULT_PROFILE } from '../persistence/adapters/approval-types.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { CoderPurpose } from '../uc03/graph-generation.ts';
import type { UC03CoderAdmission } from '../uc03/graph-types.ts';
import { currentAuthority, policyFacts } from './real-tier-admissions.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { approvedPlanBindingDigest } from './real-tier-verify-admission.ts';

export interface ApprovedPlanCoderRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly purpose: CoderPurpose;
  readonly evidence: readonly SourceEvidence[];
}

/** The patch/repair proposal a coder turn may make once its plan is approved. */
export function approvedPlanCoderAdmission(
  assembly: RealTierAssembly,
  task: BugTask,
  port: DurableStatePortV02,
  request: ApprovedPlanCoderRequest,
): Promise<UC03CoderAdmission | undefined> | UC03CoderAdmission | undefined {
  const { state } = request;
  if (request.purpose !== 'propose-patch' && request.purpose !== 'propose-repair' && request.purpose !== 'propose-replan') return undefined;
  if (state.node !== 'Patch' && state.node !== 'Repair' && state.node !== 'AwaitFeedback') return undefined;
  // Everything below is async; keep the resolver promise-typed throughout.
  return resolveAdmission(assembly, task, port, request);
}

async function resolveAdmission(assembly: RealTierAssembly, task: BugTask, port: DurableStatePortV02, { state, purpose, evidence }: ApprovedPlanCoderRequest): Promise<UC03CoderAdmission | undefined> {
  const plan = state.plan;
  const decisionRef = plan?.decisionRef;
  const planBindingDigest = decisionRef === undefined ? undefined : approvedPlanBindingDigest(task, state, decisionRef);
  if (!plan || !decisionRef || !planBindingDigest) return undefined;
  const owner = await currentAuthority(port, state);
  if (!owner) return undefined;
  const { limits, pricing, runLimits } = assembly.profile;
  const current = await port.loadTask(state.taskId);
  if (!current?.budgetLedgers) return undefined;
  const remainingCost = Math.min(
    ...current.budgetLedgers.filter(ledger => ledger.kind === 'cost').map(ledger => ledger.limit - ledger.consumed - ledger.reservations.reduce((sum, reservation) => sum + reservation.amount, 0)),
  );
  const maxInputTokens = Math.min(limits.inputTokensPerRequest, runLimits.perRunInputTokens, task.budgetLimits.maxTokens);
  const maxOutputTokens = Math.min(limits.outputTokensPerRequest, runLimits.perRunOutputTokens, task.budgetLimits.maxTokens);
  const maxBillableTokens = maxInputTokens + maxOutputTokens;
  const maxCostUsd = Math.min(remainingCost, task.budgetLimits.maxCostUsd, microUsd(pricing, maxInputTokens, maxOutputTokens, maxInputTokens) / 1_000_000);
  const providerRequestId = `coder-${randomUUID()}`;
  const providerRequest: ProviderRequest = {
    providerRequestId,
    taskId: state.taskId,
    runId: state.runId,
    role: 'coder',
    purpose,
    ...assembly.providerIdentity,
    configId: owner.policyIdentity.configId,
    pricingPolicyId: owner.policyIdentity.policyId,
    contextDigest: computeContextDigest(state, evidence),
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
    ...policyFacts(task, state, owner, purpose),
    registeredActionDigest: computeCanonicalSha256({ taskId: state.taskId, stateVersion: state.stateVersion, purpose }),
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
  };
  const result = evaluateProviderAdmissionV02(policyFor(assembly, task, facts), providerRequest, facts, {
    decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
    role: 'coder',
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
    runnableNode: state.node,
    planApplicability: 'approved-plan' as const,
    planBindingDigest,
    planDecisionRef: decisionRef,
    role: 'coder' as const,
    providerRequestId,
    requestContentDigest: computeRequestContentDigest(providerRequest),
    providerIdentity,
    requestReservationReceipt: providerRequest.reservationRef,
    budgetRefs: ['task-tokens', 'task-cost', 'run-tokens', 'run-cost'].map(kind => `${kind}-${providerRequestId}`),
  };
  const finiteBounds = { maxInputTokens, maxOutputTokens, maxBillableTokens, maxCostUsd };
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
