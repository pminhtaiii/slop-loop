import {
  createApprovalControlV02,
  isExecutorCapability,
  type UC04JournalPortV02,
} from '../../../src/approvals/control.ts';
import type { PolicyAuthorityRefV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computeDispatchClaimDigestV02,
  validateClaimClosureReceipt,
  validateDispatchClaimV02,
  type DispatchClaimV02,
} from '../../../src/contracts/approvals/contracts.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import type { NormalizedAction, ClaimReceiptV02, RepositoryAdmissionContextV02 } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest, computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import { createApprovalControl } from '../../../src/approvals/control.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import type { ApprovalContext, ApprovalStore } from '../../../src/approvals/service.ts';
import type { ApprovalActivity } from '../../../src/approvals/control.ts';
import { MemoryStatePortV02, isNeutralAttemptReceiptV02 } from '../support/uc03/memory-state.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestExecutorIdentityV02,
  createTestProviderAdmissionContextV02,
  createTestProviderOutcomeReceiptV02,
  createTestRepositoryAdmissionContextV02,
} from '../support/uc03/state-fixtures.ts';

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

test('denied resume while approval is pending does not block admission after approval', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  assert.equal((await scenario.service.control({ taskId: 'task-1', taskVersion: view.control.version, direction: 'resume', responseKey: 'premature-resume' })).outcome, 'denied');
  assert.equal(scenario.service.admitAttempt('pending', { ...claim('pending'), expectedControlVersion: 2, expectedEpoch: 2 }), false);
  assert.equal((await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve' })).outcome, 'ok');
  const approved = (await scenario.service.list('task-1')).control;
  assert.equal(approved.mode, 'runnable');
  assert.equal(approved.version, 3);
  assert.equal(approved.epoch, 3);
  assert.equal(scenario.service.admitAttempt('approved', { ...claim('approved'), expectedControlVersion: approved.version, expectedEpoch: approved.epoch }), true);
});

for (const [outcome, canAdmit] of [['denied', true], ['conflict', true], ['invalid', true], ['stale', true], ['unavailable', false], ['uncertain', false]] as const) {
  test(`a ${outcome} decision receipt ${canAdmit ? 'permits' : 'blocks'} admission after a successful approval retry`, async () => {
    let refuse = true;
    const scenario = setup({ wrapStore: store => ({ ...store, resolvePending: input => {
      if (!refuse) return store.resolvePending(input);
      refuse = false;
      const current = store.loadTaskControl('task-1');
      return { safe: { ...current.safe, outcome, decisionId: 'decision-1', requestVersion: 1 }, value: null };
    } }) });
    await scenario.service.requestDecision(binding);
    const view = await scenario.service.show('task-1', 'decision-1');
    const command = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve' as const, responseKey: 'approve' };
    assert.equal((await scenario.service.decide(command)).outcome, outcome);
    assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
    assert.equal(scenario.service.admitAttempt('pending', { ...claim('pending'), expectedControlVersion: 2, expectedEpoch: 2 }), false);
    assert.equal((await scenario.service.decide(command)).outcome, 'ok');
    const approved = (await scenario.service.list('task-1')).control;
    assert.equal(scenario.service.admitAttempt('approved', { ...claim('approved'), expectedControlVersion: approved.version, expectedEpoch: approved.epoch }), canAdmit);
  });
}

for (const [outcome, canAdmit] of [['denied', true], ['conflict', true], ['invalid', true], ['stale', true], ['unavailable', false], ['uncertain', false]] as const) {
  test(`a ${outcome} direction receipt ${canAdmit ? 'permits' : 'blocks'} admission after a recorded resume retry`, async () => {
    let refuse = true;
    const scenario = setup({ mode: 'rejected', wrapStore: store => ({ ...store, recordDirection: input => {
      assert.ok(store.recordDirection);
      if (!refuse) return store.recordDirection(input);
      refuse = false;
      return { safe: { ...store.loadTaskControl('task-1').safe, outcome }, value: null };
    } }) });
    const command = { taskId: 'task-1', taskVersion: 1, direction: 'resume', responseKey: 'resume' };
    assert.equal((await scenario.service.control(command)).outcome, outcome);
    assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 0);
    if (canAdmit) {
      assert.equal((await scenario.service.control(command)).outcome, 'ok');
    } else {
      const external = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context, activity: scenario.activity, operator: scenario.operator });
      assert.equal((await external.control(command)).outcome, 'ok');
    }
    const resumed = (await scenario.service.list('task-1')).control;
    assert.equal(resumed.mode, 'runnable');
    assert.equal(scenario.service.admitAttempt('resumed', { ...claim('resumed'), expectedControlVersion: resumed.version, expectedEpoch: resumed.epoch }), canAdmit);
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

function createJournal(context: RepositoryAdmissionContextV02): MemoryStatePortV02 {
  const initialTaskState = createTestAdmissionTaskStateV02(context);
  return new MemoryStatePortV02({
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
  });
}

function dispatchClaim(context: RepositoryAdmissionContextV02, journalClaim: ClaimReceiptV02): DispatchClaimV02 {
  const authority = context.policyAuthorityRef;
  const unsigned = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    claimId: journalClaim.claimId,
    claimDigest: '',
    taskId: journalClaim.taskId,
    runId: journalClaim.runId,
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: journalClaim.preClaimTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: journalClaim.preClaimControlVersion,
    expectedEpoch: journalClaim.epoch,
    policyIdentity: {
      policyId: authority.policyId,
      policyVersion: authority.policyVersion,
      configId: authority.configId,
      configVersion: authority.configVersion,
    },
    decisionRefs: context.actionDecisionReceipt ? [context.actionDecisionReceipt.decisionId] : [context.planDecisionRef],
    reservationRefs: [...journalClaim.reservationRefs],
    phase: 'claimed' as const,
    resultRef: null,
    subjectKind: 'repository-action' as const,
    planApplicability: context.planApplicability,
    actionId: context.action.actionId,
    actionDigest: context.actionDigest,
    repositoryStateDigest: context.canonicalRevision,
    planBindingDigest: context.planBindingDigest,
    planDecisionRef: context.planDecisionRef,
  };
  const candidate = { ...unsigned, claimDigest: computeDispatchClaimDigestV02(unsigned) };
  const checked = validateDispatchClaimV02(candidate);
  assert.equal(checked.ok, true);
  if (!checked.ok) throw new Error('test-dispatch-claim-is-invalid');
  return checked.value;
}

