/**
 * UC-03 Material Replan & Human Feedback Transitions (T018)
 * Feature: specs/001-verified-code-repair
 *
 * Requirements & Acceptance:
 * - C12: Initial plan zero, at most 3 material replans, fourth refused; rejection waits
 *   for user feedback; minor vs material based on bound fields NOT caller boolean.
 * - CAS transitions via StatePort without local durable ledger duck typing.
 * - Invalidate prior edit/approval/review authority upon material replan.
 * - Safe typed outcome without raw error exposure on unexpected port failures.
 */

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  validateBudgetLedger,
  validateFixPlan,
  validateTaskState,
  validateStateTransition,
  type BudgetLedger,
  type FixPlan,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import type {
  PlanMaterialityResult,
  ReplanInput,
  ReplanPorts,
  ReplanResult,
  TrustedReplanDirection,
} from './repair-types.ts';

const MAX_TASK_REPLANS = 3;

/**
 * Evaluates whether a candidate fix plan constitutes a material shift compared
 * to the prior recorded plan, inspecting canonical fields rather than caller claims.
 */
export function evaluatePlanMateriality(
  priorPlan: FixPlan,
  candidatePlan: FixPlan
): PlanMaterialityResult {
  if (
    !priorPlan ||
    typeof priorPlan !== 'object' ||
    !candidatePlan ||
    typeof candidatePlan !== 'object'
  ) {
    return {
      isMaterial: false,
      changedFields: [],
      reason: 'invalid-plan-input',
    };
  }

  const changedFields: string[] = [];
  for (const field of ['strategy', 'strategyDigest', 'diagnosis', 'suspectedCauseLocations', 'scopedChanges', 'evidenceRefs'] as const) {
    if (computeCanonicalSha256(priorPlan[field]) !== computeCanonicalSha256(candidatePlan[field])) changedFields.push(field);
  }
  const isMaterial = changedFields.some((field) => field !== 'evidenceRefs');
  return {
    isMaterial,
    changedFields,
    reason: isMaterial
      ? 'material-bound-plan-shift'
      : 'non-material-clarification',
  };
}

type ReplanAccountingCheck =
  | { readonly ok: true; readonly replanLedger: BudgetLedger }
  | { readonly ok: false; readonly reason: string };

function response(
  outcome: ReplanResult['outcome'],
  state: TaskState,
  reasons: readonly string[] = [],
  isMaterial = false
): ReplanResult {
  return { outcome, state, reasons, replanCount: state.replanCount, isMaterial };
}

function emptyResponse(reason: string): ReplanResult {
  return { outcome: 'INCOMPLETE', state: {} as TaskState, reasons: [reason], replanCount: 0, isMaterial: false };
}

function validReplanInput(input: unknown): input is ReplanInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).every((key) => ['taskId', 'proposalId', 'candidatePlan', 'reason'].includes(key)) &&
    typeof value.taskId === 'string' && !!value.taskId.trim() &&
    typeof value.proposalId === 'string' && !!value.proposalId.trim() &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    validateFixPlan(value.candidatePlan).ok;
}

function validPlanForTask(plan: FixPlan, state: TaskState): boolean {
  const checks = state.taskContext?.requiredChecks;
  return !!checks?.length && plan.checkSetDigest === computeCheckSetDigest(checks) &&
    plan.baselineRef === state.taskContext?.initialRevisionDigest &&
    plan.strategyDigest === computeCanonicalSha256(plan.strategy);
}

function matchesReplanReservation(
  context: ReplanPorts['trustedTransitionContext'],
  expected: Omit<NonNullable<NonNullable<ReplanPorts['trustedTransitionContext']>['replanReservation']>, 'reservationId'>,
  reservationId?: string
): boolean {
  const reservation = context?.replanReservation;
  return !!reservation && reservation.proposalId === expected.proposalId &&
    reservation.taskId === expected.taskId && reservation.configurationId === expected.configurationId &&
    reservation.priorCount === expected.priorCount && reservation.nextCount === expected.nextCount &&
    typeof reservation.reservationId === 'string' && reservation.reservationId.trim().length > 0 &&
    (reservationId === undefined || reservation.reservationId === reservationId);
}

