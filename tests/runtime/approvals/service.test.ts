import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { buildPresentation } from '../../../src/approvals/presentation.ts';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import type { ApprovalContext } from '../../../src/approvals/service.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' };
const profile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1',
  policyIdentity: identity, supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['pyproject.toml'], patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536, maxArgvEntries: 32, maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192, maxPresentationPages: 3, maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024, operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};
const action: NormalizedAction = { actionId: 'action-1', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' };
const binding = { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const };
const freshness = { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(action) };
const elements = { action: 'Run focused tests', necessity: 'Verify the proposed repair', targets: ['tests/other.py'], consequences: 'Runs isolated tests', verificationStatus: 'Not yet executed' };
const input = { requestVersion: 1, action, binding, freshness, repositoryId: 'repository-1', continuationRef: 'continuation-1', policyIdentity: identity, elements };

test('presentation binds five elements and complete exact command to the displayed digest', () => {
  const result = buildPresentation(input, profile);
  assert.deepEqual(result.summary.elements, elements);
  assert.equal(result.pages.join(''), JSON.stringify(action));
  const changed = buildPresentation({ ...input, elements: { ...elements, necessity: 'Different purpose' } }, profile);
  assert.notEqual(result.summary.presentationDigest, changed.summary.presentationDigest);
});

function setup() {
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  let current: ApprovalContext = { action, freshness, runId: 'run-1', elements, facts: {
    taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest,
    policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null,
  } };
  const context = { loadForAction: async () => current, loadForDecision: async () => current };
  const operator = { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' as const } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context, operator, now: () => '2026-10-19T00:00:00Z' });
  return { service, store, context, operator, setContext: (value: ApprovalContext) => { current = value; }, current: () => current };
}

test('canonical service atomically pauses a required request and only stored human consent admits it', async () => {
  const { service, store } = setup();
  assert.equal(service.provenance, 'mock');
  assert.equal(await service.classify(action), 'APPROVAL_REQUIRED');
  assert.equal((await service.requestDecision(binding)).status, 'pending');
  assert.equal((await service.list('task-1')).control.mode, 'waiting');
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  assert.equal((await service.resolve(binding.decisionId)).status, 'pending');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 0);
});

test('host decision checks displayed versions, persists once and reuses the original response on retry', async () => {
  const { service, store } = setup();
  await service.requestDecision(binding);
  const view = await service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.equal(await service.validateBinding(await service.resolve('decision-1')), true);
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 1);
  await assert.rejects(service.decide({ ...response, decision: 'reject' }));
  assert.equal((await service.resolve('decision-1')).status, 'approved');
});

test('presentation refuses protected payloads, terminal controls and uninspectable complete details', () => {
  for (const necessity of ['token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', '\u001b]0;approve\u0007', '\u202ereject', '\u009b31m']) {
    assert.throws(() => buildPresentation({ ...input, elements: { ...elements, necessity } }, profile), /unsafe-presentation/);
  }
  assert.throws(() => buildPresentation(input, { ...profile, maxPresentationPageBytes: 16, maxPresentationTotalBytes: 48 }), /unsafe-presentation/);
  assert.notEqual(buildPresentation(input, profile).summary.presentationDigest, buildPresentation({ ...input, requestVersion: 2 }, profile).summary.presentationDigest);
});

test('fresh context, exact identity and stored content are rechecked before consent and admission', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  for (const change of [{ taskId: 'other' }, { decisionId: 'foreign' }, { taskVersion: 99 }, { requestVersion: 99 }, { presentationDigest: digest }, { actorId: 'operator-1' }]) {
    await assert.rejects(scenario.service.decide({ ...response, ...change }));
  }
  scenario.setContext({ ...scenario.current(), elements: { ...elements, necessity: 'Changed display' } });
  await assert.rejects(scenario.service.decide(response));
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  scenario.setContext({ ...scenario.current(), elements, facts: { ...scenario.current().facts, repositoryId: 'other-repository' } });
  await assert.rejects(scenario.service.show('task-1', 'decision-1'));
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('failed decision leaves waiting hold and host authority cannot come from input fields', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  const unprivileged = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context });
  await assert.rejects(unprivileged.decide(response));
  scenario.store.failNext('resolvePending');
  assert.equal((await scenario.service.decide(response)).outcome, 'unavailable');
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
  assert.equal((await scenario.service.resolve('decision-1')).status, 'pending');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
});

