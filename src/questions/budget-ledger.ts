/**
 * Owns the cumulative UC-02 task budget and its operation reservations. One
 * instance belongs to one task and must be retained across follow-up runs.
 */
import type { QuestionBudgetProfileV1 } from '../contracts/questions/contracts.ts';
import type { QuestionBudgetLedger as QuestionBudgetLedgerPortV1, QuestionBudgetReservationResultV1 } from './budget.ts';
import { settleBudgetReceipt } from './budget-ledger-settlement.ts';
import {
  addCounters,
  availableCounters,
  counterLimits,
  counterLimitReason,
  emptyCounters,
  fitsCounters,
  freezeCounters,
  maxWork,
  planClarification,
  planFinalValidation,
  planIndexBatch,
  planModelCall,
  planRepositoryOperation,
  planRetrievalQuery,
  planSnapshotAdmission,
  planSummary,
  remainingCounters,
  subtractCounters,
  type BudgetReservationPlanV1,
  type BudgetReservationPlanResultV1,
  type BudgetCounters,
} from './budget-ledger-counters.ts';
import { BudgetReservationEngine, type InternalReservation, type ReservationLedgerPortV1 } from './budget-ledger-reservations.ts';

/** Integer micro-USD rates per million billable tokens; each call rounds its weighted total up once. */
export interface QuestionBudgetPricingV1 {
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}

export interface CreateQuestionBudgetLedgerOptionsV1 {
  readonly pricing: unknown;
  readonly now?: () => number;
}

export interface QuestionBudgetCountersV1 {
  readonly elapsedMs: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly returnedBytes: number;
  readonly billableTokens: number;
  readonly costMicros: number;
  readonly finalBytes: number;
  readonly indexedFiles: number;
  readonly indexedChunks: number;
  readonly indexDiskBytes: number;
  readonly scannedVectors: number;
  readonly conversationBytes: number;
  readonly clarificationRounds: number;
  readonly snapshotAdmissions: number;
  readonly retrievalQueries: number;
  readonly summaryOperations: number;
}

export interface QuestionBudgetWorkV1 {
  readonly scannedFiles?: number;
  readonly scannedBytes?: number;
  readonly returnedBytes?: number;
  readonly finalBytes?: number;
  readonly indexedFiles?: number;
  readonly indexedChunks?: number;
  readonly indexDiskBytes?: number;
  readonly scannedVectors?: number;
  readonly conversationBytes?: number;
  readonly clarificationRounds?: number;
}

export interface QuestionBudgetLedgerSnapshotV1 {
  readonly status: 'open' | 'blocked' | 'cancelled' | 'exhausted';
  readonly consumed: QuestionBudgetCountersV1;
  readonly reserved: QuestionBudgetCountersV1;
  readonly remainingElapsedMs: number;
}

export type QuestionBudgetRefusalCodeV1 =
  | 'tool-limit'
  | 'model-limit'
  | 'scan-limit'
  | 'output-limit'
  | 'token-limit'
  | 'cost-limit'
  | 'elapsed-deadline'
  | 'cancelled'
  | 'accounting-unknown'
  | 'busy'
  | 'invalid-work'
  | 'over-reservation'
  | 'duplicate-settlement';

export type QuestionBudgetOperationKindV1 =
  'snapshot-admission' | 'repository-list' | 'repository-search' | 'repository-read' | 'retrieval-index' | 'retrieval-query' | 'model-call' | 'final-validation' | 'summary' | 'clarification';

export type QuestionBudgetAccountingReceiptV1 = { readonly kind: 'work'; readonly work: unknown } | { readonly kind: 'model-usage'; readonly usage: unknown };

export interface QuestionBudgetExecutionContextV1 {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  /** Remaining operation time in the ledger clock at dispatch. */
  readonly remainingMs: number;
}

export type QuestionBudgetExecutionResultV1<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasonCode: QuestionBudgetRefusalCodeV1 };

