import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSession } from '../../../src/questions/session.ts';
import type { QuestionSessionRunRequest } from '../../../src/questions/session-types.ts';
import type { QuestionBudgetReservation } from '../../../src/questions/budget.ts';

const digest = 'sha256:' + 'a'.repeat(64);
const binding = { repositoryId: 'repo', workspaceId: 'workspace', revisionDigest: digest, policyDigest: digest };
const profile = {
  schemaVersion: 'question-budget/1',
  runtime: {
    maxToolCalls: 50,
    maxModelCalls: 20,
    maxScannedFiles: 100,
    maxScannedBytes: 1000000,
    maxReturnedBytes: 100000,
    maxInputTokensPerCall: 20000,
    maxOutputTokensPerCall: 1000,
    maxBillableTokensTask: 100000,
    maxCostMicrosTask: 1000000,
    maxElapsedMsTask: 30000,
    maxClarificationRounds: 3,
    maxConversationBytes: 4000,
    maxFinalBytes: 4000,
  },
  repository: { maxFileBytes: 20000, maxSpanBytes: 4000, maxSpanLines: 60, maxPageEntries: 100, maxSearchHits: 20, maxQueryBytes: 2000, maxPathBytes: 500 },
  retrieval: {
    maxFiles: 100,
    maxChunks: 200,
    maxVectorDimensions: 16,
    maxBatchSize: 8,
    maxConcurrentIndexWriters: 1,
    maxConcurrentRetrievalWorkers: 1,
    maxIndexDiskBytes: 50000,
    maxSqliteCacheBytes: 4000,
    maxWorkerMemoryBytes: 100000,
    maxExactScanVectors: 50,
    maxIndexDeadlineMs: 1000,
    maxRetrievalDeadlineMs: 500,
  },
} as const;
const task = (taskId = 'task') => ({ taskId, question: 'Explain recovery', constraints: ['Inspect source only'], binding, configDigest: digest, profile });
const control = () => ({ signal: new AbortController().signal, deadlineEpochMs: Date.now() + 10000 });
const reply = (request: QuestionSessionRunRequest) => ({
  result: {
    schemaVersion: 'repository-question/1' as const,
    identity: request.identity,
    usage: { status: 'missing' as const },
    kind: 'insufficient-evidence' as const,
    explanation: 'More source is required.',
    claims: [],
    citations: [],
    limitations: [],
  },
  retrieval: null,
});

test('session snapshots constraint elements once before validation and retained projection', async () => {
  let reads = 0;
  let retained: readonly string[] | undefined;
  const constraints: string[] = [];
  Object.defineProperty(constraints, 0, { enumerable: true, get: () => (++reads === 1 ? 'Inspect source only' : 'MARKER_SECRET_CONSTRAINT') });
  const made = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async request => {
      retained = request.context.constraints;
      return reply(request);
    },
  });
  assert.ok(made.ok);
  const outcome = await made.value.startTask({ ...task(), constraints }, control());
  assert.ok(outcome.status === 'completed' && outcome.result.kind === 'insufficient-evidence');
  assert.equal(reads, 1);
  assert.deepEqual(retained, ['Inspect source only']);
  assert.deepEqual(made.value.snapshot().projection?.constraints, ['Inspect source only']);
});

test('caller cancellation during task preparation prevents runner dispatch and closes the retained ledger', async () => {
  const caller = new AbortController();
  let calls = 0;
  const made = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    now: () => {
      caller.abort();
      return 0;
    },
    run: async request => {
      calls++;
      return reply(request);
    },
  });
  assert.ok(made.ok);
  const outcome = await made.value.startTask(task(), { ...control(), signal: caller.signal });
  assert.equal(calls, 0);
  assert.ok(outcome.status === 'completed' && outcome.result.kind === 'cancelled');
  assert.equal(made.value.snapshot().budget?.status, 'cancelled');
});

