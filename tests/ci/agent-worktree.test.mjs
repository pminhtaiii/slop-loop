import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/ci/agent-worktree.mjs');
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet', '-b', 'main']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/evidence.md'), 'Acceptance checks passed.\n');
  await writeFile(join(root, '.gitignore'), '.agent-work/\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const worker = join(root, '.agent-work/worktrees/worker');
  git(root, ['worktree', 'add', '-b', 'worker', worker]);
  await mkdir(join(root, '.agent-work/2026-10-15/run'), { recursive: true });
  await writeFile(join(root, '.agent-work/2026-10-15/run/session.json'), JSON.stringify({
    schemaVersion: 1, workspace: 'project', date: '2026-10-15', id: 'run', status: 'active', startedAt: new Date().toISOString(),
  }));
  await mkdir(join(root, '.agent-work/state'));
  await writeFile(join(root, '.agent-work/state/active-tasks.json'), JSON.stringify([
    { owner: 'worker', task: 'T001', checkout: worker, summary: 'Work', next: 'Review', status: 'completed' },
  ]));
  return { root, worker };
}
function register(root, worker) {
  const result = run(root, 'register', '--id', 'worker', '--path', worker, '--integration-ref', 'main', '--session', '2026-10-15/run', '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 0, result.stderr);
}
function accept(root) {
  const result = run(root, 'accept', '--id', 'worker', '--evidence', 'docs/evidence.md', '--workers-stopped');
  assert.equal(result.status, 0, result.stderr);
}

test('retirement previews by default and applies only to an accepted, clean, merged owned worktree', async (t) => {
  const { root, worker } = await fixture(t);
  register(root, worker);
  accept(root);
  let result = run(root, 'cleanup', '--id', 'worker');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).eligible, true);
  assert.equal(await readFile(join(worker, 'docs/evidence.md'), 'utf8'), 'Acceptance checks passed.\n');
  result = run(root, 'cleanup', '--id', 'worker', '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).removed, true);
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  git(root, ['show-ref', '--verify', 'refs/heads/worker']);
});

test('unmerged commits remain even when the worker is clean and its handoff accepted', async (t) => {
  const { root, worker } = await fixture(t);
  register(root, worker);
  await writeFile(join(worker, 'unmerged.txt'), 'preserve this change\n');
  git(worker, ['add', 'unmerged.txt']);
  git(worker, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'unmerged']);
  accept(root);
  const result = run(root, 'cleanup', '--id', 'worker', '--apply');
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /not integrated/);
  assert.equal(await readFile(join(worker, 'unmerged.txt'), 'utf8'), 'preserve this change\n');
});

test('modified, untracked, and ignored content each prevent worktree retirement', async (t) => {
  for (const mode of ['modified', 'untracked', 'ignored']) {
    const { root, worker } = await fixture(t);
    register(root, worker);
    accept(root);
    const file = mode === 'modified' ? join(worker, 'docs/evidence.md') : mode === 'ignored' ? join(worker, '.agent-work/cache.txt') : join(worker, 'notes.txt');
    if (mode === 'ignored') await mkdir(join(worker, '.agent-work'));
    await writeFile(file, 'retained content\n');
    const result = run(root, 'cleanup', '--id', 'worker', '--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).removed, false);
    assert.match(JSON.parse(result.stdout).reason, /modified, untracked, or ignored/);
    assert.equal(await readFile(file, 'utf8'), 'retained content\n');
  }
});

test('resumed tasks, changed evidence, and locked worktrees invalidate retirement', async (t) => {
  for (const mode of ['resumed', 'evidence', 'locked']) {
    const { root, worker } = await fixture(t);
    register(root, worker);
    accept(root);
    if (mode === 'resumed') await writeFile(join(root, '.agent-work/state/active-tasks.json'), JSON.stringify([{ owner: 'worker', task: 'T001', checkout: worker, status: 'active' }]));
    if (mode === 'evidence') await writeFile(join(root, 'docs/evidence.md'), 'Changed after acceptance\n');
    if (mode === 'locked') git(root, ['worktree', 'lock', worker]);
    const result = run(root, 'cleanup', '--id', 'worker', '--apply');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).removed, false);
    assert.equal(JSON.parse(result.stdout).eligible, false);
    await readFile(join(worker, 'docs/evidence.md'));
  }
});

test('unknown workers and attempts to register the primary checkout are rejected', async (t) => {
  const { root } = await fixture(t);
  let result = run(root, 'cleanup', '--id', 'unknown', '--apply');
  assert.equal(result.status, 1);
  result = run(root, 'register', '--id', 'primary', '--path', root, '--integration-ref', 'main', '--session', '2026-10-15/run', '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inside the managed worktree area/);
});
