import type { BudgetTracker } from '../accounting.ts';
import type { DurableStore } from '../store.ts';
import type { BudgetJournalRecord, BudgetLedger } from '../contracts.ts';
import { UC04_SCHEMA_VERSION } from '../contracts.ts';

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

/** Accounting and recovery adapter connecting UC-03 repair workflows with UC-04 persistence. */
export class UC03AccountingAdapter {
  private readonly budgetTracker: BudgetTracker;
  readonly durableStore?: DurableStore | undefined;
  private replanCountsByTask = new Map<string, number>();
  private runIdsByTask = new Map<string, string>();
  private restoredTasks = new Set<string>();
  private totalReplans = 0;

  /** Initializes UC03AccountingAdapter with BudgetTracker and optional DurableStore. */
  constructor(budgetTracker: BudgetTracker, durableStore?: DurableStore) {
    this.budgetTracker = budgetTracker;
    this.durableStore = durableStore;
  }

  private parseTaskId(keyedId: string): string | null {
    const m = /^(?:inv|repair|replan)-(.+)-\d+-[a-z0-9]+$/.exec(keyedId);
    return m !== null && m[1] !== undefined ? m[1] : null;
  }

  private belongsToTask(keyedId: string, taskId: string): boolean {
    const parsed = this.parseTaskId(keyedId);
    return parsed !== null && parsed === taskId;
  }

  private async restore(taskId: string, callerCount: number): Promise<number> {
    if (this.durableStore && !this.restoredTasks.has(taskId)) {
      this.restoredTasks.add(taskId);
      const journal = await this.durableStore.loadBudgetJournal(taskId);
      if (journal) {
        this.budgetTracker.replaceLedgers(journal.ledgers);
        this.runIdsByTask.set(taskId, journal.runId);
        this.replanCountsByTask.set(taskId, journal.replanCount);
        this.totalReplans = Math.max(this.totalReplans, journal.replanCount);
      }
    }
    const count = Math.max(this.replanCountsByTask.get(taskId) ?? 0, callerCount);
    this.replanCountsByTask.set(taskId, count);
    return count;
  }