test('a runner outcome after the caller deadline cannot deliver source claims or citations', async t => {
  const release = Promise.withResolvers<undefined>();
  let runnerSignal: AbortSignal | undefined;
  const made = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request, execution) => {
      runnerSignal = execution.signal;
      await release.promise;
      return {
        result: {
          schemaVersion: 'repository-question/1',
          identity: request.identity,
          usage: { status: 'missing' },
          kind: 'answered',
          claims: [{ claimId: 'claim', text: 'The source returns one.', kind: 'observation', evidence: [{ evidenceId: 'evidence', range: { startLine: 1, endLine: 1 } }] }],
          citations: [{ evidenceId: 'evidence', path: 'entry.py', range: { startLine: 1, endLine: 1 }, originalByteDigest: digest, excerptDigest: digest }],
          limitations: [],
        },
        retrieval: null,
      };
    },
  });
  assert.ok(made.ok);
  t.after(() => {
    release.resolve(undefined);
    made.value.closeSession();
  });
  const pending = made.value.startTask(task(), { ...control(), deadlineEpochMs: Date.now() + 20 });
  await new Promise(resolve => setTimeout(resolve, 40));
  release.resolve(undefined);
  const outcome = await pending;
  assert.ok(outcome.status === 'completed' && outcome.result.kind === 'budget-exhausted', JSON.stringify(outcome));
  assert.ok(!('claims' in outcome.result));
  assert.ok(!('citations' in outcome.result));
  assert.equal(runnerSignal?.aborted, true);
  assert.equal(made.value.snapshot().budget?.status, 'cancelled');
});

test('session expiry bounds an in-flight runner and prevents its later effect', async t => {
  const release = Promise.withResolvers<undefined>();
  let effects = 0;
  let effectiveDeadline = Infinity;
  let runnerSignal: AbortSignal | undefined;
  const expiry = Date.now() + 30;
  const made = openSession({
    sessionId: 'session',
    expiresAtEpochMs: expiry,
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request, execution) => {
      effectiveDeadline = execution.deadlineEpochMs;
      runnerSignal = execution.signal;
      await release.promise;
      if (!execution.signal.aborted && Date.now() < execution.deadlineEpochMs) effects++;
      return reply(request);
    },
  });
  assert.ok(made.ok);
  t.after(() => {
    release.resolve(undefined);
    made.value.closeSession();
  });
  const pending = made.value.startTask(task(), control());
  await new Promise(resolve => setTimeout(resolve, 45));
  release.resolve(undefined);
  assert.deepEqual(await pending, { status: 'refused', reasonCode: 'closed' });
  assert.equal(effectiveDeadline, expiry);
  assert.equal(runnerSignal?.aborted, true);
  assert.equal(effects, 0);
});

test('explicit continuation retains one ledger and task while a new task receives a new ledger', async () => {
  const seen: QuestionSessionRunRequest[] = [];
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      seen.push(request);
      return reply(request);
    },
  });
  assert.ok(created.ok);
  const first = await created.value.submitQuestion(task(), control());
  assert.equal(first.status, 'completed');
  if (first.status !== 'completed') return;
  assert.equal(first.result.kind, 'insufficient-evidence');
  const continued = await created.value.continueTask({ taskId: 'task', turnId: first.turnId, question: 'What happens next?' }, control());
  assert.equal(continued.status, 'completed');
  assert.equal(seen[0]?.budget, seen[1]?.budget);
  assert.notEqual(seen[0]?.identity.runId, seen[1]?.identity.runId);
  assert.equal(seen[1]?.context.intent, 'Explain recovery');
  assert.deepEqual(seen[1]?.context.constraints, ['Inspect source only']);
  assert.equal((await created.value.startTask(task('other'), control())).status, 'completed');
  assert.notEqual(seen[1]?.budget, seen[2]?.budget);
});

test('unresolved clarification cannot disappear when mandatory projection exceeds its byte limit', async () => {
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => ({
      result: {
        schemaVersion: 'repository-question/1',
        identity: request.identity,
        usage: { status: 'missing' },
        kind: 'awaiting-clarification',
        clarification: { clarificationId: 'clarify:1', round: 1, question: 'Which recovery? '.repeat(35), explanation: 'Two mechanisms exist.', unresolvedReferents: ['retry', 'restore'] },
      },
      retrieval: null,
    }),
  });
  assert.ok(created.ok);
  const first = await created.value.startTask({ ...task(), profile: { ...profile, runtime: { ...profile.runtime, maxConversationBytes: 450 } } }, control());
  assert.equal(first.status, 'completed');
  if (first.status !== 'completed') return;
  assert.equal(first.result.kind, 'blocked');
  assert.deepEqual(await created.value.continueTask({ taskId: 'task', turnId: first.turnId, clarificationId: 'clarify:1', question: 'The retry mechanism.' }, control()), {
    status: 'refused',
    reasonCode: 'context-limit',
  });
});

