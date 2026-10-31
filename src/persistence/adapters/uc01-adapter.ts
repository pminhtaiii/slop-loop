import { createHash } from 'node:crypto';
import type { BudgetTracker } from '../accounting.ts';
import type { DurableStore } from '../store.ts';
import type { BudgetLedger, BudgetReservationItem, TaskState } from '../contracts.ts';
import { UC04_SCHEMA_VERSION } from '../contracts.ts';
import { captureWorkspaceBaseline } from '../recovery.ts';

export interface UC01Ceiling {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUnits: number;
  readonly pricingId: string;
}

export interface UC01Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUnits: number;
  readonly state: 'settled' | 'uncertain';
  readonly reservationRef: string;
}

export interface UC01OperationContext {
  readonly taskId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly accountingRef: string;
  readonly deadlineEpochMs?: number;
}

export interface UC01ReserveResult {
  readonly ok: boolean;
  readonly reservationRef?: string;
  readonly accountingRef: string;
  readonly reasonCode?: string;
}

export interface UC01SettleResult {
  readonly kind: 'settled';
  readonly accountingRef: string;
  readonly consumedTokens: number;
  readonly consumedCost: number;
}

export interface UC01ReconciliationSummary {
  readonly taskId: string;
  readonly runId: string;
  readonly preservedConsumedTokens: number;
  readonly preservedConsumedCost: number;
  readonly uncertainReservationsRetained: number;
  readonly blindReplayPrevented: true;
}

