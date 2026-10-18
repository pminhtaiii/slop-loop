import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureLimits, type Question } from '../../../src/uc01/contracts.ts';
import { actionDigest, CallSpy, ScriptedUc01Ports, UC01_FIXTURE_PROFILE,
  operationContextDigest, type ModelRequest, type OperationContext, type SharedFailure } from '../support/uc01/ports.ts';

const context = (overrides: Partial<OperationContext> = {}): OperationContext => ({
  taskId: 'task', runId: 'run', invocationId: 'invocation', repositoryId: 'repo', workspaceId: 'workspace',
  repositorySnapshotDigest: 'a'.repeat(64), configId: 'config', configVersion: '1', policyId: 'policy', policyVersion: '1',
  operationId: 'operation', requestId: 'request', accountingRef: 'account', deadlineEpochMs: 5000, limits: fixtureLimits, ...overrides,
});
const failure = (status: SharedFailure['status'], reasonCode = 'scripted'): SharedFailure => ({ kind: 'failure', status, reasonCode, eventRef: 'event' });
const admissionFor = (value: OperationContext, kind: 'model' | 'read' | 'search', payload: unknown, admissionRef = 'admission') => {
  assert.match(actionDigest(kind, payload), /^[a-f0-9]{64}$/u);
  return { kind: 'admitted' as const, admissionRef, requestId: value.requestId, contextDigest: operationContextDigest(value) };
};
type Admitted = Extract<Awaited<ReturnType<ScriptedUc01Ports['guard']>>, { kind: 'admitted' }>;
const findingFor = (value: OperationContext, path: string) => ({ source: { path, revisionDigest: value.repositorySnapshotDigest,
  boundedExcerpt: 'safe excerpt', resultCount: 1, truncated: false }, location: { repositoryId: value.repositoryId,
  snapshotDigest: value.repositorySnapshotDigest, path, fileDigest: 'b'.repeat(64), startLine: 1, endLine: 1 },
  safeExcerptRef: 'excerpt', provenance: 'mock' as const });

test('mock profile is explicit, finite and cannot be promoted to real provenance', () => {
  assert.throws(() => new ScriptedUc01Ports({ taskId: 'task', now: () => 0 } as never), /profile/u);
  assert.throws(() => new ScriptedUc01Ports({ taskId: 'task', profile: { ...UC01_FIXTURE_PROFILE, profileId: 'production' } as unknown as typeof UC01_FIXTURE_PROFILE, now: () => 0 }), /profile/u);
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0 });
  assert.equal(ports.provenance, 'mock');
  assert.equal(ports.profile.profileId, 'uc01-fixture-v1');
  assert.equal(ports.profile.perInvocation.modelCalls, 4);
  assert.equal(ports.profile.perTask.modelCalls, 8);
  assert.equal('executeCommand' in ports, false);
});

test('denied, pending, stale and exhausted guards make no downstream model/read/search attempt', async () => {
  for (const status of ['denied', 'pending-approval', 'conflict', 'exhausted'] as const) {
    const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0,
      responses: { guard: [failure(status)] } });
    const current = context();
    const guard = await ports.guard(current, { kind: 'model', inputDigest: actionDigest('model', { role: 'triage' }) });
    assert.equal(guard.kind, 'failure');
    if (guard.kind === 'failure') assert.equal(guard.status, status);
    assert.deepEqual(ports.calls.snapshot().attempts, {
      guard: 1, reserve: 0, settle: 0, read: 0, search: 0, model: 0, bindContinuation: 0, resolveContinuation: 0, telemetry: 0,
    });
    assert.deepEqual(ports.calls.snapshot().dispatches, { read: 0, search: 0, model: 0 });
  }
});

