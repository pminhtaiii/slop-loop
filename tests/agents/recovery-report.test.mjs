import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const reportCli = join(root, 'scripts/agents/recovery-report.mjs');
const sessionCli = join(root, 'scripts/agents/agent-work.mjs');
const taskCli = join(root, 'scripts/agents/active-task.mjs');

async function fixture(t) {
  const checkout = await mkdtemp(join(tmpdir(), 'recovery-report-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, 'context'));
  await writeFile(join(checkout, '.gitignore'), '.agent-work/\n');
  await writeFile(join(checkout, 'context/active_task.md'), '# Active task\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\n');
  const initialized = spawnSync('git', ['init', '--quiet', '-b', 'main', checkout], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  return checkout;
}

function run(cli, checkout, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', checkout], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

test('recovery report joins assignment, live Git worktree, checkpoint, changes, and unknown agent status', async (t) => {
  const checkout = await fixture(t);
  let result = run(sessionCli, checkout, 'start', '--session', 'session-one', '--date', '2026-10-21');
  assert.equal(result.status, 0, result.stderr);
  result = run(taskCli, checkout, 'start', '--owner', 'worker', '--task', 'T001', '--session', '2026-10-21/session-one', '--summary', 'Recover feature work', '--next', 'Run focused tests');
  assert.equal(result.status, 0, result.stderr);
  await writeFile(join(checkout, 'staged.txt'), 'staged recovery evidence\n');
  const staged = spawnSync('git', ['add', 'staged.txt'], { cwd: checkout, encoding: 'utf8', windowsHide: true });
  assert.equal(staged.status, 0, staged.stderr);

  result = run(reportCli, checkout, '--owner', 'worker', '--task', 'T001');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.assignments.length, 1);
  const assignment = report.assignments[0];
  assert.deepEqual(assignment.assignment, {
    owner: 'worker', task: 'T001', status: 'active', session: '2026-10-21/session-one', checkout,
  });
  assert.equal(assignment.worktree.path, checkout);
  assert.deepEqual(assignment.worktree.stagedPaths, ['staged.txt']);
  assert.equal(assignment.checkpoint.next, 'Run focused tests');
  assert.equal(assignment.checkpoint.sessionMarker.status, 'active');
  assert.equal(assignment.agent.status, 'unknown');
  assert.match(assignment.agent.note, /do not prove an agent is running or stopped/);
});

test('recovery report is read-only when contributor state is absent', async (t) => {
  const checkout = await fixture(t);
  const result = run(reportCli, checkout);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).assignments, []);
  await assert.rejects(access(join(checkout, '.agent-work')));
});
