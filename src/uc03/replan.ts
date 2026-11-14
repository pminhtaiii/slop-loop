/** T018: canonical materiality and bounded owner-gated replanning. */

import { computeCanonicalSha256, computeCheckSetDigest, validateFixPlan, validateTaskState, validateStateTransition, type FixPlan, type TaskState } from '../contracts/foundation/uc03.ts';
import { isStatePortV02 } from './repair-types.ts';
import { MAX_TASK_REPLANS, checkReplanAccounting } from './replan-accounting.ts';
import { bindAcceptedMaterialReplan } from './replan-owner-result.ts';
import type { PlanMaterialityResult, ReplanInput, ReplanPorts, ReplanResult, TrustedReplanDirection } from './repair-types.ts';
import type { MaterialReplanResultV02 } from './graph-types-v02.ts';

/**
 * Evaluates whether a candidate fix plan constitutes a material shift compared
 * to the prior recorded plan, inspecting canonical fields rather than caller claims.
 */
export function evaluatePlanMateriality(priorPlan: FixPlan, candidatePlan: FixPlan): PlanMaterialityResult {
  if (!priorPlan || typeof priorPlan !== 'object' || !candidatePlan || typeof candidatePlan !== 'object') {
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
  const isMaterial = changedFields.some(field => field !== 'evidenceRefs');
  return {
    isMaterial,
    changedFields,
    reason: isMaterial ? 'material-bound-plan-shift' : 'non-material-clarification',
  };
}

function response(outcome: ReplanResult['outcome'], state: TaskState, reasons: readonly string[] = [], isMaterial = false): ReplanResult {
  return { outcome, state, reasons, replanCount: state.replanCount, isMaterial };
}

function emptyResponse(reason: string): ReplanResult {
  return { outcome: 'INCOMPLETE', state: {} as TaskState, reasons: [reason], replanCount: 0, isMaterial: false };
}

function validReplanInput(input: unknown): input is ReplanInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    Object.keys(value).every(key => ['taskId', 'proposalId', 'candidatePlan', 'reason'].includes(key)) &&
    typeof value.taskId === 'string' &&
    !!value.taskId.trim() &&
    typeof value.proposalId === 'string' &&
    !!value.proposalId.trim() &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    validateFixPlan(value.candidatePlan).ok
  );
}

function validPlanForTask(plan: FixPlan, state: TaskState): boolean {
  const checks = state.taskContext?.requiredChecks;
  const baselineRef = state.plan?.baselineRef ?? state.taskContext?.initialRevisionDigest;
  return !!checks?.length && plan.checkSetDigest === computeCheckSetDigest(checks) && plan.baselineRef === baselineRef && plan.strategyDigest === computeCanonicalSha256(plan.strategy);
}

function matchesReplanReservation(
  context: ReplanPorts['trustedTransitionContext'],
  expected: Omit<NonNullable<NonNullable<ReplanPorts['trustedTransitionContext']>['replanReservation']>, 'reservationId'>,
  reservationId?: string,
): boolean {
  const reservation = context?.replanReservation;
  return (
    !!reservation &&
    reservation.proposalId === expected.proposalId &&
    reservation.taskId === expected.taskId &&
    reservation.configurationId === expected.configurationId &&
    reservation.priorCount === expected.priorCount &&
    reservation.nextCount === expected.nextCount &&
    typeof reservation.reservationId === 'string' &&
    reservation.reservationId.trim().length > 0 &&
    (reservationId === undefined || reservation.reservationId === reservationId)
  );
}

function matchesTrustedDirection(direction: TrustedReplanDirection | undefined, state: TaskState): direction is TrustedReplanDirection {
  const plan = state.plan;
  return (
    state.node === 'AwaitFeedback' &&
    !!plan?.decisionRef &&
    state.activeDecisionId === plan.decisionRef &&
    !!direction &&
    (direction.directive === 'resume' || direction.directive === 'revise' || direction.directive === 'terminate') &&
    direction.taskId === state.taskId &&
    direction.workspaceId === state.workspaceId &&
    direction.repositoryRevisionDigest === state.repositoryRevisionDigest &&
    direction.stateVersion === state.stateVersion &&
    direction.planVersion === state.planVersion &&
    direction.rejectedDecisionId === plan.decisionRef &&
    direction.strategyDigest === plan.strategyDigest
  );
}

async function safeReload(statePort: ReplanPorts['statePort'], taskId: string, fallback: TaskState): Promise<TaskState> {
  try {
    const latest = await statePort.loadTask(taskId);
    return latest && latest.taskId === taskId && validateTaskState(latest).ok ? latest : fallback;
  } catch {
    return fallback;
  }
}