function publicationAfter(context: RepositoryAdmissionContextV02): PolicyAuthorityRefV02 {
  return { ...context.policyAuthorityRef, decisionAuthorityGeneration: context.policyAuthorityRef.decisionAuthorityGeneration + 1 };
}

function pauseProof(journal: MemoryStatePortV02, eventKind: 'pause' | 'denial', eventRef: string) {
  const eventDigest = (journal.getJournalSnapshot() as unknown as Record<string, unknown>)['holdEventDigest'];
  if (typeof eventDigest !== 'string') throw new Error('journal-hold-event-digest-unavailable');
  assert.match(eventDigest, /^sha256:[0-9a-f]{64}$/u);
  return { eventKind, eventRef, eventDigest };
}

test('UC-05 v0.2 publication preserves the UC-04 journal result and active authority', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const authorityRef = publicationAfter(context);
  const result = await createApprovalControlV02({ taskId: context.taskId, journal }).publishAuthority({ authorityRef });
  const snapshot = journal.getJournalSnapshot();

  assert.equal(result.outcome, 'ok');
  assert.equal(result.receipt?.status, 'published');
  assert.equal(result.receipt?.generation, authorityRef.decisionAuthorityGeneration);
  assert.deepEqual(snapshot.activeAuthorityRef, authorityRef);
  assert.equal(snapshot.authorityPublications.length, 1);
});

