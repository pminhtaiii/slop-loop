import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveryScenario, recoveryProfile } from '../support/uc05/mock-recovery.ts';
import { ApprovalServiceError, createApprovalService } from '../../../src/approvals/service.ts';
import { createApprovalContinuation } from '../../../src/approvals/control.ts';
import type { ApprovalService, ApprovalStore } from '../../../src/approvals/service.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { buildPresentation } from '../../../src/approvals/presentation.ts';
import { SanitizedTelemetry } from '../../../src/foundation/telemetry.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';

async function entries(service: ApprovalService): Promise<readonly Record<string, unknown>[]> {
  const first = await service.history('task-1', 1);
  const all = JSON.parse(first.content) as Record<string, unknown>[];
  for (let page = 2; page <= first.pageCount; page += 1) {
    const next = await service.history('task-1', page);
    assert.equal(next.snapshotDigest, first.snapshotDigest);
    all.push(...JSON.parse(next.content) as Record<string, unknown>[]);
  }
  return all;
}

function configuredService(scenario: ReturnType<typeof createRecoveryScenario>, profile: PolicyProfile = recoveryProfile, store: ApprovalStore = scenario.store): ApprovalService {
  return createApprovalService({ taskId: 'task-1', profile, store,
    context: { loadForAction: async () => scenario.current(), loadForDecision: async () => scenario.current() },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } }, now: () => '2026-10-21T00:00:00Z' });
}