/** A task-scoped ledger. Create it once and reuse it for every run in that task. */
class BudgetLedgerEngine implements QuestionBudgetLedgerPortV1, ReservationLedgerPortV1 {
  private readonly profile: QuestionBudgetProfileV1;
  private readonly pricing: QuestionBudgetPricingV1;
  private readonly now: () => number;
  private readonly consumed = emptyCounters();
  private readonly reserved = emptyCounters();
  private status: QuestionBudgetLedgerSnapshotV1['status'] = 'open';
  private terminalReason: QuestionBudgetRefusalCodeV1 | undefined;
  private nextReservation = 1;
  private activeReservationId: string | undefined;
  private readonly reservations = new Map<string, InternalReservation>();

  /** @internal Instantiate through createQuestionBudgetLedger in the public entry module. */
  public constructor(profile: QuestionBudgetProfileV1, pricing: QuestionBudgetPricingV1, now: () => number) {
    this.profile = profile;
    this.pricing = pricing;
    this.now = now;
  }

  public snapshot(): QuestionBudgetLedgerSnapshotV1 {
    const active = this.activeReservationId === undefined ? undefined : this.reservations.get(this.activeReservationId);
    const now = this.now();
    const currentElapsed =
      active?.startedAt !== undefined && Number.isFinite(now) && now >= active.startedAt
        ? Math.min(Math.ceil(now - active.startedAt), Math.max(0, this.profile.runtime.maxElapsedMsTask - this.consumed['elapsedMs']))
        : 0;
    const visibleConsumed = { ...this.consumed, elapsedMs: this.consumed['elapsedMs'] + currentElapsed };
    const remainingElapsedMs = Math.max(0, this.profile.runtime.maxElapsedMsTask - visibleConsumed['elapsedMs']);
    return Object.freeze({
      status: this.status,
      consumed: freezeCounters(visibleConsumed),
      reserved: freezeCounters(this.reserved),
      remainingElapsedMs,
    });
  }

  public reserveSnapshotAdmission(): QuestionBudgetReservationResultV1 {
    return this.admit(planSnapshotAdmission(this.profile));
  }

  public reserveRepositoryOperation(kind: 'list' | 'search' | 'read'): QuestionBudgetReservationResultV1 {
    return this.admit(planRepositoryOperation(this.profile, this.available(), kind));
  }

  public reserveFinalValidation(): QuestionBudgetReservationResultV1 {
    return this.admit(planFinalValidation(this.profile, this.available()));
  }

  public reserveSummary(projectedBytes: number): QuestionBudgetReservationResultV1 {
    return this.admit(planSummary(this.available(), projectedBytes));
  }

  public reserveClarification(): QuestionBudgetReservationResultV1 {
    return this.admit(planClarification(this.available()));
  }

  public reserveModelCall(compiledInputTokens: number): QuestionBudgetReservationResultV1 {
    return this.admit(planModelCall(this.profile, this.pricing, this.available(), compiledInputTokens));
  }

  public reserveRetrievalQuery(): QuestionBudgetReservationResultV1 {
    return this.admit(planRetrievalQuery(this.profile, this.available()));
  }

  public reserveIndexBatch(input: unknown): QuestionBudgetReservationResultV1 {
    return this.admit(planIndexBatch(this.profile, input));
  }

  public cancel(): void {
    if (this.status !== 'open') return;
    this.status = 'cancelled';
    this.terminalReason = 'cancelled';
    for (const reservation of this.reservations.values()) {
      if (reservation.status === 'reserved' || reservation.status === 'running') {
        reservation.controller.abort('cancelled');
        if (reservation.status === 'running') this.hold(reservation, 'cancelled');
      }
    }
  }

