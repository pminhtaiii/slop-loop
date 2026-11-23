import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderRequest } from '../../../src/contracts/foundation/uc03.ts';
import { buildTransportPayload, type HostModelTransportPayload } from '../../../src/foundation/model.ts';
import { createDeepSeekTransport, type DeepSeekPricing } from '../../../src/foundation/deepseek-transport.ts';
import { createRunUsageLimiter, type RunCallAdmission, type RunUsageLimits } from '../../../src/foundation/run-usage-limit.ts';
import { createFixtureProviderRequest, createFixtureSourceEvidence, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const LIMITS: RunUsageLimits = { totalModelCalls: 24, perRunInputTokens: 400000, perRunOutputTokens: 80000 };

const call = (overrides: Partial<RunCallAdmission> = {}): RunCallAdmission => ({
  taskId: 'task-1',
  runId: 'run-1',
  callId: 'call-1',
  maxInputTokens: 30000,
  maxOutputTokens: 8000,
  ...overrides,
});

// Transport rows below reuse the RFC 3849/example reserved fixtures; no network is touched.
const PRICING: DeepSeekPricing = { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1 };
const PROPOSAL = '{"kind":"stop","proposalId":"p-1","reasonCode":"done","summary":"ok","evidenceRefs":[]}';
const messageResponse = (): Response =>
  new Response(JSON.stringify({ id: 'msg-1', type: 'message', model: 'deepseek-v4.1', content: [{ type: 'text', text: PROPOSAL }], usage: { input_tokens: 120, output_tokens: 40 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const payload = (overrides: Partial<ProviderRequest> = {}): HostModelTransportPayload =>
  buildTransportPayload(
    createFixtureTaskState(),
    [createFixtureSourceEvidence()],
    createFixtureProviderRequest({ modelId: 'deepseek-flash', maxCostUsd: 0.1, maxInputTokens: 3000, maxBillableTokens: 5000, ...overrides }),
  );
function fakeFetch(handler: () => Response | Promise<Response> = messageResponse): { fetchImpl: typeof globalThis.fetch; calls: number[] } {
  const calls: number[] = [];
  const fetchImpl = async (): Promise<Response> => {
    calls.push(calls.length);
    return handler();
  };
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}
function fixedTransport(fetchImpl: typeof globalThis.fetch, runLimiter: ReturnType<typeof createRunUsageLimiter>) {
  return createDeepSeekTransport({ endpoint: 'https://model.invalid/v1/messages', apiKey: 'sk-synthetic-host-key-0123456789', pricing: PRICING, fetch: fetchImpl, runLimiter });
}

test('refuses construction without finite positive limits', () => {
  const rejected: readonly unknown[] = [
    undefined,
    {},
    { totalModelCalls: 24, perRunInputTokens: 400000 },
    { ...LIMITS, totalModelCalls: 0 },
    { ...LIMITS, perRunInputTokens: 1.5 },
    { ...LIMITS, perRunOutputTokens: Number.NaN },
    { ...LIMITS, totalModelCalls: '24' },
  ];
  for (const limits of rejected) {
    assert.throws(() => createRunUsageLimiter(limits as RunUsageLimits), /INVALID_RUN_LIMITS/);
  }
  assert.doesNotThrow(() => createRunUsageLimiter(LIMITS));
});

test('refuses a request without both task and run ids', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  assert.equal(limiter.admit(call({ taskId: '' })), false);
  assert.equal(limiter.admit(call({ runId: '' })), false);
  assert.equal(limiter.countersFor('', 'run-1'), undefined);
});

test('stops the run at its call ceiling', () => {
  const limiter = createRunUsageLimiter({ ...LIMITS, totalModelCalls: 2 });
  assert.equal(limiter.admit(call({ callId: 'c1' })), true);
  assert.equal(limiter.admit(call({ callId: 'c2' })), true);
  assert.equal(limiter.admit(call({ callId: 'c3' })), false);
  assert.equal(limiter.countersFor('task-1', 'run-1')?.calls, 2);
});

test('refuses a call whose admitted maxima would pass a per-run token ceiling', () => {
  const limiter = createRunUsageLimiter({ ...LIMITS, perRunInputTokens: 50000, perRunOutputTokens: 9000 });
  assert.equal(limiter.admit(call({ callId: 'c1', maxInputTokens: 30000, maxOutputTokens: 8000 })), true);
  assert.equal(limiter.admit(call({ callId: 'c2', maxInputTokens: 25000, maxOutputTokens: 8000 })), false);
  assert.equal(limiter.admit(call({ callId: 'c3', maxInputTokens: 20000, maxOutputTokens: 1000 })), true);
  assert.equal(limiter.admit(call({ callId: 'c4', maxOutputTokens: 1 })), false);
  const counters = limiter.countersFor('task-1', 'run-1');
  assert.equal(counters?.calls, 2);
  assert.equal(counters?.inputTokensCharged, 50000);
  assert.equal(counters?.outputTokensCharged, 9000);
});

test('replaces the provisional charge with observed usage and reports an unverified estimate', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  const entry = call();
  assert.equal(limiter.admit(entry), true);
  limiter.settle(entry, { inputTokens: 120, outputTokens: 40, costUsd: 0.00016, billableTokens: 160 });
  assert.equal(limiter.countersFor('task-1', 'run-1')?.inputTokensCharged, 120);
  assert.equal(limiter.countersFor('task-1', 'run-1')?.outputTokensCharged, 40);
  assert.deepEqual(limiter.reportFor(entry), {
    callId: 'call-1',
    inputTokens: 120,
    outputTokens: 40,
    costUsd: 0.00016,
    costLabel: 'estimate-unverified',
  });
});

test('keeps the full admitted maxima and an unknown usage report without observed usage', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  const entry = call();
  assert.equal(limiter.admit(entry), true);
  limiter.settle(entry);
  assert.deepEqual(limiter.countersFor('task-1', 'run-1'), {
    taskId: 'task-1',
    runId: 'run-1',
    calls: 1,
    inputTokensCharged: 30000,
    outputTokensCharged: 8000,
  });
  assert.deepEqual(limiter.reportFor(entry), {
    callId: 'call-1',
    inputTokens: 'unknown',
    outputTokens: 'unknown',
    costUsd: 'unknown',
    costLabel: 'unknown',
  });
});

test('keys counters per task and run and ignores a settle for a call never admitted', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  assert.equal(limiter.admit(call({ runId: 'run-a', callId: 'a' })), true);
  assert.equal(limiter.admit(call({ runId: 'run-b', callId: 'b' })), true);
  assert.equal(limiter.countersFor('task-1', 'run-a')?.calls, 1);
  assert.equal(limiter.countersFor('task-1', 'run-b')?.calls, 1);
  limiter.settle(call({ callId: 'ghost' }));
  assert.equal(limiter.reportFor(call({ callId: 'ghost' })), undefined);
  assert.equal(limiter.countersFor('task-1', 'run-a')?.inputTokensCharged, 30000);
  // A settlement for another run's call id has no pending entry and changes no counters.
  limiter.settle(call({ runId: 'run-b', callId: 'a' }), { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 });
  assert.equal(limiter.countersFor('task-1', 'run-a')?.inputTokensCharged, 30000);
  assert.equal(limiter.countersFor('task-1', 'run-b')?.inputTokensCharged, 30000);
});

test('keeps an overlapping run at its full maxima when another run settles the same call id', () => {
  const limiter = createRunUsageLimiter({ ...LIMITS, perRunInputTokens: 200, perRunOutputTokens: 200 });
  const runA = call({ taskId: 'task-a', runId: 'run-a', callId: 'shared', maxInputTokens: 200, maxOutputTokens: 200 });
  const runB = call({ taskId: 'task-b', runId: 'run-b', callId: 'shared', maxInputTokens: 200, maxOutputTokens: 200 });
  assert.equal(limiter.admit(runA), true);
  assert.equal(limiter.admit(runB), true);
  limiter.settle(runA, { inputTokens: 1, outputTokens: 1, costUsd: 0, billableTokens: 2 });
  assert.deepEqual(limiter.countersFor('task-a', 'run-a'), { taskId: 'task-a', runId: 'run-a', calls: 1, inputTokensCharged: 1, outputTokensCharged: 1 });
  assert.deepEqual(limiter.countersFor('task-b', 'run-b'), { taskId: 'task-b', runId: 'run-b', calls: 1, inputTokensCharged: 200, outputTokensCharged: 200 });
  // Run B's reservation is untouched, so its ceiling still holds.
  assert.equal(limiter.admit(call({ taskId: 'task-b', runId: 'run-b', callId: 'second', maxInputTokens: 1, maxOutputTokens: 1 })), false);
});

test('reports the unknown usage of one overlapping run without showing the other run figures', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  const runA = call({ taskId: 'task-a', runId: 'run-a', callId: 'shared' });
  const runB = call({ taskId: 'task-b', runId: 'run-b', callId: 'shared' });
  assert.equal(limiter.admit(runA), true);
  assert.equal(limiter.admit(runB), true);
  limiter.settle(runA, { inputTokens: 1, outputTokens: 2, costUsd: 0.1, billableTokens: 3 });
  limiter.settle(runB);
  assert.deepEqual(limiter.reportFor(runA), { callId: 'shared', inputTokens: 1, outputTokens: 2, costUsd: 0.1, costLabel: 'estimate-unverified' });
  assert.deepEqual(limiter.reportFor(runB), { callId: 'shared', inputTokens: 'unknown', outputTokens: 'unknown', costUsd: 'unknown', costLabel: 'unknown' });
});

