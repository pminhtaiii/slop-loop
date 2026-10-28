import {
  computeCanonicalSha256,
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  validateTaskState,
  type Baseline,
  type BugTask,
  type PolicyAuthorityRefV02,
  type RepositoryExecutionReceiptV02,
  type StatePortV02,
  type TaskState,
  type VerificationPolicyIdentityV02,
} from '../contracts/foundation/uc03.ts';
import { validateBaselineEvidenceCandidate } from './investigation-baseline-evidence.ts';
import { baselineEvidenceAcknowledgementMatches } from './investigation-snapshot.ts';
import type { BaselineEvidenceWriteRequest, BaselineEvidenceWriter } from './investigation-types.ts';
import type { UC03RepositoryAdmission } from './graph-types.ts';
import type { UC03GraphState } from './graph-state.ts';
import { createVerificationApprovalContext, currentApprovalMatches, expectedPlanMaterialDigest } from './post-patch-verification-authority.ts';

export interface VerifiedPatchAncestry {
  readonly admission: UC03RepositoryAdmission;
  readonly receipt: RepositoryExecutionReceiptV02;
  readonly originalDecisionId: string;
  readonly originalTaskState: TaskState;
}

export interface RestoredVerificationEvidence {
  readonly baseline: Baseline;
  readonly admission: UC03RepositoryAdmission;
  readonly receipt: RepositoryExecutionReceiptV02;
}

export async function restoreVerificationEvidence(
  task: BugTask,
  current: TaskState,
  owner: StatePortV02,
  baselineOwner: BaselineEvidenceWriter | undefined,
  expectedTestFiles: readonly string[],
): Promise<RestoredVerificationEvidence | undefined> {
  if (!baselineOwner?.loadBaselineEvidence) return undefined;
  const ancestry = await loadVerifiedPatchAncestry(task, current, owner);
  if (!ancestry) return undefined;
  const original = ancestry.originalTaskState;
  const baselineRef = original.plan?.baselineRef;
  if (!baselineRef) return undefined;
  let ownerBaseline;
  try {
    ownerBaseline = await baselineOwner.loadBaselineEvidence(task.taskId, original.workspaceId, task.repositoryId, baselineRef);
  } catch { return undefined; }
  if (!ownerBaseline || ownerBaseline.acknowledgement.evidenceId !== baselineRef ||
      !samePaths(ownerBaseline.content.expectedTestFiles, expectedTestFiles)) return undefined;
  const writeRequest: BaselineEvidenceWriteRequest = {
    content: ownerBaseline.content,
    contentDigest: computeCanonicalSha256(ownerBaseline.content),
  };
  if (ownerBaseline.acknowledgement.contentDigest !== writeRequest.contentDigest ||
      !baselineEvidenceAcknowledgementMatches(ownerBaseline.acknowledgement, writeRequest)) return undefined;
  const validation = validateBaselineEvidenceCandidate(ownerBaseline.content, original);
  if (!validation.ok) return undefined;
  return {
    baseline: { ...validation.baseline, evidenceId: ownerBaseline.acknowledgement.evidenceId },
    admission: ancestry.admission,
    receipt: ancestry.receipt,
  };
}