test('UC-05 v0.2 publication fails closed for a missing journal and preserves stale/conflict outcomes', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const missing = await createApprovalControlV02({ taskId: context.taskId }).publishAuthority({ authorityRef: publicationAfter(context) });
  assert.deepEqual(missing, { outcome: 'paused', receipt: null });
  const partial = await createApprovalControlV02({
    taskId: context.taskId,
    journal: { provenance: 'mock' } as UC04JournalPortV02,
  }).publishAuthority({ authorityRef: publicationAfter(context) });
  assert.deepEqual(partial, { outcome: 'paused', receipt: null });

  const journal = createJournal(context);
  const control = createApprovalControlV02({ taskId: context.taskId, journal });
  const beforeStale = journal.getJournalSnapshot();
  const stale = await control.publishAuthority({ authorityRef: context.policyAuthorityRef });
  assert.equal(stale.outcome, 'stale');
  assert.equal(stale.receipt?.status, 'stale');
  assert.deepEqual(journal.getJournalSnapshot(), beforeStale);

  const nextAuthority = publicationAfter(context);
  assert.equal((await control.publishAuthority({ authorityRef: nextAuthority })).outcome, 'ok');
  const beforeConflict = journal.getJournalSnapshot();
  const conflictingAuthority = { ...nextAuthority, configVersion: 'other-config-version' };
  const conflict = await control.publishAuthority({ authorityRef: conflictingAuthority });
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.receipt?.status, 'conflict');
  assert.deepEqual(journal.getJournalSnapshot(), beforeConflict);
});

test('UC-05 v0.2 publication rejects malformed and foreign journal replies', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const accessorJournal = {
    provenance: 'mock',
    publishAuthority: async () => Object.defineProperty({}, 'status', { get: () => { throw new Error('getter-must-not-run'); }, enumerable: true }),
  } as unknown as UC04JournalPortV02;
  const accessorResult = await createApprovalControlV02({ taskId: context.taskId, journal: accessorJournal })
    .publishAuthority({ authorityRef: publicationAfter(context) });
  assert.deepEqual(accessorResult, { outcome: 'paused', receipt: null });

  const foreignJournal = {
    provenance: 'mock',
    publishAuthority: async (options: { readonly authorityRef: PolicyAuthorityRefV02 }) => ({
      schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
      publicationId: 'pub-foreign-4',
      publicationDigest: computeCanonicalSha256({ publicationId: 'pub-foreign-4', authorityRef: context.policyAuthorityRef }),
      authorityRef: context.policyAuthorityRef,
      generation: options.authorityRef.decisionAuthorityGeneration,
      status: 'published',
    }),
  } as unknown as UC04JournalPortV02;
  const foreignResult = await createApprovalControlV02({ taskId: context.taskId, journal: foreignJournal })
    .publishAuthority({ authorityRef: publicationAfter(context) });
  assert.deepEqual(foreignResult, { outcome: 'paused', receipt: null });
});

test('UC-05 v0.2 publication winning the real journal queue rejects the old claim attempt', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const taskBefore = await journal.loadTask(context.taskId);
  const ledgersBefore = journal.getLedgers();
  const authorityRef = publicationAfter(context);
  const control = createApprovalControlV02({ taskId: context.taskId, journal });

  const publication = control.publishAuthority({ authorityRef });
  const attempt = journal.beginAttempt(claim.claimId, actor);
  const [published, attempted] = await Promise.all([publication, attempt]);

  assert.equal(published.outcome, 'ok');
  assert.equal(isNeutralAttemptReceiptV02(attempted), true);
  assert.deepEqual(await journal.loadTask(context.taskId), taskBefore);
  assert.deepEqual(journal.getLedgers(), ledgersBefore);
  assert.deepEqual(journal.getJournalSnapshot().activeAuthorityRef, authorityRef);
  assert.equal(journal.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'claimed');
  assert.equal(journal.getJournalSnapshot().attempts.length, 0);
});