test('reports each overlapping run its own observed figures for a shared call id', () => {
  const limiter = createRunUsageLimiter(LIMITS);
  const runA = call({ taskId: 'task-a', runId: 'run-a', callId: 'shared' });
  const runB = call({ taskId: 'task-b', runId: 'run-b', callId: 'shared' });
  assert.equal(limiter.admit(runA), true);
  assert.equal(limiter.admit(runB), true);
  limiter.settle(runA, { inputTokens: 1, outputTokens: 2, costUsd: 0.1, billableTokens: 3 });
  limiter.settle(runB, { inputTokens: 100, outputTokens: 200, costUsd: 20, billableTokens: 300 });
  assert.deepEqual(limiter.reportFor(runA), { callId: 'shared', inputTokens: 1, outputTokens: 2, costUsd: 0.1, costLabel: 'estimate-unverified' });
  assert.deepEqual(limiter.reportFor(runB), { callId: 'shared', inputTokens: 100, outputTokens: 200, costUsd: 20, costLabel: 'estimate-unverified' });
});

test('refuses a duplicate pending call identity before changing any counter', () => {
  const limiter = createRunUsageLimiter({ totalModelCalls: 4, perRunInputTokens: 1000, perRunOutputTokens: 1000 });
  const first = call({ callId: 'dup', maxInputTokens: 100, maxOutputTokens: 0 });
  const second = call({ callId: 'dup', maxInputTokens: 900, maxOutputTokens: 0 });
  assert.equal(limiter.admit(first), true);
  assert.equal(limiter.admit(second), false);
  assert.deepEqual(limiter.countersFor('task-1', 'run-1'), { taskId: 'task-1', runId: 'run-1', calls: 1, inputTokensCharged: 100, outputTokensCharged: 0 });
  // The first call's settlement subtracts its own 100, not the refused 900.
  limiter.settle(first, { inputTokens: 50, outputTokens: 0, costUsd: 0, billableTokens: 50 });
  assert.equal(limiter.countersFor('task-1', 'run-1')?.inputTokensCharged, 50);
  assert.deepEqual(limiter.reportFor(first), { callId: 'dup', inputTokens: 50, outputTokens: 0, costUsd: 0, costLabel: 'estimate-unverified' });
  // 950 of headroom is genuinely left, so the ceiling still holds.
  assert.equal(limiter.admit(call({ callId: 'third', maxInputTokens: 950, maxOutputTokens: 0 })), true);
  assert.equal(limiter.admit(call({ callId: 'fourth', maxInputTokens: 1, maxOutputTokens: 0 })), false);
});