  private async commit(
    taskId: string,
    runId: string,
    replanCount: number,
    before: readonly BudgetLedger[]
  ): Promise<void> {
    if (!this.durableStore) return;
    this.runIdsByTask.set(taskId, runId);
    const record: BudgetJournalRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId,
      runId,
      ledgers: this.budgetTracker.getLedgers(),
      replanCount,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.durableStore.saveBudgetJournal(record);
    } catch (err) {
      this.budgetTracker.replaceLedgers(before);
      throw err;
    }
  }

  /** Reserves tokens and cost allowance for an investigation phase. */
  async reserveInvestigation(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    estimatedCost = 1
  ): Promise<UC03ReservationResult> {
    const requestId = `inv-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const replans = await this.restore(taskId, 0);
    const before = this.budgetTracker.getLedgers();
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: estimatedCost },
      ],
      { taskId, runId }
    );
    await this.commit(taskId, runId, replans, before);

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'investigation',
    };
  }

  /** Reserves tokens, cost, and a repair attempt allowance for a code repair attempt. */
  async reserveRepairAttempt(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    estimatedCost = 1
  ): Promise<UC03ReservationResult> {
    const requestId = `repair-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const replans = await this.restore(taskId, 0);
    const before = this.budgetTracker.getLedgers();
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: estimatedCost },
        { scope: 'task', kind: 'repair', amount: 1 },
      ],
      { taskId, runId }
    );
    await this.commit(taskId, runId, replans, before);

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'repair',
    };
  }

  /** Reserves a replan allowance, enforcing maximum 3 replans boundary. */
  async reserveReplan(
    taskId: string,
    runId: string,
    estimatedTokens: number,
    currentReplanCount: number
  ): Promise<UC03ReservationResult> {
    if (!Number.isSafeInteger(currentReplanCount) || currentReplanCount < 0) {
      throw new RangeError(
        `currentReplanCount must be a non-negative safe integer; received ${currentReplanCount}`
      );
    }
    const count = await this.restore(taskId, currentReplanCount);
    if (count >= 3) {
      throw new UC03ReplanExhaustionError('Replan limit reached: maximum 3 replans permitted');
    }

    const requestId = `replan-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const before = this.budgetTracker.getLedgers();
    this.budgetTracker.reserve(
      requestId,
      [
        { scope: 'task', kind: 'tokens', amount: estimatedTokens },
        { scope: 'task', kind: 'cost', amount: 1 },
      ],
      { taskId, runId }
    );
    await this.commit(taskId, runId, count + 1, before);
    this.replanCountsByTask.set(taskId, count + 1);
    this.totalReplans++;

    return {
      reservationId: requestId,
      taskId,
      runId,
      kind: 'replan',
    };
  }

  /** Settles an attempt against actual provider usage, falling back to reservation ceilings. */
  async settleAttempt(
    reservationId: string,
    observedUsage: { readonly tokens?: number; readonly cost?: number }
  ): Promise<UC03SettleResult> {
    const task = this.parseTaskId(reservationId);
    const replans = task === null ? this.totalReplans : await this.restore(task, 0);
    const before = this.budgetTracker.getLedgers();
    const reservedAmount = (kinds: readonly string[]): number | undefined => {
      for (const ledger of before) {
        if (!kinds.includes(ledger.kind)) continue;
        const match = ledger.reservations.find(
          (r) => r.keyedId === reservationId || r.reservationId === reservationId
        );
        if (match) return match.amount;
      }
      return undefined;
    };
    const reservedTokens = reservedAmount(['tokens', 'token']);
    const reservedCost = reservedAmount(['cost']);

    this.budgetTracker.settle(reservationId, {
      inputTokens: observedUsage.tokens ?? reservedTokens ?? 0,
      outputTokens: 0,
      billableTokens: observedUsage.tokens ?? reservedTokens ?? 0,
      costUsd: observedUsage.cost ?? reservedCost ?? 0,
    });
    if (task !== null) {
      await this.commit(task, this.runIdsByTask.get(task) ?? 'active-run', replans, before);
    }

    return {
      reservationId,
      consumedTokens: this.budgetTracker.getConsumed('task', 'tokens'),
      consumedCost: this.budgetTracker.getConsumed('task', 'cost'),
      consumedRepair: this.budgetTracker.getConsumed('task', 'repair'),
      consumedReplan: task === null ? this.totalReplans : replans,
    };
  }

  /** Handles interrupted or timed-out call by retaining allowance to prevent blind retry. */
  async handleInterruptedCall(taskId: string, runId: string, reservationId: string): Promise<void> {
    const replans = await this.restore(taskId, 0);
    const before = this.budgetTracker.getLedgers();
    let settled = false;
    for (const ledger of before) {
      const match = ledger.reservations.find(
        (r) =>
          (r.keyedId === reservationId || r.reservationId === reservationId) &&
          this.belongsToTask(r.keyedId, taskId)
      );
      if (match) {
        this.budgetTracker.settleReservation(match.reservationId, match.amount);
        settled = true;
      }
    }
    if (settled) await this.commit(taskId, runId, replans, before);
  }

  /** Reconciles all pending reservations for a given task owner. */
  async reconcileTaskBudgets(taskId: string, runId: string): Promise<{
    readonly taskId: string;
    readonly runId: string;
    readonly totalTokensConsumed: number;
    readonly totalCostConsumed: number;
    readonly totalRepairConsumed: number;
  }> {
    const replans = await this.restore(taskId, 0);
    const before = this.budgetTracker.getLedgers();
    let settled = false;
    for (const ledger of before) {
      for (const res of ledger.reservations) {
        if (this.belongsToTask(res.keyedId, taskId)) {
          this.budgetTracker.settleReservation(res.reservationId, res.amount);
          settled = true;
        }
      }
    }
    if (settled) await this.commit(taskId, runId, replans, before);

    return {
      taskId,
      runId,
      totalTokensConsumed: this.budgetTracker.getConsumed('task', 'tokens'),
      totalCostConsumed: this.budgetTracker.getConsumed('task', 'cost'),
      totalRepairConsumed: this.budgetTracker.getConsumed('task', 'repair'),
    };
  }
}