test('invalid guard context does not consume the task invocation budget', async () => {
  const invocations = [
    context({ invocationId: 'invocation-1', requestId: 'request-1' }),
    context({ invocationId: 'invocation-2', requestId: 'request-2' }),
    context({ invocationId: 'invocation-3', requestId: 'request-3' }),
  ];
  const payload = { role: 'triage' };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0,
    responses: { guard: invocations.map((value, index) => admissionFor(value, 'model', payload, `admission-${index}`)) } });
  const rejected = await ports.guard(context({ taskId: 'foreign-task', invocationId: 'foreign-invocation' }),
    { kind: 'model', inputDigest: actionDigest('model', payload) });
  assert.equal(rejected.kind, 'failure');
  if (rejected.kind === 'failure') assert.deepEqual([rejected.status, rejected.reasonCode], ['conflict', 'foreign-task']);
  for (const value of invocations) {
    const admitted = await ports.guard(value, { kind: 'model', inputDigest: actionDigest('model', payload) });
    assert.equal(admitted.kind, 'admitted');
  }
  assert.equal(ports.calls.snapshot().taskUsage.invocations, 3);
  assert.equal(ports.calls.snapshot().attempts.guard, 4);
});

test('admitted model flow reserves, dispatches once and settles even an invalid-output failure in call order', async () => {
  const current = context();
  const request = { role: 'triage' as const, invocation: { invocationId: 'invocation' }, evidence: [], priorQuestions: [], catalog: { id: 'catalog' }, reservationRef: 'reservation' };
  const modelPayload = { role: request.role, invocation: request.invocation, evidence: request.evidence,
    priorQuestions: request.priorQuestions, catalog: request.catalog };
  const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUnits: 5, state: 'settled' as const, reservationRef: 'reservation' };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'model', modelPayload)],
    reserve: [{ kind: 'reserved', reservationRef: 'reservation', requestId: current.requestId }],
    model: [{ kind: 'failure', status: 'error', reasonCode: 'invalid-model-output', eventRef: 'model-event', usage }],
    settle: [{ kind: 'settled', accountingRef: 'account' }],
  } });
  const guard = await ports.guard(current, { kind: 'model', inputDigest: actionDigest('model', modelPayload) });
  assert.equal(guard.kind, 'admitted');
  if (guard.kind !== 'admitted') return;
  const reserved = await ports.reserve(current, guard, { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUnits: 200, pricingId: 'uc01-fixture-token-units-v1' });
  assert.equal(reserved.kind, 'reserved');
  const response = await ports.proposeAssessment(current, guard, request as unknown as ModelRequest);
  assert.equal(response.kind, 'failure');
  if (response.kind !== 'failure') return;
  const settled = await ports.settle(current, response.usage.reservationRef, response.usage);
  assert.equal(settled.kind, 'settled');
  assert.deepEqual(ports.calls.snapshot().taskUsage, {
    invocations: 1, modelCalls: 1, toolCalls: 0, inputTokens: 3, outputTokens: 2, totalTokens: 5, costUnits: 5,
  });
  assert.deepEqual(ports.calls.snapshot().calls.map(call => call.operation), ['guard', 'reserve', 'model', 'settle']);
  assert.deepEqual(ports.calls.snapshot().dispatches, { read: 0, search: 0, model: 1 });
  assert.equal(ports.calls.snapshot().calls.some(call => Object.hasOwn(call, 'report') || Object.hasOwn(call, 'prompt') || Object.hasOwn(call, 'expectedLabels')), false);
});

test('admission binds the snapshot and logical action and cannot be reused for stale read dispatch', async () => {
  const current = context();
  const path = 'src/issue.ts';
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'read', { path })],
    read: [{ kind: 'read', finding: findingFor(current, path) }],
  } });
  const guard = await ports.guard(current, { kind: 'read', inputDigest: actionDigest('read', { path }) });
  assert.equal(guard.kind, 'admitted');
  if (guard.kind !== 'admitted') return;
  const stale = await ports.readEvidence({ ...current, repositorySnapshotDigest: 'c'.repeat(64) }, guard, path);
  assert.equal(stale.kind, 'failure');
  if (stale.kind === 'failure') assert.equal(stale.status, 'conflict');
  assert.deepEqual(ports.calls.snapshot().dispatches, { read: 0, search: 0, model: 0 });
  assert.equal(ports.calls.snapshot().attempts.read, 1);
});

