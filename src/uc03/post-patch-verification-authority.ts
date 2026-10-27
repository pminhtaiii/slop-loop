import {
  computeCanonicalSha256,
  type ApprovalBinding,
  type BugTask,
  type RecordVerificationApprovalRequestV02,
  type TaskState,
  type StatePortV02,
  type VerificationApprovalContextV02,
  type VerificationAuthoritySnapshotV02,
  type VerificationPolicyIdentityV02,
} from '../contracts/foundation/uc03.ts';

export interface PreparedVerificationApprovalV02 {
  readonly binding: ApprovalBinding;
  readonly request: RecordVerificationApprovalRequestV02;
  readonly context: VerificationApprovalContextV02;
}

export function expectedPlanMaterialDigest(task: BugTask, state: TaskState): string | undefined {
  const plan = state.plan;
  if (!plan) return undefined;
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    diagnosis: plan.diagnosis,
    suspectedCauseLocations: plan.suspectedCauseLocations,
    evidenceRefs: plan.evidenceRefs,
    strategy: plan.strategy,
    scopedChanges: plan.scopedChanges,
    checkSetDigest: plan.checkSetDigest,
    baselineRef: plan.baselineRef,
    strategyDigest: plan.strategyDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
  });
}

export function prepareVerificationApproval(
  task: BugTask,
  state: TaskState,
  snapshot: VerificationAuthoritySnapshotV02,
  originalDecisionId: string,
): PreparedVerificationApprovalV02 | undefined {
  const plan = state.plan;
  const materialDigest = expectedPlanMaterialDigest(task, state);
  if (!plan || !materialDigest || snapshot.taskId !== state.taskId || snapshot.runId !== state.runId ||
      snapshot.stateVersion !== state.stateVersion || snapshot.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
      snapshot.controlMode !== 'runnable' || snapshot.holdRef !== null || snapshot.activeClaimId !== null) return undefined;
  const policyIdentity = snapshot.policyIdentity;
  const requestIdentity = computeCanonicalSha256({
    purpose: 'post-patch-verification-approval',
    taskId: state.taskId,
    runId: state.runId,
    originalDecisionId,
    expectedPlanMaterialDigest: materialDigest,
    settledRepositoryRevisionDigest: state.repositoryRevisionDigest,
    policyIdentity,
  });
  const decisionId = `dec-verify-${requestIdentity.slice('sha256:'.length)}`;
  const alreadyCurrent = plan.decisionRef === decisionId && state.activeDecisionId === decisionId;
  if (decisionId === originalDecisionId || ((state.approvalDecisionRefs ?? []).includes(decisionId) && !alreadyCurrent)) return undefined;
  const context = createVerificationApprovalContext(task, state, policyIdentity, snapshot.decisionAuthorityGeneration, decisionId);
  if (!context) return undefined;
  const binding: ApprovalBinding = {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: context.approvalContext.currentNormalizedActionDigest,
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    policyId: policyIdentity.policyId,
    policyVersion: policyIdentity.policyVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: [...plan.evidenceRefs],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    status: 'pending',
  };
  const request: RecordVerificationApprovalRequestV02 = {
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    originalDecisionId,
    decisionId,
    expectedStateVersion: state.stateVersion,
    expectedRepositoryRevisionDigest: state.repositoryRevisionDigest,
    expectedPlanVersion: plan.planVersion,
    expectedPlanMaterialDigest: materialDigest,
    expectedControlVersion: snapshot.controlVersion,
    expectedEpoch: snapshot.epoch,
    expectedDecisionAuthorityGeneration: snapshot.decisionAuthorityGeneration,
    policyIdentity,
    requestIdentity,
  };
  return { binding, request, context };
}