test('request receipt without its committed outbox event closes authority even on a reconstructed service', async () => {
  const scenario = createRecoveryScenario();
  const backend = { ...scenario.store, readEvents: (id: string) => ({ ...scenario.store.readEvents(id), value: [] }) };
  const service = scenario.service(backend);
  await assert.rejects(service.requestDecision(scenario.binding), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  assert.equal(scenario.store.readRequest('decision-1').value?.decisionId, 'decision-1');
  await assert.rejects(scenario.service(backend).resolve('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
});

test('decision acknowledgement requires the exact committed event while retaining accepted consent', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  const backend = { ...scenario.store, readEvents: (id: string) => {
    const response = scenario.store.readEvents(id);
    return { ...response, value: response.value?.filter(event => event.type !== 'human-resolution-recorded') ?? null };
  } };
  await assert.rejects(scenario.decide(scenario.service(backend)), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions[0]?.decision, 'approved');
  const restored = scenario.service(backend);
  assert.equal(await restored.validateBinding({ ...scenario.binding, status: 'approved' }), false);
  await assert.rejects(restored.resolve('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
});

test('history preserves committed request and consent separately from unknown execution after freshness drift', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  const changed = `sha256:${'b'.repeat(64)}`;
  const current = scenario.current();
  scenario.setContext({ ...current, facts: { ...current.facts, repositoryRevisionDigest: changed }, freshness: { ...current.freshness, currentRepositoryRevisionDigest: changed } });
  const page = await service.history('task-1', 1);
  const entries = JSON.parse(page.content) as readonly Record<string, unknown>[];
  assert.equal(entries.find(entry => entry['kind'] === 'request')?.['decisionId'], 'decision-1');
  assert.equal(entries.find(entry => entry['kind'] === 'resolution')?.['decision'], 'approved');
  assert.equal(entries.find(entry => entry['kind'] === 'current-assessment')?.['status'], 'stale');
  assert.equal(entries.find(entry => entry['kind'] === 'execution')?.['status'], 'unknown');
  assert.equal(page.truncated, false);
});

test('history separates allowed required and forbidden current classifications from committed consent', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  assert.equal((await entries(service)).find(entry => entry['kind'] === 'current-assessment')?.['classification'], 'APPROVAL_REQUIRED');
  const current = scenario.current();
  const allowed = { ...current.action, kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/'], workingDirectory: '/workspace' };
  scenario.setContext({ ...current, action: allowed, facts: { ...current.facts, registeredActionDigest: computeActionDigest(allowed) }, freshness: { ...current.freshness, currentNormalizedActionDigest: computeActionDigest(allowed) } });
  assert.equal((await entries(service)).find(entry => entry['kind'] === 'current-assessment')?.['classification'], 'ALLOWED');
  scenario.setContext({ ...current, facts: { ...current.facts, safety: { ...current.facts.safety, testsPreserved: false } } });
  const denied = (await entries(service)).find(entry => entry['kind'] === 'current-assessment');
  assert.equal(denied?.['classification'], 'FORBIDDEN');
  assert.equal(denied?.['status'], 'denied');
});

test('claim uncertain effect and reconciliation metadata never establishes verified completion', async () => {
  for (const outcome of ['dispatch-effect-observed', 'claim-reconciled'] as const) {
    const scenario = createRecoveryScenario();
    const service = scenario.service();
    await service.requestDecision(scenario.binding);
    await scenario.decide(service);
    const continuation = createApprovalContinuation({ taskId: 'task-1', approval: service, profile: recoveryProfile, recovery: scenario.owner });
    assert.equal((await continuation.admit('decision-1')).outcome, 'claimed');
    let projected = await entries(service);
    assert.equal(projected.find(entry => entry['kind'] === 'claim')?.['phase'], 'claimed');
    assert.equal(projected.find(entry => entry['kind'] === 'execution')?.['status'], 'unknown');
    const version = scenario.store.loadTaskControl('task-1').value?.version;
    assert.equal(typeof version, 'number');
    if (outcome === 'claim-reconciled') {
      scenario.store.recordOutcome({ claimId: 'claim-1', expectedControlVersion: version, phase: 'uncertain', resultRef: 'result-uncertain', event: scenario.event('dispatch-uncertain', 'claim-1') });
      projected = await entries(service);
      assert.equal(projected.find(entry => entry['kind'] === 'execution')?.['status'], 'uncertain');
      scenario.store.reconcile({ claimId: 'claim-1', expectedControlVersion: scenario.store.loadTaskControl('task-1').value?.version, resultRef: 'result-reconciled', event: scenario.event('claim-reconciled', 'claim-1') });
    } else {
      scenario.store.recordOutcome({ claimId: 'claim-1', expectedControlVersion: version, phase: 'observed', resultRef: 'result-observed', event: scenario.event('dispatch-effect-observed', 'claim-1') });
    }
    projected = await entries(service);
    assert.equal(projected.find(entry => entry['kind'] === 'claim')?.['resultRef'], outcome === 'claim-reconciled' ? 'result-reconciled' : 'result-observed');
    assert.equal(projected.find(entry => entry['kind'] === 'execution')?.['verifiedCompletion'], 'unknown');
    assert.equal(projected.some(entry => entry['kind'] === 'event' && entry['type'] === outcome), true);
  }
});

test('known cancelled failed and completed activity remains owner evidence separate from verified action success', async () => {
  for (const state of ['cancelled', 'failed', 'completed', 'uncertain', 'cancellation-requested'] as const) {
    const scenario = createRecoveryScenario();
    const original = scenario.service();
    await original.requestDecision(scenario.binding);
    await scenario.decide(original, 'reject');
    const service = createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: scenario.store,
      context: { loadForAction: async () => scenario.current(), loadForDecision: async () => scenario.current() },
      operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
      observations: { provenance: 'mock', read: async () => [{ observationId: 'observation-1', taskId: 'task-1', runId: 'run-1', decisionId: 'decision-1', attemptId: 'attempt-1', claimId: null, state, observedAt: '2026-10-21T00:00:00Z', evidenceRef: 'owner-evidence-1' }] } });
    const projected = await entries(service);
    assert.equal(projected.find(entry => entry['kind'] === 'activity-observation')?.['state'], state);
    assert.equal(projected.find(entry => entry['kind'] === 'execution')?.['verifiedCompletion'], 'unknown');
    assert.equal(projected.find(entry => entry['kind'] === 'resolution')?.['decision'], 'rejected');
  }
});

test('history rejects unavailable mismatched duplicate foreign and exotic journal records without executing traps', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  const original = scenario.store.readEvents('task-1');
  const event = original.value?.[0];
  assert.ok(event);
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { calls += 1; return original.value; } });
  const proxy = new Proxy(original, { ownKeys: () => { calls += 1; throw new Error('RAW_TOOL_STREAM'); } });
  const payloads: readonly unknown[] = [
    { ...original, value: [] },
    { ...original, value: [event, event] },
    { ...original, value: [{ ...event, taskId: 'foreign-task' }] },
    { ...original, value: [{ ...event, timestamp: '2026-10-22T00:00:00Z' }] },
    { ...original, value: [{ ...event, rawPrompt: 'RAW_PROMPT_MARKER' }] },
    { ...original, value: [null] },
    { ...original, value: Array(1) },
    { ...original, safe: { ...original.safe, outcome: 'unavailable' } }, accessor, proxy,
  ];
  for (const payload of payloads) {
    // Deliberately malformed adapter data must be admitted as unknown before any property access.
    const backend = { ...scenario.store, readEvents: () => payload as ReturnType<typeof scenario.store.readEvents> };
    const consumer = scenario.service(backend);
    await assert.rejects(consumer.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && !error.message.includes('RAW'));
    await assert.rejects(consumer.resolve('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  }
  const missing: ApprovalStore = { ...scenario.store };
  delete missing.readEvents;
  await assert.rejects(scenario.service(missing).history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  assert.equal(calls, 0);
  assert.equal((await service.list('task-1')).control.mode, 'waiting');
});

test('aggregate history bounds include UTF-8 entries and every page envelope without truncation', async () => {
  const scenario = createRecoveryScenario();
  const current = scenario.current();
  scenario.setContext({ ...current, elements: { ...current.elements, necessity: 'Kiá»ƒm chá»©ng Ä‘áº§y Ä‘á»§ æ—¥æœ¬èªž' } });
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  await service.requestDecision({ ...scenario.binding, decisionId: 'decision-2' });
  const paged = configuredService(scenario, { ...recoveryProfile, maxPresentationPageBytes: 4096, maxPresentationTotalBytes: 12288 });
  const first = await paged.history('task-1', 1);
  assert.ok(first.pageCount > 1);
  const pages = [first];
  for (let page = 2; page <= first.pageCount; page += 1) pages.push(await paged.history('task-1', page));
  assert.equal(pages.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0), first.totalBytes);
  assert.ok(first.totalBytes <= recoveryProfile.maxPresentationTotalBytes);
  for (const value of pages) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= recoveryProfile.maxPresentationPageBytes);
    assert.equal(value.truncated, false);
    assert.equal(value.snapshotDigest, first.snapshotDigest);
    assert.ok(Array.isArray(JSON.parse(value.content)));
  }
  assert.equal((await entries(service)).filter(value => value['kind'] === 'request').length, 2);
  const tiny = configuredService(scenario, { ...recoveryProfile, maxPresentationTotalBytes: 1000 });
  await assert.rejects(tiny.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'denied');
  const onePage = configuredService(scenario, { ...recoveryProfile, maxPresentationPageBytes: 4096, maxPresentationPages: 1, maxPresentationTotalBytes: 4096 });
  await assert.rejects(onePage.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'denied');
  for (const page of [0, -1, NaN, 1.5, first.pageCount + 1]) await assert.rejects(paged.history('task-1', page), error => error instanceof ApprovalServiceError && error.outcome === 'invalid');
  await assert.rejects(service.history('foreign-task', 1), error => error instanceof ApprovalServiceError && error.outcome === 'invalid');
});