test('UC-05 v0.2 beginAttempt winning the real journal queue admits once before publication', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const authorityRef = publicationAfter(context);
  const taskBefore = await journal.loadTask(context.taskId);
  const ledgersBefore = journal.getLedgers();
  const control = createApprovalControlV02({ taskId: context.taskId, journal });

  const attempt = journal.beginAttempt(claim.claimId, actor);
  const publication = control.publishAuthority({ authorityRef });
  const [attempted, published] = await Promise.all([attempt, publication]);
  const taskAfter = await journal.loadTask(context.taskId);

  assert.equal(isNeutralAttemptReceiptV02(attempted), false);
  assert.equal(published.outcome, 'ok');
  assert.equal(journal.getJournalSnapshot().claims.find((item) => item.claimId === claim.claimId)?.status, 'attempting');
  assert.equal(journal.getJournalSnapshot().attempts.length, 1);
  assert.deepEqual(journal.getJournalSnapshot().activeAuthorityRef, authorityRef);
  assert.equal(taskBefore?.node, 'Repair');
  assert.equal(taskAfter?.node, 'Patch');
  assert.equal(taskAfter?.stateVersion, context.expectedTaskStateVersion + 1);
  const repairBefore = ledgersBefore.find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  const repairAfter = journal.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.equal(repairBefore?.consumed, 0);
  assert.equal(repairAfter?.consumed, 1);
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(claim.claimId, actor)), true);
});

test('UC-05 v0.2 closure uses a real pause, no-attempt snapshot, fence, and journal close', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-event-001'), true);
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), true);
  const taskBefore = await journal.loadTask(context.taskId);
  const ledgersBefore = journal.getLedgers();
  const control = createApprovalControlV02({ taskId: context.taskId, journal });
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-event-001'),
  };

  const result = await control.closeUnattemptedClaim(input);
  const snapshot = journal.getJournalSnapshot();
  const repair = journal.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair');

  assert.equal(result.closed, true);
  assert.ok(result.receipt);
  assert.equal(result.receipt?.claimId, journalClaim.claimId);
  assert.equal(result.receipt?.claimDigest, claim.claimDigest);
  assert.equal(validateClaimClosureReceipt(result.receipt).ok, true);
  assert.equal(snapshot.mode, 'paused');
  assert.equal(snapshot.activeClaimId, null);
  assert.equal(snapshot.claims.find((item) => item.claimId === journalClaim.claimId)?.status, 'closed');
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.closures.length, 1);
  assert.ok(snapshot.fencedIncarnations.length > 0);
  const taskAfter = await journal.loadTask(context.taskId);
  assert.equal(taskAfter?.taskId, taskBefore?.taskId);
  assert.equal(taskAfter?.runId, taskBefore?.runId);
  assert.equal(taskAfter?.stateVersion, taskBefore?.stateVersion);
  assert.equal(taskAfter?.node, taskBefore?.node);
  assert.equal(taskAfter?.repositoryRevisionDigest, taskBefore?.repositoryRevisionDigest);
  assert.equal(repair?.consumed, 0);
  assert.equal(repair?.reservations.length, 0);
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), true);
  assert.deepEqual(ledgersBefore.find((ledger) => ledger.kind === 'repair')?.consumed, 0);
});

test('UC-05 v0.2 denial closure records the rejected hold and releases only the unattempted claim', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'rejected', 'denial-event-001'), true);
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), true);

  const result = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim({
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'denial', 'denial-event-001'),
  });
  const snapshot = journal.getJournalSnapshot();
  const repair = journal.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');

  assert.equal(result.closed, true);
  assert.equal(validateClaimClosureReceipt(result.receipt).ok, true);
  assert.equal(result.receipt?.pauseOrDenialEvent.eventKind, 'denial');
  assert.equal(result.receipt?.pauseOrDenialEvent.eventRef, 'denial-event-001');
  assert.equal(snapshot.mode, 'rejected');
  assert.equal(snapshot.holdRef, 'denial-event-001');
  assert.equal(snapshot.activeClaimId, null);
  assert.equal(snapshot.claims.find(row => row.claimId === journalClaim.claimId)?.status, 'closed');
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.closures.length, 1);
  assert.equal(repair?.consumed, 0);
  assert.equal(repair?.reservations.length, 0);
});

