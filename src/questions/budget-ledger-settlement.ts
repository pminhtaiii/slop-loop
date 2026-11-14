/** Validates trusted operation receipts and produces exact counter deltas. */
import type { QuestionUsageV1 } from '../contracts/questions/contracts.ts';
import { validateQuestionUsage } from '../contracts/questions/validation.ts';
import type {
  QuestionBudgetOperationKindV1,
  QuestionBudgetPricingV1,
  QuestionBudgetWorkV1,
} from './budget.ts';
import {
  costMicros,
  emptyCounters,
  hasExactKeys,
  isRecord,
  normalizeWork,
  WORK_KEYS,
  workAsCounters,
  type BudgetCounters,
} from './budget-ledger-counters.ts';

export type BudgetSettlementResultV1 =
  | { readonly ok: true; readonly counters: BudgetCounters }
  | { readonly ok: false; readonly reasonCode: 'accounting-unknown' | 'over-reservation' };

/** Checks receipt shape, trusted model usage, and every reported count against the admitted worst case. */
export function settleBudgetReceipt(
  receiptInput: unknown,
  kind: QuestionBudgetOperationKindV1,
  maximumWork: Readonly<QuestionBudgetWorkV1>,
  reservedCounters: BudgetCounters,
  maximumInputTokens: number | undefined,
  maximumOutputTokens: number | undefined,
  pricing: QuestionBudgetPricingV1,
): BudgetSettlementResultV1 {
  if (!isRecord(receiptInput)) return { ok: false, reasonCode: 'accounting-unknown' };

  if (kind === 'model-call' && receiptInput['kind'] === 'model-usage' && hasExactKeys(receiptInput, ['kind', 'usage'])) {
    const checkedUsage = validateQuestionUsage(receiptInput['usage']);
    if (!checkedUsage.ok || checkedUsage.value.status !== 'complete') {
      return { ok: false, reasonCode: 'accounting-unknown' };
    }
    const usage: QuestionUsageV1 & { readonly status: 'complete' } = checkedUsage.value;
    const totalTokens = usage.inputTokens + usage.outputTokens;
    if (
      usage.inputTokens > (maximumInputTokens ?? -1) ||
      usage.outputTokens > (maximumOutputTokens ?? -1) ||
      totalTokens > reservedCounters['billableTokens']
    ) return { ok: false, reasonCode: 'over-reservation' };
    const actualCost = costMicros(usage.inputTokens, usage.outputTokens, pricing);
    if (actualCost === undefined || actualCost > reservedCounters['costMicros']) {
      return { ok: false, reasonCode: 'over-reservation' };
    }
    const counters = emptyCounters();
    counters['modelCalls'] = 1;
    counters['billableTokens'] = totalTokens;
    counters['costMicros'] = actualCost;
    return { ok: true, counters };
  }

  if (receiptInput['kind'] !== 'work' || !hasExactKeys(receiptInput, ['kind', 'work']) || kind === 'model-call') {
    return { ok: false, reasonCode: 'accounting-unknown' };
  }
  const actual = normalizeWork(receiptInput['work']);
  if (!actual) return { ok: false, reasonCode: 'accounting-unknown' };
  const maximum = workAsCounters(maximumWork);
  for (const key of WORK_KEYS) {
    if (actual[key] > maximum[key]) return { ok: false, reasonCode: 'over-reservation' };
  }
  return { ok: true, counters: actual };
}
