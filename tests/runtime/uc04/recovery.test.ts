import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore } from '../../../src/persistence/store.ts';
import {
  StepStateMachine,
  WorkspaceDriftError,
  DependencyNotMetError,
  reconcileAndResume,
} from '../../../src/persistence/recovery.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type WorkspaceBaseline,
} from '../../../src/persistence/contracts.ts';

describe('UC-04: StepStateMachine & Recovery Reconciliation', () => {
  let tempDir: string;
  let store: DurableStore;

  const baseline: WorkspaceBaseline = {
    commitHash: 'abcdef1234567890abcdef1234567890abcdef12',
    branch: 'main',
    isClean: true,
    trackedFilesHash: 'files-hash-123',
  };

  const sampleTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-recovery-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
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
        predecessorIds: [],
      },
      {
        id: 'step-2',
        title: 'Step 2',
        description: 'Interrupted step',
        status: 'todo',
        predecessorIds: ['step-1'],
      },
      {
        id: 'step-3',
        title: 'Step 3',
        description: 'Subsequent step',
        status: 'todo',
        predecessorIds: ['step-2'],
      },
    ],
    currentStepIndex: 1,
    changedFiles: ['file1.ts'],
    openRisks: [],
    nextAction: 'Resume step 2',
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
    tempDir = await mkdtemp(join(tmpdir(), 'slop-rec-test-'));
    store = new DurableStore(tempDir);
    await store.saveCheckpoint(sampleTask);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('StepStateMachine', () => {
    const machine = new StepStateMachine();

    it('starts step when predecessors are satisfied', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      assert.equal(started.plan[1]?.status, 'doing');
      assert.equal(started.status, 'running');
      assert.equal(started.stateVersion, 3);
    });

    it('rejects starting step if predecessor is not done', () => {
      assert.throws(
        () => machine.startStep(sampleTask, 'step-3'),
        (err: unknown) => err instanceof DependencyNotMetError && (err as DependencyNotMetError).missingPredecessors.includes('step-2')
      );
    });

    it('completes step and advances currentStepIndex', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      const completed = machine.completeStep(started, 'step-2', {
        changedFiles: ['file2.ts'],
      });

      assert.equal(completed.plan[1]?.status, 'done');
      assert.deepEqual(completed.changedFiles, ['file1.ts', 'file2.ts']);
      assert.equal(completed.currentStepIndex, 2);
    });

    it('fails step and records error in openRisks', () => {
      const started = machine.startStep(sampleTask, 'step-2');
      const failed = machine.failStep(started, 'step-2', 'Compilation failed');

      assert.equal(failed.plan[1]?.status, 'failed');
      assert.equal(failed.status, 'failed');
      assert.ok(failed.openRisks.some((r) => r.includes('Compilation failed')));
    });
  });

  describe('reconcileAndResume', () => {
    it('resumes task from latest checkpoint and identifies next step without re-executing completed step', async () => {
      const fakeGitInspector = async () => ({ ...baseline });

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: fakeGitInspector,
      });

      assert.equal(resumed.taskId, sampleTask.taskId);
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
          await reconcileAndResume(sampleTask.taskId, store, {
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

      const resumed = await reconcileAndResume(sampleTask.taskId, store, {
        gitInspector: fakeGitInspector,
        unresolvedReservationAction: 'charge_as_consumed',
      });

      const tokenLedger = resumed.budgetLedgers.find((l) => l.kind === 'tokens');
      assert.ok(tokenLedger);
      assert.equal(tokenLedger.consumed, 3000); // 2000 + 1000 settled/charged
      assert.equal(tokenLedger.reservations.length, 0);
    });
  });
});