test('presentation rejects proxy records before executing reflective input traps', () => {
  const scenario = createRecoveryScenario();
  const current = scenario.current();
  let calls = 0;
  const action = new Proxy(current.action, { getPrototypeOf: () => { calls += 1; throw new Error('RAW_PROMPT'); } });
  assert.throws(() => buildPresentation({ requestVersion: 1, action, binding: scenario.binding, freshness: current.freshness, repositoryId: 'repository-1', continuationRef: 'continuation-1', policyIdentity: recoveryProfile.policyIdentity, elements: current.elements }, recoveryProfile), /unsafe-presentation/u);
  assert.equal(calls, 0);
});

test('lost committed response and best effort telemetry failure preserve immutable consent and retry identity', async () => {
  const scenario = createRecoveryScenario();
  const original = scenario.service();
  await original.requestDecision(scenario.binding);
  const lost = { ...scenario.store, resolvePending: (input: unknown) => { scenario.store.resolvePending(input); throw new Error('RAW_TOOL_STREAM'); } };
  await assert.rejects(scenario.decide(scenario.service(lost)), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && !error.message.includes('RAW'));
  const committed = scenario.store.readHistory('task-1').value?.resolutions[0];
  assert.equal(committed?.decision, 'approved');
  const before = scenario.store.readEvents('task-1').value;
  const telemetry = new SanitizedTelemetry({ provenance: 'mock', sink: () => { throw new Error('best-effort-sink-offline'); } });
  await assert.rejects(telemetry.emitActivity({ eventId: 'trace-1', taskId: 'task-1', runId: 'run-1', node: 'approval', actionType: 'decision-recorded', outcome: 'pass', durationMs: 0, timestamp: '2026-10-21T00:00:00Z', evidenceRefs: ['decision-1'] }), /best-effort-sink-offline/u);
  const current = scenario.current();
  scenario.setContext({ ...current, runId: 'run-2' });
  const reload = scenario.service();
  await scenario.decide(reload);
  assert.deepEqual(scenario.store.readHistory('task-1').value?.resolutions, [committed]);
  assert.deepEqual(scenario.store.readEvents('task-1').value, before);
  assert.equal((await entries(reload)).find(entry => entry['kind'] === 'resolution')?.['eventId'], committed?.eventId);
});

