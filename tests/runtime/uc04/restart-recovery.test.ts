import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/state/durable-store.ts';
import {
  WorkspaceDriftError,
  reconcileAndResume,
} from '../../../src/state/reconciliation.ts';
import type { TaskState, WorkspaceBaseline } from '../../../src/state/types.ts';

describe('UC-04 Ticket 05: Restart Recovery & Workspace Reconciliation', () => {
  let tempDir: string;
  let store: DurableStore;

  const baseline: WorkspaceBaseline = {
    commitHash: 'abcdef1234567890abcdef1234567890abcdef12',
    branch: 'main',
    isClean: true,
    trackedFilesHash: 'files-hash-123',
  };

  const multiStepTask: TaskState = {
    taskId: 'task-recovery-01',
    runId: 'run-1',
    taskType: 'feature',
    goal: 'Resume feature from interrupted step',
    acceptanceCriteria: ['All steps pass'],
    constraints: [],
    plan: [
      {
        id: 'step-1',
        title: 'Step 1',
        description: 'Completed step',
        status: 'done',
        completedAt: new Date().toISOString(),
        changedFiles: ['file1.ts'],
      },
      {
        id: 'step-2',
        title: 'Step 2',
        description: 'Interrupted step',
        status: 'todo',
      },
      {
        id: 'step-3',
        title: 'Step 3',
        description: 'Subsequent step',
        status: 'todo',
      },
    ],
    currentStepIndex: 1,
    changedFiles: ['file1.ts'],
    status: 'running',
    stateVersion: 2,
    budgetLedgers: [
      {
        scope: 'task',
        kind: 'tokens',
        limit: 10000,
        consumed: 2000,
        reservations: [{ reservationId: 'res-old', keyedId: 'req-interrupted', amount: 1000 }],
        configurationId: 'cfg-1',
        version: 2,
      },
    ],
    workspaceBaseline: baseline,
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-recovery-test-'));
    store = new DurableStore(tempDir);
    await store.saveCheckpoint(multiStepTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resumes task from latest checkpoint and identifies next step without re-executing completed step', async () => {
    const fakeGitInspector = async () => ({ ...baseline });

    const resumed = await reconcileAndResume(multiStepTask.taskId, store, {
      gitInspector: fakeGitInspector,
    });

    assert.equal(resumed.taskId, multiStepTask.taskId);
    const step0 = resumed.plan[0];
    assert.ok(step0);
    assert.equal(step0.status, 'done');
    assert.equal(resumed.currentStepIndex, 1);
    const step1 = resumed.plan[1];
    assert.ok(step1);
    assert.equal(step1.id, 'step-2');
    assert.equal(resumed.status, 'running');
  });

  it('rejects resumption when workspace commit hash or dirty status drifts', async () => {
    const driftedGitInspector = async () => ({
      ...baseline,
      commitHash: 'different-commit-hash-000000000000000000',
    });

    await assert.rejects(
      async () => {
        await reconcileAndResume(multiStepTask.taskId, store, {
          gitInspector: driftedGitInspector,
        });
      },
      (err: unknown) =>
        err instanceof WorkspaceDriftError &&
        /workspace drift.*commit mismatch/i.test((err as Error).message)
    );
  });

  it('reconciles interrupted reservations so budgets remain safely charged', async () => {
    const fakeGitInspector = async () => ({ ...baseline });

    const resumed = await reconcileAndResume(multiStepTask.taskId, store, {
      gitInspector: fakeGitInspector,
      unresolvedReservationAction: 'charge_as_consumed',
    });

    const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
    assert.ok(tokenLedger);
    assert.equal(tokenLedger.consumed, 3000); // 2000 + 1000 settled/charged
    assert.equal(tokenLedger.reservations.length, 0);
  });
});
