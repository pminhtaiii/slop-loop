import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQuestionBudgetLedger } from '../../../src/questions/budget.ts';

const validRuntime = {
  maxToolCalls: 5,
  maxModelCalls: 3,
  maxScannedFiles: 20,
  maxScannedBytes: 100_000,
  maxReturnedBytes: 20_000,
  maxInputTokensPerCall: 2_000,
  maxOutputTokensPerCall: 500,
  maxBillableTokensTask: 7_500,
  maxCostMicrosTask: 100_000,
  maxElapsedMsTask: 30_000,
  maxClarificationRounds: 2,
  maxConversationBytes: 10_000,
  maxFinalBytes: 4_000,
} as const;

const validRepository = {
  maxFileBytes: 20_000,
  maxSpanBytes: 4_000,
  maxSpanLines: 60,
  maxPageEntries: 100,
  maxSearchHits: 20,
  maxQueryBytes: 1_000,
  maxPathBytes: 500,
} as const;

const validRetrieval = {
  maxFiles: 7,
  maxChunks: 200,
  maxVectorDimensions: 16,
  maxBatchSize: 8,
  maxConcurrentIndexWriters: 1,
  maxConcurrentRetrievalWorkers: 1,
  maxIndexDiskBytes: 50_000,
  maxSqliteCacheBytes: 4_000,
  maxWorkerMemoryBytes: 100_000,
  maxExactScanVectors: 50,
  maxIndexDeadlineMs: 1_000,
  maxRetrievalDeadlineMs: 500,
} as const;

function validProfile(
  runtimeOverrides: Partial<Record<keyof typeof validRuntime, number>> = {},
  retrievalOverrides: Partial<Record<keyof typeof validRetrieval, number>> = {},
) {
  return {
    schemaVersion: 'question-budget/1',
    runtime: { ...validRuntime, ...runtimeOverrides },
    repository: validRepository,
    retrieval: { ...validRetrieval, ...retrievalOverrides },
  };
}

const pricing = {
  inputMicrosPerMillionTokens: 100_000,
  outputMicrosPerMillionTokens: 200_000,
} as const;

test('budget admission rejects missing retrieval limits before any operation can be reserved', () => {
  const result = createQuestionBudgetLedger(
    { schemaVersion: 'question-budget/1', runtime: validRuntime, repository: validRepository },
    { pricing, now: () => 0 },
  );

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('invalid budget profile was admitted');
  assert.equal(result.reasonCode, 'invalid-config');
  assert.deepEqual(result.errors.map(error => error.path), ['budgetProfile']);
});

test('snapshot admission reserves its finite file, byte, and deadline bounds before the adapter runs', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const reservation = created.value.reserveSnapshotAdmission();
  assert.ok(reservation.ok);
  assert.deepEqual(reservation.value.maximumWork, {
    scannedFiles: 7,
    scannedBytes: 100_000,
  });
  assert.equal(reservation.value.deadlineAt, 1_010);

  let ioCount = 0;
  const execution = await reservation.value.execute(
    async ({ signal }) => {
      assert.equal(signal.aborted, false);
      ioCount += 1;
      return { scannedFiles: 2, scannedBytes: 400 };
    },
    work => ({ kind: 'work', work }),
  );

  assert.ok(execution.ok);
  assert.equal(ioCount, 1);
  assert.equal(created.value.snapshot().consumed.scannedFiles, 2);
  assert.equal(created.value.snapshot().consumed.scannedBytes, 400);
  assert.equal(created.value.snapshot().reserved.scannedBytes, 0);
});

test('a known pre-dispatch refusal releases its reservation without charging a call', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const read = created.value.reserveRepositoryOperation('read');
  assert.ok(read.ok);
  assert.equal(created.value.snapshot().reserved.scannedBytes, validRepository.maxFileBytes);

  assert.deepEqual(read.value.releaseBeforeDispatch(), { ok: true, value: undefined });
  assert.equal(created.value.snapshot().reserved.scannedBytes, 0);
  assert.equal(created.value.snapshot().consumed.toolCalls, 0);
  let ioCount = 0;
  assert.deepEqual(await read.value.execute(
    async () => {
      ioCount += 1;
      return {};
    },
    work => ({ kind: 'work', work }),
  ), { ok: false, reasonCode: 'duplicate-settlement' });
  assert.equal(ioCount, 0);
});