test('UC-05 v0.2 close refuses an attempted claim without changing its hold or accounting', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), false);
  assert.equal(await journal.setTaskControl(context.taskId, 'rejected', 'reject-event-001'), true);
  const beforeTask = await journal.loadTask(context.taskId);
  const beforeLedgers = journal.getLedgers();
  const beforeSnapshot = journal.getJournalSnapshot();
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'denial', 'reject-event-001'),
  };

  const result = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim(input);
  assert.equal(result.closed, false);
  assert.equal(result.receipt, null);
  assert.deepEqual(await journal.loadTask(context.taskId), beforeTask);
  assert.deepEqual(journal.getLedgers(), beforeLedgers);
  assert.deepEqual(journal.getJournalSnapshot(), beforeSnapshot);
});

test('UC-05 v0.2 closure refuses unknown claims, bad pause proof, and missing fence support without mutation', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-event-003'), true);
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-event-003'),
  };
  const beforeTask = await journal.loadTask(context.taskId);
  const beforeLedgers = journal.getLedgers();
  const beforeSnapshot = journal.getJournalSnapshot();
  const incompleteJournal = {
    provenance: 'mock',
    setTaskControl: journal.setTaskControl.bind(journal),
    loadTask: journal.loadTask.bind(journal),
    getJournalSnapshot: journal.getJournalSnapshot.bind(journal),
    closeUnattemptedClaim: journal.closeUnattemptedClaim.bind(journal),
  } as unknown as UC04JournalPortV02;

  const noJournal = await createApprovalControlV02({ taskId: context.taskId }).closeUnattemptedClaim(input);
  const noFence = await createApprovalControlV02({ taskId: context.taskId, journal: incompleteJournal }).closeUnattemptedClaim(input);
  const badProof = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim({
    ...input,
    pauseOrDenialEvent: { ...input.pauseOrDenialEvent, eventRef: 'foreign-pause-event' },
  });
  const malformedProof = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim({
    ...input,
    pauseOrDenialEvent: { ...input.pauseOrDenialEvent, eventDigest: 'not-a-digest' },
  });
  const foreignUnsigned = { ...journalClaim, claimId: 'claim-not-in-journal', claimDigest: '' };
  const foreignJournalClaim = {
    ...foreignUnsigned,
    claimDigest: computeCanonicalSha256({ ...foreignUnsigned, claimDigest: undefined }),
  };
  const unknownClaim = dispatchClaim(context, foreignJournalClaim);
  const unknown = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim({
    ...input,
    claim: unknownClaim,
    journalClaim: foreignJournalClaim,
  });

  for (const result of [noJournal, noFence, badProof, malformedProof, unknown]) {
    assert.equal(result.closed, false);
    assert.equal(result.receipt, null);
  }
  assert.deepEqual(journal.getJournalSnapshot(), beforeSnapshot);
  assert.deepEqual(await journal.loadTask(context.taskId), beforeTask);
  assert.deepEqual(journal.getLedgers(), beforeLedgers);
});

test('UC-05 v0.2 closure rejects a foreign journal close response without reporting success', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  await journal.setTaskControl(context.taskId, 'paused', 'pause-event-002');
  await journal.beginAttempt(journalClaim.claimId, actor);
  assert.equal(journal.getJournalSnapshot().claims.find((item) => item.claimId === journalClaim.claimId)?.status, 'claimed');
  const beforeTask = await journal.loadTask(context.taskId);
  const beforeSnapshot = journal.getJournalSnapshot();
  const beforeLedgers = journal.getLedgers();
  const foreignCloseJournal = {
    provenance: 'mock',
    setTaskControl: journal.setTaskControl.bind(journal),
    loadTask: journal.loadTask.bind(journal),
    getJournalSnapshot: journal.getJournalSnapshot.bind(journal),
    fenceClaimRecipient: journal.fenceClaimRecipient.bind(journal),
    closeUnattemptedClaim: async () => ({ closed: true, receiptId: 'foreign-closure' }),
  } as unknown as UC04JournalPortV02;
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-event-002'),
  };

  const result = await createApprovalControlV02({ taskId: context.taskId, journal: foreignCloseJournal }).closeUnattemptedClaim(input);
  assert.equal(result.closed, false);
  assert.equal(result.receipt, null);
  assert.deepEqual(await journal.loadTask(context.taskId), beforeTask);
  const afterSnapshot = journal.getJournalSnapshot();
  assert.equal(afterSnapshot.activeClaimId, beforeSnapshot.activeClaimId);
  assert.deepEqual(afterSnapshot.claims, beforeSnapshot.claims);
  assert.deepEqual(afterSnapshot.attempts, beforeSnapshot.attempts);
  assert.deepEqual(afterSnapshot.closures, beforeSnapshot.closures);
  assert.deepEqual(journal.getLedgers(), beforeLedgers);
});