test('scripted search preserves truncation, bounds results and rejects real provenance', async () => {
  const current = context();
  const query = 'login failure';
  const truncatedPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'search', { query })], search: [{ kind: 'search', findings: [], truncated: true }],
  } });
  const searchAdmission = await truncatedPorts.guard(current, { kind: 'search', inputDigest: actionDigest('search', { query }) });
  assert.equal(searchAdmission.kind, 'admitted');
  if (searchAdmission.kind === 'admitted') {
    const result = await truncatedPorts.searchEvidence(current, searchAdmission, query);
    assert.deepEqual(result, { kind: 'search', findings: [], truncated: true });
  }
  assert.equal(truncatedPorts.calls.snapshot().dispatches.search, 1);

  const foreignFinding = { ...findingFor(current, 'src/issue.ts'), provenance: 'real' as const };
  const foreignPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'search', { query })], search: [{ kind: 'search', findings: [foreignFinding], truncated: false }],
  } });
  const foreignAdmission = await foreignPorts.guard(current, { kind: 'search', inputDigest: actionDigest('search', { query }) });
  assert.equal(foreignAdmission.kind, 'admitted');
  if (foreignAdmission.kind === 'admitted') {
    const result = await foreignPorts.searchEvidence(current, foreignAdmission, query);
    assert.equal(result.kind, 'failure');
    if (result.kind === 'failure') assert.equal(result.status, 'denied');
  }
  assert.equal(foreignPorts.calls.snapshot().dispatches.search, 1);
});

test('admitted read and search failures still consume finite calls and their admission', async () => {
  const current = context();
  const path = 'src/issue.ts';
  const readPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'read', { path })], read: [failure('error', 'read-failed')],
  } });
  const readAdmission = await readPorts.guard(current, { kind: 'read', inputDigest: actionDigest('read', { path }) });
  assert.equal(readAdmission.kind, 'admitted');
  if (readAdmission.kind === 'admitted') {
    const result = await readPorts.readEvidence(current, readAdmission, path);
    assert.equal(result.kind, 'failure');
    const replay = await readPorts.readEvidence(current, readAdmission, path);
    assert.equal(replay.kind, 'failure');
    if (replay.kind === 'failure') assert.equal(replay.status, 'conflict');
  }
  assert.deepEqual(readPorts.calls.snapshot().dispatches, { read: 1, search: 0, model: 0 });
  assert.equal(readPorts.calls.snapshot().attempts.read, 2);

  const query = 'login failure';
  const searchPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'search', { query })], search: [failure('error', 'search-failed')],
  } });
  const searchAdmission = await searchPorts.guard(current, { kind: 'search', inputDigest: actionDigest('search', { query }) });
  assert.equal(searchAdmission.kind, 'admitted');
  if (searchAdmission.kind === 'admitted') {
    const result = await searchPorts.searchEvidence(current, searchAdmission, query);
    assert.equal(result.kind, 'failure');
    const replay = await searchPorts.searchEvidence(current, searchAdmission, query);
    assert.equal(replay.kind, 'failure');
    if (replay.kind === 'failure') assert.equal(replay.status, 'conflict');
  }
  assert.deepEqual(searchPorts.calls.snapshot().dispatches, { read: 0, search: 1, model: 0 });
  assert.equal(searchPorts.calls.snapshot().attempts.search, 2);
});

test('read results must match the admitted repository path', async () => {
  const current = context();
  const requestedPath = 'src/requested.ts';
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'read', { path: requestedPath })],
    read: [{ kind: 'read', finding: findingFor(current, 'src/other.ts') }],
  } });
  const admitted = await ports.guard(current, { kind: 'read', inputDigest: actionDigest('read', { path: requestedPath }) });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind === 'admitted') {
    const result = await ports.readEvidence(current, admitted, requestedPath);
    assert.equal(result.kind, 'failure');
    if (result.kind === 'failure') assert.equal(result.status, 'denied');
  }
  assert.deepEqual(ports.calls.snapshot().dispatches, { read: 1, search: 0, model: 0 });
});

