/** UC-03 repair; T018 replan and shared types factored into sibling modules. */

import {
  computeCanonicalSha256, computeCheckSetDigest, validateApprovalBinding,
  validateStateTransition, validateTaskState, validateNormalizedAction, validateVerificationResult, validateReviewResult,
  validateRepositoryExecutionReceiptV02,
  type TaskState, type StatePort, type StatePortV02,
  type ApplyPatchAction, type ApproveFixPlanAction, type ApprovalBindingContext,
  type ExecutionGuard, type ExecutionGuardV02,
} from '../contracts/foundation/uc03.ts';
import type {
  RejectionInput, RejectionPorts, ReplanResult, RepairInput, RepairPorts, RepairResult,
} from './repair-types.ts';
import {
  getRejectionApprovalContext, validateRejectionInput, isProtectedPathOrTest,
  isVerificationResult, isReviewResult, failureRefs, refsMatch, isSha256,
  isPatchResult, checkAccounting, resolveRepairAdmissionContext, isStatePortV02,
  createRepairActionId,
} from './repair-types.ts';

export * from './repair-types.ts';
export * from './replan.ts';

function incomplete(state: TaskState | null, reason: string, actionId?: string, digest?: string): RepairResult {
  return { outcome: 'INCOMPLETE', state, reasons: [reason], ...(actionId ? { reservedActionId: actionId } : {}), ...(digest ? { appliedPatchDigest: digest } : {}) };
}