test('definite journal transaction failures and lost pending commits grant no authority', async () => {
  for (const operation of ['createPendingAndPause', 'resolvePending'] as const) {
    const scenario = createRecoveryScenario();
    const service = scenario.service();
    if (operation === 'resolvePending') await service.requestDecision(scenario.binding);
    scenario.store.failNext(operation);
    if (operation === 'createPendingAndPause') {
      await assert.rejects(service.requestDecision(scenario.binding), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
      assert.equal(scenario.store.readRequest('decision-1').value, null);
      assert.deepEqual(scenario.store.readEvents('task-1').value, []);
    } else {
      const view = await service.show('task-1', 'decision-1');
      const result = await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-approve' });
      assert.equal(result.outcome, 'unavailable');
      assert.equal((await service.list('task-1')).control.mode, 'waiting');
      assert.deepEqual(scenario.store.readHistory('task-1').value?.resolutions, []);
    }
    assert.equal(await service.validateBinding({ ...scenario.binding, status: 'approved' }), false);
  }
  const scenario = createRecoveryScenario();
  const lost = { ...scenario.store, createPendingAndPause: (input: unknown) => { scenario.store.createPendingAndPause(input); throw new Error('RAW_PROMPT'); } };
  await assert.rejects(scenario.service(lost).requestDecision(scenario.binding), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  const reload = scenario.service();
  assert.equal((await reload.list('task-1')).control.mode, 'waiting');
  assert.equal((await entries(reload)).find(entry => entry['kind'] === 'request')?.['decisionId'], 'decision-1');
  assert.equal((await reload.resolve('decision-1')).status, 'pending');
});

test('foreign or duplicate resolutions cannot be hidden by filtering the requested decision', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  const history = scenario.store.readHistory('task-1');
  assert.ok(history.value);
  const resolution = history.value.resolutions[0];
  assert.ok(resolution);
  for (const injected of [{ ...resolution, decisionId: 'foreign-decision' }, { ...resolution, safeReasonCode: 'MARKER_SECRET_HISTORY' }]) {
    const backend = { ...scenario.store, readHistory: () => ({ ...history, value: { ...history.value, resolutions: [resolution, injected] } }) };
    const consumer = scenario.service(backend);
    assert.equal(await consumer.validateBinding({ ...scenario.binding, status: 'approved' }), false);
  }
});

test('owner observations reject secrets raw payloads foreign identities duplicates terminal controls and exotic records', async () => {
  const scenario = createRecoveryScenario();
  await scenario.service().requestDecision(scenario.binding);
  const observation = { observationId: 'observation-1', taskId: 'task-1', runId: 'run-1', decisionId: 'decision-1', attemptId: 'attempt-1', claimId: null, state: 'cancelled', observedAt: '2026-10-21T00:00:00Z', evidenceRef: 'evidence-1' };
  let calls = 0;
  const proxy = new Proxy(observation, { getPrototypeOf: () => { calls += 1; throw new Error('RAW_TOOL_STREAM'); } });
  const accessor = Object.defineProperty({ ...observation }, 'state', { enumerable: true, get: () => { calls += 1; return 'cancelled'; } });
  const payloads: readonly unknown[] = [
    [{ ...observation, taskId: 'foreign' }], [{ ...observation, decisionId: 'foreign' }], [{ ...observation, claimId: 'missing' }],
    [observation, observation], [{ ...observation, evidenceRef: 'MARKER_SECRET_OBSERVATION' }],
    [{ ...observation, rawPrompt: 'RAW_PROMPT_MARKER' }], [{ ...observation, rawToolStream: 'RAW_TOOL_STREAM_MARKER' }],
    [{ ...observation, evidenceRef: '\u001b]52;c;YQ==\u0007' }], [{ ...observation, state: '\u202ecompleted' }],
    [null], [new Date()], [accessor], [proxy], Array(1), Array.from({ length: 129 }, () => observation),
  ];
  for (const payload of payloads) {
    const service = createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: scenario.store,
      context: { loadForAction: async () => scenario.current(), loadForDecision: async () => scenario.current() },
      operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
      observations: { provenance: 'mock', read: async () => payload } });
    await assert.rejects(service.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.message === 'approval-operation-denied');
  }
  assert.equal(calls, 0);
});

