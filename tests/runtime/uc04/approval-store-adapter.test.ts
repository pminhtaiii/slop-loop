import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApprovalRequestRecord, DecisionEvent, DeveloperDirection, HumanResolution } from '../../../src/contracts/approvals/contracts.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import { ApprovalServiceError, createApprovalService } from '../../../src/approvals/service.ts';
import type { ApprovalStore } from '../../../src/approvals/service.ts';
import { UC04_SCHEMA_VERSION, type TaskState } from '../../../src/persistence/contracts.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { createTestAdmissionTaskStateV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const actionDigest = `sha256:${'a'.repeat(64)}`;
const presentationDigest = `sha256:${'b'.repeat(64)}`;
const repoDigest = `sha256:${'d'.repeat(64)}`;
const policyRef = { policyId: 'policy-1', policyVersion: '1.0.0', configId: 'config-1', configVersion: '1.0.0' };
const trustedOperator = { actorId: 'developer-local', channelRef: 'channel-local', provenance: 'real' as const };

test('UC-04 / UC-05: DurableApprovalStore Adapter', async t => {
  const tempDir = mkdtempSync(join(tmpdir(), 'uc05-approval-store-test-'));

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const taskId = 'task-1';
  const decisionId = 'decision-1';

  const sampleRequest: ApprovalRequestRecord = {
    schemaVersion: 'uc05-approval/0.1-draft',
    decisionId,
    taskId,
    repositoryId: 'repo-1',
    workspaceId: 'workspace-1',
    createdRunId: 'run-1',
    continuationRef: 'continuation-1',
    requestVersion: 1,
    policyId: 'policy-1',
    policyVersion: '1.0.0',
    configId: 'config-1',
    configVersion: '1.0.0',
    actionRef: 'action-1',
    actionDigest,
    presentationDigest,
    createdAt: '2026-10-26T07:00:00.000Z',
    submissionKey: 'submission-1',
    binding: {
      decisionId,
      actionKind: 'action',
      normalizedActionDigest: actionDigest,
      taskId,
      workspaceId: 'workspace-1',
      repositoryRevisionDigest: repoDigest,
      policyId: 'policy-1',
      policyVersion: '1.0.0',
      status: 'pending',
    },
  };
  const requestFor = (localTaskId: string, localDecisionId: string, extra: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
    ...sampleRequest,
    ...extra,
    taskId: localTaskId,
    decisionId: localDecisionId,
    binding: { ...sampleRequest.binding, taskId: localTaskId, decisionId: localDecisionId },
  });

  const sampleEvent: DecisionEvent = {
    schemaVersion: 'uc05-approval/0.1-draft',
    eventId: 'event-1',
    taskId,
    runId: 'run-1',
    decisionId,
    directionId: null,
    claimId: null,
    type: 'approval-request-created',
    outcome: 'pending',
    policyRef,
    safeReasonCode: 'approval-requested',
    timestamp: '2026-10-26T07:00:01.000Z',
  };

  const eventOf = (overrides: Partial<DecisionEvent>): DecisionEvent => ({ ...sampleEvent, ...overrides });

  const resolutionOf = (responseKey: string, eventId: string): HumanResolution => ({
    schemaVersion: 'uc05-approval/0.1-draft',
    decisionId,
    responseKey,
    expectedRequestVersion: 1,
    operatorChannelRef: 'channel-local',
    decision: 'approved',
    safeReasonCode: 'developer-approved',
    decidedAt: '2026-10-26T07:05:00.000Z',
    eventId,
  });

  const listTree = (root: string): readonly string[] =>
    existsSync(root)
      ? readdirSync(root, { recursive: true, encoding: 'utf8' })
          .map(path => path.replaceAll('\\', '/'))
          .sort()
      : [];

  const writeStoredEvents = (storageDir: string, ownerTaskId: string, events: readonly unknown[]): void => {
    const dir = join(storageDir, 'tasks', ownerTaskId, 'approvals');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.json'), JSON.stringify(events), 'utf8');
  };

  const withFreshStore = (prefix: string, run: (dir: string, store: DurableApprovalStore) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try {
      run(dir, new DurableApprovalStore({ storageDir: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const interopTaskId = 'task-interop';
  const interopDecisionId = 'decision-interop';
  const interopAction = { actionId: 'action-interop', kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/'], workingDirectory: '/workspace' };

  const taskStateOf = (repositoryId: string, workspaceId: string): TaskState => ({
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: interopTaskId,
    runId: 'run-interop',
    repositoryId,
    workspaceId,
    taskType: 'feature',
    goal: 'g',
    acceptanceCriteria: ['c'],
    constraints: [],
    plan: [{ id: 's-1', title: 'Step', description: 'First', status: 'todo' }],
    currentStepIndex: 0,
    status: 'pending',
    stateVersion: 1,
    budgetLedgers: [],
    workspaceBaseline: { commitHash: 'abcdef1234567890', branch: 'feature', isClean: true, trackedFilesHash: 'hash' },
    changedFiles: [],
    openRisks: [],
    nextAction: 'start',
  });

  const contextFor = (taskId: string, repositoryId: string, workspaceId: string) => createTestRepositoryCommandAdmissionContextV02({ taskId, repositoryId, workspaceId });

  const contextOf = (repositoryId: string, workspaceId: string): unknown => ({
    action: interopAction,
    runId: 'run-interop',
    freshness: {
      currentTaskId: interopTaskId,
      currentWorkspaceId: workspaceId,
      currentRepositoryRevisionDigest: repoDigest,
      currentPolicyId: DEFAULT_POLICY_PROFILE.policyIdentity.policyId,
      currentPolicyVersion: DEFAULT_POLICY_PROFILE.policyIdentity.policyVersion,
      currentNormalizedActionDigest: computeActionDigest(interopAction),
    },
    elements: { action: 'Run focused tests', necessity: 'Verify', targets: ['tests/test_x.py'], consequences: 'Runs tests', verificationStatus: 'Not executed' },
    facts: {
      taskId: interopTaskId,
      repositoryId,
      workspaceId,
      repositoryRevisionDigest: repoDigest,
      policyIdentity: DEFAULT_POLICY_PROFILE.policyIdentity,
      registeredActionDigest: computeActionDigest(interopAction),
      continuationRef: 'continuation-interop',
      role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'tests', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' },
      patch: null,
      plan: null,
    },
  });

  const bindingOf = () => ({
    decisionId: interopDecisionId,
    actionKind: 'action' as const,
    normalizedActionDigest: computeActionDigest(interopAction),
    taskId: interopTaskId,
    workspaceId: 'workspace-1',
    repositoryRevisionDigest: repoDigest,
    policyId: DEFAULT_POLICY_PROFILE.policyIdentity.policyId,
    policyVersion: DEFAULT_POLICY_PROFILE.policyIdentity.policyVersion,
    status: 'pending' as const,
  });

  await t.test('loads initial task control and creates pending approval', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const initial = store.loadTaskControl(taskId);
    assert.equal(initial.safe.outcome, 'ok');
    assert.equal(initial.value?.mode, 'runnable');
    assert.equal(initial.value?.version, 1);

    const pendingRes = store.createPendingAndPause({
      expectedControlVersion: 1,
      submissionKey: 'submission-1',
      request: sampleRequest,
      event: sampleEvent,
    });

    assert.equal(pendingRes.safe.outcome, 'pending');
    assert.equal(pendingRes.safe.eventRef, sampleEvent.eventId);
    assert.equal(pendingRes.value?.decisionId, decisionId);

    const afterPause = store.loadTaskControl(taskId);
    assert.equal(afterPause.value?.mode, 'waiting');
    assert.equal(afterPause.value?.version, 2);
    assert.equal(afterPause.value?.pendingDecisionId, decisionId);
  });

  await t.test('simulates process restart: fresh store instance reads state from disk', () => {
    const restartedStore = new DurableApprovalStore({ storageDir: tempDir });

    const controlRes = restartedStore.loadTaskControl(taskId);
    assert.equal(controlRes.safe.outcome, 'ok');
    assert.equal(controlRes.value?.mode, 'waiting');
    assert.equal(controlRes.value?.version, 2);
    assert.equal(controlRes.value?.pendingDecisionId, decisionId);

    const requestRes = restartedStore.readRequest(decisionId);
    assert.equal(requestRes.safe.outcome, 'ok');
    assert.equal(requestRes.value?.actionRef, 'action-1');
    assert.equal(requestRes.value?.binding.actionKind, 'action');

    const eventsRes = restartedStore.readEvents(taskId);
    assert.equal(eventsRes.safe.outcome, 'ok');
    assert.equal(eventsRes.value?.length, 1);
    assert.equal(eventsRes.value?.[0]?.eventId, 'event-1');
  });

  await t.test('rejects resolution without trusted operator', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const res = store.resolvePending({
      expectedControlVersion: 2,
      expectedRequestVersion: 1,
      trustedResponse: resolutionOf('response-no-op', 'event-resolution-0'),
    });

    assert.equal(res.safe.outcome, 'denied');
    assert.equal(res.safe.safeReasonCode, 'missing-trusted-operator');
  });

  await t.test('resolves pending approval and resumes task to runnable', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const resolution = resolutionOf('response-1', 'event-resolution-1');

    const resolveRes = store.resolvePending({
      expectedControlVersion: 2,
      expectedRequestVersion: 1,
      trustedResponse: resolution,
      trustedOperator,
      event: eventOf({
        eventId: 'event-resolution-1',
        type: 'human-resolution-recorded',
        outcome: 'ok',
        safeReasonCode: 'developer-approved',
        timestamp: '2026-10-26T07:05:01.000Z',
      }),
    });

    assert.equal(resolveRes.safe.outcome, 'ok');
    assert.equal(resolveRes.value?.decision, 'approved');

    const finalControl = store.loadTaskControl(taskId);
    assert.equal(finalControl.value?.mode, 'runnable');
    assert.equal(finalControl.value?.version, 3);
    assert.equal(finalControl.value?.pendingDecisionId, null);

    const history = store.readHistory(taskId);
    assert.equal(history.value?.resolutions.length, 1);
    assert.equal(history.value?.resolutions[0]?.decision, 'approved');
  });

  await t.test('prevents replay resolution when task is no longer waiting', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const res = store.resolvePending({
      trustedResponse: resolutionOf('response-replay', 'event-replay-1'),
      trustedOperator,
    });

    assert.equal(res.safe.outcome, 'conflict');
    assert.equal(res.safe.safeReasonCode, 'task-not-waiting');
  });

  await t.test('records developer direction with operator identity', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const direction: DeveloperDirection = {
      schemaVersion: 'uc05-approval/0.1-draft',
      directionId: 'dir-1',
      taskId,
      expectedVersion: 3,
      expectedEpoch: 3,
      direction: 'resume',
      safeScopeRef: 'scope-1',
      responseKey: 'response-key-1',
      createdAt: '2026-10-26T07:07:00.000Z',
    };

    const dirRes = store.recordDirection({ direction, trustedOperator });

    assert.equal(dirRes.safe.outcome, 'ok');
    const control = store.loadTaskControl(taskId);
    assert.equal(control.value?.mode, 'runnable');
  });

  await t.test('detects version conflict safely', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const conflictRes = store.resolvePending({
      expectedControlVersion: 999,
      expectedRequestVersion: 1,
      trustedOperator,
      trustedResponse: resolutionOf('response-conflict', 'event-conflict-1'),
    });

    assert.equal(conflictRes.safe.outcome, 'conflict');
  });

  await t.test('rejects malformed decision event in pending creation', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const invalidEventRes = store.createPendingAndPause({
      expectedControlVersion: 1,
      submissionKey: 'submission-invalid-ev',
      request: requestFor('task-malformed-ev', 'decision-invalid-ev'),
      event: { invalid: 'event-shape' },
    });

    assert.equal(invalidEventRes.safe.outcome, 'denied');
    assert.equal(invalidEventRes.safe.safeReasonCode, 'invalid-event');
  });

  await t.test('rejects a repeated resolution once the task is no longer waiting', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const res2 = store.resolvePending({
      expectedRequestVersion: 1,
      trustedOperator,
      trustedResponse: resolutionOf('resp-different-key', 'ev-idempotent-1'),
    });

    assert.equal(res2.safe.outcome, 'conflict');
    assert.equal(res2.safe.safeReasonCode, 'task-not-waiting');
  });

  await t.test('ensures idempotent resolution retry with matching responseKey while waiting', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const localTaskId = 'task-idempotent-retry';
    const localDecisionId = 'dec-idempotent-retry';
    store.createPendingAndPause({
      taskId: localTaskId,
      request: requestFor(localTaskId, localDecisionId),
      binding: requestFor(localTaskId, localDecisionId).binding,
    });

    const trustedResponse = {
      schemaVersion: 'uc05-approval/0.1-draft' as const,
      decisionId: localDecisionId,
      responseKey: 'resp-matched-key',
      expectedRequestVersion: 1,
      operatorChannelRef: 'channel-local',
      decision: 'approved' as const,
      safeReasonCode: 'developer-approved',
      decidedAt: '2026-10-26T07:08:00.000Z',
      eventId: 'ev-idempotent-matched',
    };

    const firstRes = store.resolvePending({ expectedRequestVersion: 1, trustedOperator, trustedResponse });
    assert.equal(firstRes.safe.outcome, 'ok');

    const controlPath = join(tempDir, 'tasks', localTaskId, 'approvals', 'control.json');
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    control.mode = 'waiting';
    control.pendingDecisionId = localDecisionId;
    control.continuationRef = 'cont-1';
    control.reasonCode = 'waiting-approval';
    writeFileSync(controlPath, JSON.stringify(control, null, 2), 'utf8');

    const retryRes = store.resolvePending({ expectedRequestVersion: 1, trustedOperator, trustedResponse });
    assert.equal(retryRes.safe.outcome, 'ok');
    assert.equal(retryRes.safe.safeReasonCode, 'already-resolved');
  });

  await t.test('denies appendEvent when event taskId does not match target task', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const res = store.appendEvent('task-mismatch-target', {
      ...sampleEvent,
      eventId: 'event-mismatch-1',
      taskId: 'task-other-id',
      type: 'human-resolution-recorded',
      outcome: 'ok',
      safeReasonCode: 'developer-approved',
      timestamp: '2026-10-26T07:00:00.000Z',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'denied');
    assert.equal(res.reason, 'task-id-mismatch');
  });

  await t.test('refused first direction writes nothing for a missing operator', () => {
    withFreshStore('uc05-approval-refused-direction-', (dir, store) => {
      const before = listTree(dir);
      const res = store.recordDirection({ direction: { taskId: 'new-task' } });
      assert.equal(res.safe.outcome, 'denied');
      assert.equal(res.safe.safeReasonCode, 'missing-trusted-operator');
      assert.deepEqual(listTree(dir), before);
      assert.equal(existsSync(join(dir, 'tasks', 'new-task', 'approvals', 'control.json')), false);
    });
  });

  await t.test('refused traversal direction writes nothing', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'uc05-approval-traversal-'));
    try {
      const store = new DurableApprovalStore({ storageDir: join(freshDir, 'store') });
      const res = store.recordDirection({ direction: { taskId: '../../escape' } });
      assert.equal(res.safe.outcome, 'denied');
      assert.equal(res.safe.safeReasonCode, 'invalid-id');
      assert.deepEqual(listTree(freshDir), ['store']);
      assert.equal(existsSync(join(freshDir, 'escape')), false);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  await t.test('successful first direction still creates control', () => {
    withFreshStore('uc05-approval-first-direction-', (dir, store) => {
      const firstTaskId = 'first-direction-task';
      const res = store.recordDirection({
        direction: {
          schemaVersion: 'uc05-approval/0.1-draft',
          directionId: 'dir-first',
          taskId: firstTaskId,
          expectedVersion: 1,
          expectedEpoch: 1,
          direction: 'resume',
          safeScopeRef: 'scope-1',
          responseKey: 'response-key-first',
          createdAt: '2026-10-26T07:09:00.000Z',
        },
        trustedOperator,
      });
      assert.equal(res.safe.outcome, 'ok');
      assert.equal(res.safe.safeReasonCode, 'direction-recorded');
      assert.equal(existsSync(join(dir, 'tasks', firstTaskId, 'approvals', 'control.json')), true);
      assert.equal(store.loadTaskControl(firstTaskId).value?.mode, 'runnable');
    });
  });

  await t.test('refuses a forged persisted event array', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    writeStoredEvents(tempDir, 'event-task', [
      {
        eventId: 'forged',
        taskId: 'another-task',
        rawPrompt: 'protected-marker',
      },
    ]);
    const res = store.readEvents('event-task');
    assert.notEqual(res.safe.outcome, 'ok');
    assert.equal(res.value, null);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes('protected-marker'), false);
    assert.equal(serialized.includes('another-task'), false);
  });

  await t.test('refuses a cross-task but structurally valid persisted event', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    writeStoredEvents(tempDir, 'event-task', [eventOf({ eventId: 'event-foreign', taskId: 'other-task' })]);
    const res = store.readEvents('event-task');
    assert.equal(res.safe.outcome, 'denied');
    assert.equal(res.safe.safeReasonCode, 'task-id-mismatch');
    assert.equal(res.value, null);

    const append = store.appendEvent('event-task', eventOf({ eventId: 'event-own' }));
    assert.equal(append.ok, false);
    assert.equal(store.readEvents('event-task').value, null);
  });

  await t.test('accepts a validated same-task event array', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    writeStoredEvents(tempDir, 'event-task', [eventOf({ eventId: 'event-stored', taskId: 'event-task' })]);
    const res = store.readEvents('event-task');
    assert.equal(res.safe.outcome, 'ok');
    assert.equal(res.safe.safeReasonCode, 'events-loaded');
    assert.deepEqual(
      res.value?.map(ev => ev.eventId),
      ['event-stored'],
    );

    assert.deepEqual(store.appendEvent('event-task', eventOf({ eventId: 'event-new', taskId: 'event-task' })), { ok: true, status: 'appended' });
    assert.deepEqual(
      store.readEvents('event-task').value?.map(ev => ev.eventId),
      ['event-stored', 'event-new'],
    );
  });

  await t.test('refused first pending creation leaves no control file', () => {
    withFreshStore('uc05-approval-refused-pending-', (dir, store) => {
      const res = store.createPendingAndPause({ expectedControlVersion: 99, request: sampleRequest, event: sampleEvent });
      assert.equal(res.safe.outcome, 'conflict');
      assert.equal(res.safe.safeReasonCode, 'version-conflict');
      assert.deepEqual(listTree(dir), []);
    });
  });

  await t.test('first pending creation continues control from the created default', () => {
    withFreshStore('uc05-approval-first-pending-', (_dir, store) => {
      const res = store.createPendingAndPause({ request: sampleRequest, event: sampleEvent });
      assert.equal(res.safe.outcome, 'pending');
      assert.equal(res.safe.safeReasonCode, 'pending-created');
      assert.equal(res.safe.eventRef, sampleEvent.eventId);
      const control = store.loadTaskControl(taskId).value;
      // The first control takes the request's actual mapping, not the controlled seed.
      assert.deepEqual([control?.mode, control?.version, control?.pendingDecisionId], ['waiting', 2, decisionId]);
      assert.deepEqual([control?.repositoryId, control?.workspaceId], ['repo-1', 'workspace-1']);
    });
  });

  await t.test('refused replacement event batch appends none of its events', () => {
    withFreshStore('uc05-approval-atomic-events-', (dir, store) => {
      const task = 'task-atomic-events';
      const pending = 'decision-atomic-events';
      store.createPendingAndPause({
        request: requestFor(task, pending),
        event: eventOf({ eventId: 'event-existing', taskId: task, decisionId: pending }),
      });

      const res = store.replaceStalePending({
        replacement: requestFor(task, 'decision-replacement', { continuationRef: 'continuation-2' }),
        events: [
          eventOf({ eventId: 'event-batch-new', taskId: task, decisionId: 'decision-replacement' }),
          eventOf({ eventId: 'event-existing', taskId: task, decisionId: pending, safeReasonCode: 'different-reason' }),
        ],
      });

      assert.equal(res.safe.outcome, 'conflict');
      assert.equal(res.safe.safeReasonCode, 'event-conflict');
      assert.deepEqual(
        store.readEvents(task).value?.map(ev => ev.eventId),
        ['event-existing'],
      );
      assert.equal(existsSync(join(dir, 'decisions', 'decision-replacement', 'request.json')), false);
    });
  });

  await t.test('stored events survive a tightened profile and new events still append', () => {
    withFreshStore('uc05-approval-profile-tightened-', dir => {
      const task = 'task-tight-profile';
      writeStoredEvents(dir, task, [eventOf({ eventId: 'event-stored-large', taskId: task, runId: 'r'.repeat(120) })]);
      const store = new DurableApprovalStore({
        storageDir: dir,
        profile: { ...DEFAULT_POLICY_PROFILE, maxEventBytes: 450, diagnosticRules: { ...DEFAULT_POLICY_PROFILE.diagnosticRules, maxBytes: 450 } },
      });

      const readRes = store.readEvents(task);
      assert.equal(readRes.safe.safeReasonCode, 'events-loaded');
      assert.deepEqual(
        readRes.value?.map(ev => ev.eventId),
        ['event-stored-large'],
      );

      assert.deepEqual(store.appendEvent(task, eventOf({ eventId: 'event-small', taskId: task })), { ok: true, status: 'appended' });
      assert.deepEqual(
        store.readEvents(task).value?.map(ev => ev.eventId),
        ['event-stored-large', 'event-small'],
      );
    });
  });

  await t.test('throws when invalid policy profile is supplied', () => {
    assert.throws(() => new DurableApprovalStore({ storageDir: tempDir, profile: null }), /Invalid policy profile/);
    assert.throws(() => new DurableApprovalStore({ storageDir: tempDir, profile: '' }), /Invalid policy profile/);
  });

  await t.test('reports a missing decision as invalid/unknown-decision for the UC-05 request path', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const missing = store.readRequest('decision-absent');
    assert.equal(missing.safe.outcome, 'invalid');
    assert.equal(missing.safe.safeReasonCode, 'unknown-decision');
    assert.equal(missing.value, null);
  });

  await t.test('acknowledges a committed resolution and direction with their event ids', () => {
    withFreshStore('uc05-approval-receipt-events-', (_dir, store) => {
      const task = 'task-receipt-events';
      const pending = 'decision-receipt-events';
      const pendingEvent = eventOf({ eventId: 'event-receipt-request', taskId: task, decisionId: pending });
      const created = store.createPendingAndPause({ request: requestFor(task, pending), event: pendingEvent });
      assert.equal(created.safe.outcome, 'pending');
      assert.equal(created.safe.eventRef, pendingEvent.eventId);

      const resolutionEvent = eventOf({ eventId: 'event-receipt-resolution', taskId: task, decisionId: pending, type: 'human-resolution-recorded', outcome: 'ok' });
      const resolved = store.resolvePending({
        expectedControlVersion: created.safe.controlVersion,
        expectedRequestVersion: 1,
        trustedOperator,
        trustedResponse: { ...resolutionOf('response-receipt', resolutionEvent.eventId), decisionId: pending },
        event: resolutionEvent,
      });
      assert.equal(resolved.safe.outcome, 'ok');
      assert.equal(resolved.safe.eventRef, resolutionEvent.eventId);

      const directionEvent = eventOf({
        eventId: 'event-receipt-direction',
        taskId: task,
        decisionId: null,
        directionId: 'dir-receipt',
        type: 'developer-direction-recorded',
        outcome: 'ok',
      });
      const directed = store.recordDirection({
        direction: {
          schemaVersion: 'uc05-approval/0.1-draft',
          directionId: 'dir-receipt',
          taskId: task,
          expectedVersion: resolved.safe.controlVersion,
          expectedEpoch: resolved.safe.controlVersion,
          direction: 'resume',
          safeScopeRef: 'scope-receipt',
          responseKey: 'response-key-receipt',
          createdAt: '2026-10-26T07:10:00.000Z',
        },
        trustedOperator,
        event: directionEvent,
      });
      assert.equal(directed.safe.outcome, 'ok');
      assert.equal(directed.safe.eventRef, directionEvent.eventId);
    });
  });

  await t.test('UC-05 service accepts the v0.2 owner task mapping from the claim directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc05-approval-interop-'));
    try {
      const durable = new DurableStore(dir);
      await durable.init();
      const port = new DurableStatePortV02({ store: durable });
      await port.transition(createTestAdmissionTaskStateV02(contextFor(interopTaskId, 'repo-1', 'workspace-1')), 0);
      const approvals = new DurableApprovalStore({ storageDir: dir, durableStore: durable });
      const service = createApprovalService({
        taskId: interopTaskId,
        profile: DEFAULT_POLICY_PROFILE,
        store: approvals as unknown as ApprovalStore,
        context: { loadForAction: async () => contextOf('repo-1', 'workspace-1'), loadForDecision: async () => contextOf('repo-1', 'workspace-1') },
        operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
        now: () => '2026-11-14T00:00:00.000Z',
      });

      const binding = await service.requestDecision(bindingOf());
      assert.equal(binding.decisionId, interopDecisionId);
      assert.equal(binding.status, 'pending');

      const control = approvals.loadTaskControl(interopTaskId).value;
      assert.deepEqual([control?.mode, control?.repositoryId, control?.workspaceId], ['waiting', 'repo-1', 'workspace-1']);

      const stored = approvals.readRequest(interopDecisionId);
      assert.equal(stored.safe.outcome, 'ok');
      assert.equal(stored.safe.eventRef, null, 'a read carries no write acknowledgement');

      const events = approvals.readEvents(interopTaskId).value ?? [];
      assert.equal(events.filter(event => event.type === 'approval-request-created').length, 1);
      assert.equal(events.find(event => event.type === 'approval-request-created')?.decisionId, interopDecisionId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('UC-05 service refuses a context whose mapping differs from the control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc05-approval-mapping-'));
    try {
      const durable = new DurableStore(dir);
      const approvals = new DurableApprovalStore({ storageDir: dir, durableStore: durable });
      await durable.saveTask(taskStateOf('repo-1', 'workspace-1'));
      const service = createApprovalService({
        taskId: interopTaskId,
        profile: DEFAULT_POLICY_PROFILE,
        store: approvals as unknown as ApprovalStore,
        context: { loadForAction: async () => contextOf('repo-2', 'workspace-1'), loadForDecision: async () => contextOf('repo-2', 'workspace-1') },
        operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
        now: () => '2026-11-14T00:00:00.000Z',
      });

      await assert.rejects(
        service.requestDecision(bindingOf()),
        (error: unknown) => error instanceof ApprovalServiceError && error.outcome === 'stale' && error.reasonCode === 'changed-repository-mapping',
      );
      assert.equal(approvals.readRequest(interopDecisionId).safe.safeReasonCode, 'unknown-decision');
      assert.equal(approvals.loadTaskControl(interopTaskId).value?.mode, 'runnable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a resolution retry after a failed control write acknowledges the committed event, not the retried id', () => {
    withFreshStore('uc05-approval-replay-receipt-', (dir, store) => {
      const task = 'task-replay-receipt';
      const pending = 'decision-replay-receipt';
      store.createPendingAndPause({ request: requestFor(task, pending), event: eventOf({ eventId: 'event-replay-request', taskId: task, decisionId: pending }) });

      const committed = resolutionOf('response-replay-receipt', 'event-replay-committed');
      const committedEvent = eventOf({ eventId: committed.eventId, taskId: task, decisionId: pending, type: 'human-resolution-recorded', outcome: 'ok' });
      // History and the audit event landed; only the control write was lost, so the task is still waiting.
      const approvalsDir = join(dir, 'tasks', task, 'approvals');
      writeFileSync(join(approvalsDir, 'history.json'), JSON.stringify({ resolutions: [{ ...committed, decisionId: pending }], directions: [], assessments: [], claims: [] }), 'utf8');
      writeFileSync(join(approvalsDir, 'events.json'), JSON.stringify([eventOf({ eventId: 'event-replay-request', taskId: task, decisionId: pending }), committedEvent]), 'utf8');

      const retry = store.resolvePending({
        expectedControlVersion: 2,
        expectedRequestVersion: 1,
        trustedOperator,
        trustedResponse: { ...committed, decisionId: pending, eventId: 'event-replay-retried' },
        event: eventOf({ eventId: 'event-replay-retried', taskId: task, decisionId: pending, type: 'human-resolution-recorded', outcome: 'ok' }),
      });

      assert.equal(retry.safe.outcome, 'ok');
      assert.equal(retry.safe.safeReasonCode, 'already-resolved');
      assert.equal(retry.safe.eventRef, committed.eventId);
      assert.deepEqual(
        store.readEvents(task).value?.map(ev => ev.eventId),
        ['event-replay-request', committed.eventId],
      );
    });
  });

  await t.test('a direction retry after a failed control write acknowledges the committed event, not the retried id', () => {
    withFreshStore('uc05-approval-direction-replay-', (dir, store) => {
      const task = 'task-direction-replay';
      store.loadTaskControl(task);
      const direction = {
        schemaVersion: 'uc05-approval/0.1-draft' as const,
        directionId: 'dir-replay',
        taskId: task,
        expectedVersion: 1,
        expectedEpoch: 1,
        direction: 'resume' as const,
        safeScopeRef: 'scope-replay',
        responseKey: 'response-key-replay',
        createdAt: '2026-10-26T07:11:00.000Z',
      };
      const committedEvent = eventOf({ eventId: 'event-direction-committed', taskId: task, decisionId: null, directionId: direction.directionId, type: 'developer-direction-recorded', outcome: 'ok' });
      // History and the audit event landed; only the control write was lost.
      const approvalsDir = join(dir, 'tasks', task, 'approvals');
      writeFileSync(join(approvalsDir, 'history.json'), JSON.stringify({ resolutions: [], directions: [direction], assessments: [], claims: [] }), 'utf8');
      writeFileSync(join(approvalsDir, 'events.json'), JSON.stringify([committedEvent]), 'utf8');

      const retry = store.recordDirection({
        direction,
        trustedOperator,
        event: eventOf({ eventId: 'event-direction-retried', taskId: task, decisionId: null, directionId: direction.directionId, type: 'developer-direction-recorded', outcome: 'ok' }),
      });

      assert.equal(retry.safe.outcome, 'ok');
      assert.equal(retry.safe.eventRef, committedEvent.eventId);
      assert.deepEqual(
        store.readEvents(task).value?.map(ev => ev.eventId),
        [committedEvent.eventId],
      );
    });
  });

  await t.test('refuses an unreadable existing task record and writes no control', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc05-approval-unreadable-task-'));
    try {
      const durable = new DurableStore(dir);
      const taskPath = durable.getTaskPath('task-unreadable');
      mkdirSync(join(dir, 'tasks'), { recursive: true });
      writeFileSync(taskPath, '{ not json', 'utf8');
      const approvals = new DurableApprovalStore({ storageDir: dir, durableStore: durable });

      const loaded = approvals.loadTaskControl('task-unreadable');
      assert.equal(loaded.safe.outcome, 'denied');
      assert.equal(loaded.safe.safeReasonCode, 'invalid-stored-task');
      assert.equal(existsSync(join(dir, 'tasks', 'task-unreadable', 'approvals', 'control.json')), false);

      const directed = approvals.recordDirection({ direction: { taskId: 'task-unreadable' }, trustedOperator });
      assert.equal(directed.safe.outcome, 'denied');
      assert.equal(directed.safe.safeReasonCode, 'invalid-stored-task');
      assert.equal(existsSync(join(dir, 'tasks', 'task-unreadable', 'approvals')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
