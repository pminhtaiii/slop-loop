/**
 * Protected local console server (T015).
 *
 * Drives a real `node:http` server on an ephemeral loopback port against a stub `EvaluationService`
 * that records every call. "Denied before owner effects" is proven by that log staying empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { createConsoleServer, type ConsoleArtifact, type ConsoleComparisonRequest } from '../../../src/runtime/console-server.ts';
import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import type { EvaluationService, ExperimentReceipt, ExperimentView, ServiceResult } from '../../../src/runtime/evaluation-service.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { WorkflowComparisonReport } from '../../../eval/uc03/compare.ts';

const TOKEN = 'operator-token-for-controlled-console-tests';
const digest = (seed: string): string => sha256Text(seed);

const catalogEntry: CatalogEntry = {
  catalogEntryId: 'entry-case-001',
  caseId: 'case-001',
  version: '1.0.0',
  caseDigest: digest('case-case-001'),
  publicTaskDigest: digest('task-case-001'),
  initialRepositoryDigest: digest('repo-case-001'),
  fixturePath: 'C:/host-only/fixture.json',
  fixtureDigest: digest('fixture-case-001'),
  grader: { version: '1.0.0', digest: digest('grader-case-001'), path: 'C:/host-only/grader.json' },
};

const view = (id: string): ExperimentView => ({
  id,
  version: 3,
  status: 'waiting-approval',
  scope: 'catalog',
  graded: true,
  bindings: [],
  submission: null,
  taskId: 'task-001',
  runId: 'run-001',
  workspaceId: 'ws-001',
  usage: null,
  answers: [],
  directions: [],
});
const receipt = (key: string, id: string): ExperimentReceipt => ({ receiptId: `rcpt-${id}`, kind: 'start', idempotencyKey: key, experimentId: id, version: 3 });

/** A real `WorkflowComparisonReport`, so the stub cannot vouch for fields the report does not have. */
const comparisonReport = (): WorkflowComparisonReport => ({
  suite: 'uc03',
  contractVersion: 'uc03-workflow-evaluation/1',
  baselineConfigDigest: digest('config'),
  candidateConfigDigest: digest('config'),
  compatible: true,
  verdict: 'IMPROVED',
  exitCode: 0,
  failedGuards: [],
  unverifiedGuards: [],
  changedFactors: [],
  configurationConfounded: false,
  cases: [],
  summary: { totalCommon: 0, totalAdded: 0, totalRemoved: 0, stableCount: 0, improvementsCount: 0, regressionsCount: 0, unknownUsageCases: 0, observedUsageCases: 0 },
  selectedCases: [],
  pendingWaits: { baseline: [], candidate: [] },
  notSelectedCases: { baseline: [], candidate: [] },
  tokensDelta: null,
  costDeltaUsd: null,
  baselineAcceptance: { scope: 'catalog', requiredCases: 1, satisfiedCases: 1, outcome: 'pass' },
  candidateAcceptance: { scope: 'catalog', requiredCases: 1, satisfiedCases: 1, outcome: 'incomplete' },
  limitations: ['controlled comparison'],
});

type Call = Readonly<{ method: string; input: unknown }>;

interface Stub {
  service: EvaluationService;
  calls: Call[];
  approval: { presentation: (id: string) => ServiceResult<unknown>; decide: (input: unknown) => ServiceResult<unknown> };
  comparison: { compare: (input: ConsoleComparisonRequest) => ServiceResult<unknown> };
  /** Per-call delay, so a serialisation test can observe overlap if it ever happened. */
  state: { delay: number };
}

