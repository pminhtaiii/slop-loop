/** UC-03 repair; T018 remains pending. */

import {
  computeCanonicalSha256, computeCheckSetDigest, isProtectedPath, validateApprovalBinding,
  validateStateTransition, validateTaskState, validateNormalizedAction, validateVerificationResult, validateReviewResult,
  type TaskState, type FixPlan, type VerificationResult, type ReviewResult, type StatePort,
  type RepositoryPort, type ApprovalPort, type ModelPort, type StateTransitionOptions,
  type ApplyPatchAction, type ApproveFixPlanAction, type ApprovalBindingContext,
  type BudgetLedger, type ExecutionGuard,
} from '../contracts/foundation/uc03.ts';

export type RepairOutcome = 'REPAIR_PREPARED' | 'INCOMPLETE' | 'DENIED';

export interface RepairPatchProposal { readonly diff: string; readonly affectedPaths: readonly string[]; readonly evidenceRefs: readonly string[]; readonly diagnosticRefs: readonly string[] }

export interface TrustedRepairContext {
  readonly taskId: string; readonly runId: string; readonly workspaceId: string; readonly repositoryId: string; readonly repositoryRevisionDigest: string;
  readonly baselineRef: string; readonly checkSetDigest: string; readonly diffDigest: string;
  readonly evidenceRefs: readonly string[]; readonly actionRefs: readonly string[]; readonly diagnosticRefs: readonly string[];
}

export interface RepairInput {
  readonly taskId: string;
  readonly failureEvidence: VerificationResult | ReviewResult | readonly (VerificationResult | ReviewResult)[];
  readonly repairPatch?: RepairPatchProposal | undefined; readonly actionId?: string | undefined;
}

export interface RepairPorts {
  readonly statePort: StatePort; readonly repositoryPort?: RepositoryPort | undefined;
  readonly executionGuard?: ExecutionGuard | undefined; readonly approvalPort?: ApprovalPort | undefined;
  readonly modelPort?: ModelPort | undefined; readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly trustedRepairContext?: TrustedRepairContext | undefined;
}

export interface RepairResult {
  readonly outcome: RepairOutcome; readonly state: TaskState | null; readonly reasons: readonly string[];
  readonly reservedActionId?: string | undefined; readonly appliedPatchDigest?: string | undefined;
}

export interface PlanMaterialityResult { readonly isMaterial: boolean; readonly changedFields: readonly string[]; readonly reason: string }

export type ReplanOutcome = 'REPLAN_PREPARED' | 'CLARIFICATION_ACCEPTED' | 'INCOMPLETE' | 'AWAIT_FEEDBACK' | 'DENIED';

export interface ReplanInput { readonly taskId: string; readonly candidatePlan: FixPlan; readonly proposalId: string; readonly reason?: string | undefined }

export interface ReplanPorts { readonly statePort: StatePort; readonly approvalPort?: ApprovalPort | undefined; readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined }

export interface ReplanResult { readonly outcome: ReplanOutcome; readonly state: TaskState; readonly reasons: readonly string[]; readonly replanCount: number; readonly isMaterial: boolean }

export interface RejectionInput { readonly taskId: string; readonly rejectionReason: string; readonly decisionId?: string | undefined }

export interface RejectionPorts { readonly statePort: StatePort; readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined }

export function evaluatePlanMateriality(
  _priorPlan: FixPlan,
  _candidatePlan: FixPlan
): PlanMaterialityResult {
  void _priorPlan;
  void _candidatePlan;
  return {
    isMaterial: false,
    changedFields: [],
    reason: 'skeleton-neutral-not-implemented',
  };
}

function isVerificationResult(item: unknown): item is VerificationResult {
  return typeof item === 'object' && item !== null && 'testedIds' in item;
}

function isProtectedPathOrTest(filePath: string): boolean {
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  return isProtectedPath(filePath) || norm.startsWith('tests/') || norm.startsWith('test/');
}

function isReviewResult(item: unknown): item is ReviewResult {
  return typeof item === 'object' && item !== null && 'reviewId' in item && 'findings' in item;
}

