import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ApprovalRequestRecord,
  DecisionEvent,
  DeveloperDirection,
  HumanResolution,
} from '../../../src/contracts/approvals/contracts.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';

const actionDigest = `sha256:${'a'.repeat(64)}`;
const presentationDigest = `sha256:${'b'.repeat(64)}`;
const repoDigest = `sha256:${'d'.repeat(64)}`;

test('UC-04 / UC-05: DurableApprovalStore Adapter', async (t) => {
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
    policyRef: {
      policyId: 'policy-1',
      policyVersion: '1.0.0',
      configId: 'config-1',
      configVersion: '1.0.0',
    },
    safeReasonCode: 'approval-requested',
    timestamp: '2026-10-26T07:00:01.000Z',
  };

  const trustedOperator = {
    actorId: 'developer-local',
    channelRef: 'channel-local',
    provenance: 'real' as const,
  };

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

    assert.equal(pendingRes.safe.outcome, 'ok');
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

    const resolution: HumanResolution = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      responseKey: 'response-no-op',
      expectedRequestVersion: 1,
      operatorChannelRef: 'channel-local',
      decision: 'approved',
      safeReasonCode: 'developer-approved',
      decidedAt: '2026-10-26T07:05:00.000Z',
      eventId: 'event-resolution-0',
    };

    const res = store.resolvePending({
      expectedControlVersion: 2,
      expectedRequestVersion: 1,
      trustedResponse: resolution,
    });

    assert.equal(res.safe.outcome, 'denied');
    assert.equal(res.safe.safeReasonCode, 'missing-trusted-operator');
  });

  await t.test('resolves pending approval and resumes task to runnable', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });

    const resolution: HumanResolution = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      responseKey: 'response-1',
      expectedRequestVersion: 1,
      operatorChannelRef: 'channel-local',
      decision: 'approved',
      safeReasonCode: 'developer-approved',
      decidedAt: '2026-10-26T07:05:00.000Z',
      eventId: 'event-resolution-1',
    };

    const resolveRes = store.resolvePending({
      expectedControlVersion: 2,
      expectedRequestVersion: 1,
      trustedResponse: resolution,
      trustedOperator,
      event: {
        schemaVersion: 'uc05-approval/0.1-draft',
        eventId: 'event-resolution-1',
        taskId,
        runId: 'run-1',
        decisionId,
        directionId: null,
        claimId: null,
        type: 'human-resolution-recorded',
        outcome: 'ok',
        policyRef: {
          policyId: 'policy-1',
          policyVersion: '1.0.0',
          configId: 'config-1',
          configVersion: '1.0.0',
        },
        safeReasonCode: 'developer-approved',
        timestamp: '2026-10-26T07:05:01.000Z',
      },
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

    const resolution: HumanResolution = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      responseKey: 'response-replay',
      expectedRequestVersion: 1,
      operatorChannelRef: 'channel-local',
      decision: 'approved',
      safeReasonCode: 'developer-approved',
      decidedAt: '2026-10-26T07:06:00.000Z',
      eventId: 'event-replay-1',
    };

    const res = store.resolvePending({
      trustedResponse: resolution,
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

    const dirRes = store.recordDirection({
      direction,
      trustedOperator,
    });

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
      trustedResponse: {
        schemaVersion: 'uc05-approval/0.1-draft',
        decisionId,
        responseKey: 'response-conflict',
        expectedRequestVersion: 1,
        operatorChannelRef: 'channel-local',
        decision: 'approved',
        safeReasonCode: 'developer-approved',
        decidedAt: '2026-10-26T07:06:00.000Z',
        eventId: 'event-conflict-1',
      },
    });

    assert.equal(conflictRes.safe.outcome, 'conflict');
  });

  await t.test('rejects malformed decision event in pending creation', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const invalidEventRes = store.createPendingAndPause({
      expectedControlVersion: 1,
      submissionKey: 'submission-invalid-ev',
      request: {
        ...sampleRequest,
        taskId: 'task-malformed-ev',
        decisionId: 'decision-invalid-ev',
        binding: {
          ...sampleRequest.binding,
          taskId: 'task-malformed-ev',
          decisionId: 'decision-invalid-ev',
        },
      },
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
      trustedResponse: {
        schemaVersion: 'uc05-approval/0.1-draft',
        decisionId,
        responseKey: 'resp-different-key',
        expectedRequestVersion: 1,
        operatorChannelRef: 'channel-local',
        decision: 'approved',
        safeReasonCode: 'developer-approved',
        decidedAt: '2026-10-26T07:08:00.000Z',
        eventId: 'ev-idempotent-1',
      },
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
      request: {
        ...sampleRequest,
        taskId: localTaskId,
        decisionId: localDecisionId,
        binding: { ...sampleRequest.binding, taskId: localTaskId, decisionId: localDecisionId },
      },
      binding: { ...sampleRequest.binding, taskId: localTaskId, decisionId: localDecisionId },
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

    const firstRes = store.resolvePending({
      expectedRequestVersion: 1,
      trustedOperator,
      trustedResponse,
    });
    assert.equal(firstRes.safe.outcome, 'ok');

    // Reset control to waiting with pendingDecisionId to verify idempotent matching-key path
    const controlPath = join(tempDir, 'tasks', localTaskId, 'approvals', 'control.json');
    const control = JSON.parse(readFileSync(controlPath, 'utf8'));
    control.mode = 'waiting';
    control.pendingDecisionId = localDecisionId;
    control.continuationRef = 'cont-1';
    control.reasonCode = 'waiting-approval';
    writeFileSync(controlPath, JSON.stringify(control, null, 2), 'utf8');

    const retryRes = store.resolvePending({
      // debug

      expectedRequestVersion: 1,
      trustedOperator,
      trustedResponse,
    });
    assert.equal(retryRes.safe.outcome, 'ok');
    assert.equal(retryRes.safe.safeReasonCode, 'already-resolved');
  });

  await t.test('denies appendEvent when event taskId does not match target task', () => {
    const store = new DurableApprovalStore({ storageDir: tempDir });
    const res = store.appendEvent('task-mismatch-target', {
      schemaVersion: 'uc05-approval/0.1-draft',
      eventId: 'event-mismatch-1',
      taskId: 'task-other-id',
      runId: 'run-1',
      decisionId,
      directionId: null,
      claimId: null,
      type: 'human-resolution-recorded',
      outcome: 'ok',
      policyRef: {
        policyId: 'policy-1',
        policyVersion: '1.0.0',
        configId: 'config-1',
        configVersion: '1.0.0',
      },
      safeReasonCode: 'developer-approved',
      timestamp: '2026-10-26T07:00:00.000Z',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'denied');
    assert.equal(res.reason, 'task-id-mismatch');
  });

  await t.test('throws when invalid policy profile is supplied', () => {
    assert.throws(
      () => new DurableApprovalStore({ storageDir: tempDir, profile: null }),
      /Invalid policy profile/
    );
    assert.throws(
      () => new DurableApprovalStore({ storageDir: tempDir, profile: '' }),
      /Invalid policy profile/
    );
  });
});
