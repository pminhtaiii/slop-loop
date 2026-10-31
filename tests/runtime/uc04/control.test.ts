import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  StaleApprovalBindingError,
  InFlightWorkPendingError,
  pauseForApproval,
  resumeFromApproval,
  pauseTask,
  resumeTask,
} from '../../../src/persistence/task-control.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type ApprovalRequestBinding,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: Task Control, Deliberate Pause & Approval Binding', () => {
  let tempDir: string;
  let store: DurableStore;

  const sampleTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-hil-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Run risky migration with human approval',
    acceptanceCriteria: ['Approved and executed'],
    constraints: [],
    plan: [
      { id: 's-1', title: 'Preparation', description: 'Prep files', status: 'done', predecessorIds: [], evidenceRefs: ['changed:schema.sql'] },
      { id: 's-2', title: 'Apply Migration', description: 'Risky SQL change', status: 'todo', predecessorIds: ['s-1'] },
    ],
    currentStepIndex: 1,
    changedFiles: [],
    openRisks: [],
    nextAction: 'Ready to migrate',
    status: 'running',
    stateVersion: 2,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: 'commit-aaa-11111111111111111111111111111',
      branch: 'main',
      isClean: true,
      trackedFilesHash: 'hash-0',
    },
  };

  const sampleApproval: ApprovalRequestBinding = {
    requestId: 'req-app-1',
    actionType: 'run_command',
    targetFiles: ['schema.sql'],
    normalizedActionDigest: 'sha256-normalized-action',
    repoCommit: 'commit-aaa-11111111111111111111111111111',
    policyVersion: 'v1.0.0',
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-ctrl-test-'));
    store = new DurableStore(tempDir);
    await store.saveCheckpoint(sampleTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Approval Pause & Binding', () => {
    it('pauses workflow and transitions status to waiting_approval with binding persisted', async () => {
      const paused = await pauseForApproval(sampleTask, sampleApproval, store);

      assert.equal(paused.status, 'waiting_approval');
      assert.deepEqual(paused.pendingApproval, sampleApproval);
      assert.equal(paused.stateVersion, 3);

      const onDisk = await store.loadLatestCheckpoint(sampleTask.taskId);
      assert.ok(onDisk);
      assert.equal(onDisk.state.status, 'waiting_approval');
      assert.deepEqual(onDisk.state.pendingApproval, sampleApproval);
    });

    it('resumes workflow when matching approved decision is received under valid binding', async () => {
      await pauseForApproval(sampleTask, sampleApproval, store);

      const resumed = await resumeFromApproval(
        sampleTask.taskId,
        {
          requestId: 'req-app-1',
          decision: 'approved',
          approvedBy: 'lead-dev',
        },
        store,
        {
          currentCommit: sampleApproval.repoCommit,
          policyVersion: sampleApproval.policyVersion,
        }
      );

      assert.equal(resumed.status, 'running');
      assert.equal(resumed.pendingApproval, undefined);
      assert.equal(resumed.stateVersion, 4);
    });

    it('rejects resumption with StaleApprovalBindingError when git commit has changed', async () => {
      await pauseForApproval(sampleTask, sampleApproval, store);

      await assert.rejects(
        async () => {
          await resumeFromApproval(
            sampleTask.taskId,
            {
              requestId: 'req-app-1',
              decision: 'approved',
              approvedBy: 'lead-dev',
            },
            store,
            {
              currentCommit: 'commit-bbb-drifted-2222222222222222222222222',
              policyVersion: sampleApproval.policyVersion,
            }
          );
        },
        (err: unknown) =>
          err instanceof StaleApprovalBindingError &&
          /stale approval.*commit mismatch/i.test((err as Error).message)
      );
    });

    it('rejects approval resumption when currentCommit or policyVersion is omitted (fail-closed)', async () => {
      await pauseForApproval(sampleTask, sampleApproval, store);

      await assert.rejects(
        async () => {
          await resumeFromApproval(
            sampleTask.taskId,
            {
              requestId: 'req-app-1',
              decision: 'approved',
              approvedBy: 'lead-dev',
            },
            store,
            {
              currentCommit: undefined,
              policyVersion: sampleApproval.policyVersion,
            }
          );
        },
        (err: unknown) =>
          err instanceof StaleApprovalBindingError &&
          /stale approval.*commit mismatch/i.test((err as Error).message)
      );

      await assert.rejects(
        async () => {
          await resumeFromApproval(
            sampleTask.taskId,
            {
              requestId: 'req-app-1',
              decision: 'approved',
              approvedBy: 'lead-dev',
            },
            store,
            {
              currentCommit: sampleApproval.repoCommit,
              policyVersion: undefined,
            }
          );
        },
        (err: unknown) =>
          err instanceof StaleApprovalBindingError &&
          /stale approval.*policy version mismatch/i.test((err as Error).message)
      );
    });

    it('handles human rejection by transitioning task status to failed', async () => {
      await pauseForApproval(sampleTask, sampleApproval, store);

      const rejected = await resumeFromApproval(
        sampleTask.taskId,
        {
          requestId: 'req-app-1',
          decision: 'rejected',
          approvedBy: 'security-reviewer',
          reason: 'Unauthorized table drop detected',
        },
        store,
        {
          currentCommit: sampleApproval.repoCommit,
          policyVersion: sampleApproval.policyVersion,
        }
      );

      assert.equal(rejected.status, 'failed');
      assert.ok(rejected.openRisks.some((r) => r.includes('Unauthorized table drop detected')));
    });
  });

  describe('Deliberate Operator Pause & Resume', () => {
    it('creates deliberate pause record and saves to disk', async () => {
      const pauseRecord = await pauseTask(
        store,
        {
          taskId: sampleTask.taskId,
          expectedRevision: 1, // first pause (expectedRevision 1)
          pauseKey: 'pause-key-abc',
          operatorRef: 'operator-1',
          reason: 'Operator requested pause for inspection',
        },
        []
      );

      assert.equal(pauseRecord.active, true);
      assert.equal(pauseRecord.taskId, sampleTask.taskId);
      assert.equal(pauseRecord.revision, 1);
      assert.equal(pauseRecord.epoch, 1);
    });

    it('declines early resume when in-flight attempts remain unsettled', async () => {
      await pauseTask(
        store,
        {
          taskId: sampleTask.taskId,
          expectedRevision: 1,
          pauseKey: 'pause-key-abc',
          operatorRef: 'operator-1',
        },
        ['attempt-exec-1'] // in-flight attempt
      );

      await assert.rejects(
        async () => {
          await resumeTask(store, {
            taskId: sampleTask.taskId,
            expectedRevision: 1,
            resumeKey: 'resume-key-xyz',
            operatorRef: 'operator-1',
          });
        },
        (err: unknown) =>
          err instanceof InFlightWorkPendingError &&
          err.outstandingAttemptRefs.includes('attempt-exec-1')
      );
    });

    it('resumes successfully when in-flight work is empty', async () => {
      await pauseTask(
        store,
        {
          taskId: sampleTask.taskId,
          expectedRevision: 1,
          pauseKey: 'pause-key-abc',
          operatorRef: 'operator-1',
        },
        [] // no in-flight work
      );

      const resumed = await resumeTask(store, {
        taskId: sampleTask.taskId,
        expectedRevision: 1,
        resumeKey: 'resume-key-xyz',
        operatorRef: 'operator-1',
      });

      assert.equal(resumed.active, false);
      assert.equal(resumed.resumeKey, 'resume-key-xyz');
      assert.equal(resumed.revision, 2);
    });
  });
});