function matchesTrustedDirection(
  direction: TrustedReplanDirection | undefined,
  state: TaskState
): direction is TrustedReplanDirection {
  const plan = state.plan;
  return state.node === 'AwaitFeedback' && !state.activeDecisionId && !!plan?.decisionRef && !!direction &&
    (direction.directive === 'resume' || direction.directive === 'revise' || direction.directive === 'terminate') &&
    direction.taskId === state.taskId && direction.workspaceId === state.workspaceId &&
    direction.repositoryRevisionDigest === state.repositoryRevisionDigest && direction.stateVersion === state.stateVersion &&
    direction.planVersion === state.planVersion && direction.rejectedDecisionId === plan.decisionRef &&
    direction.strategyDigest === plan.strategyDigest;
}

async function safeReload(statePort: ReplanPorts['statePort'], taskId: string, fallback: TaskState): Promise<TaskState> {
  try {
    const latest = await statePort.loadTask(taskId);
    return latest && latest.taskId === taskId && validateTaskState(latest).ok ? latest : fallback;
  } catch {
    return fallback;
  }
}

async function saveTransition(
  prior: TaskState,
  next: TaskState,
  ports: ReplanPorts,
  reason: string,
  fallback: TaskState = prior
): Promise<{ readonly state: TaskState; readonly error?: string }> {
  if (!validateStateTransition(prior, next, { trusted: ports.trustedTransitionContext }).ok) {
    return { state: await safeReload(ports.statePort, prior.taskId, fallback), error: `${reason}-prevalidation-failed` };
  }
  try {
    const saved = await ports.statePort.transition(next, prior.stateVersion);
    const valid = validateStateTransition(prior, saved, { trusted: ports.trustedTransitionContext }).ok;
    if (!valid || saved.stateVersion !== next.stateVersion || saved.node !== next.node ||
        saved.planVersion !== next.planVersion || saved.replanCount !== next.replanCount ||
        computeCanonicalSha256(saved.plan ?? null) !== computeCanonicalSha256(next.plan ?? null) ||
        saved.activeDecisionId !== next.activeDecisionId ||
        saved.latestReviewRef !== next.latestReviewRef ||
        computeCanonicalSha256(saved.reviewRefs ?? []) !== computeCanonicalSha256(next.reviewRefs ?? [])) {
      return { state: await safeReload(ports.statePort, prior.taskId, fallback), error: `${reason}-result-inconsistent` };
    }
    return { state: saved };
  } catch {
    return { state: await safeReload(ports.statePort, prior.taskId, fallback), error: `${reason}-failed` };
  }
}

async function prepareUnchargedPlan(state: TaskState, candidatePlan: FixPlan, ports: ReplanPorts): Promise<ReplanResult> {
  const plan = { ...candidatePlan, planVersion: state.planVersion, decisionRef: undefined };
  const cleared = { plan, activeDecisionId: undefined, latestReviewRef: undefined, reviewRefs: [] } as const;
  if (state.node === 'Investigate') {
    const next: TaskState = { ...state, ...cleared, stateVersion: state.stateVersion + 1, node: 'AwaitPlan', nextAction: 'approve-fix-plan' };
    const saved = await saveTransition(state, next, ports, 'clarification-transition');
    return saved.error ? response('INCOMPLETE', saved.state, [saved.error])
      : response('CLARIFICATION_ACCEPTED', saved.state, ['clarification-requires-fresh-plan-approval']);
  }
  if (state.node !== 'AwaitFeedback') {
    return response('DENIED', state, ['minor-binding-change-needs-feedback-or-investigation']);
  }
  const investigate: TaskState = { ...state, ...cleared, stateVersion: state.stateVersion + 1, node: 'Investigate', nextAction: 'propose-fix-plan' };
  const first = await saveTransition(state, investigate, ports, 'clarification-transition');
  if (first.error) return response('INCOMPLETE', first.state, [first.error]);
  const awaitPlan: TaskState = { ...first.state, ...cleared, stateVersion: first.state.stateVersion + 1, node: 'AwaitPlan', nextAction: 'approve-fix-plan' };
  const second = await saveTransition(first.state, awaitPlan, ports, 'clarification-transition');
  return second.error ? response('INCOMPLETE', second.state, [second.error])
    : response('CLARIFICATION_ACCEPTED', second.state, ['clarification-requires-fresh-plan-approval']);
}