async function saveTransition(prior: TaskState, next: TaskState, ports: ReplanPorts, reason: string, fallback: TaskState = prior): Promise<{ readonly state: TaskState; readonly error?: string }> {
  if (!validateStateTransition(prior, next, { trusted: ports.trustedTransitionContext }).ok) {
    return { state: await safeReload(ports.statePort, prior.taskId, fallback), error: `${reason}-prevalidation-failed` };
  }
  try {
    const saved = await ports.statePort.transition(next, prior.stateVersion);
    const valid = validateStateTransition(prior, saved, { trusted: ports.trustedTransitionContext }).ok;
    if (
      !valid ||
      saved.stateVersion !== next.stateVersion ||
      saved.node !== next.node ||
      saved.planVersion !== next.planVersion ||
      saved.replanCount !== next.replanCount ||
      computeCanonicalSha256(saved.plan ?? null) !== computeCanonicalSha256(next.plan ?? null) ||
      saved.activeDecisionId !== next.activeDecisionId ||
      saved.latestReviewRef !== next.latestReviewRef ||
      computeCanonicalSha256(saved.reviewRefs ?? []) !== computeCanonicalSha256(next.reviewRefs ?? [])
    ) {
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
    return saved.error ? response('INCOMPLETE', saved.state, [saved.error]) : response('CLARIFICATION_ACCEPTED', saved.state, ['clarification-requires-fresh-plan-approval']);
  }
  if (state.node !== 'AwaitFeedback') {
    return response('DENIED', state, ['minor-binding-change-needs-feedback-or-investigation']);
  }
  const investigate: TaskState = { ...state, ...cleared, stateVersion: state.stateVersion + 1, node: 'Investigate', nextAction: 'propose-fix-plan' };
  const first = await saveTransition(state, investigate, ports, 'clarification-transition');
  if (first.error) return response('INCOMPLETE', first.state, [first.error]);
  const awaitPlan: TaskState = { ...first.state, ...cleared, stateVersion: first.state.stateVersion + 1, node: 'AwaitPlan', nextAction: 'approve-fix-plan' };
  const second = await saveTransition(first.state, awaitPlan, ports, 'clarification-transition');
  return second.error ? response('INCOMPLETE', second.state, [second.error]) : response('CLARIFICATION_ACCEPTED', second.state, ['clarification-requires-fresh-plan-approval']);
}

/**
 * Executes a material replan or minor plan clarification within task bounds.
 */
export async function executeReplan(input: ReplanInput, ports: ReplanPorts): Promise<ReplanResult> {
  if (!validReplanInput(input)) return emptyResponse('invalid-replan-input');
  let state: TaskState | null;
  try {
    state = await ports.statePort.loadTask(input.taskId);
  } catch {
    return emptyResponse('authoritative-task-state-unavailable');
  }
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
    const next: TaskState = {
      ...state,
      stateVersion: state.stateVersion + 1,
      node: 'AwaitPlan',
      nextAction: 'approve-fix-plan',
      plan,
      activeDecisionId: undefined,
      latestReviewRef: undefined,
      reviewRefs: [],
    };
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

  // Production route: the UC-04 material-replan transaction owns the allowance and the transition.
  if (ports.replanPort) {
    const direction = ports.trustedDirection;
    if (!direction) return response('INCOMPLETE', state, ['explicit-human-direction-required'], true);
    let accepted: MaterialReplanResultV02;
    try {
      accepted = await ports.replanPort.accept({
        taskId: state.taskId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        configurationId: state.taskContext?.configId ?? '',
        configurationVersion: state.taskContext?.configVersion ?? '',
        proposalId: input.proposalId,
        candidatePlan: input.candidatePlan,
        candidatePlanDigest: computeCanonicalSha256(input.candidatePlan),
        priorPlanVersion: state.planVersion,
        priorStateVersion: state.stateVersion,
        priorReplanCount: state.replanCount,
        expectedNextReplanCount: state.replanCount + 1,
        direction,
      });
    } catch {
      return response('INCOMPLETE', state, ['replan-reservation-failed'], true);
    }
    if (accepted.outcome === 'denied') return response('DENIED', state, [accepted.reason], true);
    // The fixed marker gives the opaque owner reference provenance, so it can never pass as a stop code.
    if (accepted.outcome === 'uncertain') return response('INCOMPLETE', state, ['replan-owner-outcome-uncertain', accepted.operationRef], true);
    // 'accepted' and 'already-accepted' both carry the owner-committed state; replay adds no charge.
    // Bind it to this request: a valid state for another task/run, or one that skips the charge, is inconsistent.
    if (!isStatePortV02(ports.statePort)) return response('INCOMPLETE', state, ['replan-owner-state-port-unavailable'], true);
    const owned = await bindAcceptedMaterialReplan(state, input, accepted, ports.statePort);
    return owned ? response('REPLAN_PREPARED', owned, [], true) : response('INCOMPLETE', state, ['reserved-task-state-inconsistent'], true);
  }

  // Controlled caller: legacy reservation and state CAS flow.
  const statePort = ports.statePort;
  if (isStatePortV02(statePort)) return response('INCOMPLETE', state, ['replan-transition-admission-unavailable'], true);
  if (accounting.replanLedger.reservations.some(item => item.keyedId === input.proposalId && item.amount === 1)) {
    return response('DENIED', state, ['idempotent-replay-denied-proposal-already-reserved'], true);
  }
  const expected = { proposalId: input.proposalId, taskId: state.taskId, configurationId: state.taskContext?.configId ?? '', priorCount: state.replanCount, nextCount: state.replanCount + 1 };
  if (!matchesReplanReservation(ports.trustedTransitionContext, expected)) {
    return response('INCOMPLETE', state, ['replan-transition-admission-unavailable'], true);
  }

  let receiptId: string;
  try {
    receiptId = await statePort.reserve('task', 'replan', 1, input.proposalId);
  } catch {
    return response('INCOMPLETE', state, ['replan-reservation-failed'], true);
  }
  let reserved: TaskState | null;
  try {
    reserved = await statePort.loadTask(input.taskId);
  } catch {
    return response('INCOMPLETE', state, ['reserved-task-state-unavailable'], true);
  }
  if (
    !reserved ||
    !validateTaskState(reserved).ok ||
    reserved.taskId !== state.taskId ||
    reserved.stateVersion !== state.stateVersion ||
    reserved.node !== state.node ||
    reserved.replanCount !== state.replanCount
  ) {
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