test('malformed model usage consumes its admission and reserved call budget once', async () => {
  const current = context();
  const payload = { role: 'triage', invocation: {}, evidence: [], priorQuestions: [], catalog: {} };
  const request = { ...payload, reservationRef: 'reservation' };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'model', payload)],
    reserve: [{ kind: 'reserved', reservationRef: 'reservation', requestId: current.requestId }],
    model: [{ kind: 'failure', status: 'error', reasonCode: 'bad-usage', eventRef: 'event', usage: {
      inputTokens: 5, outputTokens: 3, totalTokens: 8, costUnits: 8, state: 'settled', reservationRef: 'foreign-reservation',
    } }],
  } });
  const admitted = await ports.guard(current, { kind: 'model', inputDigest: actionDigest('model', payload) });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') return;
  const reservation = await ports.reserve(current, admitted, { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUnits: 150, pricingId: 'fixture' });
  assert.equal(reservation.kind, 'reserved');
  const first = await ports.proposeAssessment(current, admitted, request as unknown as ModelRequest);
  assert.equal(first.kind, 'failure');
  if (first.kind === 'failure') assert.equal(first.reasonCode, 'model-usage-reservation-binding');
  const replay = await ports.proposeAssessment(current, admitted, request as unknown as ModelRequest);
  assert.equal(replay.kind, 'failure');
  if (replay.kind === 'failure') assert.equal(replay.reasonCode, 'stale-or-reused-admission');
  assert.deepEqual(ports.calls.snapshot().dispatches, { read: 0, search: 0, model: 1 });
  assert.deepEqual(ports.calls.snapshot().taskUsage, {
    invocations: 1, modelCalls: 1, toolCalls: 0, inputTokens: 100, outputTokens: 50, totalTokens: 150, costUnits: 150,
  });
});

test('reservation ceilings accumulate per invocation and task, including uncertain holds', async () => {
  const values = [
    context({ invocationId: 'inv-1', requestId: 'req-1', operationId: 'op-1' }),
    context({ invocationId: 'inv-2', requestId: 'req-2', operationId: 'op-2' }),
    context({ invocationId: 'inv-2', requestId: 'req-3', operationId: 'op-3' }),
    context({ invocationId: 'inv-3', requestId: 'req-4', operationId: 'op-4' }),
  ];
  const payloads = values.map((_, index) => ({ role: 'triage', requestIndex: index }));
  const admissions = values.map((value, index) => admissionFor(value, 'model', payloads[index], `adm-${index}`));
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: admissions,
    reserve: [
      { kind: 'reserved', reservationRef: 'res-1', requestId: 'req-1' },
      { kind: 'reserved', reservationRef: 'res-2', requestId: 'req-2' },
    ],
  } });
  const firstCeiling = { inputTokens: 1500, outputTokens: 500, totalTokens: 2000, costUnits: 2000, pricingId: 'fixture' };
  const secondCeiling = { inputTokens: 1500, outputTokens: 500, totalTokens: 2000, costUnits: 2000, pricingId: 'fixture' };
  const invocationOverCeiling = { inputTokens: 600, outputTokens: 100, totalTokens: 700, costUnits: 700, pricingId: 'fixture' };
  const taskOverCeiling = { inputTokens: 1001, outputTokens: 1, totalTokens: 1002, costUnits: 1002, pricingId: 'fixture' };
  const accepted: { context: OperationContext; admission: Admitted }[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    const payload = payloads[index];
    assert.ok(value && payload);
    const admission = await ports.guard(value, { kind: 'model', inputDigest: actionDigest('model', payload) });
    assert.equal(admission.kind, 'admitted');
    if (admission.kind === 'admitted') accepted.push({ context: value, admission });
  }
  const first = accepted[0];
  const second = accepted[1];
  const third = accepted[2];
  const fourth = accepted[3];
  assert.ok(first && second && third && fourth);
  const firstReservation = await ports.reserve(first.context, first.admission, firstCeiling);
  assert.equal(firstReservation.kind, 'reserved');
  if (firstReservation.kind !== 'reserved') return;
  const uncertainUsage = { inputTokens: 400, outputTokens: 200, totalTokens: 600, costUnits: 600, state: 'uncertain' as const, reservationRef: firstReservation.reservationRef };
  assert.equal((await ports.settle(first.context, firstReservation.reservationRef, uncertainUsage)).kind, 'failure');
  assert.equal((await ports.reserve(second.context, second.admission, secondCeiling)).kind, 'reserved');
  const invocationOver = await ports.reserve(third.context, third.admission, invocationOverCeiling);
  assert.equal(invocationOver.kind, 'failure');
  if (invocationOver.kind === 'failure') assert.equal(invocationOver.status, 'exhausted');
  const taskOver = await ports.reserve(fourth.context, fourth.admission, taskOverCeiling);
  assert.equal(taskOver.kind, 'failure');
  if (taskOver.kind === 'failure') assert.equal(taskOver.status, 'exhausted');
  const taskCostOver = await ports.reserve(fourth.context, fourth.admission,
    { inputTokens: 1, outputTokens: 0, totalTokens: 1, costUnits: 2001, pricingId: 'fixture' });
  assert.equal(taskCostOver.kind, 'failure');
  if (taskCostOver.kind === 'failure') assert.equal(taskCostOver.status, 'exhausted');
  assert.deepEqual(ports.calls.snapshot().taskUsage, {
    invocations: 3, modelCalls: 0, toolCalls: 0, inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, costUnits: 4000,
  });
});

