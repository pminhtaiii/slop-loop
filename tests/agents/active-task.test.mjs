import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'scripts/agents/active-task.mjs');

async function fixture(t) {
  const checkout = await mkdtemp(join(tmpdir(), 'active-task-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, 'context'));
  await writeFile(join(checkout, 'context/active_task.md'), '# Active task\nPermanent instructions.\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\nPermanent footer.\n');
  const initialized = spawnSync('git', ['init', '--quiet', checkout], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  return checkout;
}

function run(checkout, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', checkout], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
}

test('a completed task can be cleared while preserving the permanent file exactly', async (t) => {
  const checkout = await fixture(t);
  const path = join(checkout, 'context/active_task.md');
  const baseline = await readFile(path, 'utf8');
  let result = run(checkout, 'start', '--owner', 'parent', '--task', 'tracking', '--summary', 'Implement tracking', '--next', 'Verify changes');
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path, 'utf8'), /Implement tracking/);
  result = run(checkout, 'finish', '--owner', 'parent', '--task', 'tracking', '--result', 'Tests passed; evidence recorded');
  assert.equal(result.status, 0, result.stderr);
  result = run(checkout, 'clear', '--owner', 'parent', '--task', 'tracking');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path, 'utf8'), baseline);
});

test('worker cleanup preserves the parent entry and active or blocked work', async (t) => {
  const checkout = await fixture(t);
  const path = join(checkout, 'context/active_task.md');
  for (const owner of ['parent', 'worker']) {
    const result = run(checkout, 'start', '--owner', owner, '--task', 'T001', '--summary', `${owner} assignment`, '--next', 'Implement');
    assert.equal(result.status, 0, result.stderr);
  }
  let result = run(checkout, 'clear', '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only completed entries/);
  result = run(checkout, 'update', '--owner', 'worker', '--task', 'T001', '--status', 'blocked', '--next', 'Wait for required input', '--verification', 'Focused check not run');
  assert.equal(result.status, 0, result.stderr);
  const blocked = await readFile(path, 'utf8');
  assert.match(blocked, /Wait for required input/);
  result = run(checkout, 'clear', '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 1);
  assert.equal(await readFile(path, 'utf8'), blocked);
  result = run(checkout, 'finish', '--owner', 'worker', '--task', 'T001', '--result', 'Assignment complete; handoff in evidence.md');
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path, 'utf8'), /Assignment complete/);
  result = run(checkout, 'clear', '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 0, result.stderr);
  const retained = await readFile(path, 'utf8');
  assert.match(retained, /parent assignment/);
  assert.doesNotMatch(retained, /worker assignment/);
});

test('damaged markers and malformed data fail without overwriting the file', async (t) => {
  const checkout = await fixture(t);
  const path = join(checkout, 'context/active_task.md');
  for (const source of [
    '# Preserve this\n<!-- active-task:start -->\n',
    '# Preserve this\n<!-- active-task:start -->\n```json\nnot json\n```\n<!-- active-task:end -->\n',
  ]) {
    await writeFile(path, source);
    const result = run(checkout, 'start', '--owner', 'parent', '--task', 'T001', '--summary', 'Work', '--next', 'Verify');
    assert.equal(result.status, 1);
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

test('a busy lock is retained and prevents any task-file mutation', async (t) => {
  const checkout = await fixture(t);
  const path = join(checkout, 'context/active_task.md');
  const baseline = await readFile(path, 'utf8');
  await mkdir(join(checkout, '.agent-work', 'state'), { recursive: true });
  const lock = join(checkout, '.agent-work/state/active-task.lock');
  await writeFile(lock, 'another writer');
  const result = run(checkout, 'start', '--owner', 'parent', '--task', 'T001', '--summary', 'Work', '--next', 'Verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /file is busy/);
  assert.equal(await readFile(path, 'utf8'), baseline);
  assert.equal(await readFile(lock, 'utf8'), 'another writer');
});

test('linked worktrees share assignments without modifying the coordinator view', async (t) => {
  const checkout = await fixture(t);
  await writeFile(join(checkout, '.gitignore'), '.agent-work/\n');
  for (const args of [
    ['add', '.gitignore', 'context/active_task.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
    ['worktree', 'add', '-b', 'worker', join(checkout, '.agent-work/worktrees/worker')],
  ]) {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const parentView = await readFile(join(checkout, 'context/active_task.md'), 'utf8');
  const worker = join(checkout, '.agent-work/worktrees/worker');
  const workerView = await readFile(join(worker, 'context/active_task.md'), 'utf8');
  let result = run(worker, 'start', '--owner', 'worker', '--task', 'T001', '--summary', 'Shared assignment', '--next', 'Verify');
  assert.equal(result.status, 0, result.stderr);
  result = run(checkout, 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Shared assignment/);
  assert.equal(await readFile(join(checkout, 'context/active_task.md'), 'utf8'), parentView);
  assert.equal(await readFile(join(worker, 'context/active_task.md'), 'utf8'), workerView);
  result = run(checkout, 'render');
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(checkout, 'context/active_task.md'), 'utf8'), /Shared assignment/);
});

test('overlapping writers either serialize or report busy without losing an assignment', async (t) => {
  const checkout = await fixture(t);
  const execute = promisify(execFile);
  const assignments = ['worker-one', 'worker-two'].map((owner) => [
    'start', '--owner', owner, '--task', 'T001', '--summary', owner, '--next', 'Verify',
  ]);
  const outcomes = await Promise.all(assignments.map((args) => execute(process.execPath, [cli, ...args, '--root', checkout], {
    windowsHide: true, timeout: 10_000,
  }).then(() => ({ status: 0 })).catch((error) => ({ status: error.code, stderr: error.stderr }))));
  for (let index = 0; index < outcomes.length; index += 1) {
    if (outcomes[index].status !== 0) {
      assert.equal(outcomes[index].status, 1, outcomes[index].stderr);
      assert.match(outcomes[index].stderr, /file is busy/);
      const retry = run(checkout, ...assignments[index]);
      assert.equal(retry.status, 0, retry.stderr);
    }
  }
  const source = await readFile(join(checkout, 'context/active_task.md'), 'utf8');
  assert.match(source, /worker-one/);
  assert.match(source, /worker-two/);
});
