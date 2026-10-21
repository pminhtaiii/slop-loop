import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sessionCli = join(root, 'scripts/agents/agent-work.mjs');
const taskCli = join(root, 'scripts/agents/active-task.mjs');

async function fixture(t) {
  const checkout = await mkdtemp(join(tmpdir(), 'session-lifecycle-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, 'context'));
  await writeFile(join(checkout, 'context/active_task.md'), '# Active task\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\n');
  const initialized = spawnSync('git', ['init', '--quiet', '-b', 'main', checkout], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  return checkout;
}

function run(cli, checkout, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', checkout], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
}

function startSession(checkout, id) {
  const result = run(sessionCli, checkout, 'start', '--session', id, '--date', '2026-10-21');
  assert.equal(result.status, 0, result.stderr);
}

test('new assignments require explicit sessions and workers must declare owned paths', async (t) => {
  const checkout = await fixture(t);
  const missingSession = run(taskCli, checkout, 'start', '--owner', 'coordinator', '--task', 'T001', '--summary', 'Work', '--next', 'Verify');
  assert.equal(missingSession.status, 1);
  assert.match(missingSession.stderr, /Session must be date\/id/);
  const missingPaths = run(taskCli, checkout, 'start', '--owner', 'worker', '--task', 'T002', '--role', 'worker', '--session', '2026-10-21/worker', '--summary', 'Work', '--next', 'Verify');
  assert.equal(missingPaths.status, 1);
  assert.match(missingPaths.stderr, /requires at least one --owned-path/);
});

test('finishing one session ignores another explicit session assignment in the same checkout', async (t) => {
  const checkout = await fixture(t);
  startSession(checkout, 'target');
  const assignment = run(taskCli, checkout, 'start', '--owner', 'other-worker', '--task', 'T002', '--session', '2026-10-21/other', '--summary', 'Other session work', '--next', 'Continue in its session');
  assert.equal(assignment.status, 0, assignment.stderr);

  const finished = run(sessionCli, checkout, 'finish', '--session', '2026-10-21/target');
  assert.equal(finished.status, 0, finished.stderr);
  const tasks = JSON.parse(await readFile(join(checkout, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].session, '2026-10-21/other');
  assert.equal(tasks[0].status, 'active');
});

test('an assignment in its own session blocks finish and names the exact owner/task', async (t) => {
  const checkout = await fixture(t);
  startSession(checkout, 'owned');
  const assignment = run(taskCli, checkout, 'start', '--owner', 'own-worker', '--task', 'T003', '--session', '2026-10-21/owned', '--summary', 'Owned work', '--next', 'Finish tests');
  assert.equal(assignment.status, 0, assignment.stderr);

  const finished = run(sessionCli, checkout, 'finish', '--session', '2026-10-21/owned');
  assert.equal(finished.status, 1);
  assert.match(finished.stderr, /own-worker\/T003 \[active; session=2026-10-21\/owned; checkout=/);
  const tasks = JSON.parse(await readFile(join(checkout, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(tasks[0].status, 'active');
});

test('legacy assignments with unknown session remain conservative blockers', async (t) => {
  const checkout = await fixture(t);
  startSession(checkout, 'legacy-target');
  await mkdir(join(checkout, '.agent-work/state'), { recursive: true });
  await writeFile(join(checkout, '.agent-work/state/active-tasks.json'), JSON.stringify([
    { owner: 'legacy-worker', task: 'T004', checkout, summary: 'Older record', next: 'Recover evidence', status: 'blocked' },
    { owner: 'malformed-worker', task: 'T005', checkout, session: 'not-a-session', summary: 'Damaged record', next: 'Inspect the state', status: 'active' },
  ]));

  const finished = run(sessionCli, checkout, 'finish', '--session', '2026-10-21/legacy-target');
  assert.equal(finished.status, 1);
  assert.match(finished.stderr, /legacy-worker\/T004 \[blocked; session=unknown; checkout=/);
  assert.match(finished.stderr, /malformed-worker\/T005 \[active; session=not-a-session; checkout=/);
  const marker = JSON.parse(await readFile(join(checkout, '.agent-work/2026-10-21/legacy-target/session.json'), 'utf8'));
  assert.equal(marker.status, 'active');
});
