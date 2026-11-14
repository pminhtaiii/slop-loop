/** Pure budget counter, work-validation, and finite reservation-plan helpers. */
import type { QuestionBudgetProfileV1 } from '../contracts/questions/contracts.ts';
import type {
  QuestionBudgetOperationKindV1,
  QuestionBudgetPricingV1,
  QuestionBudgetRefusalCodeV1,
  QuestionBudgetWorkV1,
} from './budget.ts';

export interface BudgetCounters {
  elapsedMs: number;
  toolCalls: number;
  modelCalls: number;
  scannedFiles: number;
  scannedBytes: number;
  returnedBytes: number;
  billableTokens: number;
  costMicros: number;
  finalBytes: number;
  indexedFiles: number;
  indexedChunks: number;
  indexDiskBytes: number;
  scannedVectors: number;
  conversationBytes: number;
  clarificationRounds: number;
  snapshotAdmissions: number;
  retrievalQueries: number;
  summaryOperations: number;
}

export interface IndexBatchBoundsV1 {
  readonly batchSize: number;
  readonly cacheBytes: number;
  readonly chunks: number;
  readonly diskBytes: number;
  readonly files: number;
  readonly scannedBytes: number;
  readonly scannedFiles: number;
  readonly vectorDimensions: number;
  readonly workerMemoryBytes: number;
}

export interface BudgetReservationPlanV1 {
  readonly kind: QuestionBudgetOperationKindV1;
  readonly counters: BudgetCounters;
  readonly maximumWork: Readonly<QuestionBudgetWorkV1>;
  readonly maxOperationMs: number;
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
}

export type BudgetReservationPlanResultV1 =
  | { readonly ok: true; readonly plan: BudgetReservationPlanV1 }
  | { readonly ok: false; readonly reasonCode: QuestionBudgetRefusalCodeV1; readonly terminal: boolean };

export const WORK_KEYS = [
  'scannedFiles',
  'scannedBytes',
  'returnedBytes',
  'finalBytes',
  'indexedFiles',
  'indexedChunks',
  'indexDiskBytes',
  'scannedVectors',
  'conversationBytes',
  'clarificationRounds',
] as const satisfies readonly (keyof QuestionBudgetWorkV1)[];

export const COUNTER_KEYS = [
  'elapsedMs',
  'toolCalls',
  'modelCalls',
  'scannedFiles',
  'scannedBytes',
  'returnedBytes',
  'billableTokens',
  'costMicros',
  'finalBytes',
  'indexedFiles',
  'indexedChunks',
  'indexDiskBytes',
  'scannedVectors',
  'conversationBytes',
  'clarificationRounds',
  'snapshotAdmissions',
  'retrievalQueries',
  'summaryOperations',
] as const satisfies readonly (keyof BudgetCounters)[];