/** Records every service/approval/comparison entry so a denial can be proven by an empty log. */
function createStub(): Stub {
  const calls: Call[] = [];
  const state = { delay: 0 };
  const pause = async (): Promise<void> => {
    if (state.delay > 0) await new Promise(resolve => setTimeout(resolve, state.delay));
  };
  const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
  const service: EvaluationService = {
    async startExperiment(input) {
      calls.push({ method: 'startExperiment', input });
      await pause();
      return ok({ experiment: view('exp-001'), receipt: receipt('key-1', 'exp-001') });
    },
    getExperiment(input) {
      calls.push({ method: 'getExperiment', input });
      return ok(view('exp-001'));
    },
    async answerClarification(input) {
      calls.push({ method: 'answerClarification', input });
      await pause();
      return ok({ experiment: view('exp-001'), receipt: receipt('key-1', 'exp-001') });
    },
    async issueDirection(input) {
      calls.push({ method: 'issueDirection', input });
      await pause();
      return ok({ experiment: view('exp-001'), receipt: { receiptRef: 'ctrl-1', kind: 'resume' as const, taskId: 'task-001', controlVersion: 7 } });
    },
    async continueExperiment(input) {
      calls.push({ method: 'continueExperiment', input });
      await pause();
      return ok({ experiment: view('exp-001'), receipt: receipt('key-1', 'exp-001') });
    },
  };
  return {
    service,
    calls,
    state,
    approval: {
      presentation: (id: string) => (calls.push({ method: 'approval.presentation', input: id }), ok({ decisionId: 'decision-1', presentationDigest: `sha256:${digest('pres')}` })),
      decide: (input: unknown) => (calls.push({ method: 'approval.decide', input }), ok({ decision: 'approved' })),
    },
    comparison: { compare: (input: ConsoleComparisonRequest) => (calls.push({ method: 'comparison.compare', input }), ok(comparisonReport())) },
  };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function call(port: number, method: string, path: string, options: { body?: string; headers?: Record<string, string>; omitHost?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { connection: 'close', ...options.headers };
    if (!options.omitHost) headers.host = options.headers?.host ?? `127.0.0.1:${port}`;
    else delete headers.host;
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const mutation = (port: number, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Reply> =>
  call(port, 'POST', path, {
    body: JSON.stringify(body),
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-operator-token': TOKEN,
      ...extra,
    },
  });

async function withServer(run: (port: number, stub: ReturnType<typeof createStub>) => Promise<void>, artifacts?: ReadonlyMap<string, ConsoleArtifact>): Promise<void> {
  const stub = createStub();
  const server = createConsoleServer({
    service: stub.service,
    catalog: [catalogEntry],
    operatorToken: TOKEN,
    artifacts,
    approval: stub.approval,
    comparison: stub.comparison,
  });
  const address = await server.listen(0);
  try {
    await run(address.port, stub);
  } finally {
    await server.close();
  }
}

test('console binds loopback only and keeps the token out of every response', async () => {
  await withServer(async (port, stub) => {
    assert.equal(port > 0, true);
    const page = await call(port, 'GET', '/', {});
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.body.includes(TOKEN), false);

    await mutation(port, '/api/experiments', { profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-1', source: { kind: 'catalog', caseIds: ['case-001'] } });
    assert.equal(stub.calls.length, 1);
    const denied = await call(port, 'GET', '/api/catalog', { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(denied.body.includes(TOKEN), false);
  });
});

test('missing or incorrect operator token denies a mutation with zero service calls', async () => {
  await withServer(async (port, stub) => {
    const body = { profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-1', source: { kind: 'catalog', caseIds: ['case-001'] } };
    const missing = await call(port, 'POST', '/api/experiments', {
      body: JSON.stringify(body),
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    });
    const wrong = await mutation(port, '/api/experiments', body, { 'x-operator-token': 'not-the-token-at-all' });
    assert.equal(missing.status, 403);
    assert.equal(wrong.status, 403);
    assert.equal(JSON.parse(wrong.body).error, 'FORBIDDEN_TOKEN');
    assert.deepEqual(stub.calls, []);
  });
});

test('cross-origin, missing origin and rebinding Host deny before any owner call', async () => {
  await withServer(async (port, stub) => {
    const body = { profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-1', source: { kind: 'catalog', caseIds: ['case-001'] } };
    const crossOrigin = await mutation(port, '/api/experiments', body, { origin: 'http://evil.test' });
    const noOrigin = await call(port, 'POST', '/api/experiments', {
      body: JSON.stringify(body),
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-operator-token': TOKEN },
    });
    const rebinding = await call(port, 'GET', '/api/catalog', { headers: { host: 'evil.test' } });
    const wrongPort = await call(port, 'GET', '/api/catalog', { headers: { host: '127.0.0.1:1' } });

    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.body).error, 'FORBIDDEN_ORIGIN');
    assert.equal(noOrigin.status, 403);
    assert.equal(rebinding.status, 403);
    assert.equal(JSON.parse(rebinding.body).error, 'FORBIDDEN_HOST');
    assert.equal(wrongPort.status, 403);
    assert.deepEqual(stub.calls, []);
  });
});

test('non-JSON content type, oversized body and unknown route deny with zero service calls', async () => {
  await withServer(async (port, stub) => {
    const wrongType = await mutation(port, '/api/experiments', {}, { 'content-type': 'text/plain' });
    assert.equal(wrongType.status, 415);

    const oversized = await mutation(port, '/api/experiments', { profileId: 'uc03-runtime-evaluation-v1', pad: 'x'.repeat(70 * 1024) });
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.body).error, 'REQUEST_TOO_LARGE');

    const unknown = await mutation(port, '/api/unknown', {});
    assert.equal(unknown.status, 404);
    assert.equal(JSON.parse(unknown.body).error, 'UNKNOWN_OPERATION');
    assert.equal(unknown.body.includes('C:'), false);
    assert.deepEqual(stub.calls, []);
  });
});

test('traversal and non-safe id segments deny before the service is called', async () => {
  await withServer(async (port, stub) => {
    const traversal = await call(port, 'GET', '/api/experiments/..%2F..%2Fsecret', { headers: { host: `127.0.0.1:${port}` } });
    const encodedDot = await call(port, 'GET', '/api/experiments/%2e%2e', { headers: { host: `127.0.0.1:${port}` } });
    const nul = await call(port, 'GET', '/api/experiments/bad%00id', { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(traversal.status, 400);
    assert.equal(encodedDot.status, 400);
    assert.equal(nul.status, 400);
    assert.deepEqual(stub.calls, []);
  });
});

test('every route reaches its service method with the client version and key forwarded unchanged', async () => {
  await withServer(async (port, stub) => {
    const startBody = { profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-start', source: { kind: 'catalog', caseIds: ['case-001'] } };
    assert.equal((await mutation(port, '/api/experiments', startBody)).status, 200);
    assert.deepEqual(stub.calls[0], { method: 'startExperiment', input: startBody });

    assert.equal((await call(port, 'GET', '/api/experiments/exp-001', { headers: { host: `127.0.0.1:${port}` } })).status, 200);
    assert.deepEqual(stub.calls[1], { method: 'getExperiment', input: 'exp-001' });

    assert.equal((await call(port, 'GET', '/api/experiments/exp-001/approval', { headers: { host: `127.0.0.1:${port}` } })).status, 200);
    assert.deepEqual(stub.calls[2], { method: 'approval.presentation', input: 'exp-001' });

    const decision = { idempotencyKey: 'key-decision', decision: 'approve', expectedVersion: 3, presentationDigest: `sha256:${digest('pres')}` };
    assert.equal((await mutation(port, '/api/experiments/exp-001/decision', decision)).status, 200);
    assert.deepEqual(stub.calls[3], { method: 'approval.decide', input: { ...decision, experimentId: 'exp-001' } });

    const answers = { idempotencyKey: 'key-answer', questionId: 'q-reproduction', questionDigest: digest('q'), expectedVersion: 4, answers: ['steps'] };
    assert.equal((await mutation(port, '/api/experiments/exp-001/answers', answers)).status, 200);
    assert.deepEqual(stub.calls[4], { method: 'answerClarification', input: { ...answers, id: 'exp-001' } });

    const directions = { idempotencyKey: 'key-direction', kind: 'revise', expectedTaskVersion: 2, expectedControlVersion: 5, decisionRef: 'decision-1', feedback: 'tighten' };
    assert.equal((await mutation(port, '/api/experiments/exp-001/directions', directions)).status, 200);
    assert.deepEqual(stub.calls[5], { method: 'issueDirection', input: { ...directions, id: 'exp-001' } });

    const continuation = { idempotencyKey: 'key-continue', directionRef: 'ctrl-1', expectedVersion: 6 };
    assert.equal((await mutation(port, '/api/experiments/exp-001/continue', continuation)).status, 200);
    assert.deepEqual(stub.calls[6], { method: 'continueExperiment', input: { ...continuation, id: 'exp-001' } });

    const comparison = { idempotencyKey: 'key-compare', baselineId: 'exp-001', candidateId: 'exp-002', policy: 'guarded' };
    assert.equal((await mutation(port, '/api/comparisons', comparison)).status, 200);
    assert.deepEqual(stub.calls[7], { method: 'comparison.compare', input: comparison });
    assert.equal(stub.calls.length, 8);
  });
});

test('a malformed comparison body is refused before the comparison port is called', async () => {
  await withServer(async (port, stub) => {
    const valid = { idempotencyKey: 'key-compare', baselineId: 'exp-001', candidateId: 'exp-002', policy: 'guarded' };
    const invalid: readonly unknown[] = [
      { ...valid, baselineId: '../../secrets' },
      { ...valid, candidateId: 42 },
      { ...valid, extra: 'x' },
      { idempotencyKey: 'key-compare', baselineId: 'exp-001', policy: 'guarded' },
      { ...valid, policy: 'loose' },
      { ...valid, idempotencyKey: 'k'.repeat(129) },
      { ...valid, idempotencyKey: '' },
    ];
    for (const body of invalid) {
      const reply = await mutation(port, '/api/comparisons', body);
      assert.equal(reply.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.deepEqual(JSON.parse(reply.body), { ok: false, error: 'INVALID_REQUEST' });
      assert.equal(stub.calls.filter(call => call.method === 'comparison.compare').length, 0);
    }

    assert.equal((await mutation(port, '/api/comparisons', valid)).status, 200);
    assert.deepEqual(stub.calls, [{ method: 'comparison.compare', input: valid }]);
    assert.equal((await mutation(port, '/api/comparisons', { ...valid, policy: 'strict' })).status, 200);
    assert.equal(stub.calls.filter(call => call.method === 'comparison.compare').length, 2);
  });
});

test('a duplicate idempotency key is forwarded twice: the service owns dedupe', async () => {
  await withServer(async (port, stub) => {
    const body = { profileId: 'uc03-runtime-evaluation-v1', idempotencyKey: 'key-dup', source: { kind: 'catalog', caseIds: ['case-001'] } };
    const first = await mutation(port, '/api/experiments', body);
    const second = await mutation(port, '/api/experiments', body);
    assert.equal(first.body, second.body);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(
      stub.calls.map(entry => entry.method),
      ['startExperiment', 'startExperiment'],
    );
    const inputs = stub.calls.map(entry => (entry.input as { idempotencyKey: string }).idempotencyKey);
    assert.deepEqual(inputs, ['key-dup', 'key-dup']);
  });
});

test('service failures map to status with a safe reason code and no request echo', async () => {
  await withServer(async (port, stub) => {
    (stub.service as unknown as { startExperiment: EvaluationService['startExperiment'] }).startExperiment = async input => (
      stub.calls.push({ method: 'startExperiment', input }),
      { ok: false, status: 'blocked', reasonCode: 'PROFILE_MISMATCH' }
    );
    const reply = await mutation(port, '/api/experiments', { profileId: 'other', idempotencyKey: 'key-1', source: { kind: 'catalog', caseIds: ['case-001'] } });
    assert.equal(reply.status, 503);
    assert.deepEqual(JSON.parse(reply.body), { ok: false, error: 'PROFILE_MISMATCH' });
    assert.equal(reply.body.includes('case-001'), false);
  });
});

test('no-store is set and no CORS header appears on success or denial', async () => {
  await withServer(async port => {
    const success = await call(port, 'GET', '/api/catalog', { headers: { host: `127.0.0.1:${port}` } });
    const denied = await call(port, 'GET', '/api/catalog', { headers: { host: 'evil.test' } });
    const page = await call(port, 'GET', '/', {});
    for (const reply of [success, denied, page]) {
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['access-control-allow-origin'], undefined);
      assert.equal(reply.headers['access-control-allow-credentials'], undefined);
    }
    assert.equal(success.status, 200);
    // Readiness only: the host-only fixture and grader paths never reach the browser.
    assert.equal(success.body.includes('C:/host-only'), false);
    assert.equal(page.body.includes('http://') || page.body.includes('https://'), false);
  });
});

test('artifact allowlist serves a known digest, refuses unknown, oversized or tampered entries', async () => {
  const text = 'def divide(a, b):\n    return a / b\n';
  const big = 'x'.repeat(1024 * 1024 + 1);
  const artifacts = new Map<string, ConsoleArtifact>([
    ['artifact-1', { text, taskId: 'task-001', digest: sha256Text(text), mediaType: 'text/plain' }],
    ['artifact-big', { text: big, taskId: 'task-001', digest: sha256Text(big), mediaType: 'text/plain' }],
    ['artifact-bad', { text, taskId: 'task-001', digest: digest('other'), mediaType: 'text/plain' }],
    ['artifact-html', { text, taskId: 'task-001', digest: sha256Text(text), mediaType: 'text/html' }],
  ]);
  await withServer(async port => {
    const known = await call(port, 'GET', '/api/artifacts/artifact-1', { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(known.status, 200);
    assert.equal(JSON.parse(known.body).result.digest, sha256Text(text));
    assert.equal(JSON.parse(known.body).result.text, text);

    assert.equal((await call(port, 'GET', '/api/artifacts/unknown', { headers: { host: `127.0.0.1:${port}` } })).status, 404);
    assert.equal((await call(port, 'GET', '/api/artifacts/artifact-big', { headers: { host: `127.0.0.1:${port}` } })).status, 409);
    assert.equal((await call(port, 'GET', '/api/artifacts/artifact-bad', { headers: { host: `127.0.0.1:${port}` } })).status, 409);
    assert.equal((await call(port, 'GET', '/api/artifacts/artifact-html', { headers: { host: `127.0.0.1:${port}` } })).status, 409);
  }, artifacts);
});

test('mutations are serialised: concurrent requests reach the stub strictly sequentially', async () => {
  await withServer(async (port, stub) => {
    stub.state.delay = 25;
    const order: string[] = [];
    const original = stub.service.answerClarification.bind(stub.service);
    stub.service.answerClarification = async input => {
      order.push(`enter:${(input as { idempotencyKey: string }).idempotencyKey}`);
      const result = await original(input);
      order.push(`exit:${(input as { idempotencyKey: string }).idempotencyKey}`);
      return result;
    };
    const make = (key: string) => ({ idempotencyKey: key, questionId: 'q-1', questionDigest: digest('q'), expectedVersion: 1, answers: ['a'] });
    const [first, second] = await Promise.all([mutation(port, '/api/experiments/exp-001/answers', make('key-a')), mutation(port, '/api/experiments/exp-001/answers', make('key-b'))]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(order, ['enter:key-a', 'exit:key-a', 'enter:key-b', 'exit:key-b']);
  });
});

test('a rejected mutation does not break the serialisation chain', async () => {
  await withServer(async (port, stub) => {
    const failing = await mutation(port, '/api/experiments/exp-001/answers', { idempotencyKey: 'key-bad' });
    assert.equal(failing.status, 200);
    (stub.service as unknown as { answerClarification: EvaluationService['answerClarification'] }).answerClarification = async () => {
      throw new Error('owner failure');
    };
    const thrown = await mutation(port, '/api/experiments/exp-001/answers', { idempotencyKey: 'key-throws' });
    assert.equal(thrown.status, 500);
    (stub.service as unknown as { answerClarification: EvaluationService['answerClarification'] }).answerClarification = async input => {
      stub.calls.push({ method: 'answerClarification', input });
      return { ok: true, value: { experiment: view('exp-001'), receipt: receipt('key-after', 'exp-001') } };
    };
    const after = await mutation(port, '/api/experiments/exp-001/answers', { idempotencyKey: 'key-after' });
    assert.equal(after.status, 200);
    assert.equal(stub.calls.at(-1)?.method, 'answerClarification');
  });
});