test('UC-05 control v0.2 authority boundary: raw claim ID and v0.1 claim never grant executor authority', () => {
  assert.equal(isExecutorCapability('raw-claim-id-xyz'), false);
  assert.equal(isExecutorCapability('claim-12345'), false);
  assert.equal(isExecutorCapability({ schemaVersion: 'uc05-approval/0.1-draft', claimId: 'claim-1' }), false);
  assert.equal(isExecutorCapability({ claimId: 'claim-1', actionId: 'action-1' }), false);
  assert.equal(isExecutorCapability(null), false);
  assert.equal(isExecutorCapability(undefined), false);
});

test('UC-05 v0.2 closure refuses a wellformed foreign event digest before fencing or release', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-forged-digest'), true);
  const beforeTask = await journal.loadTask(context.taskId);
  const beforeLedgers = journal.getLedgers();
  const beforeSnapshot = journal.getJournalSnapshot();
  const result = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim({
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: { ...pauseProof(journal, 'pause', 'pause-forged-digest'), eventDigest: `sha256:${'f'.repeat(64)}` },
  });

  assert.deepEqual(result, { closed: false, receipt: null });
  assert.deepEqual(await journal.loadTask(context.taskId), beforeTask);
  assert.deepEqual(journal.getLedgers(), beforeLedgers);
  assert.deepEqual(journal.getJournalSnapshot(), beforeSnapshot);
});

