/** Reservation execution, lifecycle, deadlines, and late-response fencing. */
import type {
  QuestionBudgetAccountingReceiptV1,
  QuestionBudgetExecutionContextV1,
  QuestionBudgetExecutionResultV1,
  QuestionBudgetOperationKindV1,
  QuestionBudgetRefusalCodeV1,
  QuestionBudgetReservation as QuestionBudgetReservationPortV1,
  QuestionBudgetWorkV1,
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
  _start(internal: InternalReservation): QuestionBudgetExecutionResultV1<void>;
  _releaseBeforeDispatch(internal: InternalReservation): QuestionBudgetExecutionResultV1<void>;
  _complete(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<void>;
  _hold(internal: InternalReservation, reasonCode: QuestionBudgetRefusalCodeV1): void;
  _ignoreLate(internal: InternalReservation): void;
  _checkResponse(internal: InternalReservation): QuestionBudgetRefusalCodeV1 | undefined;
  _reconcile(internal: InternalReservation, receipt: unknown): QuestionBudgetExecutionResultV1<void>;
}

/** The only reservation path that may invoke an adapter. */
export class BudgetReservationEngine implements QuestionBudgetReservationPortV1 {
  private readonly owner: ReservationLedgerPortV1;
  private readonly internal: InternalReservation;

  public constructor(owner: ReservationLedgerPortV1, internal: InternalReservation) {
    this.owner = owner;
    this.internal = internal;
  }

  public get id(): string { return this.internal.id; }
  public get kind(): QuestionBudgetOperationKindV1 { return this.internal.kind; }
  public get maximumWork(): Readonly<QuestionBudgetWorkV1> { return this.internal.maximumWork; }
  public get maximumBillableTokens(): number { return this.internal.reservedCounters['billableTokens']; }
  public get maximumCostMicros(): number { return this.internal.reservedCounters['costMicros']; }
  public get deadlineAt(): number { return this.internal.deadlineAt; }
  public get signal(): AbortSignal { return this.internal.controller.signal; }

  public releaseBeforeDispatch(): QuestionBudgetExecutionResultV1<void> {
    return this.owner._releaseBeforeDispatch(this.internal);
  }

  public reconcile(accounting: QuestionBudgetAccountingReceiptV1): QuestionBudgetExecutionResultV1<void> {
    return this.owner._reconcile(this.internal, accounting);
  }

  public async execute<T>(
    operation: (context: QuestionBudgetExecutionContextV1) => Promise<T>,
    account: (value: T) => QuestionBudgetAccountingReceiptV1,
  ): Promise<QuestionBudgetExecutionResultV1<T>> {
    const started = this.owner._start(this.internal);
    if (!started.ok) return started;
    let value: T;
    try {
      value = await operation({ signal: this.signal, deadlineAt: this.deadlineAt });
    } catch (error) {
      if (this.signal.aborted) {
        this.owner._ignoreLate(this.internal);
        const responseStatus = this.owner._checkResponse(this.internal);
        return { ok: false, reasonCode: responseStatus ?? 'cancelled' };
      }
      this.owner._hold(this.internal, 'accounting-unknown');
      throw error;
    }
    const responseStatus = this.owner._checkResponse(this.internal);
    if (responseStatus !== undefined) {
      this.owner._ignoreLate(this.internal);
      return { ok: false, reasonCode: responseStatus };
    }
    let receipt: QuestionBudgetAccountingReceiptV1;
    try {
      receipt = account(value);
    } catch (error) {
      this.owner._hold(this.internal, 'accounting-unknown');
      throw error;
    }
    const completion = this.owner._complete(this.internal, receipt);
    return completion.ok ? { ok: true, value } : completion;
  }
}