test('presentation refuses secret ANSI OSC bidi and over-bound complete details without writing a request', async () => {
  for (const payload of ['MARKER_SECRET_APPROVAL', '\u001b[31mapprove', '\u001b]52;c;YQ==\u0007', '\u202eapprove', 'å¤§'.repeat(9000)]) {
    const scenario = createRecoveryScenario();
    const current = scenario.current();
    scenario.setContext({ ...current, elements: { ...current.elements, necessity: payload } });
    const service = scenario.service();
    await assert.rejects(service.requestDecision(scenario.binding), error => error instanceof ApprovalServiceError && error.outcome === 'denied');
    assert.equal(scenario.store.readRequest('decision-1').value, null);
    assert.deepEqual(scenario.store.readEvents('task-1').value, []);
  }
});

test('torn owner snapshots are unavailable and current context failure leaves immutable metadata inspectable', async () => {
  const scenario = createRecoveryScenario();
  await scenario.service().requestDecision(scenario.binding);
  let reads = 0;
  const backend = { ...scenario.store, loadTaskControl: (taskId: string) => {
    const result = scenario.store.loadTaskControl(taskId);
    reads += 1;
    return reads > 2 && result.value ? { ...result, value: { ...result.value, version: result.value.version + 1 } } : result;
  } };
  await assert.rejects(scenario.service(backend).history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  const consumer = createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: scenario.store,
    context: { loadForAction: async () => { throw new Error('RAW_TOOL_STREAM'); }, loadForDecision: async () => { throw new Error('RAW_PROMPT'); } },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } } });
  const projected = await entries(consumer);
  assert.equal(projected.find(entry => entry['kind'] === 'request')?.['createdAt'], '2026-10-21T00:00:00Z');
  assert.equal(projected.find(entry => entry['kind'] === 'current-assessment')?.['status'], 'unknown');
  assert.equal(JSON.stringify(projected).includes('RAW_'), false);
});

