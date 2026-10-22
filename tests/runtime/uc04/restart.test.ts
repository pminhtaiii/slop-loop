import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('UC-04: Durable Foundation Process Restart & Crash Recovery (T012)', () => {
  let tempDir: string;
  const childScript = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.js')
        ? '../support/uc04/restart-child.js'
        : '../support/uc04/restart-child.ts',
      import.meta.url
    )
  );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'slop-restart-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('proves state durability and safe progress resumption across distinct process lifecycles', () => {
    const taskId = 'task-restart-t012';

    // 1. Process 1: Initialize Task
    const initRes = spawnSync(
      process.execPath,
      [childScript, '--store-dir', tempDir, '--task-id', taskId, '--command', 'init'],
      { encoding: 'utf8' }
    );
    assert.equal(initRes.status, 0, `Init failed: ${initRes.stderr}`);
    const initOut = JSON.parse(initRes.stdout.trim());
    assert.equal(initOut.status, 'INIT_OK');
    const pid1 = initOut.pid;

    // 2. Process 2: Execute Step 1
    const step1Res = spawnSync(
      process.execPath,
      [childScript, '--store-dir', tempDir, '--task-id', taskId, '--command', 'step1'],
      { encoding: 'utf8' }
    );
    assert.equal(step1Res.status, 0, `Step 1 failed: ${step1Res.stderr}`);
    const step1Out = JSON.parse(step1Res.stdout.trim());
    assert.equal(step1Out.status, 'STEP1_OK');
    const pid2 = step1Out.pid;

    // 3. Process 3: Start Step 2 & Abruptly Crash (code 137)
    const crashRes = spawnSync(
      process.execPath,
      [childScript, '--store-dir', tempDir, '--task-id', taskId, '--command', 'crash-on-step2'],
      { encoding: 'utf8' }
    );
    assert.equal(crashRes.status, 137, 'Expected child process to exit with code 137');
    const crashOut = JSON.parse(crashRes.stdout.trim());
    assert.equal(crashOut.status, 'CRASHING_BEFORE_SETTLE');
    const pid3 = crashOut.pid;

    // 4. Process 4: Fresh Process Resumes and Completes Workflow
    const resumeRes = spawnSync(
      process.execPath,
      [childScript, '--store-dir', tempDir, '--task-id', taskId, '--command', 'resume'],
      { encoding: 'utf8' }
    );
    assert.equal(resumeRes.status, 0, `Resume failed: ${resumeRes.stderr}`);
    const resumeOut = JSON.parse(resumeRes.stdout.trim());
    assert.equal(resumeOut.status, 'RESUME_COMPLETED_OK');
    assert.equal(resumeOut.finalStatus, 'completed');
    assert.equal(resumeOut.consumedTokens, 2000); // 500 from step1 + 1000 conservative recovery + 500 rerun
    const pid4 = resumeOut.pid;

    // 5. CRITICAL: Prove each step ran in an independent OS process
    const pids = new Set([pid1, pid2, pid3, pid4]);
    assert.equal(pids.size, 4, 'All 4 operations must run in separate OS process lifecycles');

    // Verify all steps are done in final state
    const allDone = resumeOut.stepStatuses.every((s: { status: string }) => s.status === 'done');
    assert.equal(allDone, true);
  });
});