test('an exact tool-call boundary denies final validation before its IO callback runs', async () => {
  const created = createQuestionBudgetLedger(validProfile({ maxToolCalls: 1 }), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const read = created.value.reserveRepositoryOperation('read');
  assert.ok(read.ok);
  const readResult = await read.value.execute(
    async () => ({ scannedFiles: 1, scannedBytes: 500, returnedBytes: 40 }),
    work => ({ kind: 'work', work }),
  );
  assert.ok(readResult.ok);
  assert.equal(created.value.snapshot().consumed.toolCalls, 1);

  let finalIoCount = 0;
  const final = created.value.reserveFinalValidation();
  if (final.ok) {
    await final.value.execute(
      async () => {
        finalIoCount += 1;
        return {};
      },
      work => ({ kind: 'work', work }),
    );
  } else assert.equal(final.reasonCode, 'tool-limit');

  assert.equal(finalIoCount, 0);
  assert.equal(created.value.snapshot().status, 'exhausted');
});

test('cancellation aborts the adapter signal and ignores a late result while retaining its hold', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const read = created.value.reserveRepositoryOperation('read');
  assert.ok(read.ok);
  let resolveLate: ((value: { scannedFiles: number; scannedBytes: number; returnedBytes: number }) => void) | undefined;
  let accountCalls = 0;
  const pending = read.value.execute(
    ({ signal }) => {
      assert.equal(signal.aborted, false);
      return new Promise(resolve => { resolveLate = resolve; });
    },
    work => {
      accountCalls += 1;
      return { kind: 'work', work };
    },
  );

  created.value.cancel();
  assert.equal(read.value.signal.aborted, true);
  assert.ok(resolveLate);
  resolveLate({ scannedFiles: 1, scannedBytes: 10, returnedBytes: 5 });
  const result = await pending;

  assert.deepEqual(result, { ok: false, reasonCode: 'cancelled' });
  assert.equal(accountCalls, 0);
  assert.equal(created.value.snapshot().status, 'cancelled');
  assert.equal(created.value.snapshot().reserved.scannedBytes, validRepository.maxFileBytes);
});

test('model reservations settle trusted usage once at exact integer micro-cost', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const call = created.value.reserveModelCall(100);
  assert.ok(call.ok);
  assert.equal(call.value.maximumBillableTokens, 600);
  assert.equal(call.value.maximumCostMicros, 110);

  let dispatches = 0;
  const response = {
    decision: { kind: 'insufficient', explanation: 'The inspected source does not establish this.' },
    usage: { status: 'complete', inputTokens: 80, outputTokens: 12 },
  } as const;
  const result = await call.value.execute(
    async () => {
      dispatches += 1;
      return response;
    },
    value => ({ kind: 'model-usage', usage: value.usage }),
  );

  assert.ok(result.ok);
  assert.equal(created.value.snapshot().consumed.modelCalls, 1);
  assert.equal(created.value.snapshot().consumed.billableTokens, 92);
  assert.equal(created.value.snapshot().consumed.costMicros, 11);
  assert.equal(created.value.snapshot().reserved.costMicros, 0);
  assert.deepEqual(await call.value.execute(async () => {
    dispatches += 1;
    return response;
  }, value => ({ kind: 'model-usage', usage: value.usage })), { ok: false, reasonCode: 'duplicate-settlement' });
  assert.equal(dispatches, 1);
});

test('unknown model usage holds the full reservation and blocks the next dispatch', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const call = created.value.reserveModelCall(100);
  assert.ok(call.ok);
  const result = await call.value.execute(
    async () => ({ usage: { status: 'unknown', reasonCode: 'timeout' } }),
    value => ({ kind: 'model-usage', usage: value.usage }),
  );

  assert.deepEqual(result, { ok: false, reasonCode: 'accounting-unknown' });
  assert.equal(created.value.snapshot().status, 'blocked');
  assert.equal(created.value.snapshot().reserved.modelCalls, 1);
  assert.equal(created.value.snapshot().reserved.billableTokens, 600);
  assert.equal(created.value.snapshot().reserved.costMicros, 110);
  assert.deepEqual(created.value.reserveModelCall(10), { ok: false, reasonCode: 'accounting-unknown' });

  const reconciled = call.value.reconcile({
    kind: 'model-usage',
    usage: { status: 'complete', inputTokens: 80, outputTokens: 12 },
  });
  assert.ok(reconciled.ok);
  assert.equal(created.value.snapshot().status, 'open');
  assert.equal(created.value.snapshot().reserved.billableTokens, 0);
  assert.equal(created.value.snapshot().consumed.billableTokens, 92);
  assert.deepEqual(call.value.reconcile({
    kind: 'model-usage',
    usage: { status: 'complete', inputTokens: 80, outputTokens: 12 },
  }), { ok: false, reasonCode: 'duplicate-settlement' });
});

test('usage beyond the reserved input bound is rejected and held without admitting a response', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const call = created.value.reserveModelCall(100);
  assert.ok(call.ok);
  const result = await call.value.execute(
    async () => ({ usage: { status: 'complete', inputTokens: 101, outputTokens: 1 } }),
    value => ({ kind: 'model-usage', usage: value.usage }),
  );

  assert.deepEqual(result, { ok: false, reasonCode: 'over-reservation' });
  assert.equal(created.value.snapshot().status, 'blocked');
  assert.equal(created.value.snapshot().reserved.billableTokens, 600);
});