  private reserve(
    kind: QuestionBudgetOperationKindV1,
    counters: BudgetCounters,
    maxOperationMs: number,
    work = maxWork(counters),
    modelBounds?: { readonly inputTokens: number; readonly outputTokens: number },
  ): QuestionBudgetReservationResultV1 {
    if (this.status !== 'open') return { ok: false, reasonCode: this.terminalReason ?? 'accounting-unknown' };
    if (this.activeReservationId !== undefined) return { ok: false, reasonCode: 'busy' };

    const now = this.now();
    if (!Number.isFinite(now) || now < 0) return this.exhaust('elapsed-deadline');
    const remainingMs = this.profile.runtime.maxElapsedMsTask - this.consumed['elapsedMs'];
    if (remainingMs <= 0) return this.exhaust('elapsed-deadline');
    const limits = counterLimits(this.profile);
    if (!fitsCounters(this.consumed, this.reserved, limits) || !fitsCounters(this.reserved, counters, remainingCounters(this.consumed, limits))) {
      return this.exhaust(counterLimitReason(this.consumed, this.reserved, counters, limits));
    }
    const timeoutMs = Math.min(remainingMs, maxOperationMs);
    const deadlineAt = now + timeoutMs;
    if (timeoutMs <= 0 || !Number.isFinite(deadlineAt) || deadlineAt <= now) return this.exhaust('elapsed-deadline');
    if (!addCounters(this.reserved, counters)) return this.exhaust('scan-limit');
    const internal: InternalReservation = {
      id: 'qb-' + this.nextReservation,
      kind,
      maximumWork: Object.freeze({ ...work }),
      reservedCounters: counters,
      deadlineAt,
      controller: new AbortController(),
      maximumInputTokens: modelBounds?.inputTokens,
      maximumOutputTokens: modelBounds?.outputTokens,
      status: 'reserved',
      holdReason: undefined,
      startedAt: undefined,
      timer: undefined,
    };
    this.nextReservation += 1;
    this.reservations.set(internal.id, internal);
    return { ok: true, value: new BudgetReservationEngine(this, internal) };
  }

  private available(): BudgetCounters {
    return availableCounters(this.consumed, this.reserved, counterLimits(this.profile));
  }

  private admit(result: BudgetReservationPlanResultV1): QuestionBudgetReservationResultV1 {
    if (!result.ok) return result.terminal ? this.exhaust(result.reasonCode) : { ok: false, reasonCode: result.reasonCode };
    const plan: BudgetReservationPlanV1 = result.plan;
    const modelBounds = plan.maximumInputTokens === undefined || plan.maximumOutputTokens === undefined ? undefined : { inputTokens: plan.maximumInputTokens, outputTokens: plan.maximumOutputTokens };
    return this.reserve(plan.kind, plan.counters, plan.maxOperationMs, plan.maximumWork, modelBounds);
  }

  private exhaust(reasonCode: QuestionBudgetRefusalCodeV1): QuestionBudgetReservationResultV1 {
    if (this.status !== 'open') return { ok: false, reasonCode: this.terminalReason ?? reasonCode };
    this.status = 'exhausted';
    this.terminalReason = reasonCode;
    return { ok: false, reasonCode };
  }

  private complete(internal: InternalReservation, receipt: unknown, reconciled = false): QuestionBudgetExecutionResultV1<undefined> {
    if (internal.status !== 'running') return { ok: false, reasonCode: 'duplicate-settlement' };
    if (internal.controller.signal.aborted || this.status !== 'open') {
      this.ignoreLate(internal);
      return { ok: false, reasonCode: this.terminalReason ?? 'cancelled' };
    }
    const settlement = settleBudgetReceipt(receipt, internal.kind, internal.maximumWork, internal.reservedCounters, internal.maximumInputTokens, internal.maximumOutputTokens, this.pricing);
    if (!settlement.ok) {
      this.hold(internal, 'accounting-unknown');
      return { ok: false, reasonCode: settlement.reasonCode };
    }
    const elapsedMs = reconciled ? 0 : this.elapsedFor(internal);
    if (elapsedMs === undefined) {
      this.hold(internal, 'elapsed-deadline');
      return { ok: false, reasonCode: 'elapsed-deadline' };
    }
    settlement.counters['elapsedMs'] = elapsedMs;
    if (internal.kind.startsWith('repository-') || internal.kind === 'final-validation') settlement.counters['toolCalls'] = 1;
    return this.settleCounters(internal, settlement.counters);
  }

