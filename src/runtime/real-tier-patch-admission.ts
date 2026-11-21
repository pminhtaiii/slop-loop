/**
 * The approved-plan patch admission for the real tier (Patch and Repair).
 *
 * It binds the current owner head, the approved plan decision and plan binding digest, the current
 * revision, the exact admitted patch and its target paths, and issues a UC-05 receipt through the
 * production evaluator. It refuses a patch whose target paths leave the approved plan's
 * `scopedChanges`, and refuses a stale plan decision. The receipt is what the execution guard and
 * the patch receiver act on; this module performs no effect.
 */
import { evaluatePolicyV02, type PolicyFactsV02 } from '../approvals/policy.ts';
import { computeActionDigest, computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { BugTask, TaskState } from '../contracts/foundation/uc03.ts';
import { DEFAULT_POLICY_PROFILE } from '../persistence/adapters/approval-types.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { UC03RepositoryAdmission } from '../uc03/graph-types.ts';
import { currentAuthority, policyFacts } from './real-tier-admissions.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { executionProfileOf } from './real-tier-execution-profile.ts';
import { countPatchEdits } from './real-tier-patch-receiver.ts';
import { approvedPlanBindingDigest } from './real-tier-verify-admission.ts';

export interface PatchAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly patchContent: string;
  readonly targetPaths: readonly string[];
  readonly actionId?: string | undefined;
}