function checkReplanAccounting(
  state: TaskState,
  proposalId?: string,
  receiptId?: string
): ReplanAccountingCheck {
  const task = state.taskContext;
  const ledgers = state.budgetLedgers;
  if (!ledgers?.length) return { ok: false, reason: 'missing-budget-ledgers' };
  if (!task) return { ok: false, reason: 'missing-budget-configuration' };

  const requirements = [
    ['replan', task.budgetLimits.maxReplanCount, 'count'],
    ['repair', task.budgetLimits.maxRepairAttempts, 'count'],
    ['tokens', task.budgetLimits.maxTokens, 'count'],
    ['cost', task.budgetLimits.maxCostUsd, 'usd'],
  ] as const;
  const seenReservations = new Set<string>();
  const checked: BudgetLedger[] = [];
  for (const [kind, limit, unit] of requirements) {
    const matches = ledgers.filter((ledger) => ledger.scope === 'task' && ledger.kind === kind);
    if (matches.length !== 1) return { ok: false, reason: `missing-or-duplicate-${kind}-budget-ledger` };
    const ledger = matches[0];
    if (!ledger || !validateBudgetLedger(ledger).ok || !Number.isFinite(limit) || limit <= 0 ||
        ledger.configurationId !== task.configId || ledger.limit !== limit || ledger.unit !== unit) {
      return { ok: false, reason: `inconsistent-${kind}-budget-configuration` };
    }
    for (const item of ledger.reservations) {
      if (item.amount <= 0 || seenReservations.has(item.reservationId)) {
        return { ok: false, reason: `inconsistent-${kind}-budget-accounting` };
      }
      seenReservations.add(item.reservationId);
    }
    const total = ledger.consumed + ledger.reservations.reduce((sum, item) => sum + item.amount, 0);
    if (total > ledger.limit) {
      return { ok: false, reason: `inconsistent-${kind}-budget-accounting` };
    }
    checked.push(ledger);
  }

  const replanLedger = checked[0];
  if (!replanLedger) return { ok: false, reason: 'missing-replan-budget-ledger' };
  const replanTotal = replanLedger.consumed + replanLedger.reservations.reduce((sum, item) => sum + item.amount, 0);
  const expectedCount = proposalId && receiptId ? state.replanCount + 1 : state.replanCount;
  if (task.budgetLimits.maxReplanCount !== MAX_TASK_REPLANS ||
      replanLedger.limit !== MAX_TASK_REPLANS || replanTotal !== expectedCount) {
    return { ok: false, reason: 'inconsistent-replan-accounting' };
  }
  if (checked[1]?.reservations.some((item) => !state.evidenceRefs.includes('repair-action:' + item.keyedId))) {
    return { ok: false, reason: 'repair-effect-needs-trusted-reconciliation' };
  }
  if (checked.slice(2).some((ledger) => ledger.reservations.length > 0)) return { ok: false, reason: 'uncertain-accounting-reservations' };
  if (checked.slice(1).some((ledger) => ledger.consumed >= ledger.limit)) {
    return { ok: false, reason: 'task-budget-exhausted' };
  }

  if (proposalId || receiptId) {
    if (!proposalId || !receiptId || replanTotal !== state.replanCount + 1 ||
        replanLedger.reservations.filter((item) => item.keyedId === proposalId && item.amount === 1 && item.reservationId === receiptId).length !== 1) {
      return { ok: false, reason: 'replan-reservation-not-authoritative' };
    }
  }
  return { ok: true, replanLedger };
}

/**
 * Executes a material replan or minor plan clarification within task bounds.
 */
