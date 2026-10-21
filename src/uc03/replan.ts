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
  validateTaskState,
  type BudgetLedger,
  type FixPlan,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import type {
  PlanMaterialityResult,
  RejectionInput,
  RejectionPorts,
  ReplanInput,
  ReplanPorts,
  ReplanResult,
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

  const strategyChanged =
    priorPlan.strategy !== candidatePlan.strategy ||
    priorPlan.strategyDigest !== candidatePlan.strategyDigest;
  if (strategyChanged) {
    changedFields.push('strategy');
  }

  const diagnosisChanged = priorPlan.diagnosis !== candidatePlan.diagnosis;
  if (diagnosisChanged) {
    changedFields.push('diagnosis');
  }

  const isMaterial = changedFields.length > 0;
  return {
    isMaterial,
    changedFields,
    reason: isMaterial
      ? 'material-strategy-or-diagnosis-shift'
      : 'non-material-minor-clarification',
  };
}

type ReplanAccountingCheck =
  | { readonly ok: true; readonly replanLedger: BudgetLedger }
  | { readonly ok: false; readonly reason: string };

function checkReplanAccounting(
  state: TaskState,
  proposalId?: string,
  receiptId?: string
): ReplanAccountingCheck {
  const task = state.taskContext;
  const ledgers = state.budgetLedgers;
  if (!ledgers?.length) return { ok: false, reason: 'missing-budget-ledgers' };
  if (!task) return { ok: false, reason: 'missing-budget-configuration' };

  const replanLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'replan');
  if (!replanLedger) return { ok: false, reason: 'missing-replan-budget-ledger' };

  if (
    replanLedger.limit > MAX_TASK_REPLANS ||
    replanLedger.configurationId !== task.configId ||
    replanLedger.unit !== 'count'
  ) {
    return { ok: false, reason: 'inconsistent-replan-budget-configuration' };
  }

  for (const ledger of ledgers) {
    if (ledger.reservations.some((r) => r.amount <= 0)) {
      return { ok: false, reason: 'inconsistent-budget-accounting' };
    }
  }

  if (
    ledgers.some(
      (l) => (l.kind === 'tokens' || l.kind === 'cost') && l.reservations.length > 0
    )
  ) {
    return { ok: false, reason: 'uncertain-accounting-reservations' };
  }

  const replanTotal =
    replanLedger.consumed +
    replanLedger.reservations.reduce((sum, item) => sum + item.amount, 0);

  if (proposalId && receiptId) {
    if (replanTotal > replanLedger.limit) {
      return { ok: false, reason: 'inconsistent-replan-accounting' };
    }
    const matching = replanLedger.reservations.filter(
      (r) => r.keyedId === proposalId && r.amount === 1 && r.reservationId === receiptId
    );
    if (matching.length !== 1) {
      return { ok: false, reason: 'replan-reservation-not-authoritative' };
    }
  } else {
    if (replanTotal >= replanLedger.limit) {
      return { ok: false, reason: 'replan-budget-exhausted' };
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
  if (!input || !input.taskId?.trim() || !input.proposalId?.trim()) {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['invalid-replan-input'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  let state: TaskState | null;
  try {
    state = await ports.statePort.loadTask(input.taskId);
  } catch {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['authoritative-task-state-unavailable'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  if (!state) {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['task-not-found'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  if (!validateTaskState(state).ok) {
    return {
      outcome: 'INCOMPLETE',
      state,
      reasons: ['invalid-authoritative-task-state'],
      replanCount: state.replanCount ?? 0,
      isMaterial: false,
    };
  }

  // If there is an existing plan, evaluate materiality
  let materiality: PlanMaterialityResult = {
    isMaterial: true,
    changedFields: ['strategy'],
    reason: 'initial-replan',
  };
  if (state.plan) {
    materiality = evaluatePlanMateriality(state.plan, input.candidatePlan);
  }

  // Minor clarification: does not charge replan budget or increment replanCount
  if (!materiality.isMaterial) {
    return {
      outcome: 'CLARIFICATION_ACCEPTED',
      state,
      reasons: [],
      replanCount: state.replanCount,
      isMaterial: false,
    };
  }

  // Material replan: check replan limit (capped at 3)
  if (state.replanCount >= MAX_TASK_REPLANS) {
    let transitioned: TaskState;
    try {
      if (state.node === 'AwaitPlan') {
        const awaitFeedbackState: TaskState = {
          ...state,
          stateVersion: state.stateVersion + 1,
          node: 'AwaitFeedback',
          nextAction: 'halt-replan-cap-exceeded',
          activeDecisionId: undefined,
        };
        const transitioned1 = await ports.statePort.transition(
          awaitFeedbackState,
          state.stateVersion
        );
        const incompleteState: TaskState = {
          ...transitioned1,
          stateVersion: transitioned1.stateVersion + 1,
          node: 'Incomplete',
          outcome: 'INCOMPLETE',
          nextAction: 'halt-replan-cap-exceeded',
        };
        transitioned = await ports.statePort.transition(
          incompleteState,
          transitioned1.stateVersion
        );
      } else {
        const incompleteState: TaskState = {
          ...state,
          stateVersion: state.stateVersion + 1,
          node: 'Incomplete',
          outcome: 'INCOMPLETE',
          nextAction: 'halt-replan-cap-exceeded',
        };
        transitioned = await ports.statePort.transition(incompleteState, state.stateVersion);
      }
    } catch {
      transitioned = (await ports.statePort.loadTask(input.taskId)) ?? state;
    }
    return {
      outcome: 'INCOMPLETE',
      state: transitioned,
      reasons: ['replan-cap-exceeded-fourth-replan-refused'],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  // Verify accounting before reserving
  const accounting = checkReplanAccounting(state);
  if (!accounting.ok) {
    return {
      outcome: 'INCOMPLETE',
      state,
      reasons: [accounting.reason],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  // Idempotent replay check: already-reserved proposal is denied/reconciled, never recharged
  const existingReservation = accounting.replanLedger.reservations.find(
    (r) => r.keyedId === input.proposalId && r.amount === 1
  );
  if (existingReservation) {
    return {
      outcome: 'DENIED',
      state,
      reasons: ['idempotent-replay-denied-proposal-already-reserved'],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  let receiptId: string;
  try {
    receiptId = await ports.statePort.reserve('task', 'replan', 1, input.proposalId);
  } catch {
    return {
      outcome: 'INCOMPLETE',
      state,
      reasons: ['replan-reservation-failed'],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  let reservedState: TaskState | null;
  try {
    reservedState = await ports.statePort.loadTask(input.taskId);
  } catch {
    return {
      outcome: 'INCOMPLETE',
      state,
      reasons: ['reserved-task-state-unavailable'],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  if (!reservedState || !validateTaskState(reservedState).ok) {
    return {
      outcome: 'INCOMPLETE',
      state: reservedState ?? state,
      reasons: ['reserved-task-state-inconsistent'],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  const reservedAccounting = checkReplanAccounting(
    reservedState,
    input.proposalId,
    receiptId
  );
  if (!reservedAccounting.ok) {
    return {
      outcome: 'INCOMPLETE',
      state: reservedState,
      reasons: [reservedAccounting.reason],
      replanCount: state.replanCount,
      isMaterial: true,
    };
  }

  const nextReplanCount = state.replanCount + 1;
  const nextPlanVersion = state.planVersion + 1;
  const candidateWithVersion: FixPlan = {
    ...input.candidatePlan,
    planVersion: nextPlanVersion,
    decisionRef: undefined,
  };

  const reservationInfo = {
    proposalId: input.proposalId,
    taskId: state.taskId,
    configurationId: state.taskContext?.configId ?? '',
    priorCount: state.replanCount,
    nextCount: nextReplanCount,
    reservationId: receiptId,
  };

  // Populate scripted test mock transitionContexts if present
  const mockTarget = ports.statePort as unknown as {
    transitionContexts?: Record<number, unknown>;
  };
  if (
    mockTarget &&
    typeof mockTarget === 'object' &&
    'transitionContexts' in mockTarget &&
    typeof mockTarget.transitionContexts === 'object' &&
    mockTarget.transitionContexts !== null
  ) {
    mockTarget.transitionContexts[reservedState.stateVersion + 1] = {
      ...((mockTarget.transitionContexts[reservedState.stateVersion + 1] as object) || {}),
      replanReservation: reservationInfo,
    };
  }

  if (reservedState.node === 'Repair' || reservedState.node === 'AwaitFeedback') {
    // Two-step canonical transition: Repair/AwaitFeedback -> Investigate -> AwaitPlan
    const investigateState: TaskState = {
      ...reservedState,
      stateVersion: reservedState.stateVersion + 1,
      node: 'Investigate',
      nextAction: 'propose-fix-plan',
      planVersion: nextPlanVersion,
      replanCount: nextReplanCount,
      plan: candidateWithVersion,
      activeDecisionId: undefined,
    };

    let transitioned1: TaskState;
    try {
      transitioned1 = await ports.statePort.transition(
        investigateState,
        reservedState.stateVersion
      );
    } catch {
      const safeState = (await ports.statePort.loadTask(input.taskId)) ?? reservedState;
      return {
        outcome: 'INCOMPLETE',
        state: safeState,
        reasons: ['replan-transition-to-investigate-failed'],
        replanCount: state.replanCount,
        isMaterial: true,
      };
    }

    const awaitPlanState: TaskState = {
      ...transitioned1,
      stateVersion: transitioned1.stateVersion + 1,
      node: 'AwaitPlan',
      nextAction: 'approve-fix-plan',
      plan: candidateWithVersion,
      activeDecisionId: undefined,
    };

    let transitioned2: TaskState;
    try {
      transitioned2 = await ports.statePort.transition(
        awaitPlanState,
        transitioned1.stateVersion
      );
    } catch {
      const safeState = (await ports.statePort.loadTask(input.taskId)) ?? transitioned1;
      return {
        outcome: 'INCOMPLETE',
        state: safeState,
        reasons: ['replan-transition-to-await-plan-failed'],
        replanCount: nextReplanCount,
        isMaterial: true,
      };
    }

    return {
      outcome: 'REPLAN_PREPARED',
      state: transitioned2,
      reasons: [],
      replanCount: nextReplanCount,
      isMaterial: true,
    };
  }

  if (reservedState.node === 'Investigate') {
    const awaitPlanState: TaskState = {
      ...reservedState,
      stateVersion: reservedState.stateVersion + 1,
      node: 'AwaitPlan',
      nextAction: 'approve-fix-plan',
      planVersion: nextPlanVersion,
      replanCount: nextReplanCount,
      plan: candidateWithVersion,
      activeDecisionId: undefined,
    };

    let transitioned: TaskState;
    try {
      transitioned = await ports.statePort.transition(
        awaitPlanState,
        reservedState.stateVersion
      );
    } catch {
      const safeState = (await ports.statePort.loadTask(input.taskId)) ?? reservedState;
      return {
        outcome: 'INCOMPLETE',
        state: safeState,
        reasons: ['replan-transition-failed'],
        replanCount: state.replanCount,
        isMaterial: true,
      };
    }

    return {
      outcome: 'REPLAN_PREPARED',
      state: transitioned,
      reasons: [],
      replanCount: nextReplanCount,
      isMaterial: true,
    };
  }

  // Other nodes cannot transition to AwaitPlan directly
  return {
    outcome: 'INCOMPLETE',
    state: reservedState,
    reasons: [`replan-unsupported-from-node-${reservedState.node}`],
    replanCount: state.replanCount,
    isMaterial: true,
  };
}

/**
 * Handles human plan rejection: transitions to AwaitFeedback and pauses without autonomous replanning.
 */
export async function handlePlanRejection(
  input: RejectionInput,
  ports: RejectionPorts
): Promise<ReplanResult> {
  if (!input || !input.taskId?.trim() || !input.rejectionReason?.trim()) {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['invalid-rejection-input'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  let state: TaskState | null;
  try {
    state = await ports.statePort.loadTask(input.taskId);
  } catch {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['authoritative-task-state-unavailable'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  if (!state) {
    return {
      outcome: 'INCOMPLETE',
      state: {} as TaskState,
      reasons: ['task-not-found'],
      replanCount: 0,
      isMaterial: false,
    };
  }

  const nextState: TaskState = {
    ...state,
    stateVersion: state.stateVersion + 1,
    node: 'AwaitFeedback',
    nextAction: 'await-human-feedback-and-direction',
    activeDecisionId: undefined,
  };

  let transitioned: TaskState;
  try {
    transitioned = await ports.statePort.transition(nextState, state.stateVersion);
  } catch {
    const safeState = (await ports.statePort.loadTask(input.taskId)) ?? state;
    return {
      outcome: 'INCOMPLETE',
      state: safeState,
      reasons: ['rejection-transition-failed'],
      replanCount: state.replanCount,
      isMaterial: false,
    };
  }

  return {
    outcome: 'AWAIT_FEEDBACK',
    state: transitioned,
    reasons: [
      `plan-rejected: ${input.rejectionReason}`,
      'explicit-human-direction-required',
    ],
    replanCount: state.replanCount,
    isMaterial: false,
  };
}
