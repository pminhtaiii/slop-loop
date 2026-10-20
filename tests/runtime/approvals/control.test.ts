import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { createApprovalControl } from '../../../src/approvals/control.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import type { ApprovalContext, ApprovalStore } from '../../../src/approvals/service.ts';
import type { ApprovalActivity } from '../../../src/approvals/control.ts';

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

test('actual coordinator bars every caller class on a waiting task, including alternate action identities', () => {
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 2, epoch: 2, mode: 'waiting', pendingDecisionId: 'decision-1', continuationRef: 'continuation-1', reasonCode: 'pending', outstandingClaimRefs: [] }] });
  const activity = createMockActivityControl(profile);
  const coordinator = createApprovalControl({ taskId: 'task-1', activity, load: () => { const current = store.loadTaskControl('task-1').value; assert.ok(current); return current; } });
  for (const caller of ['coder', 'reviewer', 'model', 'tool', 'read', 'test', 'background']) {
    assert.equal(coordinator.admitAttempt(caller, { schemaVersion: 'uc05-approval/0.1-draft', claimId: `claim-${caller}`, actionId: `alternate-${caller}`, taskId: 'task-1', expectedControlVersion: 2, expectedEpoch: 2, repositoryStateDigest: digest, policyIdentity: identity, decisionRefs: [], reservationRefs: ['reservation-1'], phase: 'claimed', resultRef: null }), false);
  }
  assert.equal(activity.inspectOutstanding('task-1').length, 0);
});

function setup(options: { mode?: 'runnable' | 'rejected' | 'recovery-blocked' | 'ended'; outstandingClaimRefs?: readonly string[]; deadlineMs?: number; wrapActivity?: (activity: ApprovalActivity) => ApprovalActivity; wrapStore?: (store: ApprovalStore) => ApprovalStore } = {}) {
  const configuredProfile = { ...profile, operationDeadlineMs: options.deadlineMs ?? profile.operationDeadlineMs, commandRules: profile.commandRules.map(rule => ({ ...rule, timeoutMs: Math.min(rule.timeoutMs, options.deadlineMs ?? rule.timeoutMs) })) };
  const store = createMockApprovalStore({ profile: configuredProfile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: options.mode ?? 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: options.outstandingClaimRefs ?? [] }] });
  let current: ApprovalContext = { action, freshness, runId: 'run-1', elements, facts: {
    taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest,
    policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null,
  } };
  const context = { loadForAction: async () => current, loadForDecision: async () => current, loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: identity }) };
  const operator = { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' as const } };
  const activity = createMockActivityControl(configuredProfile);
  const service = createApprovalService({ taskId: 'task-1', profile: configuredProfile, store: options.wrapStore?.(store) ?? store, context, activity: options.wrapActivity?.(activity) ?? activity, operator, now: () => '2026-10-19T00:00:00Z' });
  return { service, store, context, activity, operator, setContext: (value: ApprovalContext) => { current = value; }, current: () => current };
}

function claim(id = 'one') {
  return { schemaVersion: 'uc05-approval/0.1-draft', claimId: `claim-${id}`, actionId: `action-${id}`, taskId: 'task-1', expectedControlVersion: 1, expectedEpoch: 1, repositoryStateDigest: digest, policyIdentity: identity, decisionRefs: [], reservationRefs: ['reservation-1'], phase: 'claimed', resultRef: null } as const;
}

test('service pending fences in-flight activity and every caller; rejection requests cancellation without claiming rollback', async () => {
  const { service, activity } = setup();
  assert.equal(service.admitAttempt('running', claim()), true);
  await service.requestDecision(binding);
  assert.equal(activity.inspectOutstanding('task-1')[0]?.cancellationRequested, true);
  for (const caller of ['coder', 'reviewer', 'model', 'tool', 'read', 'test', 'background']) assert.equal(service.admitAttempt(caller, claim(caller)), false);
  const view = await service.show('task-1', 'decision-1');
  await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'rejection' });
  assert.equal(activity.recordEffectAttempt('running', 'read').outcome, 'uncertain');
  assert.equal(activity.recordOutcome('running', 'cancelled').outcome, 'conflict');
  assert.equal((await service.list('task-1')).control.mode, 'rejected');
});