export async function executeRepair(input: RepairInput, ports: RepairPorts): Promise<RepairResult> {
  let state: TaskState | null;
  try { state = await ports.statePort.loadTask(input.taskId); }
  catch { return incomplete(null, 'authoritative-task-state-unavailable'); }
  if (!state) return incomplete(null, 'task-not-found');
  const stop = (reason: string, actionId?: string) => incomplete(state, reason, actionId);
  if (!validateTaskState(state).ok) return stop('invalid-authoritative-task-state');
  if (!isSha256(state.repositoryRevisionDigest)) return stop('invalid-current-repository-revision');

  const items = Array.isArray(input.failureEvidence) ? input.failureEvidence : [input.failureEvidence];
  if (!items.length) return stop('missing-failure-evidence');
  for (const item of items) {
    if (isVerificationResult(item)) {
      if (!validateVerificationResult(item).ok) return stop('invalid-verification-failure-evidence');
      if (item.outcome !== 'fail') return stop('not-failure-evidence');
      if (item.taskId !== state.taskId || item.runId !== state.runId || item.repoDigest !== state.repositoryRevisionDigest) {
        return stop('stale-or-unbound-verification-failure');
      }
      if (!item.diffDigest || !item.diagnosticRefs.length) return stop('verification-diagnostics-or-diff-missing');
    } else if (isReviewResult(item)) {
      if (!validateReviewResult(item).ok) return stop('invalid-review-failure-evidence');
      if (item.status === 'accepted') return stop('not-failure-evidence');
      if (item.status !== 'findings') return stop('review-failure-evidence-not-actionable');
      if (item.repoDigest !== state.repositoryRevisionDigest) return stop('stale-review-failure-evidence');
    } else return stop('unknown-failure-evidence-type');
  }

  const accounting = checkAccounting(state);
  if (!accounting.ok) return stop(accounting.reason);
  const plan = state.plan;
  const task = state.taskContext;
  const approval = ports.trustedTransitionContext?.approval;
  if (!plan?.decisionRef || !task?.requiredChecks.length || !approval || !ports.approvalPort) {
    return stop('current-approved-plan-unavailable');
  }
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  if (plan.checkSetDigest !== checkSetDigest) return stop('approved-plan-check-set-mismatch');
  const planAction: ApproveFixPlanAction = {
    actionId: plan.decisionRef, kind: 'approve_fix_plan', planVersion: state.planVersion,
    strategyDigest: plan.strategyDigest, diagnosisEvidenceRefs: plan.evidenceRefs, checkSetDigest,
  };
  const currentApproval: ApprovalBindingContext = {
    currentTaskId: state.taskId, currentWorkspaceId: state.workspaceId,
    // Plan approval authorizes the bounded strategy against its original baseline.
    // The exact Repair admission below separately binds this attempt to today's revision.
    currentRepositoryRevisionDigest: task.initialRevisionDigest,
    currentPolicyId: task.configId, currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(planAction), currentPlanVersion: state.planVersion,
    currentStrategyDigest: plan.strategyDigest, currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: plan.evidenceRefs, currentCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    currentCheckSetDigest: checkSetDigest,
  };
  const hostBinding = validateApprovalBinding(approval.binding, approval.freshness);
  const binding = validateApprovalBinding(approval.binding, currentApproval);
  if (!hostBinding.ok || !binding.ok || binding.value.status !== 'approved' || binding.value.actionKind !== 'fix_plan' ||
      binding.value.decisionId !== state.activeDecisionId || binding.value.decisionId !== plan.decisionRef) {
    return stop('current-plan-approval-missing-or-stale');
  }
  try {
    if (!await ports.approvalPort.validateBinding(binding.value)) return stop('current-plan-approval-not-authoritative');
  } catch { return stop('current-plan-approval-not-authoritative'); }

  const refs = failureRefs(items);
  const ctx = ports.trustedRepairContext;
  const digests = items.map((item) => item.diffDigest);
  if (state.node !== 'Repair' || !ctx || new Set(refs.evidence).size !== refs.evidence.length ||
      new Set(refs.actions).size !== refs.actions.length || ctx.taskId !== state.taskId || ctx.runId !== state.runId ||
      ctx.workspaceId !== state.workspaceId || ctx.repositoryId !== state.repositoryId ||
      ctx.repositoryRevisionDigest !== state.repositoryRevisionDigest || ctx.baselineRef !== plan.baselineRef ||
      ctx.checkSetDigest !== checkSetDigest || !ctx.diffDigest.trim() || digests.some((digest) => digest !== ctx.diffDigest) ||
      !refsMatch(ctx.evidenceRefs, refs.evidence) || !refsMatch(ctx.actionRefs, refs.actions) ||
      !refsMatch(ctx.diagnosticRefs, refs.diagnostics) ||
      refs.evidence.some((ref) => !state.evidenceRefs.includes(ref) || state.evidenceRefs.includes(`repair-consumed:${ref}`)) ||
      [...refs.actions, ...refs.diagnostics].some((ref) => !state.evidenceRefs.includes(ref)) ||
      (input.repairPatch && (!refsMatch(input.repairPatch.evidenceRefs, refs.evidence) || !refsMatch(input.repairPatch.diagnosticRefs, refs.diagnostics)))) {
    return stop('current-repair-evidence-binding-unavailable-or-stale');
  }
  for (const item of items) {
    if (isVerificationResult(item)) {
      const matches = item.testedIds.map((id) => task.requiredChecks.find((check) => check.checkId === id));
      const phaseMatches = matches.every((check) => check && (check.purpose === 'reproduction' ? 'focused' : check.purpose) === item.phase);
      if (new Set(item.testedIds).size !== item.testedIds.length || matches.some((check) => !check) || !phaseMatches) {
        return stop('verification-failure-check-set-mismatch');
      }
    } else if (item.checkSetDigest !== checkSetDigest || item.reviewId !== state.latestReviewRef || !state.reviewRefs?.includes(item.reviewId)) {
      return stop('review-failure-binding-mismatch');
    }
  }
  const proposal = input.repairPatch;
  if (!proposal || !proposal.diff.trim() || !proposal.affectedPaths.length || new Set(proposal.affectedPaths).size !== proposal.affectedPaths.length) {
    return stop('repair-proposal-missing-or-invalid');
  }
  if (proposal.affectedPaths.some(isProtectedPathOrTest)) return { outcome: 'DENIED', state, reasons: ['forbidden-protected-path-edit'] };

  const actionId = createRepairActionId(state, items);
  if (!actionId) return stop('repair-action-identity-unavailable');
  if (input.actionId !== undefined && input.actionId !== actionId) return stop('repair-action-identity-mismatch');
  if (accounting.repair.reservations.some((entry) => entry.keyedId === actionId) || state.evidenceRefs.includes(`repair-action:${actionId}`)) {
    return stop('repair-evidence-already-reserved');
  }
  if (!ports.executionGuard) return stop('execution-guard-unavailable');
  const action: ApplyPatchAction = {
    actionId, kind: 'apply_patch', patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths], baseRevisionDigest: state.repositoryRevisionDigest,
  };
  const admittedAction = validateNormalizedAction(action);
  if (!admittedAction.ok) return stop('invalid-repair-action');
  try {
    const permission = await ports.approvalPort.classify(admittedAction.value);
    if (permission === 'FORBIDDEN') return { outcome: 'DENIED', state, reasons: ['patch-action-forbidden'] };
    if (permission !== 'ALLOWED') return stop('patch-action-approval-required');
  } catch { return stop('patch-policy-unavailable'); }

  // Check if v0.2 atomic admission is active
  const admissionContext = resolveRepairAdmissionContext(ports, ctx);
  if (isStatePortV02(ports.statePort) && !admissionContext) return stop('repair-admission-context-required');
  if (admissionContext && !isStatePortV02(ports.statePort)) return stop('repair-admission-version-mismatch');
  if (admissionContext && isStatePortV02(ports.statePort)) {
    let effect: Awaited<ReturnType<ExecutionGuard['validateAndExecute']>>;
    try {
      effect = await (ports.executionGuard as ExecutionGuardV02).validateAndExecute(admittedAction.value, state, admissionContext);
    } catch {
      return incomplete(state, 'repair-effect-uncertain', actionId);
    }

    if (effect.outcome !== 'success') {
      const latest = await safeReload(ports.statePort, input.taskId, state);
      const reason = (effect as { reason?: string }).reason;
      return effect.outcome === 'denied'
        ? { outcome: 'DENIED', state: latest, reasons: [reason ?? 'patch-action-denied'], reservedActionId: actionId }
        : incomplete(latest, reason ?? 'repair-effect-not-confirmed', actionId);
    }

    let latest: TaskState | null;
    try {
      latest = await ports.statePort.loadTask(input.taskId);
    } catch {
      return incomplete(state, 'authoritative-task-state-unavailable', actionId);
    }

    if (!latest || latest.node !== 'Verify' || !validateTaskState(latest).ok) {
      return incomplete(latest ?? state, 'repair-verification-transition-result-inconsistent', actionId);
    }

    const patch = isPatchResult(effect.result) ? effect.result : undefined;
    const settled = patch?.executionReceipt === undefined || !admissionContext
      ? undefined
      : validateRepositoryExecutionReceiptV02(patch.executionReceipt, admissionContext);
    if (!patch || !settled?.ok || settled.value.outcome.repositoryOperation !== 'apply-patch' ||
        settled.value.outcome.observedResultRevisionDigest !== patch.newRevisionDigest ||
        latest.repositoryRevisionDigest !== patch.newRevisionDigest) {
      return incomplete(latest, 'repair-owner-settlement-receipt-unavailable-or-stale', actionId);
    }

    const digest = computeCanonicalSha256(proposal.diff);
    return {
      outcome: 'REPAIR_PREPARED',
      state: latest,
      reasons: [],
      reservedActionId: actionId,
      appliedPatchDigest: digest,
      executionReceipt: settled.value,
    };
  }

  // Legacy v0.1 reservation and state CAS flow
  let receiptId: string;
  try { receiptId = await (ports.statePort as StatePort).reserve('task', 'repair', 1, actionId); }
  catch { return stop('repair-reservation-failed'); }
  if (!receiptId.trim()) return stop('repair-reservation-unconfirmed', actionId);
  let reserved: TaskState | null;
  try { reserved = await ports.statePort.loadTask(input.taskId); }
  catch { return stop('reserved-task-state-unavailable', actionId); }
  if (!reserved || reserved.stateVersion !== state.stateVersion || reserved.runId !== state.runId ||
      reserved.repositoryRevisionDigest !== state.repositoryRevisionDigest || !validateTaskState(reserved).ok) {
    return incomplete(reserved ?? state, 'reserved-task-state-inconsistent', actionId);
  }
  const reservedAccounting = checkAccounting(reserved, actionId, receiptId);
  if (!reservedAccounting.ok) return incomplete(reserved, reservedAccounting.reason, actionId);

  const evidenceRefs = [...new Set([
    ...reserved.evidenceRefs, ...refs.evidence, ...refs.actions, ...refs.diagnostics,
    ...refs.evidence.map((ref) => `repair-consumed:${ref}`), `repair-action:${actionId}`,
  ])];
  const next: TaskState = {
    ...reserved, stateVersion: reserved.stateVersion + 1, node: 'Patch',
    nextAction: 'verify-repair-candidate', evidenceRefs,
    changedPaths: [...new Set([...reserved.changedPaths, ...proposal.affectedPaths])],
  };
  if (!validateStateTransition(state, next, { trusted: ports.trustedTransitionContext }).ok) {
    return incomplete(reserved, 'repair-transition-prevalidation-failed', actionId);
  }
  let effect: Awaited<ReturnType<ExecutionGuard['validateAndExecute']>>;
  try { effect = await (ports.executionGuard as ExecutionGuard).validateAndExecute(admittedAction.value, state); }
  catch { return incomplete(reserved, 'repair-effect-uncertain', actionId); }
  if (effect.outcome !== 'success') {
    return effect.outcome === 'denied'
      ? { outcome: 'DENIED', state: reserved, reasons: ['patch-action-denied'], reservedActionId: actionId }
      : incomplete(reserved, 'repair-effect-not-confirmed', actionId);
  }
  if (!isPatchResult(effect.result)) return incomplete(reserved, 'repair-effect-result-inconsistent', actionId);
  const revision = effect.result.newRevisionDigest;
  const digest = computeCanonicalSha256(proposal.diff);
  const failPatch = (fallback: TaskState, reason: string) =>
    safeReload(ports.statePort, input.taskId, fallback).then((latest) => incomplete(latest, reason, actionId, digest));
  let patched: TaskState;
  let transitioned: TaskState;
  try {
    patched = await (ports.statePort as StatePort).transition(next, state.stateVersion);
    if (!validateStateTransition(state, patched, { trusted: ports.trustedTransitionContext }).ok) {
      return failPatch(reserved, 'repair-transition-result-inconsistent');
    }
    const verified: TaskState = {
      ...patched, stateVersion: patched.stateVersion + 1, node: 'Verify',
      repositoryRevisionDigest: revision,
      activeDecisionId: undefined, reviewRefs: [], latestReviewRef: undefined,
    };
    transitioned = await (ports.statePort as StatePort).transition(verified, patched.stateVersion);
  }
  catch {
    return failPatch(reserved, 'repair-transition-not-confirmed');
  }
  if (!validateStateTransition(patched, transitioned).ok || transitioned.repositoryRevisionDigest !== revision || transitioned.activeDecisionId || transitioned.latestReviewRef || transitioned.reviewRefs?.length) {
    return failPatch(reserved, 'repair-verification-transition-result-inconsistent');
  }
  return { outcome: 'REPAIR_PREPARED', state: transitioned, reasons: [], reservedActionId: actionId, appliedPatchDigest: digest };
}