test('failed history detail observation preserves binding validation and attempt admission on the same service', async () => {
  const scenario = createRecoveryScenario();
  const activity = createMockActivityControl(recoveryProfile);
  let detailsUnavailable = false;
  const service = createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: scenario.store, activity,
    context: { loadForAction: async () => scenario.current(), loadForDecision: async () => {
      if (detailsUnavailable) throw new Error('RAW_PROMPT');
      return scenario.current();
    } },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } }, now: () => '2026-10-21T00:00:00Z' });
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  const approved = { ...scenario.binding, status: 'approved' as const };
  assert.equal(await service.validateBinding(approved), true);
  const before = await service.list('task-1');
  detailsUnavailable = true;
  const projected = await entries(service);
  assert.equal(projected.find(entry => entry['kind'] === 'resolution')?.['decision'], 'approved');
  assert.equal(projected.find(entry => entry['kind'] === 'current-assessment')?.['status'], 'unknown');
  assert.equal(projected.find(entry => entry['kind'] === 'current-assessment')?.['classification'], 'unknown');
  assert.equal(JSON.stringify(projected).includes('RAW_'), false);
  detailsUnavailable = false;
  assert.deepEqual(await service.list('task-1'), before);
  const valid = await service.validateBinding(approved);
  const admitted = service.admitAttempt('attempt-after-history', {
    schemaVersion: 'uc05-approval/0.1-draft', claimId: 'claim-after-history', actionId: scenario.current().action.actionId,
    taskId: 'task-1', expectedControlVersion: before.control.version, expectedEpoch: before.control.epoch,
    repositoryStateDigest: approved.repositoryRevisionDigest, policyIdentity: recoveryProfile.policyIdentity,
    decisionRefs: [approved.decisionId], reservationRefs: ['reservation-1'], phase: 'claimed', resultRef: null,
  });
  assert.deepEqual({ valid, admitted }, { valid: true, admitted: true });
  assert.equal(activity.inspectOutstanding('task-1')[0]?.attemptId, 'attempt-after-history');
  assert.deepEqual(activity.readEffectLog(), []);
});

test('terminal journal provenance is identical for authority and history while later decision runs remain valid', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  scenario.setContext({ ...scenario.current(), runId: 'run-2' });
  await scenario.decide(service);
  const committed = scenario.store.readEvents('task-1');
  for (const mutation of [{ runId: null }, { policyRef: { ...recoveryProfile.policyIdentity, configId: 'foreign-config' } }]) {
    const backend = { ...scenario.store, readEvents: () => ({ ...committed, value: committed.value?.map(event => event.type === 'human-resolution-recorded' ? { ...event, ...mutation } : event) ?? null }) };
    const consumer = scenario.service(backend);
    await assert.rejects(consumer.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
    assert.equal(await consumer.validateBinding({ ...scenario.binding, status: 'approved' }), false);
  }
  assert.equal(await service.validateBinding({ ...scenario.binding, status: 'approved' }), true);
  assert.equal((await entries(service)).find(entry => entry['type'] === 'human-resolution-recorded')?.['runId'], 'run-2');
});

test('claim journal transitions require linked owner policy non-null runs and matching uncertainty outcomes', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  await createApprovalContinuation({ taskId: 'task-1', approval: service, recovery: scenario.owner, profile: recoveryProfile }).admit('decision-1');
  scenario.store.recordOutcome({ claimId: 'claim-1', expectedControlVersion: scenario.store.loadTaskControl('task-1').value?.version, phase: 'uncertain', resultRef: 'result-uncertain', event: scenario.event('dispatch-uncertain', 'claim-1') });
  const original = scenario.store.readEvents('task-1');
  for (const mutate of [
    (event: NonNullable<typeof original.value>[number]) => event.type === 'dispatch-uncertain' ? { ...event, outcome: 'ok' as const } : event,
    (event: NonNullable<typeof original.value>[number]) => event.type === 'dispatch-claim-created' ? { ...event, policyRef: { ...event.policyRef, policyId: 'foreign-policy' } } : event,
    (event: NonNullable<typeof original.value>[number]) => event.type === 'dispatch-claim-created' ? { ...event, runId: null } : event,
    (event: NonNullable<typeof original.value>[number]) => event.type === 'dispatch-uncertain' ? { ...event, decisionId: 'decision-1' } : event,
  ]) {
    const backend = { ...scenario.store, readEvents: () => ({ ...original, value: original.value?.map(mutate) ?? null }) };
    await assert.rejects(scenario.service(backend).history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  }
});