export function createVerificationApprovalContext(
  task: BugTask,
  state: TaskState,
  policyIdentity: VerificationPolicyIdentityV02,
  generation: number,
  decisionId: string,
  purpose: VerificationApprovalContextV02['purpose'] = 'current-verification',
): VerificationApprovalContextV02 | undefined {
  const plan = state.plan;
  if (!plan) return undefined;
  const normalizedActionDigest = computeCanonicalSha256({
    actionId: decisionId,
    kind: 'approve_fix_plan',
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  });
  return {
    purpose,
    expectedIssuerKeyRef: policyIdentity.issuerKeyRef,
    expectedDecisionAuthorityGeneration: generation,
    approvalContext: {
      currentTaskId: state.taskId,
      currentWorkspaceId: state.workspaceId,
      currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
      currentPolicyId: policyIdentity.policyId,
      currentPolicyVersion: policyIdentity.policyVersion,
      currentNormalizedActionDigest: normalizedActionDigest,
      currentPlanVersion: plan.planVersion,
      currentStrategyDigest: plan.strategyDigest,
      currentBaselineRef: plan.baselineRef,
      currentEvidenceRefs: [...plan.evidenceRefs],
      currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      currentCheckSetDigest: plan.checkSetDigest,
    },
  };
}

export function currentApprovalMatches(
  resolution: { readonly outcome: string; readonly decisionId?: string; readonly binding?: ApprovalBinding; readonly issuerKeyRef?: string; readonly decisionAuthorityGeneration?: number; readonly contextDigest?: string },
  decisionId: string,
  context: VerificationApprovalContextV02,
): boolean {
  const binding = resolution.binding;
  const freshness = context.approvalContext;
  return resolution.outcome === 'resolved' && resolution.decisionId === decisionId && !!binding &&
    binding.decisionId === decisionId && binding.status === 'approved' && binding.actionKind === 'fix_plan' &&
    binding.taskId === freshness.currentTaskId && binding.workspaceId === freshness.currentWorkspaceId &&
    binding.repositoryRevisionDigest === freshness.currentRepositoryRevisionDigest &&
    binding.policyId === freshness.currentPolicyId && binding.policyVersion === freshness.currentPolicyVersion &&
    binding.normalizedActionDigest === freshness.currentNormalizedActionDigest &&
    binding.planVersion === freshness.currentPlanVersion && binding.strategyDigest === freshness.currentStrategyDigest &&
    binding.baselineRef === freshness.currentBaselineRef &&
    computeCanonicalSha256(binding.evidenceRefs ?? []) === computeCanonicalSha256(freshness.currentEvidenceRefs) &&
    binding.criteriaDigest === freshness.currentCriteriaDigest && binding.checkSetDigest === freshness.currentCheckSetDigest &&
    resolution.issuerKeyRef === context.expectedIssuerKeyRef &&
    resolution.decisionAuthorityGeneration === context.expectedDecisionAuthorityGeneration &&
    resolution.contextDigest === computeCanonicalSha256(context);
}

export async function currentPlanApprovalIsCurrent(
  task: BugTask,
  expected: TaskState,
  owner: StatePortV02,
  decisionId: string,
): Promise<boolean> {
  if (!owner.loadTask || !owner.readVerificationAuthoritySnapshot || !owner.resolvePlanDecisionInContext) return false;
  let current: TaskState | null;
  let snapshot: VerificationAuthoritySnapshotV02 | null;
  try {
    current = await owner.loadTask(expected.taskId);
    if (!current) return false;
    snapshot = await owner.readVerificationAuthoritySnapshot(expected.taskId);
  } catch { return false; }
  if (!snapshot || !current.plan || current.plan.decisionRef !== decisionId || expected.plan?.decisionRef !== decisionId ||
      current.taskId !== expected.taskId || current.runId !== expected.runId ||
      current.repositoryRevisionDigest !== expected.repositoryRevisionDigest ||
      expectedPlanMaterialDigest(task, current) !== expectedPlanMaterialDigest(task, expected) ||
      snapshot.stateVersion !== current.stateVersion || snapshot.repositoryRevisionDigest !== current.repositoryRevisionDigest ||
      snapshot.controlMode !== 'runnable' || snapshot.holdRef !== null || snapshot.activeClaimId !== null ||
      (current.activeDecisionId !== undefined && current.activeDecisionId !== decisionId)) return false;
  const context = createVerificationApprovalContext(
    task, current, snapshot.policyIdentity, snapshot.decisionAuthorityGeneration, decisionId,
  );
  if (!context) return false;
  let resolution;
  try { resolution = await owner.resolvePlanDecisionInContext(decisionId, context); }
  catch { return false; }
  return currentApprovalMatches(resolution, decisionId, context);
}