for (const outcome of ['completed', 'cancelled'] as const) {
  test(`successful mock ${outcome} observation after actual service stop preserves rejection and denies new admission`, async () => {
    const scenario = setup();
    assert.equal(scenario.service.admitAttempt('running', claim()), true);
    if (outcome === 'completed') assert.equal(scenario.activity.recordEffectAttempt('running', 'read').outcome, 'ok');
    await reject(scenario);
    assert.equal(scenario.activity.inspectOutstanding('task-1')[0]?.cancellationRequested, true);
    const rejected = await scenario.service.list('task-1');
    assert.equal(rejected.control.mode, 'rejected');
    const observed = scenario.activity.recordOutcome('running', outcome);
    assert.equal(observed.outcome, 'ok');
    assert.equal(observed.value?.state, outcome);
    assert.equal(scenario.activity.inspectOutstanding('task-1').length, 0);
    assert.equal(scenario.activity.readEffectLog().length, outcome === 'completed' ? 1 : 0);
    assert.deepEqual((await scenario.service.list('task-1')).control, rejected.control);
    assert.equal((await scenario.service.resolve('decision-1')).status, 'rejected');
    assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 1);
    assert.equal(scenario.service.admitAttempt('after-observation', { ...claim('next'), expectedControlVersion: rejected.control.version, expectedEpoch: rejected.control.epoch }), false);
    await assert.rejects(scenario.service.classify(action));
    assert.equal(scenario.activity.readEffectLog().length, outcome === 'completed' ? 1 : 0);
  });
}

async function reject(scenario: ReturnType<typeof setup>) {
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'reject' });
}

test('host direction releases only rejection and its accepted retry preserves a later pending request and original scope', async () => {
  const scenario = setup();
  await reject(scenario);
  const command = { taskId: 'task-1', taskVersion: 3, direction: 'revise', responseKey: 'revise-once' };
  assert.equal((await scenario.service.control(command)).outcome, 'ok');
  assert.equal((await scenario.service.resolve('decision-1')).status, 'rejected');
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
  assert.equal(await scenario.service.classify(action), 'APPROVAL_REQUIRED');
  await scenario.service.requestDecision({ ...binding, decisionId: 'decision-2' });
  const originalContext = scenario.context.loadForTask;
  scenario.context.loadForTask = async () => { throw new Error('current context unavailable; retry must use history'); };
  assert.equal((await scenario.service.control(command)).outcome, 'ok');
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 1);
  await assert.rejects(scenario.service.control({ ...command, direction: 'end' }));
  await assert.rejects(scenario.service.control({ ...command, responseKey: 'new-stale' }));
  assert.equal(scenario.service.admitAttempt('retry', claim()), false);
  scenario.context.loadForTask = async () => ({ ...await originalContext(), safeScopeRef: 'scope-2' });
  assert.equal((await scenario.service.control({ taskId: 'task-1', taskVersion: 5, direction: 'end', responseKey: 'end' })).outcome, 'paused');
  assert.equal((await scenario.service.control(command)).outcome, 'ok');
  assert.equal((await scenario.service.list('task-1')).control.mode, 'ended');
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 2);
});

test('resume cannot discard unconfirmed in-flight activity; end preserves uncertain observations and retries do not cancel twice', async () => {
  let cancellationRequests = 0;
  const scenario = setup({ wrapActivity: activity => ({ ...activity, requestCancellation: taskId => { cancellationRequests += 1; return activity.requestCancellation(taskId); } }) });
  assert.equal(scenario.service.admitAttempt('running', claim()), true);
  await reject(scenario);
  assert.equal(scenario.activity.recordOutcome('running', 'uncertain').outcome, 'uncertain');
  await assert.rejects(scenario.service.control({ taskId: 'task-1', taskVersion: 3, direction: 'resume', responseKey: 'resume' }));
  const command = { taskId: 'task-1', taskVersion: 3, direction: 'end', responseKey: 'end' };
  assert.equal((await scenario.service.control(command)).outcome, 'paused');
  assert.equal((await scenario.service.list('task-1')).control.mode, 'ended');
  assert.equal(scenario.activity.inspectOutstanding('task-1')[0]?.state, 'uncertain');
  assert.equal((await scenario.service.control(command)).outcome, 'paused');
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 1);
  assert.equal(cancellationRequests, 2);
});

