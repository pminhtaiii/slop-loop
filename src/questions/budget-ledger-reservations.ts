/** Reservation execution, lifecycle, deadlines, and late-response fencing. */
import type {
  QuestionBudgetAccountingReceiptV1,
  QuestionBudgetExecutionContextV1,
  QuestionBudgetExecutionResultV1,
  QuestionBudgetOperationKindV1,
  QuestionBudgetRefusalCodeV1,
  QuestionBudgetReservation as QuestionBudgetReservationPortV1,
  QuestionBudgetWorkV1,
  QuestionBudgetReservationResultV1,
} from './budget.ts';
import type { BudgetCounters } from './budget-ledger-counters.ts';

export interface InternalReservation {
  readonly id: string;
  readonly kind: QuestionBudgetOperationKindV1;
  readonly maximumWork: Readonly<QuestionBudgetWorkV1>;
  readonly reservedCounters: BudgetCounters;
  readonly deadlineAt: number;
  readonly controller: AbortController;
  readonly maximumInputTokens: number | undefined;
  readonly maximumOutputTokens: number | undefined;
  status: 'reserved' | 'running' | 'settled' | 'held' | 'released';
  holdReason: QuestionBudgetRefusalCodeV1 | undefined;
  startedAt: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ReservationLedgerPortV1 {
  _hasTime(internal: InternalReservation): boolean;
  _start(internal: InternalReservation): QuestionBudgetExecutionResultV1<number>;
  _releaseBeforeDispatch(internal: InternalReservation): QuestionBudgetExecutionResultV1<void>;
  _complete(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<void>;
  _hold(internal: InternalReservation, reasonCode: QuestionBudgetRefusalCodeV1): void;
  _ignoreLate(internal: InternalReservation): void;
  _checkResponse(internal: InternalReservation): QuestionBudgetRefusalCodeV1 | undefined;
  _reconcile(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<void>;
}

/** Uses ordinary work settlement for compiler time, with no provider token or cost receipt. */
export async function executeModelCompilation<T>(admission: QuestionBudgetReservationResultV1, compile: (control: QuestionBudgetExecutionContextV1) => T): Promise<QuestionBudgetExecutionResultV1<T>> {
  if (!admission.ok) return admission;
  const errors: unknown[] = [];
  const result = await admission.value.execute(
    async control => {
      try {
        return { ok: true, value: compile(control) } as const;
      } catch (error) {
        errors.push(error);
        return { ok: false } as const;
      }
    },
    () => ({ kind: 'work', work: {} }),
  );
  if (errors.length > 0) throw errors[0];
  if (!result.ok) return result;
  return result.value.ok ? { ok: true, value: result.value.value } : { ok: false, reasonCode: 'accounting-unknown' };
}

/** Measures the trusted ledger clock for settled work and capped terminal accounting. */
export function reservationElapsed(internal: InternalReservation, now: number, remaining: number, allowExpired = false): number | undefined {
  if (internal.startedAt === undefined || !Number.isFinite(now) || now < internal.startedAt || (!allowExpired && now >= internal.deadlineAt)) return undefined;
  const elapsed = Math.ceil(now - internal.startedAt);
  if (!Number.isSafeInteger(elapsed) || remaining <= 0 || (!allowExpired && elapsed > remaining)) return undefined;
  return Math.min(elapsed, remaining);
}

/** The only reservation path that may invoke an adapter. */
export class BudgetReservationEngine implements QuestionBudgetReservationPortV1 {
  private readonly owner: ReservationLedgerPortV1;
  private readonly internal: InternalReservation;

  public constructor(owner: ReservationLedgerPortV1, internal: InternalReservation) {
    this.owner = owner;
    this.internal = internal;
  }

  public get id(): string {
    return this.internal.id;
  }
  public get kind(): QuestionBudgetOperationKindV1 {
    return this.internal.kind;
  }
  public get maximumWork(): Readonly<QuestionBudgetWorkV1> {
    return this.internal.maximumWork;
  }
  public get maximumBillableTokens(): number {
    return this.internal.reservedCounters['billableTokens'];
  }
  public get maximumCostMicros(): number {
    return this.internal.reservedCounters['costMicros'];
  }
  public get deadlineAt(): number {
    return this.internal.deadlineAt;
  }
  public get signal(): AbortSignal {
    return this.internal.controller.signal;
  }

  public releaseBeforeDispatch(): QuestionBudgetExecutionResultV1<void> {
    return this.owner._releaseBeforeDispatch(this.internal);
  }

  public reconcile(accounting: QuestionBudgetAccountingReceiptV1): QuestionBudgetExecutionResultV1<void> {
    if (accounting?.kind === 'model-not-dispatched') return { ok: false, reasonCode: 'accounting-unknown' };
    return this.owner._reconcile(this.internal, accounting);
  }

  public async execute<T>(
    operation: (context: QuestionBudgetExecutionContextV1) => Promise<T>,
    account: (value: T) => QuestionBudgetAccountingReceiptV1,
    noDispatchResult?: object,
  ): Promise<QuestionBudgetExecutionResultV1<T>> {
    const started = this.owner._start(this.internal);
    if (!started.ok) return started;
    const aborted = Symbol('reservation-aborted');
    const cancellation = Promise.withResolvers<typeof aborted>();
    const onAbort = () => cancellation.resolve(aborted);
    this.signal.addEventListener('abort', onAbort, { once: true });
    let value: T | typeof aborted;
    try {
      value = await Promise.race([
        cancellation.promise,
        operation({ signal: this.signal, deadlineAt: this.deadlineAt, remainingMs: started.value, hasTime: () => this.owner._hasTime(this.internal) }),
      ]);
    } catch (error) {
      if (this.signal.aborted) {
        this.owner._ignoreLate(this.internal);
        const responseStatus = this.owner._checkResponse(this.internal);
        return { ok: false, reasonCode: responseStatus ?? 'cancelled' };
      }
      this.owner._hold(this.internal, 'accounting-unknown');
      throw error;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
    // Only the host's private invocation object can precede late-provider fencing. Never inspect provider fields here.
    const undispatched = this.kind === 'model-call' && typeof noDispatchResult === 'object' && noDispatchResult !== null && value === noDispatchResult;
    const responseStatus = undispatched ? undefined : this.owner._checkResponse(this.internal);
    if (value === aborted || responseStatus !== undefined) {
      this.owner._ignoreLate(this.internal);
      return { ok: false, reasonCode: responseStatus ?? 'cancelled' };
    }
    let receipt: QuestionBudgetAccountingReceiptV1;
    try {
      receipt = account(value);
    } catch (error) {
      this.owner._hold(this.internal, 'accounting-unknown');
      throw error;
    }
    if ((receipt?.kind === 'model-not-dispatched') !== undispatched) {
      this.owner._hold(this.internal, 'accounting-unknown');
      return { ok: false, reasonCode: 'accounting-unknown' };
    }
    const completion = this.owner._complete(this.internal, receipt);
    return completion.ok ? { ok: true, value } : completion;
  }
}
