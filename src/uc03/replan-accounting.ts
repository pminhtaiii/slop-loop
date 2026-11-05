/**
 * UC-03 replan budget accounting (T027).
 *
 * Split out of `replan.ts` so the material-replan entry stays under the repository's per-file size
 * bound. Pure: reads a `TaskState` and returns the replan ledger plus a refusal reason.
 */

import { validateBudgetLedger, type BudgetLedger, type TaskState } from '../contracts/foundation/uc03.ts';

export const MAX_TASK_REPLANS = 3;

export type ReplanAccountingCheck = { readonly ok: true; readonly replanLedger: BudgetLedger } | { readonly ok: false; readonly reason: string };

export function checkReplanAccounting(state: TaskState, proposalId?: string, receiptId?: string): ReplanAccountingCheck {
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
    const matches = ledgers.filter(ledger => ledger.scope === 'task' && ledger.kind === kind);
    if (matches.length !== 1) return { ok: false, reason: `missing-or-duplicate-${kind}-budget-ledger` };
    const ledger = matches[0];
    if (!ledger || !validateBudgetLedger(ledger).ok || !Number.isFinite(limit) || limit <= 0 || ledger.configurationId !== task.configId || ledger.limit !== limit || ledger.unit !== unit) {
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
  if (task.budgetLimits.maxReplanCount !== MAX_TASK_REPLANS || replanLedger.limit !== MAX_TASK_REPLANS || replanTotal !== expectedCount) {
    return { ok: false, reason: 'inconsistent-replan-accounting' };
  }
  if (checked[1]?.reservations.some(item => !state.evidenceRefs.includes('repair-action:' + item.keyedId))) {
    return { ok: false, reason: 'repair-effect-needs-trusted-reconciliation' };
  }
  if (checked.slice(2).some(ledger => ledger.reservations.length > 0)) return { ok: false, reason: 'uncertain-accounting-reservations' };
  if (checked.slice(1).some(ledger => ledger.consumed >= ledger.limit)) {
    return { ok: false, reason: 'task-budget-exhausted' };
  }

  if (proposalId || receiptId) {
    if (
      !proposalId ||
      !receiptId ||
      replanTotal !== state.replanCount + 1 ||
      replanLedger.reservations.filter(item => item.keyedId === proposalId && item.amount === 1 && item.reservationId === receiptId).length !== 1
    ) {
      return { ok: false, reason: 'replan-reservation-not-authoritative' };
    }
  }
  return { ok: true, replanLedger };
}