export async function loadVerifiedPatchAncestry(
  task: BugTask,
  current: TaskState,
  owner: StatePortV02,
): Promise<VerifiedPatchAncestry | undefined> {
  if (!owner.readSettledPatchAncestry || !owner.resolvePlanDecisionInContext || !current.plan?.decisionRef) return undefined;
  let ancestry;
  try {
    ancestry = await owner.readSettledPatchAncestry({
      taskId: current.taskId,
      runId: current.runId,
      resultingRepositoryRevisionDigest: current.repositoryRevisionDigest,
    });
  } catch { return undefined; }
  if (!ancestry) return undefined;
  const original = ancestry.originalTaskState;
  const originalPlan = original.plan;
  const currentPlan = current.plan;
  const originalDecisionId = originalPlan?.decisionRef;
  if (!validateTaskState(original).ok || !originalPlan || !currentPlan || !originalDecisionId ||
      original.activeDecisionId !== originalDecisionId || original.node !== 'Patch' ||
      original.taskId !== current.taskId || original.runId !== current.runId ||
      original.workspaceId !== current.workspaceId || original.repositoryId !== task.repositoryId ||
      original.repositoryRevisionDigest !== task.initialRevisionDigest ||
      originalDecisionId !== ancestry.admissionContext.planDecisionRef ||
      currentPlan.planVersion !== originalPlan.planVersion ||
      expectedPlanMaterialDigest(task, original) !== expectedPlanMaterialDigest(task, current)) return undefined;
  if (current.node !== 'Verify' && current.node !== 'Review' && current.node !== 'Repair' && current.node !== 'Deliver') return undefined;
  if (current.activeDecisionId !== undefined && current.activeDecisionId !== currentPlan.decisionRef) return undefined;
  if (ancestry.outcome.subjectKind !== 'repository-action') return undefined;
  const admissionValidation = validateRepositoryAdmissionV02(ancestry.admissionContext, ancestry.trustedAdmissionContext);
  const receipt: RepositoryExecutionReceiptV02 = {
    claim: ancestry.claim, attempt: ancestry.attempt, outcome: ancestry.outcome, settlement: ancestry.settlement,
  };
  const receiptValidation = validateRepositoryExecutionReceiptV02(receipt, ancestry.admissionContext);
  const expectedPatchDigest = planBindingDigest(task, original);
  if (!admissionValidation.ok || !receiptValidation.ok || ancestry.admissionContext.runnableNode !== 'Patch' ||
      ancestry.admissionContext.planApplicability !== 'approved-plan' || ancestry.admissionContext.action.kind !== 'apply_patch' ||
      ancestry.admissionContext.taskId !== original.taskId || ancestry.admissionContext.runId !== original.runId ||
      ancestry.admissionContext.workspaceId !== original.workspaceId || ancestry.admissionContext.repositoryId !== original.repositoryId ||
      ancestry.admissionContext.expectedTaskStateVersion !== original.stateVersion ||
      ancestry.admissionContext.canonicalRevision !== original.repositoryRevisionDigest ||
      ancestry.admissionContext.planBindingDigest !== expectedPatchDigest ||
      ancestry.admissionContext.policyAuthorityRef.decisionAuthorityGeneration !== ancestry.originalAuthorityRef.decisionAuthorityGeneration ||
      computeCanonicalSha256(ancestry.admissionContext.policyAuthorityRef) !== computeCanonicalSha256(ancestry.originalAuthorityRef) ||
      ancestry.claim.taskId !== original.taskId || ancestry.claim.runId !== original.runId ||
      ancestry.claim.preClaimTaskStateVersion !== original.stateVersion || ancestry.claim.status !== 'claimed' ||
      ancestry.attempt.claimId !== ancestry.claim.claimId || ancestry.attempt.taskId !== original.taskId ||
      ancestry.attempt.postBeginTaskStateVersion !== original.stateVersion + 1 ||
      ancestry.outcome.claimId !== ancestry.claim.claimId || ancestry.outcome.attemptId !== ancestry.attempt.attemptId ||
      ancestry.outcome.outcome !== 'observed' || ancestry.outcome.repositoryOperation !== 'apply-patch' ||
      ancestry.outcome.observedResultRevisionDigest !== current.repositoryRevisionDigest ||
      ancestry.settlement.outcome !== 'settled' || ancestry.settlement.receiptId !== ancestry.outcome.receiptId) return undefined;

  const authority = ancestry.originalAuthorityRef;
  const context = createVerificationApprovalContext(task, original, toPolicyIdentity(authority), authority.decisionAuthorityGeneration, originalDecisionId, 'historical-patch');
  if (!context) return undefined;
  const resolution = await owner.resolvePlanDecisionInContext(originalDecisionId, context);
  if (!currentApprovalMatches(resolution, originalDecisionId, context)) return undefined;
  return {
    admission: { context: ancestry.admissionContext, trustedContext: ancestry.trustedAdmissionContext },
    receipt,
    originalDecisionId,
    originalTaskState: original,
  };
}

function planBindingDigest(task: BugTask, state: TaskState): string {
  const plan = state.plan;
  if (!plan?.decisionRef) return '';
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

function toPolicyIdentity(authority: PolicyAuthorityRefV02): VerificationPolicyIdentityV02 {
  return {
    policyId: authority.policyId,
    policyVersion: authority.policyVersion,
    configId: authority.configId,
    configVersion: authority.configVersion,
    issuerKeyRef: authority.issuerKeyRef,
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return computeCanonicalSha256([...left].sort()) === computeCanonicalSha256([...right].sort());
}

/** Legacy graph checkpoint predicate retained for the unchanged Repair consumer. */
export function validSettledPatchEvidence(state: UC03GraphState, task: BugTask, persisted: TaskState): boolean {
  const source = state.patchAdmission;
  const receipt = state.patchReceipt;
  if (!source || !receipt || !persisted.plan?.decisionRef || !persisted.plan.baselineRef ||
      state.state?.plan?.baselineRef !== persisted.plan.baselineRef ||
      (state.baseline !== undefined && (state.baseline.repositorySnapshotDigest !== task.initialRevisionDigest || state.baseline.evidenceId !== persisted.plan.baselineRef)) ||
      (persisted.activeDecisionId !== undefined && persisted.activeDecisionId !== persisted.plan.decisionRef)) return false;
  const admission = validateRepositoryAdmissionV02(source.context, source.trustedContext);
  const execution = validateRepositoryExecutionReceiptV02(receipt, source.context);
  if (!admission.ok || !execution.ok || admission.value.action.kind !== 'apply_patch') return false;
  return admission.value.taskId === persisted.taskId && admission.value.runId === persisted.runId &&
    admission.value.workspaceId === persisted.workspaceId && admission.value.repositoryId === persisted.repositoryId &&
    (admission.value.runnableNode === 'Patch' || admission.value.runnableNode === 'Repair') &&
    admission.value.expectedTaskStateVersion + 2 <= persisted.stateVersion &&
    admission.value.planDecisionRef === persisted.plan.decisionRef &&
    admission.value.planBindingDigest === legacyPlanBindingDigest(task, persisted) &&
    execution.value.attempt.postBeginTaskStateVersion === admission.value.expectedTaskStateVersion + 1 &&
    execution.value.outcome.repositoryOperation === 'apply-patch' &&
    execution.value.outcome.observedResultRevisionDigest === persisted.repositoryRevisionDigest;
}

export function currentPlanBindingDigest(task: BugTask, state: TaskState): string {
  return legacyPlanBindingDigest(task, state);
}

function legacyPlanBindingDigest(task: BugTask, state: TaskState): string {
  const plan = state.plan;
  if (!plan?.decisionRef) return '';
  return computeCanonicalSha256({
    taskId: state.taskId, planVersion: plan.planVersion, strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef ?? '', evidenceRefs: plan.evidenceRefs ?? [],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria), checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}