test('retrieval queries and index batches settle against finite retrieval and task work limits', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);
  const query = created.value.reserveRetrievalQuery();
  assert.ok(query.ok);
  assert.equal(query.value.maximumWork.scannedVectors, validRetrieval.maxExactScanVectors);
  const queryResult = await query.value.execute(
    async () => ({ scannedVectors: 40 }),
    work => ({ kind: 'work', work }),
  );
  assert.ok(queryResult.ok);
  const nextQuery = created.value.reserveRetrievalQuery();
  assert.ok(nextQuery.ok);
  assert.equal(nextQuery.value.maximumWork.scannedVectors, 10);
  const nextQueryResult = await nextQuery.value.execute(
    async () => ({ scannedVectors: 10 }),
    work => ({ kind: 'work', work }),
  );
  assert.ok(nextQueryResult.ok);
  assert.deepEqual(created.value.reserveRetrievalQuery(), { ok: false, reasonCode: 'scan-limit' });

  const indexed = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(indexed.ok);
  const batch = indexed.value.reserveIndexBatch({
    files: 2,
    chunks: 20,
    diskBytes: 2_000,
    scannedFiles: 2,
    scannedBytes: 10_000,
    batchSize: 4,
    workerMemoryBytes: 50_000,
    cacheBytes: 1_000,
    vectorDimensions: 16,
  });
  assert.ok(batch.ok);
  const batchResult = await batch.value.execute(
    async () => ({ indexedFiles: 1, indexedChunks: 8, indexDiskBytes: 800, scannedFiles: 1, scannedBytes: 4_000 }),
    work => ({ kind: 'work', work }),
  );
  assert.ok(batchResult.ok);
  assert.equal(indexed.value.snapshot().consumed.indexedFiles, 1);
  assert.equal(indexed.value.snapshot().consumed.indexedChunks, 8);
  assert.equal(indexed.value.snapshot().consumed.indexDiskBytes, 800);
});

test('the same ledger carries tool charges across follow-up operations without a reset', async () => {
  const created = createQuestionBudgetLedger(validProfile({ maxToolCalls: 2 }), { pricing, now: () => 10 });
  assert.ok(created.ok);

  const firstRunRead = created.value.reserveRepositoryOperation('read');
  assert.ok(firstRunRead.ok);
  assert.ok((await firstRunRead.value.execute(
    async () => ({ scannedFiles: 1, scannedBytes: 300, returnedBytes: 20 }),
    work => ({ kind: 'work', work }),
  )).ok);

  const followUpList = created.value.reserveRepositoryOperation('list');
  assert.ok(followUpList.ok);
  assert.ok((await followUpList.value.execute(
    async () => ({ returnedBytes: 100 }),
    work => ({ kind: 'work', work }),
  )).ok);

  assert.equal(created.value.snapshot().consumed.toolCalls, 2);
  assert.deepEqual(created.value.reserveRepositoryOperation('read'), { ok: false, reasonCode: 'tool-limit' });
});

test('the exact elapsed deadline consumes time and rejects the response before accounting or later IO', async () => {
  let currentTime = 10;
  const created = createQuestionBudgetLedger(validProfile({ maxElapsedMsTask: 5 }), {
    pricing,
    now: () => currentTime,
  });
  assert.ok(created.ok);
  const read = created.value.reserveRepositoryOperation('read');
  assert.ok(read.ok);
  let accountingCalls = 0;
  const result = await read.value.execute(
    async () => {
      currentTime = 15;
      return { scannedFiles: 1, scannedBytes: 100, returnedBytes: 10 };
    },
    work => {
      accountingCalls += 1;
      return { kind: 'work', work };
    },
  );

  assert.deepEqual(result, { ok: false, reasonCode: 'elapsed-deadline' });
  assert.equal(accountingCalls, 0);
  assert.equal(created.value.snapshot().status, 'exhausted');
  assert.equal(created.value.snapshot().consumed.elapsedMs, 5);
  let finalIoCount = 0;
  const final = created.value.reserveFinalValidation();
  if (final.ok) {
    await final.value.execute(async () => {
      finalIoCount += 1;
      return {};
    }, work => ({ kind: 'work', work }));
  } else assert.equal(final.reasonCode, 'elapsed-deadline');
  assert.equal(finalIoCount, 0);
});

test('summary projection and clarification rounds consume their task-wide byte and round limits', async () => {
  const created = createQuestionBudgetLedger(validProfile(), { pricing, now: () => 10 });
  assert.ok(created.ok);

  const summary = created.value.reserveSummary(1_000);
  assert.ok(summary.ok);
  assert.deepEqual(summary.value.maximumWork, { conversationBytes: 1_000 });
  assert.ok((await summary.value.execute(
    async () => ({ conversationBytes: 800 }),
    work => ({ kind: 'work', work }),
  )).ok);
  assert.equal(created.value.snapshot().consumed.conversationBytes, 800);
  assert.equal(created.value.snapshot().consumed.summaryOperations, 1);

  const clarification = created.value.reserveClarification();
  assert.ok(clarification.ok);
  assert.ok((await clarification.value.execute(
    async () => ({ clarificationRounds: 1 }),
    work => ({ kind: 'work', work }),
  )).ok);
  assert.equal(created.value.snapshot().consumed.clarificationRounds, 1);
});
