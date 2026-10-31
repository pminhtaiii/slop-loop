import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableStore, isSafeStorageId } from '../../../src/persistence/store.ts';
import {
  UC04_SCHEMA_VERSION,
  type TaskState,
  type DeliberatePauseRecord,
  type BudgetJournalRecord,
  type DispatchClaimRecord,
} from '../../../src/persistence/contracts.ts';

async function countEntries(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.length;
}

describe('UC-04: DurableStore (Persistence & Checkpoints)', () => {
  let tempDir: string;
  let store: DurableStore;

  const sampleTask: TaskState = {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId: 'task-test-01',
    runId: 'run-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Test atomic storage',
    acceptanceCriteria: ['Pass test'],
    constraints: [],
    plan: [
      {
        id: 's-1',
        title: 'Step 1',
        description: 'First',
        status: 'todo',
      },
    ],
    currentStepIndex: 0,
    changedFiles: [],
    openRisks: [],
    nextAction: 'Start step 1',
    status: 'pending',
    stateVersion: 1,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: '1234567890abcdef1234567890abcdef12345678',
      branch: 'feature',
      isClean: true,
      trackedFilesHash: 'hash-abc',
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-store-test-'));
    store = new DurableStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saves task state atomically and reads it back faithfully', async () => {
    await store.saveTask(sampleTask);
    const loaded = await store.loadTask(sampleTask.taskId);
    assert.deepEqual(loaded, sampleTask);
  });

  it('saves checkpoints with monotonic version and checksum verification', async () => {
    const cp = await store.saveCheckpoint(sampleTask);
    assert.equal(cp.taskId, sampleTask.taskId);
    assert.equal(cp.stateVersion, sampleTask.stateVersion);
    assert.ok(cp.checksum.length > 0);

    const loadedCp = await store.loadCheckpoint(sampleTask.taskId, cp.checkpointId);
    assert.deepEqual(loadedCp, cp);

    const latest = await store.loadLatestCheckpoint(sampleTask.taskId);
    assert.deepEqual(latest, cp);
  });

  it('rejects checkpoints with non-monotonic stateVersion', async () => {
    await store.saveCheckpoint(sampleTask); // version 1
    const duplicateVersionTask: TaskState = {
      ...sampleTask,
      stateVersion: 1,
    };
    await assert.rejects(
      async () => {
        await store.saveCheckpoint(duplicateVersionTask);
      },
      {
        message: /Non-monotonic stateVersion/i,
      }
    );

    // Save version 3
    await store.saveCheckpoint({
      ...sampleTask,
      stateVersion: 3,
    });

    // Try saving version 2 (< 3)
    const lowerVersionTask: TaskState = {
      ...sampleTask,
      stateVersion: 2,
    };
    await assert.rejects(
      async () => {
        await store.saveCheckpoint(lowerVersionTask);
      },
      {
        message: /Non-monotonic stateVersion/i,
      }
    );
  });

  it('sorts checkpoints numerically by stateVersion rather than lexicographically', async () => {
    // Save checkpoint at version 9
    const taskV9: TaskState = {
      ...sampleTask,
      stateVersion: 9,
      currentStepIndex: 0,
    };
    await store.saveCheckpoint(taskV9);

    // Save checkpoint at version 10
    const taskV10: TaskState = {
      ...sampleTask,
      stateVersion: 10,
      currentStepIndex: 1,
    };
    await store.saveCheckpoint(taskV10);

    const latest = await store.loadLatestCheckpoint(sampleTask.taskId);
    assert.ok(latest);
    assert.equal(latest.stateVersion, 10);
    assert.equal(latest.state.currentStepIndex, 1);
  });

  it('prevents concurrent mutations using non-reclaimed file locks', async () => {
    let executedInLock = false;
    const result = await store.withLock('custom-op', async () => {
      executedInLock = true;
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(executedInLock, true);

    // Overlapping lock attempt within same resource should throw EEXIST / busy error
    await assert.rejects(
      async () => {
        await store.withLock('custom-op', async () => {
          await store.withLock('custom-op', () => Promise.resolve());
        });
      },
      {
        message: /busy|already locked/i,
      }
    );
  });

  it('detects corrupted or tampered checkpoint files', async () => {
    const cp = await store.saveCheckpoint(sampleTask);
    const cpPath = store.getCheckpointPath(sampleTask.taskId, cp.checkpointId);

    // Tamper with file
    const content = JSON.parse(await readFile(cpPath, 'utf8'));
    content.state.goal = 'TAMPERED GOAL';
    await writeFile(cpPath, JSON.stringify(content), 'utf8');

    await assert.rejects(
      async () => {
        await store.loadCheckpoint(sampleTask.taskId, cp.checkpointId);
      },
      {
        message: /integrity|checksum mismatch/i,
      }
    );
  });

  it('saves and loads deliberate pause records faithfully', async () => {
    const pauseRec: DeliberatePauseRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: sampleTask.taskId,
      active: true,
      pauseKey: 'pause-key-1',
      operatorRef: 'dev-1',
      acceptedAt: new Date().toISOString(),
      revision: 1,
      epoch: 1,
      resumeKey: null,
      outstandingAttemptRefs: ['att-1'],
    };

    await store.savePauseRecord(pauseRec);
    const loaded = await store.loadPauseRecord(sampleTask.taskId);
    assert.deepEqual(loaded, pauseRec);
  });

  it('rejects unsafe storage ids without creating files', async () => {
    await store.init();
    const before = await countEntries(tempDir);

    assert.throws(() => store.getTaskPath('../../outside'), /Unsafe task id/);
    assert.throws(() => store.getTaskPath('a/b'), /Unsafe task id/);
    assert.throws(() => store.getTaskPath(''), /Unsafe task id/);
    assert.throws(() => store.getTaskPath('..'), /Unsafe task id/);
    assert.throws(() => store.getCheckpointPath('ok', '../../x'), /Unsafe checkpoint id/);
    assert.throws(() => store.getPauseRecordPath('../x'), /Unsafe task id/);

    assert.equal(await countEntries(tempDir), before);
  });

  it('rejects unsafe lock resource ids without creating a lock file', async () => {
    await store.init();
    const before = await countEntries(tempDir);

    await assert.rejects(
      async () => {
        await store.withLock('..', async () => 1);
      },
      { message: /Unsafe lock resource id/ }
    );

    assert.equal(await countEntries(tempDir), before);
  });

  it('still accepts canonical ids including pause-prefixed resource ids', async () => {
    assert.equal(isSafeStorageId('task-test-01'), true);
    assert.equal(isSafeStorageId('pause-task-test-01'), true);
    assert.equal(isSafeStorageId('cp-1234567890-v2'), true);
    assert.equal(isSafeStorageId('..'), false);
    assert.equal(isSafeStorageId('a/b'), false);
    assert.equal(isSafeStorageId('-leading'), false);

    const result = await store.withLock('pause-task-test-01', async () => 'locked');
    assert.equal(result, 'locked');
  });

  it('round trips canonical checkpoint and pause ids through the store', async () => {
    const cp = await store.saveCheckpoint(sampleTask);
    const latest = await store.loadLatestCheckpoint(sampleTask.taskId);
    assert.deepEqual(latest, cp);

    const pauseRec: DeliberatePauseRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: sampleTask.taskId,
      active: true,
      pauseKey: 'pause-key-1',
      operatorRef: 'dev-1',
      acceptedAt: new Date().toISOString(),
      revision: 1,
      epoch: 1,
      resumeKey: null,
      outstandingAttemptRefs: [],
    };
    await store.savePauseRecord(pauseRec);
    assert.deepEqual(await store.loadPauseRecord(sampleTask.taskId), pauseRec);
  });

  it('saves and loads budget journal records by task', async () => {
    const record: BudgetJournalRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: sampleTask.taskId,
      runId: sampleTask.runId,
      ledgers: [
        {
          scope: 'task',
          kind: 'tokens',
          limit: 1000,
          consumed: 120,
          reservations: [],
          configurationId: 'cfg-1',
          version: 2,
        },
      ],
      replanCount: 1,
      updatedAt: new Date().toISOString(),
    };

    await store.saveBudgetJournal(record);
    assert.deepEqual(await store.loadBudgetJournal(sampleTask.taskId), record);
    assert.equal(await store.loadBudgetJournal('unknown-task'), null);
  });

  it('rejects a corrupted budget journal file', async () => {
    const record: BudgetJournalRecord = {
      schemaVersion: UC04_SCHEMA_VERSION,
      taskId: sampleTask.taskId,
      runId: sampleTask.runId,
      ledgers: [],
      replanCount: 0,
      updatedAt: new Date().toISOString(),
    };
    await store.saveBudgetJournal(record);

    const journalPath = store.getBudgetJournalPath(sampleTask.taskId);
    const content = JSON.parse(await readFile(journalPath, 'utf8'));
    content.replanCount = 'not-a-number';
    await writeFile(journalPath, JSON.stringify(content), 'utf8');

    await assert.rejects(
      async () => {
        await store.loadBudgetJournal(sampleTask.taskId);
      },
      { message: /Corrupted BudgetJournalRecord/ }
    );
  });

  it('saves and loads dispatch claims ordered by createdAt then claimId', async () => {
    const later: DispatchClaimRecord = {
      claimId: 'claim-b',
      taskId: sampleTask.taskId,
      runId: sampleTask.runId,
      stepId: 's-1',
      actionId: 'act-b',
      epoch: 1,
      stateVersion: 2,
      phase: 'dispatched',
      reservationRefs: [],
      createdAt: '2026-10-31T00:00:02.000Z',
    };
    const earlier: DispatchClaimRecord = {
      ...later,
      claimId: 'claim-a',
      actionId: 'act-a',
      createdAt: '2026-10-31T00:00:01.000Z',
    };

    await store.saveDispatchClaim(later);
    await store.saveDispatchClaim(earlier);

    const claims = await store.loadDispatchClaims(sampleTask.taskId);
    assert.deepEqual(claims.map((c) => c.claimId), ['claim-a', 'claim-b']);
    assert.deepEqual(await store.loadDispatchClaims('unknown-task'), []);
  });
});