  private settleCounters(internal: InternalReservation, actual: BudgetCounters): QuestionBudgetExecutionResultV1<undefined> {
    if (internal.kind === 'snapshot-admission') actual['snapshotAdmissions'] = 1;
    if (internal.kind === 'retrieval-query') actual['retrievalQueries'] = 1;
    if (internal.kind === 'summary') actual['summaryOperations'] = 1;
    if (!addCounters(this.consumed, actual)) {
      this.hold(internal, 'accounting-unknown');
      return { ok: false, reasonCode: 'accounting-unknown' };
    }
    subtractCounters(this.reserved, internal.reservedCounters);
    internal.status = 'settled';
    this.activeReservationId = undefined;
    this.clearTimer(internal);
    return { ok: true, value: undefined };
  }

  private elapsedFor(internal: InternalReservation): number | undefined {
    if (internal.startedAt === undefined) return undefined;
    const endedAt = this.now();
    if (!Number.isFinite(endedAt) || endedAt < internal.startedAt || endedAt >= internal.deadlineAt) return undefined;
    const elapsedMs = Math.ceil(endedAt - internal.startedAt);
    if (!Number.isSafeInteger(elapsedMs) || this.consumed['elapsedMs'] + elapsedMs > this.profile.runtime.maxElapsedMsTask) return undefined;
    return elapsedMs;
  }

  private elapsedAtHold(internal: InternalReservation): number | undefined {
    if (internal.startedAt === undefined) return undefined;
    const endedAt = this.now();
    if (!Number.isFinite(endedAt) || endedAt < internal.startedAt) return undefined;
    const elapsedMs = Math.ceil(endedAt - internal.startedAt);
    const remainingMs = this.profile.runtime.maxElapsedMsTask - this.consumed['elapsedMs'];
    if (!Number.isSafeInteger(elapsedMs) || remainingMs <= 0) return undefined;
    return Math.min(elapsedMs, remainingMs);
  }

  private hold(internal: InternalReservation, reasonCode: QuestionBudgetRefusalCodeV1): void {
    if (internal.status !== 'running' && internal.status !== 'reserved') return;
    if (internal.status === 'running') {
      const elapsedMs = this.elapsedAtHold(internal);
      if (elapsedMs !== undefined) this.consumed['elapsedMs'] += elapsedMs;
      this.activeReservationId = undefined;
    }
    internal.status = 'held';
    internal.holdReason = reasonCode;
    if (reasonCode === 'cancelled') {
      this.status = 'cancelled';
      this.terminalReason = 'cancelled';
    } else if (reasonCode === 'elapsed-deadline') {
      this.status = 'exhausted';
      this.terminalReason = 'elapsed-deadline';
    } else {
      this.status = 'blocked';
      this.terminalReason = 'accounting-unknown';
    }
    this.clearTimer(internal);
  }

  private ignoreLate(internal: InternalReservation): void {
    if (internal.status === 'running') this.hold(internal, this.terminalReason ?? 'cancelled');
  }

  private start(internal: InternalReservation): QuestionBudgetExecutionResultV1<number> {
    if (internal.status !== 'reserved') return { ok: false, reasonCode: 'duplicate-settlement' };
    if (this.status !== 'open') return { ok: false, reasonCode: this.terminalReason ?? 'accounting-unknown' };
    if (this.activeReservationId !== undefined) return { ok: false, reasonCode: 'busy' };
    const startedAt = this.now();
    if (!Number.isFinite(startedAt) || startedAt < 0 || startedAt >= internal.deadlineAt) {
      subtractCounters(this.reserved, internal.reservedCounters);
      internal.status = 'released';
      this.status = 'exhausted';
      this.terminalReason = 'elapsed-deadline';
      return { ok: false, reasonCode: 'elapsed-deadline' };
    }
    internal.status = 'running';
    internal.startedAt = startedAt;
    this.activeReservationId = internal.id;
    const remainingMs = this.scheduleTimer(internal);
    if (remainingMs === undefined) return { ok: false, reasonCode: 'elapsed-deadline' };
    return { ok: true, value: remainingMs };
  }

