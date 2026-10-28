import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { cliSource, git } from './support/agent-context-fixture.mjs';

function ledger({ checked = true, open = [], conflicts = false, malformed = false } = {}) {
  const tasks = [];
  for (let number = 1; number <= 61; number += 1) {
    const id = `T${String(number).padStart(3, '0')}`;
    const isOpen = open.includes(id);
    let dependencies = [];
    if (id === 'T057') dependencies = ['T048', 'T056'];
    if (id === 'T058') dependencies = ['T057'];
    if (id === 'T059') dependencies = ['T021', 'T040', 'T042', 'T044', 'T046', 'T048', 'T050', 'T052', 'T054', 'T056', 'T058'];
    if (id === 'T022') dependencies = ['T021', 'T040', 'T042', 'T044', 'T046', 'T048', 'T050', 'T052', 'T054', 'T056', 'T058', 'T059'];
    if (id === 'T060') dependencies = ['T018', 'T022', 'T054'];
    if (id === 'T061') dependencies = ['T060'];
    if (malformed && id === 'T002') dependencies = ['T001,'];
    const path = conflicts && ['T003', 'T004'].includes(id) ? 'src/shared.ts' : `src/task-${id}.ts`;
    const title = id === 'T059' ? 'Add neutral guard signature scaffold; intentional behavioral RED.' : `Task ${id}`;
    tasks.push(`- [${checked && !isOpen ? 'x' : ' '}] ${id} ${title} in \`${path}\`.\n  - **Dependencies**: ${dependencies.length ? dependencies.join(', ') : 'None'}.\n  - **Owned Paths**: ${path}.`);
  }
  return `# Tasks\n\n## Phase 1: Work\n${tasks.join('\n')}\n\n\`\`\`markdown\n- [ ] T999 Fenced example in \`src/example.ts\`.\n  - **Dependencies**: T000.\n\`\`\`\n`;
}

