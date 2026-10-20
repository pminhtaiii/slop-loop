import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/state/durable-store.ts';
import {
  StaleApprovalBindingError,
  pauseForApproval,
  resumeFromApproval,
} from '../../../src/workflow/human-pause.ts';
import type { TaskState, ApprovalRequestBinding } from '../../../src/state/types.ts';

describe('UC-04 Ticket 07: Human-in-the-Loop Pause & Approval Binding', () => {
  let tempDir: string;
  let store: DurableStore;

  const sampleTask: TaskState = {
    taskId: 'task-hil-01',
    runId: 'run-1',
    taskType: 'feature',
    goal: 'Run risky migration with human approval',
    acceptanceCriteria: ['Approved and executed'],
    constraints: [],
    plan: [
      { id: 's-1', title: 'Preparation', description: 'Prep files', status: 'done' },
      { id: 's-2', title: 'Apply Migration', description: 'Risky SQL change', status: 'todo' },
    ],
    currentStepIndex: 1,
    changedFiles: [],
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
    tempDir = await mkdtemp(join(tmpdir(), 'slop-hil-test-'));
    store = new DurableStore(tempDir);
    await store.saveCheckpoint(sampleTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('pauses workflow and transitions status to waiting_approval with binding persisted', async () => {
    const paused = await pauseForApproval(sampleTask, sampleApproval, store);

    assert.equal(paused.status, 'waiting_approval');
    assert.deepEqual(paused.pendingApproval, sampleApproval);
    assert.equal(paused.stateVersion, 3);

    // Verify persisted on disk
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
    assert.ok(rejected.openRisks?.some((r) => r.includes('Unauthorized table drop detected')));
  });
});