/** The production UC-05 profile the batch is admitted under: the task's pinned policy identity and its checks. */
export function realTierPolicyProfile(assembly: RealTierAssembly, task: BugTask): Record<string, unknown> {
  return {
    ...DEFAULT_POLICY_PROFILE,
    profileVersion: assembly.profile.approvalPolicy.profileVersion,
    policyIdentity: { policyId: task.configId, policyVersion: task.configVersion, configId: task.configId, configVersion: task.configVersion },
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

export async function patchAdmission(assembly: RealTierAssembly, task: BugTask, port: DurableStatePortV02, request: PatchAdmissionRequest): Promise<UC03RepositoryAdmission | undefined> {
  const { state, patchContent, targetPaths } = request;
  if (state.taskId !== task.taskId || (state.node !== 'Patch' && state.node !== 'Repair')) return undefined;
  const plan = state.plan;
  const decisionRef = plan?.decisionRef;
  const planBindingDigest = decisionRef === undefined ? undefined : approvedPlanBindingDigest(task, state, decisionRef);
  if (!plan || !decisionRef || !planBindingDigest) return undefined;
  // The plan decision must still be the owner's recorded human approval, not merely a plan field: a
  // superseded authority generation leaves the recorded approval stale, and this refuses it.
  const owner = await currentAuthority(port, state);
  if (!owner) return undefined;
  const recordedContext = {
    purpose: 'historical-patch' as const,
    expectedIssuerKeyRef: owner.policyIdentity.issuerKeyRef,
    expectedDecisionAuthorityGeneration: owner.decisionAuthorityGeneration,
    approvalContext: {
      currentTaskId: state.taskId,
      currentWorkspaceId: state.workspaceId,
      currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
      currentPolicyId: owner.policyIdentity.policyId,
      currentPolicyVersion: owner.policyIdentity.policyVersion,
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
      currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      currentCheckSetDigest: plan.checkSetDigest,
    },
  };
  const recorded = await port.planDecisionIsApproved(decisionRef, recordedContext);
  if (!recorded) return undefined;
  // A patch may write only the paths its approved plan scoped, and only a fresh, ordered path set.
  const scoped = new Set(plan.scopedChanges);
  const targets = [...targetPaths];
  if (targets.length === 0 || new Set(targets).size !== targets.length || targets.some(path => !scoped.has(path))) return undefined;
  const edits = countPatchEdits(patchContent);
  if (edits === null) return undefined;
  const ownerIdentity = owner.policyIdentity;
  const actionId = request.actionId ?? `patch-${computeCanonicalSha256([state.taskId, state.stateVersion, planBindingDigest]).slice('sha256:'.length, 'sha256:'.length + 24)}`;
  const action = { actionId, kind: 'apply_patch' as const, patchContent, targetPaths: targets, baseRevisionDigest: state.repositoryRevisionDigest };
  const criteriaDigest = computeCanonicalSha256(task.acceptanceCriteria);
  const binding = {
    decisionId: decisionRef,
    actionKind: 'fix_plan' as const,
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
    status: 'approved' as const,
  };
  const facts: PolicyFactsV02 = {
    ...policyFacts(task, state, owner, 'approved-plan-patch'),
    registeredActionDigest: computeActionDigest(action),
    patch: {
      fileCount: targets.length,
      addedDeletedLines: edits,
      dependencyChange: false,
      deletion: false,
      structuralChange: false,
      sensitiveConfiguration: false,
      productionCode: true,
    },
    command: null,
    plan: {
      binding,
      context: {
        currentTaskId: state.taskId,
        currentWorkspaceId: state.workspaceId,
        currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
        currentPolicyId: ownerIdentity.policyId,
        currentPolicyVersion: ownerIdentity.policyVersion,
        currentNormalizedActionDigest: binding.normalizedActionDigest,
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
  };
  const result = evaluatePolicyV02(realTierPolicyProfile(assembly, task), action, facts, {
    decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
    planApplicability: 'approved-plan',
    planBindingDigest,
    planDecisionRef: decisionRef,
  });
  if (!result.ok || result.receipt.result !== 'ALLOWED' || computeCanonicalSha256((await currentAuthority(port, state)) ?? null) !== computeCanonicalSha256(owner)) return undefined;
  const { receipt } = result;
  const evaluationBody = {
    receiptId: receipt.receiptId,
    actionDigest: receipt.actionDigest,
    freshnessContextDigest: receipt.freshnessContextDigest,
    policyId: receipt.policyId,
    policyVersion: receipt.policyVersion,
    configId: receipt.configId,
    configVersion: receipt.configVersion,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    result: receipt.result,
  };
  const context = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    controlSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    expectedControlVersion: owner.controlVersion,
    expectedEpoch: owner.epoch,
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    runnableNode: state.node,
    canonicalRevision: state.repositoryRevisionDigest,
    executionProfileId: assembly.profile.image.label,
    action,
    actionDigest: computeActionDigest(action),
    policyAuthorityRef: { ...ownerIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration },
    policyEvaluationReceipt: { ...evaluationBody, receiptDigest: computeCanonicalSha256(evaluationBody) },
    planBindingDigest,
    planDecisionRef: decisionRef,
    baseRevision: state.repositoryRevisionDigest,
    targetPaths: targets,
    patchDigest: computeCanonicalSha256(patchContent),
    finiteBounds: {
      maxPatchBytes: executionProfileOf(task, assembly.profile.image.label, state).patchBounds.maxPatchBytes,
      maxChangedPaths: executionProfileOf(task, assembly.profile.image.label, state).patchBounds.maxChangedPaths,
    },
    reservationRefs: [`repair-slot:${state.taskId}:${state.stateVersion}`],
  };
  const trustedContext = {
    subjectKind: 'repository-action' as const,
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: context.expectedTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: context.expectedControlVersion,
    expectedEpoch: context.expectedEpoch,
    taskId: context.taskId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId,
    runnableNode: context.runnableNode,
    canonicalRevision: context.canonicalRevision,
    executionProfileId: context.executionProfileId,
    planApplicability: context.planApplicability,
    planBindingDigest: context.planBindingDigest,
    planDecisionRef: context.planDecisionRef,
    policyAuthorityRef: context.policyAuthorityRef,
    policyEvaluationReceiptRef: context.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: context.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: context.policyEvaluationReceipt.freshnessContextDigest,
    executionProfile: executionProfileOf(task, assembly.profile.image.label, state),
    allowedDiagnosticChecks: [],
    allowedDiagnosticTestPaths: [],
  };
  return { context, trustedContext } as unknown as UC03RepositoryAdmission;
}