test('malformed/protected activity receipt closes actual admission without fabricating durable state', async () => {
  const scenario = setup({ wrapActivity: activity => ({ ...activity, fenceTask: () => ({ outcome: 'paused', safeReasonCode: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }) }) });
  await assert.rejects(scenario.service.requestDecision(binding));
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  assert.equal(scenario.service.admitAttempt('forbidden-gap', claim()), false);
});

test('unavailable authoritative history closes local admission even when durable control remains runnable', async () => {
  const scenario = setup({ wrapStore: store => ({ ...store, readHistory: taskId => ({ ...store.readHistory(taskId), value: { resolutions: [] } }) }) });
  await assert.rejects(scenario.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'end' }));
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.equal(scenario.service.admitAttempt('gap', claim()), false);
});

test('untrusted control receipts are rejected without invoking accessors', async () => {
  let reads = 0;
  const scenario = setup({ wrapStore: store => ({ ...store, loadTaskControl: taskId => {
    const response = store.loadTaskControl(taskId);
    return { ...response, safe: Object.defineProperty({ ...response.safe }, 'outcome', { enumerable: true, get: () => { reads += 1; return 'ok'; } }) };
  } }) });
  await assert.rejects(scenario.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'end' }));
  assert.equal(reads, 0);
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'runnable');
});

test('a direction receipt without its authoritative event never reopens local admission', async () => {
  const scenario = setup({ mode: 'rejected', wrapStore: store => ({ ...store, readEvents: taskId => {
    const response = store.readEvents?.(taskId); assert.ok(response); return { ...response, value: [] };
  } }) });
  await assert.rejects(scenario.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'resume' }));
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.equal(scenario.service.admitAttempt('gap', { ...claim(), expectedControlVersion: 2, expectedEpoch: 2 }), false);
});

test('an admission receipt must identify the actual attempt, and malformed receipts close classification too', async () => {
  const scenario = setup({ wrapActivity: activity => ({ ...activity, admitAttempt: () => ({ outcome: 'ok', safeReasonCode: 'activity-attempt-admitted-in-memory', value: null }) }) });
  assert.equal(scenario.service.admitAttempt('missing', claim()), false);
  await assert.rejects(scenario.service.classify(action));
});

test('only explicit current scoped host directions release rejection; claims and other holds remain, end retains claims', async () => {
  for (const mode of ['recovery-blocked', 'ended'] as const) {
    for (const direction of ['resume', 'revise'] as const) {
      const scenario = setup({ mode });
      assert.equal((await scenario.service.control({ taskId: 'task-1', taskVersion: 1, direction, responseKey: 'denied' })).outcome, 'denied');
      assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, mode);
    }
  }
  const waiting = setup();
  await waiting.service.requestDecision(binding);
  assert.equal((await waiting.service.control({ taskId: 'task-1', taskVersion: 2, direction: 'resume', responseKey: 'not-approval' })).outcome, 'denied');
  assert.equal((await waiting.service.resolve('decision-1')).status, 'pending');
  const held = setup({ mode: 'rejected', outstandingClaimRefs: ['unsettled-claim'] });
  assert.equal((await held.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'revise', responseKey: 'hold' })).outcome, 'uncertain');
  const end = { taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'end' };
  assert.equal((await held.service.control(end)).outcome, 'paused');
  assert.deepEqual(held.store.loadTaskControl('task-1').value?.outstandingClaimRefs, ['unsettled-claim']);
  assert.equal((await held.service.control(end)).outcome, 'paused');
  assert.equal(held.store.readHistory('task-1').value?.directions.length, 1);
});