test('UC-05 v0.2 closure is claim-scoped after an earlier settled attempt and preserves its history and hold', async () => {
  const providerContext = createTestProviderAdmissionContextV02();
  const providerAuthority = {
    policyId: providerContext.providerIdentity.pricingPolicyId,
    policyVersion: providerContext.providerIdentity.pricingPolicyVersion,
    configId: providerContext.providerIdentity.configId,
    configVersion: providerContext.providerIdentity.configVersion,
    issuerKeyRef: providerContext.providerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: providerContext.providerIdentity.decisionAuthorityGeneration,
  };
  const providerState = createTestAdmissionTaskStateV02(providerContext);
  const journal = new MemoryStatePortV02({
    initialTaskState: providerState,
    transitionContexts: createTestAdmissionTransitionContextsV02(providerContext, providerState),
    initialControlVersion: providerContext.expectedControlVersion,
    initialEpoch: providerContext.expectedEpoch,
    initialAuthorityRef: providerAuthority,
  });
  const priorClaim = await journal.claim(providerContext);
  const priorActor = createTestExecutorIdentityV02({ payloadDigest: providerContext.requestContentDigest });
  const priorAttempt = await journal.beginAttempt(priorClaim.claimId, priorActor);
  assert.equal(isNeutralAttemptReceiptV02(priorAttempt), false);
  const priorOutcome = createTestProviderOutcomeReceiptV02(priorClaim, priorAttempt, providerContext);
  assert.equal((await journal.recordOutcome(priorOutcome)).outcome, 'settled');
  const historicalAttempt = journal.getJournalSnapshot().attempts[0];
  assert.ok(historicalAttempt);
  assert.equal((historicalAttempt as unknown as Record<string, unknown>)['claimId'], priorClaim.claimId);
  const providerAccountingBeforeClosure = journal.getLedgers()
    .filter(ledger => ledger.kind === 'tokens' || ledger.kind === 'cost');

  const repositoryAuthority = createTestRepositoryAdmissionContextV02().policyAuthorityRef;
  assert.equal((await journal.publishAuthority({ authorityRef: repositoryAuthority })).status, 'published');
  const taskBeforeClaim = await journal.loadTask(providerContext.taskId);
  assert.ok(taskBeforeClaim);
  const repositoryContext = createTestRepositoryAdmissionContextV02({
    repositoryId: taskBeforeClaim.repositoryId,
    workspaceId: taskBeforeClaim.workspaceId,
    canonicalRevision: taskBeforeClaim.repositoryRevisionDigest,
    expectedTaskStateVersion: taskBeforeClaim.stateVersion,
    expectedControlVersion: journal.getJournalSnapshot().controlVersion,
  });
  const currentClaim = await journal.claim(repositoryContext);
  const currentActor = createTestExecutorIdentityV02({ payloadDigest: repositoryContext.actionDigest });
  assert.equal(await journal.setTaskControl(repositoryContext.taskId, 'paused', 'pause-after-history'), true);
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(currentClaim.claimId, currentActor)), true);

  const result = await createApprovalControlV02({ taskId: repositoryContext.taskId, journal }).closeUnattemptedClaim({
    claim: dispatchClaim(repositoryContext, currentClaim),
    journalClaim: currentClaim,
    recipientIdentity: currentActor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-after-history'),
  });
  const snapshot = journal.getJournalSnapshot();
  const repair = journal.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');
  const historicalAfter = snapshot.attempts.find(row => row.attemptId === historicalAttempt?.attemptId);

  assert.equal(result.closed, true);
  assert.equal(snapshot.mode, 'paused');
  assert.equal(snapshot.holdRef, 'pause-after-history');
  assert.equal(snapshot.activeClaimId, null);
  assert.equal(snapshot.claims.find(row => row.claimId === currentClaim.claimId)?.status, 'closed');
  assert.ok(historicalAfter);
  assert.equal(historicalAfter?.status, 'settled');
  assert.equal((historicalAfter as unknown as Record<string, unknown>)['claimId'], priorClaim.claimId);
  assert.equal((snapshot.attempts as unknown as readonly Record<string, unknown>[]).some(row => row['claimId'] === currentClaim.claimId), false);
  assert.deepEqual(journal.getLedgers().filter(ledger => ledger.kind === 'tokens' || ledger.kind === 'cost'), providerAccountingBeforeClosure);
  assert.equal(repair?.consumed, 0);
  assert.equal(repair?.reservations.length, 0);
  assert.ok(snapshot.fencedIncarnations.includes(`${currentActor.adapterIdentity}\u0000${currentActor.processIncarnation}`));
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(currentClaim.claimId, currentActor)), true);
});

test('UC-05 v0.2 closure retry reuses its persisted fence after the close port refuses', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-retry-fence'), true);
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-retry-fence'),
  };
  const before = journal.getJournalSnapshot();
  const ledgersBefore = journal.getLedgers();
  const refusingJournal = {
    provenance: 'mock',
    setTaskControl: journal.setTaskControl.bind(journal),
    loadTask: journal.loadTask.bind(journal),
    getJournalSnapshot: journal.getJournalSnapshot.bind(journal),
    fenceClaimRecipient: journal.fenceClaimRecipient.bind(journal),
    closeUnattemptedClaim: async (receipt: Parameters<typeof journal.closeUnattemptedClaim>[0]) => ({
      closed: false,
      receiptId: receipt.receiptId,
    }),
  } as unknown as UC04JournalPortV02;

  const refused = await createApprovalControlV02({ taskId: context.taskId, journal: refusingJournal }).closeUnattemptedClaim(input);
  const afterRefusal = journal.getJournalSnapshot();
  assert.deepEqual(refused, { closed: false, receipt: null });
  assert.equal(afterRefusal.controlVersion, before.controlVersion + 1);
  assert.equal(afterRefusal.mode, 'paused');
  assert.equal(afterRefusal.holdRef, 'pause-retry-fence');
  assert.equal(afterRefusal.activeClaimId, journalClaim.claimId);
  assert.equal(afterRefusal.claims.find(row => row.claimId === journalClaim.claimId)?.status, 'claimed');
  assert.equal(afterRefusal.fenceProofs.length, 1);
  assert.deepEqual(journal.getLedgers(), ledgersBefore);

  const retried = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim(input);
  const afterRetry = journal.getJournalSnapshot();
  const repair = journal.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.equal(retried.closed, true);
  assert.equal(afterRetry.mode, 'paused');
  assert.equal(afterRetry.holdRef, 'pause-retry-fence');
  assert.equal(afterRetry.activeClaimId, null);
  assert.equal(afterRetry.claims.find(row => row.claimId === journalClaim.claimId)?.status, 'closed');
  assert.equal(afterRetry.fenceProofs.length, 1);
  assert.equal(afterRetry.closures.length, 1);
  assert.equal(repair?.consumed, 0);
  assert.equal(repair?.reservations.length, 0);
  assert.ok(afterRetry.fencedIncarnations.includes(`${actor.adapterIdentity}\u0000${actor.processIncarnation}`));
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), true);
});