export function emptyCounters(): BudgetCounters {
  return {
    elapsedMs: 0,
    toolCalls: 0,
    modelCalls: 0,
    scannedFiles: 0,
    scannedBytes: 0,
    returnedBytes: 0,
    billableTokens: 0,
    costMicros: 0,
    finalBytes: 0,
    indexedFiles: 0,
    indexedChunks: 0,
    indexDiskBytes: 0,
    scannedVectors: 0,
    conversationBytes: 0,
    clarificationRounds: 0,
    snapshotAdmissions: 0,
    retrievalQueries: 0,
    summaryOperations: 0,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function hasExactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(input).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

export function freezeCounters(counters: BudgetCounters): Readonly<BudgetCounters> {
  return Object.freeze({ ...counters });
}

export function counterLimits(profile: QuestionBudgetProfileV1): BudgetCounters {
  return {
    elapsedMs: profile.runtime.maxElapsedMsTask,
    toolCalls: profile.runtime.maxToolCalls,
    modelCalls: profile.runtime.maxModelCalls,
    scannedFiles: profile.runtime.maxScannedFiles,
    scannedBytes: profile.runtime.maxScannedBytes,
    returnedBytes: profile.runtime.maxReturnedBytes,
    billableTokens: profile.runtime.maxBillableTokensTask,
    costMicros: profile.runtime.maxCostMicrosTask,
    finalBytes: profile.runtime.maxFinalBytes,
    indexedFiles: profile.retrieval.maxFiles,
    indexedChunks: profile.retrieval.maxChunks,
    indexDiskBytes: profile.retrieval.maxIndexDiskBytes,
    scannedVectors: profile.retrieval.maxExactScanVectors,
    conversationBytes: profile.runtime.maxConversationBytes,
    clarificationRounds: profile.runtime.maxClarificationRounds,
    snapshotAdmissions: profile.runtime.maxToolCalls,
    retrievalQueries: profile.runtime.maxToolCalls,
    summaryOperations: profile.runtime.maxToolCalls,
  };
}

export function normalizeWork(input: unknown): BudgetCounters | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.some(key => !(WORK_KEYS as readonly string[]).includes(key))) return undefined;
  const counters = emptyCounters();
  for (const key of WORK_KEYS) {
    const value = input[key];
    if (value === undefined) {
      if (Object.hasOwn(input, key)) return undefined;
      continue;
    }
    if (!isNonNegativeSafeInteger(value)) return undefined;
    counters[key] = value;
  }
  return counters;
}

export function addCounters(target: BudgetCounters, delta: BudgetCounters): boolean {
  for (const key of COUNTER_KEYS) {
    if (!Number.isSafeInteger(target[key] + delta[key])) return false;
  }
  for (const key of COUNTER_KEYS) target[key] += delta[key];
  return true;
}

export function subtractCounters(target: BudgetCounters, delta: BudgetCounters): void {
  for (const key of COUNTER_KEYS) target[key] -= delta[key];
}

export function fitsCounters(used: BudgetCounters, proposed: BudgetCounters, limits: BudgetCounters): boolean {
  return COUNTER_KEYS.every(key => used[key] + proposed[key] <= limits[key]);
}

export function remainingCounters(used: BudgetCounters, limits: BudgetCounters): BudgetCounters {
  const remaining = emptyCounters();
  for (const key of COUNTER_KEYS) remaining[key] = limits[key] - used[key];
  return remaining;
}

export function availableCounters(consumed: BudgetCounters, reserved: BudgetCounters, limits: BudgetCounters): BudgetCounters {
  const used = emptyCounters();
  for (const key of COUNTER_KEYS) used[key] = consumed[key] + reserved[key];
  return remainingCounters(used, limits);
}

/** Selects the stable refusal category for a reservation that exceeds one or more task caps. */
export function counterLimitReason(
  consumed: BudgetCounters,
  reserved: BudgetCounters,
  proposed: BudgetCounters,
  limits: BudgetCounters,
): QuestionBudgetRefusalCodeV1 {
  const fits = (key: keyof BudgetCounters): boolean => consumed[key] + reserved[key] + proposed[key] <= limits[key];
  if (proposed['toolCalls'] > 0 && !fits('toolCalls')) return 'tool-limit';
  if (proposed['modelCalls'] > 0 && !fits('modelCalls')) return 'model-limit';
  if ((proposed['scannedFiles'] > 0 && !fits('scannedFiles')) || (proposed['scannedBytes'] > 0 && !fits('scannedBytes'))) return 'scan-limit';
  if ((proposed['returnedBytes'] > 0 && !fits('returnedBytes')) || (proposed['finalBytes'] > 0 && !fits('finalBytes'))) return 'output-limit';
  if (proposed['billableTokens'] > 0 && !fits('billableTokens')) return 'token-limit';
  if (proposed['costMicros'] > 0 && !fits('costMicros')) return 'cost-limit';
  if (proposed['indexedFiles'] > 0 && !fits('indexedFiles')) return 'scan-limit';
  if (proposed['indexedChunks'] > 0 && !fits('indexedChunks')) return 'scan-limit';
  if (proposed['indexDiskBytes'] > 0 && !fits('indexDiskBytes')) return 'output-limit';
  if (proposed['scannedVectors'] > 0 && !fits('scannedVectors')) return 'scan-limit';
  if (proposed['conversationBytes'] > 0 && !fits('conversationBytes')) return 'output-limit';
  if (proposed['clarificationRounds'] > 0 && !fits('clarificationRounds')) return 'model-limit';
  if (proposed['snapshotAdmissions'] > 0 && !fits('snapshotAdmissions')) return 'scan-limit';
  if (proposed['retrievalQueries'] > 0 && !fits('retrievalQueries')) return 'scan-limit';
  if (proposed['summaryOperations'] > 0 && !fits('summaryOperations')) return 'output-limit';
  return 'scan-limit';
}