test('orphan or semantically inconsistent assessment and direction events are not committed history', async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  const original = scenario.store.readEvents('task-1');
  const base = original.value?.[0];
  assert.ok(base);
  const backend = { ...scenario.store, readEvents: () => ({ ...original, value: [...original.value ?? [], { ...base, eventId: 'orphan-assessment', type: 'binding-assessed' as const, outcome: 'stale' as const, safeReasonCode: 'binding-stale' }] }) };
  assert.equal(await scenario.service(backend).validateBinding({ ...scenario.binding, status: 'approved' }), false);
  await assert.rejects(scenario.service(backend).history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
});

test('one bounded current-detail observation batch preserves immutable history when every provider hangs', { timeout: 4000 }, async () => {
  const scenario = createRecoveryScenario();
  const service = scenario.service();
  await service.requestDecision(scenario.binding);
  await scenario.decide(service);
  await service.requestDecision({ ...scenario.binding, decisionId: 'decision-2' });
  const consumer = createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store: scenario.store,
    context: { loadForAction: async () => new Promise<never>(() => { /* Simulated permanently unavailable details. */ }), loadForDecision: async () => new Promise<never>(() => { /* Simulated permanently unavailable details. */ }) },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } } });
  const page = await consumer.history('task-1', 1);
  const projected = JSON.parse(page.content) as readonly Record<string, unknown>[];
  assert.equal(projected.find(entry => entry['kind'] === 'resolution')?.['decision'], 'approved');
  assert.equal(projected.some(entry => entry['kind'] === 'current-assessment' && entry['status'] === 'unknown'), true);
});

test('direction retry refuses corrupted journal provenance before acknowledging a recorded response', async () => {
  const scenario = createRecoveryScenario();
  const create = (store: ApprovalStore = scenario.store): ApprovalService => createApprovalService({ taskId: 'task-1', profile: recoveryProfile, store, activity: createMockActivityControl(recoveryProfile),
    context: { loadForAction: async () => scenario.current(), loadForDecision: async () => scenario.current(), loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: recoveryProfile.policyIdentity }) },
    operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } }, now: () => '2026-10-21T00:00:00Z' });
  const input = { taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'end-1' };
  assert.equal((await create().control(input)).outcome, 'paused');
  const original = scenario.store.readEvents('task-1');
  for (const mutation of [{ runId: null }, { outcome: 'ok' as const }, { timestamp: '2026-10-22T00:00:00Z' }]) {
    const consumer = create({ ...scenario.store, readEvents: () => ({ ...original, value: original.value?.map(event => ({ ...event, ...mutation })) ?? null }) });
    await assert.rejects(consumer.control(input), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
    await assert.rejects(consumer.history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  }
});

test('replacement assessment keeps the newer historical policy and rejects inconsistent reciprocal journal evidence', async () => {
  const scenario = createRecoveryScenario();
  await scenario.service().requestDecision(scenario.binding);
  const policyIdentity = { ...recoveryProfile.policyIdentity, configVersion: '2' };
  const current = scenario.current();
  scenario.setContext({ ...current, runId: 'run-2', facts: { ...current.facts, policyIdentity } });
  const profile = { ...recoveryProfile, policyIdentity };
  const service = configuredService(scenario, profile);
  await service.requestDecision({ ...scenario.binding, decisionId: 'decision-2' });
  const projected = await entries(service);
  assert.equal(projected.find(entry => entry['kind'] === 'assessment')?.['runId'], 'run-2');
  assert.equal((projected.find(entry => entry['type'] === 'binding-assessed')?.['policyRef'] as Record<string, unknown>)['configVersion'], '2');
  const original = scenario.store.readEvents('task-1');
  for (const mutation of [{ outcome: 'ok' as const }, { policyRef: { ...policyIdentity, configId: 'foreign-config' } }, { policyRef: recoveryProfile.policyIdentity }, { timestamp: '2026-10-22T00:00:00Z' }]) {
    const backend = { ...scenario.store, readEvents: () => ({ ...original, value: original.value?.map(event => event.type === 'binding-assessed' ? { ...event, ...mutation } : event) ?? null }) };
    await assert.rejects(configuredService(scenario, profile, backend).history('task-1', 1), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  }
});