export async function executeReplan(
  input: ReplanInput,
  ports: ReplanPorts
): Promise<ReplanResult> {
  if (!validReplanInput(input)) return emptyResponse('invalid-replan-input');
  let state: TaskState | null;
  try { state = await ports.statePort.loadTask(input.taskId); }
  catch { return emptyResponse('authoritative-task-state-unavailable'); }
  if (!state) return emptyResponse('task-not-found');
  if (!validateTaskState(state).ok) return response('INCOMPLETE', state, ['invalid-authoritative-task-state']);
  if (!validPlanForTask(input.candidatePlan, state)) return response('INCOMPLETE', state, ['candidate-plan-binding-mismatch']);

  let materiality: PlanMaterialityResult = { isMaterial: false, changedFields: [], reason: 'initial-plan' };
  if (state.plan) materiality = evaluatePlanMateriality(state.plan, input.candidatePlan);

  if (state.node === 'AwaitFeedback' && !matchesTrustedDirection(ports.trustedDirection, state)) {
    return response('AWAIT_FEEDBACK', state, ['explicit-human-direction-required'], materiality.isMaterial);
  }

  const accounting = checkReplanAccounting(state);
  if (!accounting.ok) return response('INCOMPLETE', state, [accounting.reason], materiality.isMaterial);

  if (!state.plan) {
    if (state.node !== 'Investigate' || state.replanCount !== 0) return response('INCOMPLETE', state, ['initial-plan-state-inconsistent']);
    const plan = { ...input.candidatePlan, planVersion: state.planVersion, decisionRef: undefined };
    const next: TaskState = { ...state, stateVersion: state.stateVersion + 1, node: 'AwaitPlan', nextAction: 'approve-fix-plan', plan, activeDecisionId: undefined, latestReviewRef: undefined, reviewRefs: [] };
    const saved = await saveTransition(state, next, ports, 'initial-plan-transition');
    return saved.error ? response('INCOMPLETE', saved.state, [saved.error]) : response('REPLAN_PREPARED', saved.state);
  }

  if (state.node === 'AwaitFeedback') {
    const direction = ports.trustedDirection;
    if (!direction) return response('AWAIT_FEEDBACK', state, ['explicit-human-direction-required'], materiality.isMaterial);
    if (direction.directive === 'terminate') {
      const next: TaskState = { ...state, stateVersion: state.stateVersion + 1, node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'human-directed-termination', activeDecisionId: undefined };
      const saved = await saveTransition(state, next, ports, 'termination-transition');
      return response('INCOMPLETE', saved.state, saved.error ? [saved.error] : ['human-directed-termination']);
    }
    if (direction.directive === 'resume' && materiality.isMaterial) {
      return response('DENIED', state, ['resume-direction-does-not-authorize-material-revision'], true);
    }
    if (!materiality.isMaterial) return prepareUnchargedPlan(state, input.candidatePlan, ports);
  }

  if (!materiality.isMaterial) {
    if (materiality.changedFields.length) {
      if (state.node === 'Investigate') return prepareUnchargedPlan(state, input.candidatePlan, ports);
      return response('DENIED', state, ['minor-binding-change-needs-feedback-or-investigation']);
    }
    return response('CLARIFICATION_ACCEPTED', state);
  }

  if (state.replanCount >= MAX_TASK_REPLANS) {
    const clearedPlan = state.plan ? { ...state.plan, decisionRef: undefined } : undefined;
    const stopState: TaskState = { ...state, activeDecisionId: undefined, plan: clearedPlan, latestReviewRef: undefined, reviewRefs: [] };
    let savedState = state;
    if (state.node === 'AwaitPlan') {
      const waiting: TaskState = { ...stopState, stateVersion: state.stateVersion + 1, node: 'AwaitFeedback', nextAction: 'halt-replan-cap-exceeded' };
      const first = await saveTransition(state, waiting, ports, 'replan-cap-transition');
      if (first.error) return response('INCOMPLETE', first.state, ['replan-cap-exceeded-fourth-replan-refused', first.error], true);
      savedState = first.state;
      const incomplete: TaskState = { ...savedState, stateVersion: savedState.stateVersion + 1, node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'halt-replan-cap-exceeded' };
      const second = await saveTransition(savedState, incomplete, ports, 'replan-cap-transition');
      if (second.error) return response('INCOMPLETE', second.state, ['replan-cap-exceeded-fourth-replan-refused', second.error], true);
      savedState = second.state;
    } else if (state.node === 'Repair' || state.node === 'AwaitFeedback') {
      const incomplete: TaskState = { ...stopState, stateVersion: state.stateVersion + 1, node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'halt-replan-cap-exceeded' };
      const saved = await saveTransition(state, incomplete, ports, 'replan-cap-transition');
      if (saved.error) return response('INCOMPLETE', saved.state, ['replan-cap-exceeded-fourth-replan-refused', saved.error], true);
      savedState = saved.state;
    }
    return response('INCOMPLETE', savedState, ['replan-cap-exceeded-fourth-replan-refused'], true);
  }

  if (state.node !== 'Repair' && state.node !== 'Investigate' && state.node !== 'AwaitFeedback') {
    return response('DENIED', state, [`replan-unsupported-from-node-${state.node}`], true);
  }
  if (accounting.replanLedger.reservations.some((item) => item.keyedId === input.proposalId && item.amount === 1)) {
    return response('DENIED', state, ['idempotent-replay-denied-proposal-already-reserved'], true);
  }
  const expected = { proposalId: input.proposalId, taskId: state.taskId, configurationId: state.taskContext?.configId ?? '', priorCount: state.replanCount, nextCount: state.replanCount + 1 };
  if (!matchesReplanReservation(ports.trustedTransitionContext, expected)) {
    return response('INCOMPLETE', state, ['replan-transition-admission-unavailable'], true);
  }

  let receiptId: string;
  try { receiptId = await ports.statePort.reserve('task', 'replan', 1, input.proposalId); }
  catch { return response('INCOMPLETE', state, ['replan-reservation-failed'], true); }
  let reserved: TaskState | null;
  try { reserved = await ports.statePort.loadTask(input.taskId); }
  catch { return response('INCOMPLETE', state, ['reserved-task-state-unavailable'], true); }
  if (!reserved || !validateTaskState(reserved).ok || reserved.taskId !== state.taskId || reserved.stateVersion !== state.stateVersion || reserved.node !== state.node || reserved.replanCount !== state.replanCount) {
    return response('INCOMPLETE', reserved ?? state, ['reserved-task-state-inconsistent'], true);
  }
  const charged = checkReplanAccounting(reserved, input.proposalId, receiptId);
  if (!charged.ok) return response('INCOMPLETE', reserved, [charged.reason], true);

  const count = state.replanCount + 1;
  const planVersion = state.planVersion + 1;
  const plan = { ...input.candidatePlan, planVersion, decisionRef: undefined };
  const clear = { plan, activeDecisionId: undefined, latestReviewRef: undefined, reviewRefs: [] } as const;
  let prior = state;
  let accounted = reserved;
  if (state.node !== 'Investigate') {
    const investigate: TaskState = { ...reserved, ...clear, stateVersion: state.stateVersion + 1, node: 'Investigate', nextAction: 'propose-fix-plan', planVersion, replanCount: count };
    const first = await saveTransition(state, investigate, ports, 'replan-transition-to-investigate', reserved);
    if (first.error) return response('INCOMPLETE', first.state, [first.error], true);
    prior = first.state;
    accounted = first.state;
  }
  const awaitPlan: TaskState = { ...accounted, ...clear, stateVersion: prior.stateVersion + 1, node: 'AwaitPlan', nextAction: 'approve-fix-plan', planVersion, replanCount: count };
  const saved = await saveTransition(prior, awaitPlan, ports, 'replan-transition-to-await-plan', accounted);
  return saved.error ? response('INCOMPLETE', saved.state, [saved.error], true) : response('REPLAN_PREPARED', saved.state, [], true);
}