test('UC-05 v0.2 closure exact retry recovers a lost committed close response', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const journalClaim = await journal.claim(context);
  const claim = dispatchClaim(context, journalClaim);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-lost-close'), true);
  const input = {
    claim,
    journalClaim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseProof(journal, 'pause', 'pause-lost-close'),
  };
  let lostResponse = true;
  const losingJournal = {
    provenance: 'mock',
    setTaskControl: journal.setTaskControl.bind(journal),
    loadTask: journal.loadTask.bind(journal),
    getJournalSnapshot: journal.getJournalSnapshot.bind(journal),
    fenceClaimRecipient: journal.fenceClaimRecipient.bind(journal),
    closeUnattemptedClaim: async (receipt: Parameters<typeof journal.closeUnattemptedClaim>[0]) => {
      const response = await journal.closeUnattemptedClaim(receipt);
      assert.equal(response.closed, true);
      if (lostResponse) {
        lostResponse = false;
        throw new Error('lost-close-response');
      }
      return response;
    },
  } as unknown as UC04JournalPortV02;
  const lost = await createApprovalControlV02({ taskId: context.taskId, journal: losingJournal }).closeUnattemptedClaim(input);
  const afterLostResponse = journal.getJournalSnapshot();
  const repairAfterFirstClose = journal.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');

  assert.deepEqual(lost, { closed: false, receipt: null });
  assert.equal(afterLostResponse.mode, 'paused');
  assert.equal(afterLostResponse.holdRef, 'pause-lost-close');
  assert.equal(afterLostResponse.activeClaimId, null);
  assert.equal(afterLostResponse.claims.find(row => row.claimId === journalClaim.claimId)?.status, 'closed');
  assert.equal(afterLostResponse.closures.length, 1);
  assert.equal(repairAfterFirstClose?.consumed, 0);
  assert.equal(repairAfterFirstClose?.reservations.length, 0);

  const retried = await createApprovalControlV02({ taskId: context.taskId, journal }).closeUnattemptedClaim(input);
  const afterRetry = journal.getJournalSnapshot();
  const repairAfterRetry = journal.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'repair');
  assert.equal(retried.closed, true);
  assert.equal(retried.receipt?.receiptId, afterLostResponse.closures[0]?.receiptId);
  assert.equal(afterRetry.mode, 'paused');
  assert.equal(afterRetry.holdRef, 'pause-lost-close');
  assert.equal(afterRetry.activeClaimId, null);
  assert.equal(afterRetry.closures.length, 1);
  assert.equal(repairAfterRetry?.consumed, 0);
  assert.equal(repairAfterRetry?.reservations.length, 0);
  assert.ok(afterRetry.fencedIncarnations.includes(`${actor.adapterIdentity}\u0000${actor.processIncarnation}`));
  assert.equal(isNeutralAttemptReceiptV02(await journal.beginAttempt(journalClaim.claimId, actor)), true);
});