function failureRefs(items: readonly (VerificationResult | ReviewResult)[]) {
  const evidence = items.map((item) => isVerificationResult(item) ? item.evidenceId : item.reviewId);
  const actions = items.map((item) => isVerificationResult(item) ? item.actionId : item.iterationReservationRef);
  const diagnostics = items.flatMap((item) => isVerificationResult(item) ? item.diagnosticRefs : item.findings.map((finding) => finding.evidenceRef ?? item.reviewId));
  return { evidence, actions, diagnostics: [...new Set(diagnostics)] };
}

function refsMatch(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((ref: unknown, index: number) => typeof ref === 'string' && ref === expected[index]);
}

type AccountingCheck = { readonly ok: true; readonly repair: BudgetLedger } | { readonly ok: false; readonly reason: string };

function checkAccounting(state: TaskState, actionId?: string, receiptId?: string): AccountingCheck {
  const task = state.taskContext;
  const ledgers = state.budgetLedgers;
  if (!ledgers?.length) return { ok: false, reason: 'missing-budget-ledgers' };
  if (!task) return { ok: false, reason: 'missing-budget-configuration' };
  const repair = ledgers.find((entry) => entry.scope === 'task' && entry.kind === 'repair');
  const tokens = ledgers.find((entry) => entry.scope === 'task' && entry.kind === 'tokens');
  const cost = ledgers.find((entry) => entry.scope === 'task' && entry.kind === 'cost');
  if (!repair || !tokens || !cost) return { ok: false, reason: 'missing-budget-ledgers' };
  for (const [ledger, limit, unit] of [
    [repair, task.budgetLimits.maxRepairAttempts, 'count'],
    [tokens, task.budgetLimits.maxTokens, 'count'],
    [cost, task.budgetLimits.maxCostUsd, 'usd'],
  ] as const) {
    if (ledger.configurationId !== task.configId || ledger.limit !== limit || ledger.unit !== unit) {
      return { ok: false, reason: 'inconsistent-budget-configuration' };
    }
    if (ledger.reservations.some((item) => item.amount <= 0)) return { ok: false, reason: 'inconsistent-budget-accounting' };
    const total = ledger.consumed + ledger.reservations.reduce((sum, item) => sum + item.amount, 0);
    if (ledger.kind === 'repair' && actionId) {
      if (total > limit) return { ok: false, reason: 'inconsistent-budget-accounting' };
      const match = ledger.reservations.filter((item) => item.keyedId === actionId && item.amount === 1 && item.reservationId === receiptId);
      if (match.length !== 1) return { ok: false, reason: 'repair-reservation-not-authoritative' };
    } else if (total >= limit) {
      return { ok: false, reason: ledger.kind === 'repair' ? 'repair-budget-exhausted' : 'token-or-cost-budget-exhausted' };
    }
  }
  if (ledgers.some((entry) => (entry.kind === 'tokens' || entry.kind === 'cost') && entry.reservations.length > 0)) {
    return { ok: false, reason: 'uncertain-accounting-reservations' };
  }
  return { ok: true, repair };
}

function isPatchResult(value: unknown): value is { readonly applied: true; readonly newRevisionDigest: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'applied' in value && value.applied === true && 'newRevisionDigest' in value && typeof value.newRevisionDigest === 'string' && !!value.newRevisionDigest.trim();
}

function incomplete(state: TaskState | null, reason: string, actionId?: string, digest?: string): RepairResult {
  return { outcome: 'INCOMPLETE', state, reasons: [reason], ...(actionId ? { reservedActionId: actionId } : {}), ...(digest ? { appliedPatchDigest: digest } : {}) };
}