test('finite call spies preserve invocation and task usage across continuations and stop at the first over-limit guard', async () => {
  const spy = new CallSpy(UC01_FIXTURE_PROFILE);
  const taskId = 'task';
  for (let index = 0; index < 8; index++) spy.recordDispatch('model', context({ taskId, invocationId: `inv-${Math.floor(index / 4)}` }));
  assert.deepEqual(spy.snapshot().taskUsage, { invocations: 2, modelCalls: 8, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0 });
  assert.equal(spy.canDispatch(context({ taskId, invocationId: 'inv-1' }), 'model'), false);
  assert.equal(spy.canDispatch(context({ taskId, invocationId: 'inv-2' }), 'model'), false);
  assert.equal(spy.snapshot().taskUsage.invocations, 2);
});

test('the per-invocation model limit admits four calls and stops the fifth at guard', async () => {
  const contexts = Array.from({ length: 5 }, (_, index) => context({ invocationId: 'same-invocation', requestId: `req-${index}`, operationId: `op-${index}` }));
  const requests = contexts.map((value, index) => ({ role: 'triage' as const, invocation: { invocationId: value.invocationId, issueId: `issue-${index}` },
    evidence: [], priorQuestions: [], catalog: { id: 'catalog' }, reservationRef: `res-${index}` }));
  const payloads = requests.map(({ role, invocation, evidence, priorQuestions, catalog }) => ({ role, invocation, evidence, priorQuestions, catalog }));
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: contexts.map((value, index) => admissionFor(value, 'model', payloads[index], `adm-${index}`)),
    reserve: contexts.map((value, index) => ({ kind: 'reserved' as const, reservationRef: `res-${index}`, requestId: value.requestId })),
    model: requests.map((request, index) => ({ kind: 'failure' as const, status: 'error' as const, reasonCode: 'scripted', eventRef: `event-${index}`,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUnits: 2, state: 'settled' as const, reservationRef: request.reservationRef } })),
  } });
  const results = [];
  for (let index = 0; index < contexts.length; index++) {
    const value = contexts[index]; const request = requests[index]; const payload = payloads[index];
    assert.ok(value && request && payload);
    const admitted = await ports.guard(value, { kind: 'model', inputDigest: actionDigest('model', payload) });
    if (admitted.kind !== 'admitted') { results.push(admitted); continue; }
    await ports.reserve(value, admitted, { inputTokens: 2, outputTokens: 2, totalTokens: 4, costUnits: 4, pricingId: 'fixture' });
    results.push(await ports.proposeAssessment(value, admitted, request as unknown as ModelRequest));
  }
  assert.equal(results[3]?.kind, 'failure');
  assert.equal(results[4]?.kind === 'failure' && results[4].status, 'exhausted');
  assert.equal(ports.calls.snapshot().attempts.model, 4);
  assert.equal(ports.calls.snapshot().dispatches.model, 4);
});

