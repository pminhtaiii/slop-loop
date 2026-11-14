/** Public UC-02 budget entry: validates host configuration and creates one task ledger. */
import type { QuestionValidationError } from '../contracts/questions/contracts.ts';
import { validateQuestionBudgetProfile } from '../contracts/questions/validation.ts';
import {
  createQuestionBudgetLedgerEngine,
  type CreateQuestionBudgetLedgerOptionsV1,
  type QuestionBudgetAccountingReceiptV1,
  type QuestionBudgetExecutionContextV1,
  type QuestionBudgetExecutionResultV1,
  type QuestionBudgetLedgerSnapshotV1,
  type QuestionBudgetOperationKindV1,
  type QuestionBudgetPricingV1,
  type QuestionBudgetRefusalCodeV1,
  type QuestionBudgetWorkV1,
} from './budget-ledger.ts';

export type {
  CreateQuestionBudgetLedgerOptionsV1,
  QuestionBudgetAccountingReceiptV1,
  QuestionBudgetCountersV1,
  QuestionBudgetExecutionContextV1,
  QuestionBudgetExecutionResultV1,
  QuestionBudgetLedgerSnapshotV1,
  QuestionBudgetOperationKindV1,
  QuestionBudgetPricingV1,
  QuestionBudgetRefusalCodeV1,
  QuestionBudgetWorkV1,
} from './budget-ledger.ts';

/** One finite pre-dispatch admission; execute is the only route that invokes an adapter. */
export interface QuestionBudgetReservation {
  readonly id: string;
  readonly kind: QuestionBudgetOperationKindV1;
  readonly maximumWork: Readonly<QuestionBudgetWorkV1>;
  readonly maximumBillableTokens: number;
  readonly maximumCostMicros: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  /** Releases the bound only while no adapter dispatch has started. */
  releaseBeforeDispatch(): QuestionBudgetExecutionResultV1<void>;
  /** Calls the adapter with its deadline and signal, then admits only a timely settled result. */
  execute<T>(
    operation: (context: QuestionBudgetExecutionContextV1) => Promise<T>,
    account: (value: T) => QuestionBudgetAccountingReceiptV1,
  ): Promise<QuestionBudgetExecutionResultV1<T>>;
  /** Apply later trusted accounting to an uncertain held reservation; late adapter results are never reconciled automatically. */
  reconcile(accounting: QuestionBudgetAccountingReceiptV1): QuestionBudgetExecutionResultV1<void>;
}

/** One cumulative task ledger; reuse it across follow-ups and never recreate it from a model decision. */
export interface QuestionBudgetLedger {
  snapshot(): QuestionBudgetLedgerSnapshotV1;
  reserveSnapshotAdmission(): QuestionBudgetReservationResultV1;
  reserveRepositoryOperation(kind: 'list' | 'search' | 'read'): QuestionBudgetReservationResultV1;
  reserveFinalValidation(): QuestionBudgetReservationResultV1;
  reserveModelCall(compiledInputTokens: number): QuestionBudgetReservationResultV1;
  reserveRetrievalQuery(): QuestionBudgetReservationResultV1;
  reserveIndexBatch(input: unknown): QuestionBudgetReservationResultV1;
  reserveSummary(projectedBytes: number): QuestionBudgetReservationResultV1;
  reserveClarification(): QuestionBudgetReservationResultV1;
  cancel(): void;
}

export type QuestionBudgetReservationResultV1 =
  | { readonly ok: true; readonly value: QuestionBudgetReservation }
  | { readonly ok: false; readonly reasonCode: QuestionBudgetRefusalCodeV1 };

export type QuestionBudgetLedgerCreationV1 =
  | { readonly ok: true; readonly value: QuestionBudgetLedger }
  | { readonly ok: false; readonly reasonCode: 'invalid-config'; readonly errors: readonly QuestionValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidConfig(path: string, code: QuestionValidationError['code'] = 'invalid-shape'): QuestionBudgetLedgerCreationV1 {
  return {
    ok: false,
    reasonCode: 'invalid-config',
    errors: Object.freeze([Object.freeze({ code, path })]),
  };
}

function validatePricing(input: unknown): QuestionBudgetPricingV1 | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'inputMicrosPerMillionTokens' || keys[1] !== 'outputMicrosPerMillionTokens') {
    return undefined;
  }
  const inputRate = input['inputMicrosPerMillionTokens'];
  const outputRate = input['outputMicrosPerMillionTokens'];
  if (!isNonNegativeSafeInteger(inputRate) || !isNonNegativeSafeInteger(outputRate)) return undefined;
  return Object.freeze({
    inputMicrosPerMillionTokens: inputRate,
    outputMicrosPerMillionTokens: outputRate,
  });
}

/** Validates every finite runtime, repository, and retrieval cap before creating the task ledger. */
export function createQuestionBudgetLedger(
  input: unknown,
  options: CreateQuestionBudgetLedgerOptionsV1,
): QuestionBudgetLedgerCreationV1 {
  const profile = validateQuestionBudgetProfile(input);
  if (!profile.ok) return { ok: false, reasonCode: 'invalid-config', errors: profile.errors };
  const pricing = validatePricing(options?.pricing);
  if (!pricing) return invalidConfig('pricing', 'invalid-limit');
  const now = options.now ?? (() => performance.now());
  const initialTime = now();
  if (!Number.isFinite(initialTime) || initialTime < 0) return invalidConfig('clock', 'invalid-limit');
  return {
    ok: true,
    value: createQuestionBudgetLedgerEngine(profile.value, pricing, now),
  };
}