test('request retry reuses immutable creation and rejection never becomes valid admission', async () => {
  const scenario = setup();
  let clock = 0;
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context, operator: scenario.operator, now: () => `2026-10-19T00:00:0${clock++}Z` });
  await service.requestDecision(binding);
  const original = scenario.store.readRequest('decision-1').value;
  await service.requestDecision(binding);
  assert.deepEqual(scenario.store.readRequest('decision-1').value, original);
  const view = await service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'response-1' };
  assert.equal((await service.decide(response)).outcome, 'paused');
  const recorded = scenario.store.readHistory('task-1').value;
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.deepEqual(scenario.store.readHistory('task-1').value, recorded);
  assert.equal((await service.list('task-1')).control.mode, 'rejected');
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('missing store and stalled trusted context fail closed with bounded safe errors', async () => {
  const scenario = setup();
  const unavailable = createApprovalService({ taskId: 'task-1', profile, context: scenario.context });
  await assert.rejects(unavailable.classify(action), /approval-operation-denied/);
  const stalled = createApprovalService({ taskId: 'task-1', profile: { ...profile, operationDeadlineMs: 20, commandRules: [{ ...profile.commandRules[0], timeoutMs: 20 }] }, store: scenario.store, context: { loadForAction: () => new Promise(() => { /* Simulate absent host response. */ }), loadForDecision: () => new Promise(() => { /* Simulate absent host response. */ }) } });
  await assert.rejects(stalled.classify(action), /approval-operation-denied/);
});

test('preexisting pause and a pause during fresh context loading deny classification', async () => {
  const scenario = setup();
  scenario.context.loadForAction = async () => { await scenario.service.requestDecision(binding); return scenario.current(); };
  await assert.rejects(scenario.service.classify(action), /approval-operation-denied/);
  await assert.rejects(scenario.service.classify(action), /approval-operation-denied/);
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
});