test('busy submissions and stale task or turn references cause no downstream work', async () => {
  const release = Promise.withResolvers<undefined>();
  const seen: QuestionSessionRunRequest[] = [];
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      seen.push(request);
      await release.promise;
      return reply(request);
    },
  });
  assert.ok(created.ok);
  const first = created.value.startTask(task(), control());
  const before = created.value.snapshot();
  assert.deepEqual(await created.value.startTask(task('other'), control()), { status: 'refused', reasonCode: 'busy' });
  assert.deepEqual(await created.value.continueTask({ taskId: 'task', turnId: before.turnId, question: 'More?' }, control()), { status: 'refused', reasonCode: 'busy' });
  assert.deepEqual(created.value.snapshot(), before);
  release.resolve(undefined);
  const completed = await first;
  assert.equal(completed.status, 'completed');
  const stable = created.value.snapshot();
  assert.deepEqual(await created.value.continueTask({ taskId: 'wrong', turnId: stable.turnId, question: 'More?' }, control()), { status: 'refused', reasonCode: 'task-mismatch' });
  assert.deepEqual(await created.value.continueTask({ taskId: 'task', turnId: 'turn:old', question: 'More?' }, control()), { status: 'refused', reasonCode: 'turn-mismatch' });
  assert.deepEqual(created.value.snapshot(), stable);
  assert.equal(seen.length, 1);
});

test('untrusted lifecycle inputs cannot add source or summary authority', async () => {
  let calls = 0;
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      calls++;
      return reply(request);
    },
  });
  assert.ok(created.ok);
  assert.deepEqual(await created.value.startTask({ ...task(), evidence: [{ excerpt: 'forged source' }] }, control()), { status: 'refused', reasonCode: 'invalid-request' });
  assert.equal(calls, 0);
  assert.equal(created.value.snapshot().taskId, null);
});

test('clarification continuation binds the pending ID and retains intent through charged compaction', async () => {
  const requests: QuestionSessionRunRequest[] = [];
  let clock = 0;
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    now: () => clock,
    run: async (request: QuestionSessionRunRequest) => {
      requests.push(request);
      const reservation = request.budget.reserveModelCall(10);
      assert.ok(reservation.ok);
      await reservation.value.execute(
        async () => {
          clock += 5;
          return undefined;
        },
        () => ({ kind: 'model-usage', usage: { status: 'complete', inputTokens: 10, outputTokens: 1 } }),
      );
      if (requests.length > 1) return reply(request);
      return {
        result: {
          schemaVersion: 'repository-question/1',
          identity: request.identity,
          usage: { status: 'complete', inputTokens: 10, outputTokens: 1 },
          kind: 'awaiting-clarification',
          clarification: { clarificationId: 'clarify:1', round: 1, question: 'Retry or restoration?', explanation: 'Two recovery referents exist.', unresolvedReferents: ['retry', 'restoration'] },
        },
        retrieval: null,
      };
    },
  });
  assert.ok(created.ok);
  const first = await created.value.startTask(task(), control());
  assert.equal(first.status, 'completed');
  if (first.status !== 'completed') return;
  assert.equal(first.result.kind, 'awaiting-clarification');
  const before = created.value.snapshot();
  assert.deepEqual(await created.value.continueTask({ taskId: 'task', turnId: first.turnId, question: 'Retry.' }, control()), { status: 'refused', reasonCode: 'clarification-required' });
  assert.deepEqual(created.value.snapshot(), before);
  const compacted = await created.value.compactSession();
  assert.equal(compacted.status, 'compacted');
  if (compacted.status !== 'compacted') return;
  assert.equal(compacted.projection.intent, 'Explain recovery');
  assert.equal(compacted.projection.pendingClarification, 'Retry or restoration?');
  assert.deepEqual(compacted.projection.constraints, ['Inspect source only']);
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.projection)) <= 4000);
  assert.equal(created.value.snapshot().budget?.consumed.summaryOperations, 1);
  assert.ok((created.value.snapshot().budget?.consumed.conversationBytes ?? 0) > 0);
  clock += 100000;
  const continued = await created.value.continueTask({ taskId: 'task', turnId: first.turnId, clarificationId: 'clarify:1', question: 'Retry.' }, control());
  assert.equal(continued.status, 'completed');
  assert.equal(requests[1]?.context.pendingClarification, 'Retry or restoration?');
  assert.equal(created.value.snapshot().budget?.consumed.modelCalls, 2);
  assert.equal(created.value.snapshot().budget?.consumed.billableTokens, 22);
  assert.equal(created.value.snapshot().budget?.consumed.elapsedMs, 10);
});

