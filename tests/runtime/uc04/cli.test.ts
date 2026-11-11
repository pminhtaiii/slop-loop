import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DurableStore } from '../../../src/persistence/store.ts';
import { runCli } from '../../../src/persistence/cli.ts';
import { UC04_SCHEMA_VERSION, type TaskState } from '../../../src/persistence/contracts.ts';

const execFileAsync = promisify(execFile);

function makeMockTask(taskId: string, status: TaskState['status'] = 'running'): TaskState {
  return {
    schemaVersion: UC04_SCHEMA_VERSION,
    taskId,
    runId: 'run-cli-1',
    repositoryId: 'repo-01',
    workspaceId: 'ws-01',
    taskType: 'feature',
    goal: 'Test CLI execution',
    acceptanceCriteria: ['Pass test'],
    constraints: [],
    plan: [
      {
        id: 's-1',
        title: 'Initial analysis',
        description: 'First step',
        status: 'done',
        requiredEvidenceRefs: ['ev-01'],
        evidenceRefs: ['ev-01'],
      },
      {
        id: 's-2',
        title: 'Apply patch',
        description: 'Second step',
        status: 'todo',
        requiredEvidenceRefs: [],
        evidenceRefs: [],
        predecessorIds: ['s-1'],
      },
    ],
    currentStepIndex: 1,
    changedFiles: [],
    openRisks: [],
    nextAction: 'Apply patch',
    status,
    stateVersion: 1,
    budgetLedgers: [],
    workspaceBaseline: {
      commitHash: '1234567890abcdef1234567890abcdef12345678',
      branch: 'feature',
      isClean: true,
      trackedFilesHash: 'hash-abc',
    },
  };
}

test('UC-04: Operator Task Control CLI', async (t) => {
  let tempBase: string;
  let store: DurableStore;

  t.beforeEach(async () => {
    tempBase = await mkdtemp(join(tmpdir(), 'uc04-cli-test-'));
    store = new DurableStore(tempBase);
    await store.init();
  });

  t.afterEach(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  await t.test('help command prints usage information with exitCode 0', async () => {
    const res = await runCli(['--help'], store);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('UC-04 Durable Task Control CLI'));
    assert.ok(res.output.includes('task status <taskId>'));
  });

  await t.test('status command handles missing and existing tasks', async () => {
    const resMissing = await runCli(['status', 'non-existent-task'], store);
    assert.equal(resMissing.exitCode, 1);
    assert.ok(resMissing.output.includes("Task 'non-existent-task' not found"));

    const taskId = 'task-status-1';
    await store.saveTaskState(makeMockTask(taskId));

    const resFound = await runCli(['status', taskId], store);
    assert.equal(resFound.exitCode, 0);
    assert.ok(resFound.output.includes(`Task: ${taskId}`));
    assert.ok(resFound.output.includes('Initial analysis'));
    assert.ok(resFound.output.includes('Apply patch'));
    assert.ok(resFound.output.includes('(deps: s-1)'));
  });

  await t.test('pause command pauses running task and rejects invalid pause transitions', async () => {
    const taskId = 'task-pause-1';
    const mockTask = makeMockTask(taskId, 'running');
    await store.saveTaskState(mockTask);
    await store.saveCheckpoint(mockTask);

    const resPause = await runCli(['pause', taskId, 'Maintenance window'], store);
    assert.equal(resPause.exitCode, 0);
    assert.ok(resPause.output.includes("Task 'task-pause-1' successfully paused"));

    // Attempt pausing again
    const resAlreadyPaused = await runCli(['pause', taskId], store);
    assert.equal(resAlreadyPaused.exitCode, 1);
    assert.ok(resAlreadyPaused.output.includes('currently paused; cannot pause'));
  });

  await t.test('resume command unpauses and resumes task', async () => {
    const taskId = 'task-resume-1';
    const mockTask = makeMockTask(taskId, 'running');
    await store.saveTaskState(mockTask);
    await store.saveCheckpoint(mockTask);

    // Pause first
    const resPause = await runCli(['pause', taskId], store);
    assert.equal(resPause.exitCode, 0);

    const pauseRec = await store.loadPauseRecord(taskId);
    assert.equal(pauseRec?.active, true);

    // Resume
    const resResume = await runCli(['resume', taskId], store, {
      gitInspector: async () => ({ ...mockTask.workspaceBaseline }),
    });
    assert.equal(resResume.exitCode, 0);
    assert.ok(resResume.output.includes('successfully resumed'));

    // Verify pause record is deactivated
    const updatedPause = await store.loadPauseRecord(taskId);
    assert.equal(updatedPause?.active, false);
  });

  await t.test('compact command outputs 6-field markdown summary', async () => {
    const taskId = 'task-compact-1';
    await store.saveTaskState(makeMockTask(taskId));

    const res = await runCli(['compact', taskId], store);
    assert.equal(res.exitCode, 0);
    assert.ok(res.output.includes('Compacted Task Context'));
    assert.ok(res.output.includes('Initial analysis'));
  });

  await t.test('executes directly via subprocess with correct exit code', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['src/persistence/cli.ts', '--help']);
    assert.ok(stdout.includes('UC-04 Durable Task Control CLI'));

    // Test error exit code
    await assert.rejects(
      async () => {
        await execFileAsync(process.execPath, ['src/persistence/cli.ts', 'unknown-command']);
      },
      (err: unknown) => {
        assert.equal((err as { code?: number }).code, 1);
        return true;
      },
    );
  });
});