async function checkout(t, source = ledger()) {
  const root = await mkdtemp(join(tmpdir(), 'agent-context-batch-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'fixture']);
  git(root, ['config', 'user.name', 'Agent Context Batch Tests']);
  git(root, ['config', 'user.email', 'agent-context-batch@example.invalid']);
  const tasksPath = join(root, 'specs', 'feature', 'tasks.md');
  await mkdir(join(root, 'specs', 'feature'), { recursive: true });
  await writeFile(tasksPath, source, 'utf8');
  git(root, ['add', '--', 'specs/feature/tasks.md']);
  git(root, ['commit', '-m', 'fixture baseline']);
  return { root, tasksPath, statePath: join(root, '.agent-work', 'state', 'active-tasks.json') };
}

function run(current, mode, extra = [], tasksPath = 'specs/feature/tasks.md') {
  return spawnSync(process.execPath, [
    cliSource, mode, '--tasks', tasksPath, ...extra, '--root', current.root,
  ], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
}

async function writeAssignments(current, entries) {
  await mkdir(join(current.root, '.agent-work', 'state'), { recursive: true });
  await writeFile(current.statePath, `${JSON.stringify(entries)}\n`, 'utf8');
}

test('batch computes canonical dependency closure, reports explicit authorization and ignores unrelated assignments without writing', async (t) => {
  const current = await checkout(t, ledger({ open: ['T060', 'T061'] }));
  const unrelated = Array.from({ length: 300 }, (_, index) => ({
    owner: `old-${index}`, task: `unrelated-${index}`, role: 'worker', status: 'active',
    checkout: current.root, session: 'old-session', summary: 'Unrelated stale assignment', next: 'No action',
  }));
  unrelated.push({
    owner: 'prior-session-worker', task: 'T060', role: 'worker', status: 'active',
    checkout: current.root, session: 'old-session', summary: 'Prior session assignment', next: 'No action',
    ownedPaths: ['src/task-T060.ts'],
  });
  await writeAssignments(current, unrelated);
  const beforeTasks = await readFile(current.tasksPath, 'utf8');
  const beforeState = await readFile(current.statePath, 'utf8');

  const result = run(current, 'batch', ['--scope', 'T057-T061', '--session', 'current-session']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).dependencyClosure, [
    'T018', 'T021', 'T022', 'T040', 'T042', 'T044', 'T046', 'T048', 'T050', 'T052',
    'T054', 'T056', 'T057', 'T058', 'T059', 'T060', 'T061',
  ]);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.readyFrontier.map((task) => task.id), ['T060']);
  assert.deepEqual(output.missingAuthorization, ['T060', 'T061']);
  assert.deepEqual(output.workers, []);
  assert.ok(output.tasks.find((task) => task.id === 'T060').paths.includes('src/task-T060.ts'));
  assert.equal(result.stdout.includes('unrelated-'), false);
  assert.equal(await readFile(current.tasksPath, 'utf8'), beforeTasks);
  assert.equal(await readFile(current.statePath, 'utf8'), beforeState);
});

test('review-ready requires checked integrated scope and terminal scoped workers; no-review is skipped, not certified', async (t) => {
  const current = await checkout(t, ledger({ open: ['T060', 'T061'] }));
  await writeAssignments(current, [{
    owner: 'live-worker', task: 'T060', role: 'worker', status: 'active', checkout: current.root,
    session: 'current-session', summary: 'Still editing', next: 'Finish and hand off', ownedPaths: ['src/task-T060.ts'],
  }, {
    owner: 'handoff-worker', task: 'T061', role: 'worker', status: 'handed-off', checkout: current.root,
    session: 'current-session', summary: 'Result awaits integration', next: 'Coordinator integration', ownedPaths: ['src/task-T061.ts'],
  }]);

  const blocked = run(current, 'review-ready', [
    '--scope', 'T057-T061', '--session', 'current-session', '--authorized', 'T060',
  ]);
  assert.equal(blocked.status, 0, blocked.stderr);
  let output = JSON.parse(blocked.stdout);
  assert.equal(output.review.status, 'blocked');
  assert.equal(output.review.reviewed, false);
  assert.equal(output.review.acceptanceCertified, false);
  assert.ok(output.blockers.unchecked.includes('T060'));
  assert.ok(output.blockers.liveWorkers.some((worker) => worker.task === 'T060'));
  assert.ok(output.blockers.unintegratedHandoffs.some((worker) => worker.task === 'T061'));
  assert.deepEqual(output.missingAuthorization, ['T061']);

  const skipped = run(current, 'review-ready', [
    '--scope', 'T057-T061', '--no-review', '--session', 'current-session',
  ]);
  assert.equal(skipped.status, 0, skipped.stderr);
  output = JSON.parse(skipped.stdout);
  assert.equal(output.review.status, 'skipped');
  assert.equal(output.review.reviewed, false);
  assert.equal(output.review.acceptanceCertified, false);
});

test('review-ready reports end-of-scope logistics without treating a checked RED checkpoint as acceptance', async (t) => {
  const current = await checkout(t);
  const result = run(current, 'review-ready', ['--scope', 'T057-T061']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.review.status, 'ready');
  assert.equal(output.review.reviewed, false);
  assert.equal(output.review.acceptanceCertified, false);
  assert.ok(output.tasks.find((task) => task.id === 'T059').summary.includes('intentional behavioral RED'));
  assert.ok(output.dependencyClosure.includes('T022'));
});

test('batch surfaces exact path collisions at the ready frontier', async (t) => {
  const current = await checkout(t, ledger({ checked: false, conflicts: true }));
  const result = run(current, 'batch', ['--scope', 'T003-T004', '--authorized', 'T003', '--authorized', 'T004']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.readyFrontier.map((task) => task.id), ['T003', 'T004']);
  assert.ok(output.conflicts.some((conflict) =>
    conflict.path === 'src/shared.ts' && conflict.tasks.includes('T003') && conflict.tasks.includes('T004')));
});

test('batch rejects unknown scopes, malformed dependencies, duplicate IDs, cycles, and path traversal', async (t) => {
  const current = await checkout(t);
  assert.match(run(current, 'batch', ['--scope', 'T999']).stderr, /Unknown scope task ID T999/);
  assert.match(run(current, 'batch', ['--scope', '../T001']).stderr, /Invalid scope/);

  await writeFile(current.tasksPath, ledger({ malformed: true }), 'utf8');
  assert.match(run(current, 'batch', ['--scope', 'T001']).stderr, /Malformed dependency/);

  const missingDependencies = ledger().replace(/(- \[x\] T001[^\n]*\n) {2}- \*\*Dependencies\*\*: None\.\n/, '$1');
  await writeFile(current.tasksPath, missingDependencies, 'utf8');
  let result = run(current, 'review-ready', ['--scope', 'T001']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).blockers.dependenciesUnspecified.includes('T001'));

  const externalGate = ledger().replace(
    '- [x] T002 Task T002 in `src/task-T002.ts`.\n  - **Dependencies**: None.',
    '- [x] T002 Task T002 in `src/task-T002.ts`.\n  - **Dependencies**: T001; external X04-STATE.',
  );
  await writeFile(current.tasksPath, externalGate, 'utf8');
  result = run(current, 'review-ready', ['--scope', 'T002']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).blockers.unresolvedExternalDependencies.some((entry) =>
    entry.task === 'T002' && entry.dependency === 'X04-STATE'));

  const unknownDependency = ledger().replace('  - **Dependencies**: None.\n', '  - **Dependencies**: T999.\n');
  await writeFile(current.tasksPath, unknownDependency, 'utf8');
  assert.match(run(current, 'batch', ['--scope', 'T001']).stderr, /unknown task T999/i);

  const duplicate = '# Tasks\n\n## Phase 1\n- [ ] T001 One in `src/one.ts`.\n  - **Dependencies**: None.\n- [ ] T001 Duplicate in `src/two.ts`.\n  - **Dependencies**: None.\n';
  await writeFile(current.tasksPath, duplicate, 'utf8');
  assert.match(run(current, 'batch', ['--scope', 'T001']).stderr, /Duplicate canonical task ID T001/);

  const cycle = '# Tasks\n\n## Phase 1\n- [ ] T001 One in `src/one.ts`.\n  - **Dependencies**: T002.\n- [ ] T002 Two in `src/two.ts`.\n  - **Dependencies**: T001.\n';
  await writeFile(current.tasksPath, cycle, 'utf8');
  assert.match(run(current, 'batch', ['--scope', 'T001']).stderr, /DEPENDENCY_CYCLE|dependency cycle/i);
  assert.match(run(current, 'batch', ['--scope', 'T001'], '../outside.md').stderr, /repo-relative path|escapes the checkout root/);
});

test('CLI help documents batch and review-ready scope, authorization, and opt-out flags', () => {
  for (const mode of ['batch', 'review-ready']) {
    const result = spawnSync(process.execPath, [cliSource, mode, '--help'], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--scope T057-T061/);
    assert.match(result.stdout, /--authorized T057/);
  }
  const review = spawnSync(process.execPath, [cliSource, 'review-ready', '--help'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.match(review.stdout, /--no-review/);
});