test('fix-plan request fields must describe the exact registered plan action', async () => {
  const scenario = setup();
  const plan: NormalizedAction = { actionId: 'plan-1', kind: 'approve_fix_plan', planVersion: 1, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  const planFields = { planVersion: 2, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'], criteriaDigest: digest, checkSetDigest: digest };
  const planBinding = { ...binding, ...planFields, actionKind: 'fix_plan' as const, normalizedActionDigest: computeActionDigest(plan) };
  scenario.setContext({ ...scenario.current(), action: plan, facts: { ...scenario.current().facts, registeredActionDigest: computeActionDigest(plan), command: null }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(plan), currentPlanVersion: 2, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'], currentCriteriaDigest: digest, currentCheckSetDigest: digest } });
  await assert.rejects(scenario.service.requestDecision(planBinding));
  assert.equal(scenario.store.readRequest('decision-1').value, null);
});

test('maximum bounded request and response identities remain recordable', async () => {
  const scenario = setup();
  const longBinding = { ...binding, decisionId: 'd'.repeat(127) };
  await scenario.service.requestDecision(longBinding);
  const view = await scenario.service.show('task-1', longBinding.decisionId);
  const response = await scenario.service.decide({ taskId: 'task-1', decisionId: longBinding.decisionId, taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'r'.repeat(127) });
  assert.equal(response.outcome, 'ok');
  assert.equal((response.eventRef ?? '').length <= 127, true);
});

test('identical response keys on unrelated tasks have distinct journal identities', async () => {
  const scenario = setup();
  const initial = scenario.store.loadTaskControl('task-1').value;
  assert.ok(initial);
  const store = createMockApprovalStore({ profile, initialControls: [initial, { ...initial, taskId: 'task-2' }] });
  const context2 = { ...scenario.current(), facts: { ...scenario.current().facts, taskId: 'task-2' }, freshness: { ...freshness, currentTaskId: 'task-2' } };
  const context = { loadForAction: async (taskId: string) => taskId === 'task-1' ? scenario.current() : context2, loadForDecision: async (decisionId: string) => decisionId === 'decision-1' ? scenario.current() : context2 };
  const eventRefs: (string | null)[] = [];
  for (const [taskId, decisionId] of [['task-1', 'decision-1'], ['task-2', 'decision-2']] as const) {
    const service = createApprovalService({ taskId, profile, store, context, operator: scenario.operator });
    await service.requestDecision({ ...binding, taskId, decisionId });
    const view = await service.show(taskId, decisionId);
    const response = await service.decide({ taskId, decisionId, taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'same-key' });
    assert.equal(response.outcome, 'ok');
    eventRefs.push(response.eventRef);
  }
  assert.notEqual(eventRefs[0], eventRefs[1]);
});

test('a delayed provider cannot start a pending or decision mutation after its operation timed out', async () => {
  for (const operation of ['request', 'decide']) {
    const scenario = setup();
    let release: ((value: ApprovalContext) => void) | undefined;
    const delayed = new Promise<ApprovalContext>(resolve => { release = resolve; });
    if (operation === 'decide') await scenario.service.requestDecision(binding);
    const view = operation === 'decide' ? await scenario.service.show('task-1', 'decision-1') : undefined;
    const service = createApprovalService({ taskId: 'task-1', profile: { ...profile, operationDeadlineMs: 20, commandRules: [{ ...profile.commandRules[0], timeoutMs: 20 }] }, store: scenario.store,
      context: { loadForAction: async () => scenario.current(), loadForDecision: () => delayed }, operator: scenario.operator });
    const pending = operation === 'request' ? service.requestDecision(binding) : service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view?.control.version, requestVersion: 1, presentationDigest: view?.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
    await assert.rejects(pending, /approval-operation-denied/);
    assert.ok(release);
    release(scenario.current());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, operation === 'request' ? 'runnable' : 'waiting');
    assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  }
});

test('public reads reject protected stored control metadata without leaking its reason', async () => {
  const scenario = setup();
  const store = { ...scenario.store, loadTaskControl: (taskId: string) => {
    const result = scenario.store.loadTaskControl(taskId);
    return { ...result, value: result.value === null ? null : { ...result.value, reasonCode: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.list('task-1'), error => error instanceof Error && error.message === 'approval-operation-denied');
});

test('UTF-8 inspection pages retain all exact patch bytes and refuse oversized content', () => {
  const patch: NormalizedAction = { actionId: 'patch-1', kind: 'apply_patch', targetPaths: ['src/a.py'], baseRevisionDigest: digest, patchContent: `--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+${'é'.repeat(5000)}\n` };
  const patchInput = { ...input, action: patch, binding: { ...binding, normalizedActionDigest: computeActionDigest(patch) }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(patch) } };
  const result = buildPresentation(patchInput, profile);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages.join(''), JSON.stringify(patch));
  assert.equal(result.pages.every(page => Buffer.byteLength(page) <= 8192 && !page.includes('\ufffd')), true);
  const tooBig = { ...patch, patchContent: patch.patchContent.repeat(3) };
  assert.throws(() => buildPresentation({ ...patchInput, action: tooBig, binding: { ...binding, normalizedActionDigest: computeActionDigest(tooBig) }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(tooBig) } }, profile), /unsafe-presentation/);
  assert.throws(() => Reflect.apply(buildPresentation, undefined, [undefined, profile]), error => error instanceof Error && error.message === 'unsafe-presentation');
});

test('failed pending persistence closes local agent admission instead of trusting a runnable snapshot', async () => {
  const scenario = setup();
  scenario.store.failNext('createPendingAndPause');
  await assert.rejects(scenario.service.requestDecision(binding));
  await assert.rejects(scenario.service.classify(action));
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('a corrupted decision receipt never leaks protected metadata or admits work after an accepted resolution', async () => {
  for (const change of [{ eventRef: 'MARKER_SECRET_DO_NOT_DISCLOSE' }, { eventRef: 'foreign-event' }, { controlVersion: 99 }]) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const view = await scenario.service.show('task-1', 'decision-1');
    const store = { ...scenario.store, resolvePending: (input: unknown) => {
      const response = scenario.store.resolvePending(input);
      return { ...response, safe: { ...response.safe, ...change } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    const input = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
    await assert.rejects(service.decide(input), error => error instanceof Error && error.message === 'approval-operation-denied');
    const accepted = await service.resolve('decision-1');
    assert.equal(accepted.status, 'approved');
    assert.equal(await service.validateBinding(accepted), false);
    await assert.rejects(service.classify(action));
    await assert.rejects(service.decide({ ...input, decision: 'reject' }));
    assert.deepEqual(await service.resolve('decision-1'), accepted);
  }
});

test('an uncertain decision requires reconciliation whether its commit happened or not', async () => {
  for (const committed of [false, true]) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const view = await scenario.service.show('task-1', 'decision-1');
    const store = { ...scenario.store, resolvePending: (input: unknown) => {
      if (!committed) scenario.store.failNext('resolvePending');
      const response = scenario.store.resolvePending(input);
      return { ...response, value: null, safe: { ...response.safe, outcome: 'uncertain' as const } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    const response = await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
    assert.equal(response.outcome, 'uncertain');
    assert.equal(response.safeReasonCode, 'decision-reconciliation-required');
    assert.equal(response.safeNextAction, 'reconcile');
    assert.equal(response.eventRef, null);
    assert.equal((await service.resolve('decision-1')).status, committed ? 'approved' : 'pending');
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
    await assert.rejects(service.classify(action));
  }
});

test('retrying an earlier approval preserves a later pending request and prior admission state', async () => {
  for (const admissionClosed of [false, true]) {
    const { service, store } = setup();
    await service.requestDecision(binding);
    const first = await service.show('task-1', 'decision-1');
    const responseA = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: first.control.version, requestVersion: 1, presentationDigest: first.presentation.presentationDigest, decision: 'approve', responseKey: 'response-a' };
    const accepted = await service.decide(responseA);
    assert.equal(accepted.outcome, 'ok');
    const bindingB = { ...binding, decisionId: 'decision-2' };
    await service.requestDecision(bindingB);
    const waiting = await service.show('task-1', 'decision-2');
    const responseB = { ...responseA, decisionId: 'decision-2', taskVersion: waiting.control.version, presentationDigest: waiting.presentation.presentationDigest, responseKey: 'response-b' };
    if (admissionClosed) {
      store.failNext('resolvePending');
      assert.equal((await service.decide(responseB)).outcome, 'unavailable');
    }
    const retried = await service.decide(responseA);
    assert.equal(retried.outcome, 'ok');
    assert.equal(retried.eventRef, accepted.eventRef);
    assert.deepEqual((await service.list('task-1')).control, waiting.control);
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
    await assert.rejects(service.classify(action));
    assert.equal((await service.decide(responseB)).outcome, 'ok');
    assert.equal(await service.validateBinding(await service.resolve('decision-2')), !admissionClosed);
    assert.equal((await service.resolve('decision-1')).status, 'approved');
  }
});

test('provider contexts reject arrays, accessors and incomplete fields before reading untrusted properties', async () => {
  const scenario = setup();
  let getterReads = 0;
  const accessor = (object: object, key: string, value: unknown): object => Object.defineProperty({ ...object }, key, { enumerable: true, get: () => { getterReads += 1; return value; } });
  const current = scenario.current();
  const invalid: readonly unknown[] = [
    Object.assign([], current),
    accessor(current, 'action', action),
    { ...current, facts: accessor(current.facts, 'taskId', 'task-1') },
    { ...current, freshness: accessor(freshness, 'currentTaskId', 'task-1') },
    { ...current, elements: accessor(elements, 'necessity', elements.necessity) },
    { ...current, runId: undefined },
    { ...current, facts: { ...current.facts, repositoryId: undefined } },
    { ...current, freshness: {} },
    { ...current, elements: { ...elements, verificationStatus: undefined } },
  ];
  for (const raw of invalid) {
    const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: { loadForAction: async () => raw, loadForDecision: async () => raw }, operator: scenario.operator });
    await assert.rejects(service.classify(action), /approval-operation-denied/);
    await assert.rejects(service.requestDecision(binding), /approval-operation-denied/);
  }
  assert.equal(getterReads, 0);
  assert.equal((await scenario.service.list('task-1')).control.mode, 'runnable');
  assert.equal(await scenario.service.classify(action), 'APPROVAL_REQUIRED');
});