export function maxWork(counters: BudgetCounters): Readonly<QuestionBudgetWorkV1> {
  const value: QuestionBudgetWorkV1 = {};
  for (const key of WORK_KEYS) {
    if (counters[key] > 0) Object.assign(value, { [key]: counters[key] });
  }
  return Object.freeze(value);
}

export function workAsCounters(work: QuestionBudgetWorkV1): BudgetCounters {
  const counters = emptyCounters();
  for (const key of WORK_KEYS) {
    const value = work[key];
    if (value !== undefined) counters[key] = value;
  }
  return counters;
}

/** One integer micro-USD ceiling over the weighted input and output token total. */
export function costMicros(
  inputTokens: number,
  outputTokens: number,
  pricing: QuestionBudgetPricingV1,
): number | undefined {
  const million = 1_000_000n;
  const numerator =
    BigInt(inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(pricing.outputMicrosPerMillionTokens);
  const total = (numerator + million - 1n) / million;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : undefined;
}

function plan(
  kind: QuestionBudgetOperationKindV1,
  counters: BudgetCounters,
  maximumWork: QuestionBudgetWorkV1,
  maxOperationMs: number,
  modelBounds?: { readonly inputTokens: number; readonly outputTokens: number },
): BudgetReservationPlanResultV1 {
  return {
    ok: true,
    plan: {
      kind,
      counters,
      maximumWork: Object.freeze({ ...maximumWork }),
      maxOperationMs,
      ...(modelBounds === undefined
        ? {}
        : { maximumInputTokens: modelBounds.inputTokens, maximumOutputTokens: modelBounds.outputTokens }),
    },
  };
}

function denied(reasonCode: QuestionBudgetRefusalCodeV1, terminal = true): BudgetReservationPlanResultV1 {
  return { ok: false, reasonCode, terminal };
}

export function planSnapshotAdmission(profile: QuestionBudgetProfileV1): BudgetReservationPlanResultV1 {
  const counters = emptyCounters();
  const scannedFiles = Math.min(profile.runtime.maxScannedFiles, profile.retrieval.maxFiles);
  counters['scannedFiles'] = scannedFiles;
  counters['scannedBytes'] = profile.runtime.maxScannedBytes;
  counters['snapshotAdmissions'] = 1;
  return plan('snapshot-admission', counters, { scannedFiles, scannedBytes: counters['scannedBytes'] }, profile.retrieval.maxIndexDeadlineMs);
}

export function planRepositoryOperation(
  profile: QuestionBudgetProfileV1,
  available: BudgetCounters,
  kind: 'list' | 'search' | 'read',
): BudgetReservationPlanResultV1 {
  const counters = emptyCounters();
  counters['toolCalls'] = 1;
  const work: QuestionBudgetWorkV1 = {};

  if (kind === 'list') {
    const pageBytes = BigInt(profile.repository.maxPageEntries) * BigInt(profile.repository.maxPathBytes);
    const returnedBytes = Math.min(
      available['returnedBytes'],
      pageBytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(pageBytes),
    );
    if (returnedBytes <= 0) return denied('output-limit');
    counters['returnedBytes'] = returnedBytes;
    Object.assign(work, { returnedBytes });
    return plan('repository-list', counters, work, available['elapsedMs']);
  }

  if (kind === 'read') {
    const scannedFiles = Math.min(1, available['scannedFiles']);
    const scannedBytes = Math.min(profile.repository.maxFileBytes, available['scannedBytes']);
    const returnedBytes = Math.min(profile.repository.maxSpanBytes, available['returnedBytes']);
    if (scannedFiles <= 0 || scannedBytes <= 0) return denied('scan-limit');
    if (returnedBytes <= 0) return denied('output-limit');
    counters['scannedFiles'] = scannedFiles;
    counters['scannedBytes'] = scannedBytes;
    counters['returnedBytes'] = returnedBytes;
    Object.assign(work, { scannedFiles, scannedBytes, returnedBytes });
    return plan('repository-read', counters, work, available['elapsedMs']);
  }

  const scannedFiles = available['scannedFiles'];
  const scannedBytes = available['scannedBytes'];
  const outputPerHit = BigInt(profile.repository.maxSpanBytes) + BigInt(profile.repository.maxPathBytes);
  const maximumHitsBytes = outputPerHit * BigInt(profile.repository.maxSearchHits);
  const boundedHitBytes = maximumHitsBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(maximumHitsBytes);
  const returnedBytes = Math.min(available['returnedBytes'], boundedHitBytes);
  if (scannedFiles <= 0 || scannedBytes <= 0) return denied('scan-limit');
  if (returnedBytes <= 0) return denied('output-limit');
  counters['scannedFiles'] = scannedFiles;
  counters['scannedBytes'] = scannedBytes;
  counters['returnedBytes'] = returnedBytes;
  Object.assign(work, { scannedFiles, scannedBytes, returnedBytes });
  return plan('repository-search', counters, work, available['elapsedMs']);
}

export function planFinalValidation(profile: QuestionBudgetProfileV1, available: BudgetCounters): BudgetReservationPlanResultV1 {
  if (available['scannedFiles'] <= 0 || available['scannedBytes'] <= 0) return denied('scan-limit');
  const counters = emptyCounters();
  counters['toolCalls'] = 1;
  counters['finalBytes'] = profile.runtime.maxFinalBytes;
  return plan('final-validation', counters, { finalBytes: profile.runtime.maxFinalBytes }, available['elapsedMs']);
}

export function planSummary(
  available: BudgetCounters,
  projectedBytes: number,
): BudgetReservationPlanResultV1 {
  if (!isNonNegativeSafeInteger(projectedBytes) || projectedBytes === 0) return denied('invalid-work', false);
  if (projectedBytes > available['conversationBytes']) return denied('output-limit');
  const counters = emptyCounters();
  counters['conversationBytes'] = projectedBytes;
  counters['summaryOperations'] = 1;
  return plan('summary', counters, { conversationBytes: projectedBytes }, available['elapsedMs']);
}

export function planClarification(available: BudgetCounters): BudgetReservationPlanResultV1 {
  const counters = emptyCounters();
  counters['clarificationRounds'] = 1;
  return plan('clarification', counters, { clarificationRounds: 1 }, available['elapsedMs']);
}

export function planModelCall(
  profile: QuestionBudgetProfileV1,
  pricing: QuestionBudgetPricingV1,
  available: BudgetCounters,
  compiledInputTokens: number,
): BudgetReservationPlanResultV1 {
  if (!isNonNegativeSafeInteger(compiledInputTokens) || compiledInputTokens === 0) return denied('invalid-work', false);
  if (compiledInputTokens > profile.runtime.maxInputTokensPerCall) return denied('token-limit');
  const outputTokens = profile.runtime.maxOutputTokensPerCall;
  const totalTokens = BigInt(compiledInputTokens) + BigInt(outputTokens);
  if (totalTokens > BigInt(Number.MAX_SAFE_INTEGER)) return denied('token-limit');
  const reservedCost = costMicros(compiledInputTokens, outputTokens, pricing);
  if (reservedCost === undefined) return denied('cost-limit');
  const counters = emptyCounters();
  counters['modelCalls'] = 1;
  counters['billableTokens'] = Number(totalTokens);
  counters['costMicros'] = reservedCost;
  return plan('model-call', counters, {}, available['elapsedMs'], { inputTokens: compiledInputTokens, outputTokens });
}

export function planRetrievalQuery(profile: QuestionBudgetProfileV1, available: BudgetCounters): BudgetReservationPlanResultV1 {
  const scannedVectors = available['scannedVectors'];
  if (scannedVectors <= 0) return denied('scan-limit');
  const counters = emptyCounters();
  counters['scannedVectors'] = scannedVectors;
  counters['retrievalQueries'] = 1;
  return plan('retrieval-query', counters, { scannedVectors }, profile.retrieval.maxRetrievalDeadlineMs);
}

export function planIndexBatch(
  profile: QuestionBudgetProfileV1,
  input: unknown,
): BudgetReservationPlanResultV1 {
  if (!isRecord(input)) return denied('invalid-work', false);
  const expectedKeys = [
    'batchSize',
    'cacheBytes',
    'chunks',
    'diskBytes',
    'files',
    'scannedBytes',
    'scannedFiles',
    'vectorDimensions',
    'workerMemoryBytes',
  ];
  if (!hasExactKeys(input, expectedKeys)) return denied('invalid-work', false);
  const batchSize = input['batchSize'];
  const cacheBytes = input['cacheBytes'];
  const chunks = input['chunks'];
  const diskBytes = input['diskBytes'];
  const files = input['files'];
  const scannedBytes = input['scannedBytes'];
  const scannedFiles = input['scannedFiles'];
  const vectorDimensions = input['vectorDimensions'];
  const workerMemoryBytes = input['workerMemoryBytes'];
  if (
    !isNonNegativeSafeInteger(batchSize) || !isNonNegativeSafeInteger(cacheBytes) ||
    !isNonNegativeSafeInteger(chunks) || !isNonNegativeSafeInteger(diskBytes) ||
    !isNonNegativeSafeInteger(files) || !isNonNegativeSafeInteger(scannedBytes) ||
    !isNonNegativeSafeInteger(scannedFiles) || !isNonNegativeSafeInteger(vectorDimensions) ||
    !isNonNegativeSafeInteger(workerMemoryBytes)
  ) return denied('invalid-work', false);
  const bounds: IndexBatchBoundsV1 = {
    batchSize,
    cacheBytes,
    chunks,
    diskBytes,
    files,
    scannedBytes,
    scannedFiles,
    vectorDimensions,
    workerMemoryBytes,
  };
  if (
    bounds.batchSize === 0 || bounds.batchSize > profile.retrieval.maxBatchSize ||
    bounds.files === 0 || bounds.files > profile.retrieval.maxFiles ||
    bounds.chunks > profile.retrieval.maxChunks ||
    bounds.diskBytes > profile.retrieval.maxIndexDiskBytes ||
    bounds.workerMemoryBytes > profile.retrieval.maxWorkerMemoryBytes ||
    bounds.cacheBytes > profile.retrieval.maxSqliteCacheBytes ||
    bounds.vectorDimensions === 0 || bounds.vectorDimensions > profile.retrieval.maxVectorDimensions ||
    bounds.scannedFiles > bounds.files ||
    bounds.scannedBytes > profile.runtime.maxScannedBytes
  ) return denied('scan-limit');
  const counters = emptyCounters();
  counters['indexedFiles'] = bounds.files;
  counters['indexedChunks'] = bounds.chunks;
  counters['indexDiskBytes'] = bounds.diskBytes;
  counters['scannedFiles'] = bounds.scannedFiles;
  counters['scannedBytes'] = bounds.scannedBytes;
  return plan(
    'retrieval-index',
    counters,
    {
      indexedFiles: bounds.files,
      indexedChunks: bounds.chunks,
      indexDiskBytes: bounds.diskBytes,
      scannedFiles: bounds.scannedFiles,
      scannedBytes: bounds.scannedBytes,
    },
    profile.retrieval.maxIndexDeadlineMs,
  );
}