test('failed pending/decision/direction writes and lost receipts retain closed admission without claiming noncommit', async () => {
  const pending = setup();
  pending.store.failNext('createPendingAndPause');
  await assert.rejects(pending.service.requestDecision(binding));
  assert.equal(pending.store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.equal(pending.service.admitAttempt('gap', claim()), false);
  const direction = setup({ mode: 'rejected' });
  direction.store.failNext('recordDirection');
  assert.equal((await direction.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'resume' })).outcome, 'unavailable');
  assert.equal(direction.store.loadTaskControl('task-1').value?.mode, 'rejected');
  assert.equal(direction.store.readHistory('task-1').value?.directions.length, 0);
  const lost = setup({ mode: 'rejected', wrapStore: store => ({ ...store, recordDirection: input => { const response = store.recordDirection?.(input); assert.ok(response); return { ...response, safe: { ...response.safe, outcome: 'uncertain', eventRef: null } }; } }) });
  assert.equal((await lost.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'resume' })).outcome, 'uncertain');
  assert.equal(lost.store.loadTaskControl('task-1').value?.mode, 'runnable');
  assert.equal(lost.service.admitAttempt('gap', { ...claim(), expectedControlVersion: 2, expectedEpoch: 2 }), false);
});

test('deadline fences late task context before direction mutation; feedback, forged authority and stale versions create no directions', async () => {
  const delayed = setup({ mode: 'rejected', deadlineMs: 5 });
  const original = delayed.context.loadForTask;
  delayed.context.loadForTask = async () => { await new Promise(resolve => setTimeout(resolve, 25)); return original(); };
  await assert.rejects(delayed.service.control({ taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'late' }));
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(delayed.store.readHistory('task-1').value?.directions.length, 0);
  assert.equal(delayed.store.loadTaskControl('task-1').value?.mode, 'rejected');
  const scenario = setup({ mode: 'rejected' });
  const command = { taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'resume' };
  for (const input of [{ ...command, taskId: 'foreign' }, { ...command, taskVersion: 2 }, { ...command, direction: 'feedback' }, { ...command, safeScopeRef: 'injected' }, { ...command, actorId: 'operator-1' }, { ...command, responseKey: '' }]) await assert.rejects(scenario.service.control(input));
  const unprivileged = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context, activity: scenario.activity });
  await assert.rejects(unprivileged.control(command));
  scenario.context.loadForTask = async () => ({ ...await original(), safeScopeRef: '' });
  await assert.rejects(scenario.service.control(command));
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 0);
});

test('unrelated task admission remains eligible and a pause committed inside activity admission is observed', () => {
  const initial = { schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-2', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] } as const;
  const store = createMockApprovalStore({ profile, initialControls: [initial] });
  const activity = createMockActivityControl(profile);
  const load = () => { const current = store.loadTaskControl('task-2').value; assert.ok(current); return current; };
  const unrelated = createApprovalControl({ taskId: 'task-2', activity, load });
  assert.equal(unrelated.admitAttempt('unrelated', { ...claim(), taskId: 'task-2' }), true);
  let paused = false;
  const racing = createApprovalControl({ taskId: 'task-2', load: () => paused ? { ...load(), version: 2, epoch: 2, mode: 'ended' } : load(), activity: { ...activity, admitAttempt: input => { const receipt = activity.admitAttempt(input); paused = true; return receipt; } } });
  assert.equal(racing.admitAttempt('racing', { ...claim('race'), taskId: 'task-2' }), false);
});

test('final authoritative admission reload must remain valid, task-local and free of outstanding holds', () => {
  const initial = { schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] } as const;
  for (const change of [{ schemaVersion: 'invalid' }, { taskId: 'foreign-task' }, { outstandingClaimRefs: ['new-claim'] }, { repositoryId: 'foreign-repository' }, { workspaceId: 'foreign-workspace' }]) {
    const activity = createMockActivityControl(profile);
    let reads = 0;
    const coordinator = createApprovalControl({ taskId: 'task-1', activity, load: () => {
      reads += 1;
      // Simulate an untrusted authoritative port changing its response during admission.
      return reads === 1 ? initial : Object.assign({}, initial, change);
    } });
    assert.equal(coordinator.admitAttempt('racing', claim()), false, JSON.stringify(change));
    assert.equal(reads, 2);
  }
});