  private scheduleTimer(internal: InternalReservation): number | undefined {
    const now = this.now();
    const remainingMs = internal.deadlineAt - now;
    if (!Number.isFinite(now) || remainingMs <= 0) {
      internal.controller.abort('elapsed-deadline');
      this.hold(internal, 'elapsed-deadline');
      return undefined;
    }
    const maxTimerDelayMs = 2_147_483_647;
    const delay = Math.min(maxTimerDelayMs, Math.max(1, Math.ceil(remainingMs)));
    internal.timer = setTimeout(() => {
      if (internal.status !== 'running') return;
      const currentTime = this.now();
      if (Number.isFinite(currentTime) && currentTime < internal.deadlineAt) {
        this.scheduleTimer(internal);
        return;
      }
      internal.controller.abort('elapsed-deadline');
      this.hold(internal, 'elapsed-deadline');
    }, delay);
    return remainingMs;
  }

  private clearTimer(internal: InternalReservation): void {
    if (internal.timer !== undefined) clearTimeout(internal.timer);
    internal.timer = undefined;
  }

  public _start(internal: InternalReservation): QuestionBudgetExecutionResultV1<number> {
    return this.start(internal);
  }

  public _releaseBeforeDispatch(internal: InternalReservation): QuestionBudgetExecutionResultV1<void> {
    if (internal.status !== 'reserved') return { ok: false, reasonCode: 'duplicate-settlement' };
    if (this.status !== 'open') return { ok: false, reasonCode: this.terminalReason ?? 'accounting-unknown' };
    subtractCounters(this.reserved, internal.reservedCounters);
    internal.status = 'released';
    internal.controller.abort('released-before-dispatch');
    return { ok: true, value: undefined };
  }

  public _complete(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<undefined> {
    return this.complete(internal, receipt);
  }

  public _hold(internal: InternalReservation, reasonCode: QuestionBudgetRefusalCodeV1): void {
    this.hold(internal, reasonCode);
  }

  public _ignoreLate(internal: InternalReservation): void {
    this.ignoreLate(internal);
  }

  public _checkResponse(internal: InternalReservation): QuestionBudgetRefusalCodeV1 | undefined {
    if (internal.status !== 'running') return this.terminalReason ?? 'duplicate-settlement';
    if (internal.controller.signal.aborted || this.status !== 'open') return this.terminalReason ?? 'cancelled';
    const now = this.now();
    if (!Number.isFinite(now) || now < (internal.startedAt ?? now)) {
      this.hold(internal, 'accounting-unknown');
      return 'accounting-unknown';
    }
    if (now >= internal.deadlineAt) {
      internal.controller.abort('elapsed-deadline');
      this.hold(internal, 'elapsed-deadline');
      return 'elapsed-deadline';
    }
    return undefined;
  }

  public _reconcile(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<void> {
    if (internal.status !== 'held' || internal.holdReason !== 'accounting-unknown' || this.status !== 'blocked') {
      return { ok: false, reasonCode: 'duplicate-settlement' };
    }
    if (this.activeReservationId !== undefined || [...this.reservations.values()].some(reservation => reservation !== internal && reservation.status === 'held')) {
      return { ok: false, reasonCode: 'accounting-unknown' };
    }
    this.status = 'open';
    this.terminalReason = undefined;
    internal.status = 'running';
    const completion = this.complete(internal, receipt, true);
    return completion.ok ? { ok: true, value: undefined } : completion;
  }
}

/** Validates the full profile, including repository and retrieval limits, before a ledger exists. */
/** @internal Instantiates the ledger after the public entry point validates configuration. */
export function createQuestionBudgetLedgerEngine(profile: QuestionBudgetProfileV1, pricing: QuestionBudgetPricingV1, now: () => number): QuestionBudgetLedgerPortV1 {
  return new BudgetLedgerEngine(profile, pricing, now);
}