function rejectionResult(outcome: ReplanResult['outcome'], state: TaskState, reasons: readonly string[]): ReplanResult {
  return { outcome, state, reasons, replanCount: state.replanCount, isMaterial: false };
}

export async function handlePlanRejection(input: RejectionInput, ports: RejectionPorts): Promise<ReplanResult> {
  if (!validateRejectionInput(input)) return { outcome: 'INCOMPLETE', state: {} as TaskState, reasons: ['invalid-rejection-input'], replanCount: 0, isMaterial: false };
  let state: TaskState | null;
  try { state = await ports.statePort.loadTask(input.taskId); }
  catch { return { outcome: 'INCOMPLETE', state: {} as TaskState, reasons: ['authoritative-task-state-unavailable'], replanCount: 0, isMaterial: false }; }
  if (!state) return { outcome: 'INCOMPLETE', state: {} as TaskState, reasons: ['task-not-found'], replanCount: 0, isMaterial: false };
  const approvalPort = ports.approvalPort;
  if (!validateTaskState(state).ok || state.taskId !== input.taskId || state.node !== 'AwaitPlan' ||
      !state.plan?.decisionRef || state.activeDecisionId !== state.plan.decisionRef ||
      state.activeDecisionId !== input.decisionId || !approvalPort) {
    return rejectionResult('INCOMPLETE', state, ['stored-rejected-plan-decision-required']);
  }
  const freshness = getRejectionApprovalContext(state);
  if (!freshness) return rejectionResult('INCOMPLETE', state, ['current-plan-rejection-binding-unavailable']);
  let storedDecision: Awaited<ReturnType<typeof approvalPort.resolve>>;
  try { storedDecision = await approvalPort.resolve(input.decisionId); }
  catch { return rejectionResult('INCOMPLETE', state, ['stored-plan-decision-unavailable']); }
  const decision = validateApprovalBinding(storedDecision, freshness);
  if (!decision.ok || decision.value.status !== 'rejected' || decision.value.actionKind !== 'fix_plan' ||
      decision.value.decisionId !== state.activeDecisionId || decision.value.decisionId !== input.decisionId) {
    return rejectionResult('INCOMPLETE', state, ['stored-rejection-does-not-match-current-plan']);
  }

  const next: TaskState = {
    ...state, stateVersion: state.stateVersion + 1, node: 'AwaitFeedback',
    nextAction: 'await-human-feedback-and-direction', activeDecisionId: undefined,
    approvalDecisionRefs: [...new Set([...(state.approvalDecisionRefs ?? []), decision.value.decisionId])],
  };
  if (!validateStateTransition(state, next).ok) return rejectionResult('INCOMPLETE', state, ['rejection-transition-prevalidation-failed']);
  let saved: TaskState;
  try { saved = await ports.statePort.transition(next, state.stateVersion); }
  catch { return rejectionResult('INCOMPLETE', await safeReload(ports.statePort, input.taskId, state), ['rejection-transition-failed']); }
  if (!validateStateTransition(state, saved).ok || saved.node !== 'AwaitFeedback' || saved.activeDecisionId) {
    return rejectionResult('INCOMPLETE', await safeReload(ports.statePort, input.taskId, state), ['rejection-transition-result-inconsistent']);
  }
  return rejectionResult('AWAIT_FEEDBACK', saved, ['stored-plan-rejection-confirmed', 'explicit-human-direction-required']);
}

async function safeReload(statePort: StatePort | StatePortV02, taskId: string, fallback: TaskState): Promise<TaskState> { try { const latest = await statePort.loadTask(taskId); return latest && latest.taskId === taskId && validateTaskState(latest).ok ? latest : fallback; } catch { return fallback; } }
