import type { BudgetTracker } from '../accounting.ts';
import type { DurableStore } from '../store.ts';

export interface UC03ReservationResult {
  readonly reservationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly kind: 'investigation' | 'repair' | 'replan';
}

export interface UC03SettleResult {
  readonly reservationId: string;
  readonly consumedTokens: number;
  readonly consumedCost: number;
  readonly consumedRepair: number;
  readonly consumedReplan: number;
}

export class UC03ReplanExhaustionError extends Error {
  constructor(message = 'Replan limit of 3 exceeded') {
    super(message);
    this.name = 'UC03ReplanExhaustionError';
  }
}

export class UC03AccountingAdapter {
  private readonly budgetTracker: BudgetTracker;
  readonly durableStore?: DurableStore | undefined;

  constructor(budgetTracker: BudgetTracker, durableStore?: DurableStore) {
    this.budgetTracker = budgetTracker;
    this.durableStore = durableStore;
  }

  async reserveInvestigation(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    estimatedCost = 1
  ): Promise<UC03ReservationResult> {
    const requestId = `inv-${taskId}-${Date.now()}`;
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: estimatedCost },
      ],
      { taskId, runId }
    );

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'investigation',
    };
  }

  async reserveRepairAttempt(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    estimatedCost = 1
  ): Promise<UC03ReservationResult> {
    const requestId = `repair-${taskId}-${Date.now()}`;
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: estimatedCost },
        { scope: 'task', kind: 'repair', amount: 1 },
      ],
      { taskId, runId }
    );

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'repair',
    };
  }

  async reserveReplan(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    currentReplanCount: number
  ): Promise<UC03ReservationResult> {
    if (currentReplanCount >= 3) {
      throw new UC03ReplanExhaustionError(
        `Cannot reserve replan: task ${taskId} has already reached the maximum 3 replans`
      );
    }

    const requestId = `replan-${taskId}-${Date.now()}`;
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: 1 },
      ],
      { taskId, runId }
    );

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'replan',
    };
  }

  async settleAttempt(
    reservationId: string,
    observedUsage: { readonly tokens?: number; readonly cost?: number }
  ): Promise<UC03SettleResult> {
    this.budgetTracker.settle(reservationId, {
      inputTokens: observedUsage.tokens ?? 0,
      outputTokens: 0,
      billableTokens: observedUsage.tokens ?? 0,
      costUsd: observedUsage.cost ?? 0,
    });

    return {
      reservationId,
      consumedTokens: this.budgetTracker.getConsumed('task', 'tokens'),
      consumedCost: this.budgetTracker.getConsumed('task', 'cost'),
      consumedRepair: this.budgetTracker.getConsumed('task', 'repair'),
      consumedReplan: this.budgetTracker.getConsumed('task', 'reviewer'),
    };
  }

  handleInterruptedCall(_taskId: string, _runId: string, reservationId: string): void {
    for (const ledger of this.budgetTracker.getLedgers()) {
      const match = ledger.reservations.find((r) => r.keyedId === reservationId);
      if (match) {
        this.budgetTracker.settleReservation(match.reservationId, match.amount);
      }
    }
  }

  reconcileTaskBudgets(taskId: string, runId: string): {
    readonly taskId: string;
    readonly runId: string;
    readonly totalTokensConsumed: number;
    readonly totalCostConsumed: number;
    readonly totalRepairConsumed: number;
  } {
    for (const ledger of this.budgetTracker.getLedgers()) {
      for (const res of ledger.reservations) {
        this.budgetTracker.settleReservation(res.reservationId, res.amount);
      }
    }

    return {
      taskId,
      runId,
      totalTokensConsumed: this.budgetTracker.getConsumed('task', 'tokens'),
      totalCostConsumed: this.budgetTracker.getConsumed('task', 'cost'),
      totalRepairConsumed: this.budgetTracker.getConsumed('task', 'repair'),
    };
  }
}