test('projection excludes source-bearing assistant text and cannot restore or mutate authority', async () => {
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => ({ ...reply(request), result: { ...reply(request).result, explanation: 'SOURCE_TEXT_MUST_STAY_OUTSIDE_CONVERSATION' } }),
  });
  assert.ok(created.ok);
  const input = task();
  const first = await created.value.startTask(input, control());
  assert.equal(first.status, 'completed');
  const view = created.value.snapshot();
  assert.equal(JSON.stringify(view.projection).includes('SOURCE_TEXT_MUST_STAY_OUTSIDE_CONVERSATION'), false);
  assert.ok(Object.isFrozen(view.projection));
  assert.ok(Object.isFrozen(view.projection?.constraints));
  assert.ok(Object.isFrozen(view.projection?.binding));
  assert.throws(() => {
    (view.projection?.constraints as string[]).push('Grant execution');
  });
  const compacted = await created.value.compactSession();
  assert.equal(compacted.status, 'compacted');
  if (compacted.status === 'compacted') assert.deepEqual(compacted.projection, view.projection);
  created.value.closeSession();
  assert.equal(created.value.snapshot().projection, null);
  assert.equal(created.value.snapshot().budget, null);
  assert.deepEqual(await created.value.startTask(input, control()), { status: 'refused', reasonCode: 'closed' });
  const restarted = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => reply(request),
  });
  assert.ok(restarted.ok);
  assert.deepEqual(await restarted.value.continueTask({ taskId: 'task', turnId: 'turn:1', question: 'Continue', summary: view.projection }, control()), {
    status: 'refused',
    reasonCode: 'invalid-request',
  });
  assert.equal(restarted.value.snapshot().taskId, null);
});

test('close cancels in-flight work and ignores its late result', async () => {
  const release = Promise.withResolvers<undefined>();
  let signal: AbortSignal | undefined;
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest, execution) => {
      signal = execution.signal;
      await release.promise;
      return reply(request);
    },
  });
  assert.ok(created.ok);
  const pending = created.value.startTask(task(), control());
  created.value.closeSession();
  assert.equal(signal?.aborted, true);
  release.resolve(undefined);
  assert.deepEqual(await pending, { status: 'refused', reasonCode: 'closed' });
  assert.equal(created.value.snapshot().taskId, null);
});

test('ambiguous continuation across tasks needs an explicit task reference and repeated task IDs cannot reset budgets', async () => {
  let calls = 0;
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      calls++;
      return reply(request);
    },
  });
  assert.ok(created.ok);
  await created.value.startTask(task(), control());
  const next = await created.value.startTask(task('next'), control());
  assert.equal(next.status, 'completed');
  if (next.status !== 'completed') return;
  assert.deepEqual(await created.value.continueTask({ turnId: next.turnId, question: 'And its recovery?' }, control()), { status: 'refused', reasonCode: 'clarification-required' });
  assert.deepEqual(await created.value.startTask(task(), control()), { status: 'refused', reasonCode: 'invalid-request' });
  assert.equal(calls, 2);
});

test('lifecycle snapshots top-level input values once before using task authority', async () => {
  const seen: QuestionSessionRunRequest[] = [];
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      seen.push(request);
      return reply(request);
    },
  });
  assert.ok(created.ok);
  let reads = 0;
  const supplied = {
    ...task(),
    get question() {
      return ++reads === 1 ? 'Original user intent' : 'Changed user intent';
    },
  };
  const first = await created.value.startTask(supplied, control());
  assert.equal(first.status, 'completed');
  assert.equal(reads, 1);
  assert.equal(seen[0]?.question, 'Original user intent');
  assert.equal(seen[0]?.context.intent, 'Original user intent');
});

