import type { BudgetLedger, BudgetReservationItem, TaskState } from './contracts.ts';

export function attemptStepId(state: TaskState): string {
  const step =
    state.plan.find((s) => s.status === 'doing') ?? state.plan.find((s) => s.status !== 'done') ?? state.plan[0];
  return step?.id ?? 'unknown-step';
}

export function suspendedState(state: TaskState, ledgers: readonly BudgetLedger[], reason: string): TaskState {
  return {
    ...state,
    budgetLedgers: [...ledgers],
    status: 'paused',
    stateVersion: state.stateVersion + 1,
    nextAction: reason,
  };
}

export function mergeLedgers(journal: readonly BudgetLedger[], checkpoint: readonly BudgetLedger[]): BudgetLedger[] {
  const merged = new Map<string, BudgetLedger>();
  for (const ledger of [...checkpoint, ...journal]) {
    const key = `${ledger.scope}:${ledger.kind}`;
    const prior = merged.get(key);
    if (!prior || ledger.version >= prior.version) {
      merged.set(key, { ...ledger, reservations: [...ledger.reservations] });
    }
  }
  return [...merged.values()];
}

export function ledgerDigest(ledgers: readonly BudgetLedger[]): string {
  const key = (l: BudgetLedger): string => `${l.scope}:${l.kind}`;
  return JSON.stringify(
    [...ledgers]
      .sort((a, b) => key(a).localeCompare(key(b)))
      .map((l) => ({
        ...l,
        reservations: [...l.reservations].sort((a, b) => a.reservationId.localeCompare(b.reservationId)),
      }))
  );
}

export function findOutcome<T extends { readonly requestId: string }>(
  reservation: BudgetReservationItem,
  outcomeByRequest: ReadonlyMap<string, T>
): T | undefined {
  for (const requestId of [reservation.keyedId, reservation.reservationId]) {
    const outcome = outcomeByRequest.get(requestId);
    if (outcome) return outcome;
  }
  return undefined;
}