test('re-admits a call identity once its earlier admission has settled', () => {
  const limiter = createRunUsageLimiter({ ...LIMITS, totalModelCalls: 2 });
  const entry = call();
  assert.equal(limiter.admit(entry), true);
  limiter.settle(entry, { inputTokens: 120, outputTokens: 40, costUsd: 0, billableTokens: 160 });
  assert.equal(limiter.admit(entry), true);
  assert.equal(limiter.countersFor('task-1', 'run-1')?.calls, 2);
  assert.equal(limiter.reportFor(entry)?.inputTokens, 'unknown');
  limiter.settle(entry, { inputTokens: 1, outputTokens: 2, costUsd: 0, billableTokens: 3 });
  assert.equal(limiter.reportFor(entry)?.inputTokens, 1);
});

test('stops the transport at the call ceiling with zero fetches for the refused call', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const subject = fixedTransport(fetchImpl, createRunUsageLimiter({ ...LIMITS, totalModelCalls: 24 }));
  for (let index = 0; index < 24; index += 1) {
    assert.equal('proposal' in (await subject.execute(payload({ providerRequestId: `req-${index}` }))), true, `call ${index}`);
  }
  assert.equal(calls.length, 24);
  const refused = await subject.execute(payload({ providerRequestId: 'req-25' }));
  assert.deepEqual(refused, { outcome: 'denied', reason: 'RUN_USAGE_LIMIT_REACHED: this run reached its call or token ceiling before dispatch' });
  assert.equal(calls.length, 24);
});

test('stops the transport when admitted maxima would pass a per-run token ceiling', async () => {
  // Uncertain responses never settle, so each call keeps its full 3,000 in / 1,000 out maxima.
  const { fetchImpl, calls } = fakeFetch(() => new Response('{"error":"boom"}', { status: 503 }));
  const subject = fixedTransport(fetchImpl, createRunUsageLimiter({ ...LIMITS, perRunInputTokens: 6000, perRunOutputTokens: 2000 }));
  assert.equal((await subject.execute(payload({ providerRequestId: 'req-a' }))) instanceof Object, true);
  await subject.execute(payload({ providerRequestId: 'req-b' }));
  const refused = await subject.execute(payload({ providerRequestId: 'req-c' }));
  assert.equal((refused as { reason?: string }).reason?.startsWith('RUN_USAGE_LIMIT_REACHED'), true);
  assert.equal(calls.length, 2);
});

test('stops each transport run separately, keyed by the request task and run', async () => {
  const { fetchImpl } = fakeFetch();
  const subject = fixedTransport(fetchImpl, createRunUsageLimiter({ ...LIMITS, totalModelCalls: 1 }));
  assert.equal('proposal' in (await subject.execute(payload({ providerRequestId: 'req-a', runId: 'run-a' }))), true);
  assert.equal('proposal' in (await subject.execute(payload({ providerRequestId: 'req-b', runId: 'run-b' }))), true);
  const refused = await subject.execute(payload({ providerRequestId: 'req-c', runId: 'run-a' }));
  assert.equal((refused as { reason?: string }).reason?.startsWith('RUN_USAGE_LIMIT_REACHED'), true);
});