test('expired session capabilities refuse operations instead of accepting reconstructed context', async () => {
  let calls = 0;
  const created = openSession({
    sessionId: 'session',
    expiresAtEpochMs: Date.now() + 25,
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      calls++;
      return reply(request);
    },
  });
  assert.ok(created.ok);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(await created.value.startTask(task(), control()), { status: 'refused', reasonCode: 'closed' });
  assert.equal(created.value.snapshot().closed, true);
  assert.equal(calls, 0);
});

test('explicit stale rebind preserves task ledger and clears old source context without automatic retries', async () => {
  const seen: QuestionSessionRunRequest[] = [];
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      seen.push(request);
      if (seen.length === 1)
        return {
          ...reply(request),
          result: { schemaVersion: 'repository-question/1', identity: request.identity, usage: { status: 'missing' }, kind: 'stale-repository', reasonCode: 'binding-mismatch' },
        };
      return reply(request);
    },
  });
  assert.ok(created.ok);
  const first = await created.value.startTask(task(), control());
  assert.equal(first.status, 'completed');
  if (first.status !== 'completed') return;
  assert.deepEqual(await created.value.continueTask({ taskId: 'task', turnId: first.turnId, question: 'Retry' }, control()), { status: 'refused', reasonCode: 'rebind-required' });
  assert.equal(seen.length, 1);
  const rebound = await created.value.continueTask(
    { taskId: 'task', turnId: first.turnId, question: 'Inspect current revision', rebind: { binding: { ...binding, revisionDigest: 'sha256:' + 'b'.repeat(64) } } },
    control(),
  );
  assert.equal(rebound.status, 'completed');
  assert.equal(seen[0]?.budget, seen[1]?.budget);
  assert.equal(seen[1]?.profile, seen[0]?.profile);
  assert.equal(seen[1]?.identity.taskId, 'task');
  assert.equal(seen[1]?.identity.binding.revisionDigest, 'sha256:' + 'b'.repeat(64));
  assert.equal(seen[1]?.context.intent, 'Explain recovery');
  assert.deepEqual(seen[1]?.sourceReferences, []);
});

test('repository switch cancels work but cannot replace an unknown held ledger until trusted reconciliation', async t => {
  const provider = Promise.withResolvers<undefined>();
  const seen: QuestionSessionRunRequest[] = [];
  let held: QuestionBudgetReservation | undefined;
  const created = openSession({
    sessionId: 'session',
    pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    run: async (request: QuestionSessionRunRequest) => {
      seen.push(request);
      if (seen.length === 1) {
        const admission = request.budget.reserveModelCall(10);
        assert.ok(admission.ok);
        held = admission.value;
        await admission.value.execute(
          async () => provider.promise,
          () => ({ kind: 'model-usage', usage: { status: 'complete', inputTokens: 10, outputTokens: 1 } }),
        );
      }
      return reply(request);
    },
  });
  assert.ok(created.ok);
  t.after(() => {
    created.value.closeSession();
    provider.resolve(undefined);
  });
  const initial = created.value.startTask(task(), control());
  const other = { ...task('new'), binding: { ...binding, repositoryId: 'other-repo' }, question: 'Inspect other source' };
  const switched = await created.value.switchRepository(other, control());
  assert.deepEqual(switched, { status: 'refused', reasonCode: 'accounting-pending' });
  const old = await initial;
  assert.equal(old.status, 'completed');
  assert.ok(old.status === 'completed' && old.result.kind === 'cancelled');
  assert.equal(seen.length, 1);
  assert.deepEqual(await created.value.startTask(task('same-repo-new-task'), control()), { status: 'refused', reasonCode: 'accounting-pending' });
  assert.ok(held);
  assert.ok(held.reconcile({ kind: 'model-usage', usage: { status: 'complete', inputTokens: 10, outputTokens: 1 } }).ok);
  assert.deepEqual(await created.value.startTask(other, control()), { status: 'refused', reasonCode: 'switch-required' });
  assert.equal((await created.value.switchRepository(other, control())).status, 'completed');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]?.budget, seen[1]?.budget);
  assert.deepEqual(seen[1]?.sourceReferences, []);
  assert.deepEqual(seen[1]?.context.conversation, []);
  provider.resolve(undefined);
});