test('scripted model and tool limits admit exact boundaries and deny one-over calls before downstream attempts', async () => {
  const modelContexts = Array.from({ length: 9 }, (_, index) => context({ invocationId: `model-inv-${Math.floor(index / 4)}`,
    requestId: `model-request-${index}`, operationId: `model-op-${index}` }));
  const modelRequests = modelContexts.map((value, index) => ({ role: 'triage' as const,
    invocation: { invocationId: value.invocationId, issueId: `issue-${index}` }, evidence: [], priorQuestions: [], catalog: { id: 'catalog' }, reservationRef: `model-res-${index}` }));
  const modelPayloads = modelRequests.map(({ role, invocation, evidence, priorQuestions, catalog }) => ({ role, invocation, evidence, priorQuestions, catalog }));
  const modelResponses = modelContexts.slice(0, 8).map((_, index) => ({ kind: 'failure' as const, status: 'error' as const,
    reasonCode: 'invalid-model-output', eventRef: `event-${index}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
      costUnits: 2, state: 'settled' as const, reservationRef: `model-res-${index}` } }));
  const modelPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: modelContexts.map((value, index) => admissionFor(value, 'model', modelPayloads[index], `model-adm-${index}`)),
    reserve: modelContexts.slice(0, 8).map((value, index) => ({ kind: 'reserved' as const, reservationRef: `model-res-${index}`, requestId: value.requestId })),
    model: modelResponses,
  } });
  const modelResults = [];
  for (let index = 0; index < modelContexts.length; index++) {
    const value = modelContexts[index]; const request = modelRequests[index]; const payload = modelPayloads[index];
    assert.ok(value && request && payload);
    const admitted = await modelPorts.guard(value, { kind: 'model', inputDigest: actionDigest('model', payload) });
    if (admitted.kind !== 'admitted') { modelResults.push(admitted); continue; }
    const reserved = await modelPorts.reserve(value, admitted, { inputTokens: 2, outputTokens: 2, totalTokens: 4, costUnits: 4, pricingId: 'fixture' });
    if (reserved.kind !== 'reserved') { modelResults.push(reserved); continue; }
    modelResults.push(await modelPorts.proposeAssessment(value, admitted, request as unknown as ModelRequest));
  }
  assert.deepEqual(modelResults.slice(0, 8).map(result => result.kind), Array(8).fill('failure'));
  assert.equal(modelResults[4]?.kind === 'failure' && modelResults[4].status, 'error');
  assert.equal(modelResults[8]?.kind === 'failure' && modelResults[8].status, 'exhausted');
  assert.deepEqual(modelPorts.calls.snapshot().dispatches, { read: 0, search: 0, model: 8 });
  assert.equal(modelPorts.calls.snapshot().attempts.model, 8);
  assert.deepEqual(modelPorts.calls.snapshot().taskUsage, { invocations: 3, modelCalls: 8, toolCalls: 0, inputTokens: 16, outputTokens: 16, totalTokens: 32, costUnits: 32 });

  const toolContexts = Array.from({ length: 14 }, (_, index) => context({ invocationId: `tool-inv-${index <= 6 ? 0 : index <= 12 ? 1 : 2}`,
    requestId: `tool-request-${index}`, operationId: `tool-op-${index}` }));
  const paths = toolContexts.map((_, index) => `src/file-${index}.ts`);
  const toolPorts = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: toolContexts.filter((_value, index) => index !== 6 && index !== 13)
      .map((value, index) => {
        const sourceIndex = index < 6 ? index : index + 1;
        return admissionFor(value, 'read', { path: paths[sourceIndex] }, `tool-adm-${sourceIndex}`);
      }),
    read: toolContexts.filter((_value, index) => index !== 6 && index !== 13).map((value, index) => {
      const sourceIndex = index < 6 ? index : index + 1;
      return { kind: 'read' as const, finding: findingFor(value, paths[sourceIndex] ?? 'src/file.ts') };
    }),
  } });
  const toolResults = [];
  for (let index = 0; index < toolContexts.length; index++) {
    const value = toolContexts[index]; const path = paths[index];
    assert.ok(value && path);
    const admitted = await toolPorts.guard(value, { kind: 'read', inputDigest: actionDigest('read', { path }) });
    toolResults.push(admitted.kind === 'admitted' ? await toolPorts.readEvidence(value, admitted, path) : admitted);
  }
  assert.equal(toolResults[6]?.kind === 'failure' && toolResults[6].status, 'exhausted');
  assert.equal(toolResults[13]?.kind === 'failure' && toolResults[13].status, 'exhausted');
  assert.deepEqual(toolResults.slice(0, 6).map(result => result.kind), Array(6).fill('read'));
  assert.deepEqual(toolResults.slice(7, 13).map(result => result.kind), Array(6).fill('read'));
  assert.deepEqual(toolPorts.calls.snapshot().dispatches, { read: 12, search: 0, model: 0 });
  assert.equal(toolPorts.calls.snapshot().attempts.read, 12);
  assert.deepEqual(toolPorts.calls.snapshot().taskUsage, { invocations: 3, modelCalls: 0, toolCalls: 12, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUnits: 0 });
});

test('uncertain usage remains charged without automatic redispatch and telemetry strips forbidden fields', async () => {
  const current = context();
  const modelPayload = { role: 'triage', invocation: {}, evidence: [], priorQuestions: [], catalog: {} };
  const usage = { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUnits: 6, state: 'uncertain' as const, reservationRef: 'uncertain-reservation' };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'model', modelPayload)],
    reserve: [{ kind: 'reserved', reservationRef: 'uncertain-reservation', requestId: current.requestId }],
    model: [{ kind: 'failure', status: 'uncertain', reasonCode: 'usage-unknown', eventRef: 'uncertain-event', usage }],
    settle: [{ kind: 'failure', status: 'uncertain', reasonCode: 'retain-reservation', eventRef: 'settlement-event' }],
    telemetry: [{ eventRef: 'safe-event' }],
  } });
  const guard = await ports.guard(current, { kind: 'model', inputDigest: actionDigest('model', modelPayload) });
  assert.equal(guard.kind, 'admitted');
  if (guard.kind !== 'admitted') return;
  await ports.reserve(current, guard, { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUnits: 200, pricingId: 'uc01-fixture-token-units-v1' });
  const response = await ports.proposeAssessment(current, guard, { ...modelPayload, reservationRef: 'uncertain-reservation' } as unknown as ModelRequest);
  assert.equal(response.kind, 'failure');
  if (response.kind !== 'failure') return;
  assert.equal(response.status, 'uncertain');
  await ports.settle(current, response.usage.reservationRef, response.usage);
  await ports.emitSafeEvent({ eventId: 'event', type: 'assessment', outcome: 'uncertain', durationMs: 10,
    counts: { modelCalls: 1, toolCalls: 0, evidenceItems: 0, questions: 0 }, configRef: 'config' });
  const snapshot = ports.calls.snapshot();
  assert.equal(snapshot.dispatches.model, 1);
  assert.equal(snapshot.taskUsage.modelCalls, 1);
  assert.equal(snapshot.safeEvents[0]?.outcome, 'uncertain');
  assert.equal(Object.hasOwn(snapshot.safeEvents[0] ?? {}, 'report'), false);
  assert.equal(snapshot.calls.filter(call => call.operation === 'model').length, 1);
});

test('call traces expose only operation and stable references, and do not retain case or model labels', () => {
  const spy = new CallSpy(UC01_FIXTURE_PROFILE);
  spy.recordAttempt('telemetry', context(), { kind: 'emitted' });
  const record = spy.snapshot().calls[0];
  assert.deepEqual(Object.keys(record ?? {}).sort(), ['operation', 'ordinal', 'requestId', 'resultKind']);
  assert.equal(Object.hasOwn(record ?? {}, 'classification'), false);
  assert.equal(Object.hasOwn(record ?? {}, 'report'), false);
});

test('the model-facing request rejects grader labels and telemetry refuses extra sensitive fields', async () => {
  const current = context();
  const baseRequest = { role: 'triage' as const, invocation: {} as never, evidence: [], priorQuestions: [], catalog: {} as never, reservationRef: 'res' };
  const payload = { role: baseRequest.role, invocation: baseRequest.invocation, evidence: baseRequest.evidence,
    priorQuestions: baseRequest.priorQuestions, catalog: baseRequest.catalog };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    guard: [admissionFor(current, 'model', payload)], reserve: [{ kind: 'reserved', reservationRef: 'res', requestId: current.requestId }],
  } });
  const guard = await ports.guard(current, { kind: 'model', inputDigest: actionDigest('model', payload) });
  assert.equal(guard.kind, 'admitted');
  if (guard.kind !== 'admitted') return;
  await ports.reserve(current, guard, { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUnits: 2, pricingId: 'fixture' });
  const result = await ports.proposeAssessment(current, guard,
    { ...baseRequest, expectedLabels: { classification: 'secret' } } as unknown as ModelRequest);
  assert.equal(result.kind, 'failure');
  if (result.kind === 'failure') assert.equal(result.reasonCode, 'model-visible-extra-fields');
  assert.equal(ports.calls.snapshot().dispatches.model, 0);
  assert.equal(JSON.stringify(ports.calls.snapshot()).includes('secret'), false);
  const unsafeEvent = { eventId: 'event', type: 'assessment', outcome: 'assessed', durationMs: 1,
    counts: { modelCalls: 1, toolCalls: 0, evidenceItems: 0, questions: 0 }, configRef: 'config', report: 'private source' };
  await assert.rejects(ports.emitSafeEvent(unsafeEvent as never), /Unsafe telemetry event shape/u);
  assert.equal(ports.calls.snapshot().safeEvents.length, 0);
});

test('caller-owned continuations bind to the prior assessment and reject stale identity without persistence claims', async () => {
  const current = context();
  const digest = 'd'.repeat(64);
  const questions: Question[] = [{ id: 'q', text: 'Which users are affected?', affects: ['scope'], reason: 'Changes impact' }];
  const assessment = { assessmentId: 'assessment', issueId: 'issue', reportDigest: digest, repositoryId: current.repositoryId,
    repositorySnapshotDigest: current.repositorySnapshotDigest, questions } as never;
  const continuation = { taskId: current.taskId, issueId: 'issue', reportDigest: digest, repositoryId: current.repositoryId,
    repositorySnapshotDigest: current.repositorySnapshotDigest, configId: current.configId, configVersion: current.configVersion,
    priorAssessmentId: 'assessment', questions };
  const ports = new ScriptedUc01Ports({ taskId: 'task', profile: UC01_FIXTURE_PROFILE, now: () => 0, responses: {
    bindContinuation: [{ kind: 'bound', continuationRef: 'continuation-ref' }],
    resolveContinuation: [{ kind: 'resolved', continuation }, { kind: 'resolved', continuation: { ...continuation, configVersion: '2' } }],
  } });
  const bound = await ports.bindContinuation(current, assessment);
  assert.deepEqual(bound, { kind: 'bound', continuationRef: 'continuation-ref' });
  const resolved = await ports.resolveContinuation(current, 'continuation-ref');
  assert.equal(resolved.kind, 'resolved');
  const stale = await ports.resolveContinuation(current, 'continuation-ref');
  assert.equal(stale.kind, 'failure');
  if (stale.kind === 'failure') assert.equal(stale.status, 'conflict');
  assert.deepEqual(ports.calls.snapshot().calls.map(call => call.operation), ['bindContinuation', 'resolveContinuation', 'resolveContinuation']);
});