export async function executeRepair(input: RepairInput, ports: RepairPorts): Promise<RepairResult> {
  let state: TaskState | null;
  try { state = await ports.statePort.loadTask(input.taskId); }
  catch { return incomplete(null, 'authoritative-task-state-unavailable'); }
  if (!state) return incomplete(null, 'task-not-found');
  if (!validateTaskState(state).ok) return incomplete(state, 'invalid-authoritative-task-state');

  const items = Array.isArray(input.failureEvidence) ? input.failureEvidence : [input.failureEvidence];
  if (!items.length) return incomplete(state, 'missing-failure-evidence');
  for (const item of items) {
    if (isVerificationResult(item)) {
      if (!validateVerificationResult(item).ok) return incomplete(state, 'invalid-verification-failure-evidence');
      if (item.outcome !== 'fail') return incomplete(state, 'not-failure-evidence');
      if (item.taskId !== state.taskId || item.runId !== state.runId || item.repoDigest !== state.repositoryRevisionDigest) {
        return incomplete(state, 'stale-or-unbound-verification-failure');
      }
      if (!item.diffDigest || !item.diagnosticRefs.length) return incomplete(state, 'verification-diagnostics-or-diff-missing');
    } else if (isReviewResult(item)) {
      if (!validateReviewResult(item).ok) return incomplete(state, 'invalid-review-failure-evidence');
      if (item.status === 'accepted') return incomplete(state, 'not-failure-evidence');
      if (item.status !== 'findings') return incomplete(state, 'review-failure-evidence-not-actionable');
      if (item.repoDigest !== state.repositoryRevisionDigest) return incomplete(state, 'stale-review-failure-evidence');
    } else return incomplete(state, 'unknown-failure-evidence-type');
  }

  const accounting = checkAccounting(state);
  if (!accounting.ok) return incomplete(state, accounting.reason);
  const plan = state.plan;
  const task = state.taskContext;
  const approval = ports.trustedTransitionContext?.approval;
  if (!plan?.decisionRef || !task?.requiredChecks.length || !approval || !ports.approvalPort) {
    return incomplete(state, 'current-approved-plan-unavailable');
  }
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  if (plan.checkSetDigest !== checkSetDigest) return incomplete(state, 'approved-plan-check-set-mismatch');
  const planAction: ApproveFixPlanAction = {
    actionId: plan.decisionRef, kind: 'approve_fix_plan', planVersion: state.planVersion,
    strategyDigest: plan.strategyDigest, diagnosisEvidenceRefs: plan.evidenceRefs, checkSetDigest,
  };
  const currentApproval: ApprovalBindingContext = {
    currentTaskId: state.taskId, currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
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
    return incomplete(state, 'current-plan-approval-missing-or-stale');
  }
  try {
    if (!await ports.approvalPort.validateBinding(binding.value)) return incomplete(state, 'current-plan-approval-not-authoritative');
  } catch { return incomplete(state, 'current-plan-approval-not-authoritative'); }

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
    return incomplete(state, 'current-repair-evidence-binding-unavailable-or-stale');
  }
  for (const item of items) {
    if (isVerificationResult(item)) {
      const matches = item.testedIds.map((id) => task.requiredChecks.find((check) => check.checkId === id));
      const phaseMatches = matches.every((check) => check && (check.purpose === 'reproduction' ? 'focused' : check.purpose) === item.phase);
      if (new Set(item.testedIds).size !== item.testedIds.length || matches.some((check) => !check) || !phaseMatches) {
        return incomplete(state, 'verification-failure-check-set-mismatch');
      }
    } else if (item.checkSetDigest !== checkSetDigest || item.reviewId !== state.latestReviewRef || !state.reviewRefs?.includes(item.reviewId)) {
      return incomplete(state, 'review-failure-binding-mismatch');
    }
  }
  const proposal = input.repairPatch;
  if (!proposal || !proposal.diff.trim() || !proposal.affectedPaths.length || new Set(proposal.affectedPaths).size !== proposal.affectedPaths.length) {
    return incomplete(state, 'repair-proposal-missing-or-invalid');
  }
  if (proposal.affectedPaths.some(isProtectedPathOrTest)) return { outcome: 'DENIED', state, reasons: ['forbidden-protected-path-edit'] };

  const actionId = `act-repair-${computeCanonicalSha256({
    taskId: state.taskId, runId: state.runId, repositoryRevisionDigest: state.repositoryRevisionDigest,
    baselineRef: plan.baselineRef, checkSetDigest, diffDigest: ctx.diffDigest,
    evidenceRefs: refs.evidence, actionRefs: refs.actions, diagnosticRefs: refs.diagnostics,
  })}`;
  if (input.actionId !== undefined && input.actionId !== actionId) return incomplete(state, 'repair-action-identity-mismatch');
  if (accounting.repair.reservations.some((entry) => entry.keyedId === actionId) || state.evidenceRefs.includes(`repair-action:${actionId}`)) {
    return incomplete(state, 'repair-evidence-already-reserved');
  }
  if (!ports.executionGuard) return incomplete(state, 'execution-guard-unavailable');
  const action: ApplyPatchAction = {
    actionId, kind: 'apply_patch', patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths], baseRevisionDigest: state.repositoryRevisionDigest,
  };
  const admittedAction = validateNormalizedAction(action);
  if (!admittedAction.ok) return incomplete(state, 'invalid-repair-action');
  try {
    const permission = await ports.approvalPort.classify(admittedAction.value);
    if (permission === 'FORBIDDEN') return { outcome: 'DENIED', state, reasons: ['patch-action-forbidden'] };
    if (permission !== 'ALLOWED') return incomplete(state, 'patch-action-approval-required');
  } catch { return incomplete(state, 'patch-policy-unavailable'); }

  let receiptId: string;
  try { receiptId = await ports.statePort.reserve('task', 'repair', 1, actionId); }
  catch { return incomplete(state, 'repair-reservation-failed'); }
  if (!receiptId.trim()) return incomplete(state, 'repair-reservation-unconfirmed', actionId);
  let reserved: TaskState | null;
  try { reserved = await ports.statePort.loadTask(input.taskId); }
  catch { return incomplete(state, 'reserved-task-state-unavailable', actionId); }
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
  try { effect = await ports.executionGuard.validateAndExecute(admittedAction.value, state); }
  catch { return incomplete(reserved, 'repair-effect-uncertain', actionId); }
  if (effect.outcome !== 'success') {
    return effect.outcome === 'denied'
      ? { outcome: 'DENIED', state: reserved, reasons: ['patch-action-denied'], reservedActionId: actionId }
      : incomplete(reserved, 'repair-effect-not-confirmed', actionId);
  }
  if (!isPatchResult(effect.result)) return incomplete(reserved, 'repair-effect-result-inconsistent', actionId);
  const digest = computeCanonicalSha256(proposal.diff);
  let transitioned: TaskState;
  try { transitioned = await ports.statePort.transition(next, state.stateVersion); }
  catch {
    return incomplete(await safeReload(ports.statePort, input.taskId, reserved), 'repair-transition-not-confirmed', actionId, digest);
  }
  if (!validateTaskState(transitioned).ok || transitioned.stateVersion !== next.stateVersion || transitioned.node !== 'Patch' || transitioned.runId !== state.runId) {
    return incomplete(await safeReload(ports.statePort, input.taskId, reserved), 'repair-transition-result-inconsistent', actionId, digest);
  }
  return { outcome: 'REPAIR_PREPARED', state: transitioned, reasons: [], reservedActionId: actionId, appliedPatchDigest: digest };
}

async function safeReload(statePort: StatePort, taskId: string, fallback: TaskState): Promise<TaskState> {
  try {
    const latest = await statePort.loadTask(taskId);
    return latest && validateTaskState(latest).ok ? latest : fallback;
  } catch { return fallback; }
}
export async function executeReplan(
  input: ReplanInput,
  ports: ReplanPorts
): Promise<ReplanResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
    replanCount: currentState?.replanCount ?? 0,
    isMaterial: false,
  };
}

export async function handlePlanRejection(
  input: RejectionInput,
  ports: RejectionPorts
): Promise<ReplanResult> {
  const currentState = await ports.statePort.loadTask(input.taskId);
  return {
    outcome: 'INCOMPLETE',
    state: currentState ?? ({} as TaskState),
    reasons: ['skeleton-neutral-not-implemented'],
    replanCount: currentState?.replanCount ?? 0,
    isMaterial: false,
  };
}