/** Validates and digests step payload into a SHA-256 evidence reference. */
export function computeStepDigest(stepData: unknown): string {
  if (typeof stepData === 'string') {
    if (/^sha256:[0-9a-f]{64}$/i.test(stepData)) {
      return stepData;
    }
    return `sha256:${createHash('sha256').update(stepData).digest('hex')}`;
  }
  if (stepData === undefined) {
    throw new Error('Invalid stepData: stepData cannot be undefined');
  }
  let serialized: string;
  try {
    const s = JSON.stringify(stepData);
    if (s === undefined) {
      throw new Error('Invalid stepData: serialization produced undefined');
    }
    serialized = s;
  } catch (err) {
    throw new Error(`Invalid stepData: JSON serialization failed: ${(err as Error).message}`);
  }
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

/** Accounting and recovery adapter connecting UC-01 triage with UC-04 persistence. */
export class UC01AccountingAdapter {
  private readonly budgetTracker: BudgetTracker;
  private readonly durableStore?: DurableStore | undefined;
  private readonly repoRoot: string;
  private readonly restoredTasks = new Set<string>();
  private readonly runIdsByTask = new Map<string, string>();
  private readonly replansByTask = new Map<string, number>();
  private readonly ownersById = new Map<string, string>();

  /** Initializes UC01AccountingAdapter with BudgetTracker and optional DurableStore. */
  constructor(budgetTracker: BudgetTracker, durableStore?: DurableStore, repoRoot?: string) {
    this.budgetTracker = budgetTracker;
    this.durableStore = durableStore;
    this.repoRoot = repoRoot ?? process.cwd();
  }

  private async restore(taskId: string): Promise<void> {
    if (!this.durableStore || this.restoredTasks.has(taskId)) return;
    const journal = await this.durableStore.loadBudgetJournal(taskId);
    this.restoredTasks.add(taskId);
    if (journal) {
      this.budgetTracker.replaceLedgers(journal.ledgers);
      this.runIdsByTask.set(taskId, journal.runId);
      this.replansByTask.set(taskId, journal.replanCount);
      for (const ledger of journal.ledgers) {
        for (const res of ledger.reservations) {
          this.ownersById.set(res.keyedId, journal.taskId);
        }
      }
    }
  }

  private taskOf(reservation: BudgetReservationItem): string | undefined {
    return this.ownersById.get(reservation.keyedId);
  }

  private ownedLedgers(taskId: string): BudgetLedger[] {
    return this.budgetTracker.getLedgers().map((ledger) => ({
      ...ledger,
      reservations: ledger.reservations.filter((reservation) => this.taskOf(reservation) === taskId),
    }));
  }

  private async commit(taskId: string, runId: string, before: readonly BudgetLedger[]): Promise<void> {
    if (!this.durableStore) return;
    this.runIdsByTask.set(taskId, runId);
    try {
      await this.durableStore.saveBudgetJournal({
        schemaVersion: UC04_SCHEMA_VERSION,
        taskId,
        runId,
        ledgers: this.ownedLedgers(taskId),
        replanCount: this.replansByTask.get(taskId) ?? 0,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      this.budgetTracker.replaceLedgers(before);
      throw err;
    }
  }

  /** Reserves token and cost budget for a UC-01 triage operation. */
  async reserve(context: UC01OperationContext, ceiling: UC01Ceiling): Promise<UC01ReserveResult> {
    await this.restore(context.taskId);
    const availableTokens = this.budgetTracker.getAvailable('task', 'tokens');
    if (availableTokens < ceiling.totalTokens) {
      return {
        ok: false,
        accountingRef: context.accountingRef,
        reasonCode: 'call-budget-exhausted',
      };
    }

    const before = this.budgetTracker.getLedgers();
    try {
      this.budgetTracker.reserve(
        context.requestId,
        [
          { scope: 'task', kind: 'tokens', amount: ceiling.totalTokens },
          { scope: 'task', kind: 'cost', amount: ceiling.costUnits },
        ],
        { taskId: context.taskId, runId: context.runId }
      );
      this.ownersById.set(context.requestId, context.taskId);
    } catch {
      return {
        ok: false,
        accountingRef: context.accountingRef,
        reasonCode: 'reservation-failed',
      };
    }

    try {
      await this.commit(context.taskId, context.runId, before);
    } catch {
      this.ownersById.delete(context.requestId);
      return {
        ok: false,
        accountingRef: context.accountingRef,
        reasonCode: 'reservation-failed',
      };
    }

    return {
      ok: true,
      reservationRef: context.requestId,
      accountingRef: context.accountingRef,
    };
  }

  /** Settles actual token and cost usage against a reserved ceiling. */
  async settle(
    context: UC01OperationContext,
    reservationRef: string,
    observed: UC01Usage
  ): Promise<UC01SettleResult> {
    await this.restore(context.taskId);
    const before = this.budgetTracker.getLedgers();
    if (observed.state === 'uncertain') {
      for (const ledger of before) {
        const match = ledger.reservations.find(
          (r) => r.reservationId === reservationRef || r.keyedId === reservationRef
        );
        if (match) {
          const owner = this.taskOf(match);
          if (owner === context.taskId || (owner === undefined && reservationRef === context.requestId)) {
            this.budgetTracker.settleReservation(match.reservationId, match.amount);
          }
        }
      }
    } else {
      this.budgetTracker.settle(reservationRef, {
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        billableTokens: observed.inputTokens + observed.outputTokens,
        costUsd: observed.costUnits,
      });
    }
    await this.commit(context.taskId, context.runId, before);

    return {
      kind: 'settled',
      accountingRef: context.accountingRef,
      consumedTokens: this.budgetTracker.getConsumed('task', 'tokens'),
      consumedCost: this.budgetTracker.getConsumed('task', 'cost'),
    };
  }

  /** Reconciles unconfirmed call reservations without duplicate spend. */
  async reconcileAfterInterrupt(taskId: string, runId: string): Promise<UC01ReconciliationSummary> {
    await this.restore(taskId);
    const before = this.budgetTracker.getLedgers();
    let uncertainCount = 0;
    for (const ledger of before) {
      for (const res of ledger.reservations) {
        if (this.taskOf(res) !== taskId) continue;
        this.budgetTracker.settleReservation(res.reservationId, res.amount);
        uncertainCount++;
      }
    }
    await this.commit(taskId, runId, before);

    return {
      taskId,
      runId,
      preservedConsumedTokens: this.budgetTracker.getConsumed('task', 'tokens'),
      preservedConsumedCost: this.budgetTracker.getConsumed('task', 'cost'),
      uncertainReservationsRetained: uncertainCount,
      blindReplayPrevented: true,
    };
  }

  /** Persists task checkpoint with step progress and budget state. */
  async saveCheckpoint(
    taskId: string,
    stepName: 'intake' | 'clarify' | 'assess' | 'recommend',
    stepData?: unknown
  ): Promise<void> {
    if (!this.durableStore) return;

    const existing = await this.durableStore.loadTask(taskId);
    const nextVersion = (existing?.stateVersion ?? 0) + 1;
    const ledgers = this.ownedLedgers(taskId);

    const basePlan = existing?.plan ?? [
      { id: 'intake', title: 'Issue Intake', description: 'Intake', status: 'todo' as const },
      { id: 'clarify', title: 'Clarification', description: 'Clarify', status: 'todo' as const },
      { id: 'assess', title: 'Evidence Assessment', description: 'Assess', status: 'todo' as const },
      { id: 'recommend', title: 'Destination Recommendation', description: 'Recommend', status: 'todo' as const },
    ];

    const stepIndex = basePlan.findIndex((p) => p.id === stepName);
    const stepDigest = computeStepDigest(stepData);
    const updatedPlan = basePlan.map((p, idx) => {
      if (p.id === stepName) {
        return {
          ...p,
          status: 'done' as const,
          evidenceRefs: [stepDigest],
          completedAt: new Date().toISOString(),
        };
      }
      if (stepIndex >= 0 && idx === stepIndex + 1 && p.status === 'todo') {
        return {
          ...p,
          status: 'doing' as const,
          startedAt: new Date().toISOString(),
        };
      }
      return p;
    });

    const baseline = existing?.workspaceBaseline ?? (await captureWorkspaceBaseline(this.repoRoot));

    const nextState: TaskState = existing
      ? {
          ...existing,
          plan: updatedPlan,
          currentStepIndex: stepIndex >= 0 ? stepIndex : existing.currentStepIndex,
          nextAction: `Completed step ${stepName}`,
          stateVersion: nextVersion,
          budgetLedgers: ledgers,
        }
      : {
          schemaVersion: UC04_SCHEMA_VERSION,
          taskId,
          runId: `run-${Date.now()}`,
          repositoryId: 'repo-default',
          workspaceId: 'workspace-default',
          taskType: 'feature',
          goal: 'Issue Triage and Assessment',
          acceptanceCriteria: ['Classify issue', 'Assess evidence', 'Recommend destination'],
          constraints: ['Respect token limits', 'Preserve accounting on interrupt'],
          plan: updatedPlan,
          currentStepIndex: stepIndex >= 0 ? stepIndex : 0,
          changedFiles: [],
          openRisks: [],
          nextAction: `Completed step ${stepName}`,
          status: 'running',
          stateVersion: nextVersion,
          budgetLedgers: ledgers,
          workspaceBaseline: baseline,
        };

    await this.durableStore.saveCheckpoint(nextState);
  }
}
