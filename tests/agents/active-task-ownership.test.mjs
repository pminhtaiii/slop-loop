import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/agents/active-task.mjs');
const session = '2026-10-25/ownership-test';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function invoke(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'active-task-ownership-'));
  const repo = join(directory, 'repo');
  await mkdir(join(repo, 'context'), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(repo, ['init', '--quiet', '-b', 'development']);
  await writeFile(join(repo, 'context/active_task.md'), '# Active task\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\n');
  await writeFile(join(repo, '.gitignore'), '.agent-work/\n');
  await writeFile(join(repo, 'owned.txt'), 'owned\n');
  await writeFile(join(repo, 'other.txt'), 'other\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base']);
  return { directory, repo };
}

async function reservedFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'active-task-ownership-reserved-'));
  const repo = join(directory, 'repo');
  const origin = join(directory, 'origin.git');
  const worker = join(directory, 'worker');
  await mkdir(join(repo, 'context'), { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ['init', '--quiet', '--bare', origin]);
  git(repo, ['init', '--quiet', '-b', 'development']);
  await writeFile(join(repo, 'context/active_task.md'), '# Active task\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\n');
  await writeFile(join(repo, '.gitignore'), '.agent-work/\n');
  await writeFile(join(repo, 'owned.txt'), 'owned\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '--quiet', 'origin', 'HEAD:refs/heads/development']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/development']);
  git(repo, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/development:refs/remotes/origin/development']);
  return { directory, repo, worker, baseSha };
}

function startWorker(repo, owner, task, path = 'owned.txt') {
  return invoke(repo, 'start', '--role', 'worker', '--owner', owner, '--task', task, '--session', session,
    '--summary', 'Own a bounded file set', '--next', 'Implement and verify', '--owned-path', path);
}

function startCoordinator(repo, owner, task, ...paths) {
  const args = ['start', '--role', 'coordinator', '--owner', owner, '--task', task, '--session', session,
    '--summary', 'Coordinate the integration', '--next', 'Review worker output'];
  for (const path of paths) args.push('--owned-path', path);
  return invoke(repo, ...args);
}

async function state(repo) {
  return JSON.parse(await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8'));
}

test('update extends active worker ownership with an audit record and an idempotent retry', async (t) => {
  const { repo } = await fixture(t);
  let result = startWorker(repo, 'worker', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  result = startWorker(repo, 'other-worker', 'unrelated', 'other.txt');
  assert.equal(result.status, 0, result.stderr);
  const original = (await state(repo))[0];
  const binding = structuredClone(original.binding);
  const args = ['update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'new-helper.mjs',
    '--add-owned-path', 'new-helper.test.mjs', '--reason', 'Helper path discovered during implementation'];

  result = invoke(repo, ...args);
  assert.equal(result.status, 0, result.stderr);
  let updated = (await state(repo))[0];
  assert.deepEqual(updated.ownedPaths, ['new-helper.mjs', 'new-helper.test.mjs', 'owned.txt']);
  assert.deepEqual(updated.ownershipExtensions.map(({ paths, reason }) => ({ paths, reason })), [
    { paths: ['new-helper.mjs', 'new-helper.test.mjs'], reason: 'Helper path discovered during implementation' },
  ]);
  assert.ok(Number.isFinite(Date.parse(updated.ownershipExtensions[0].at)));
  assert.equal(new Date(updated.ownershipExtensions[0].at).toISOString(), updated.ownershipExtensions[0].at);
  assert.deepEqual(updated.binding, binding);
  assert.equal(updated.readiness, undefined);

  const afterFirstExtension = await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8');
  result = invoke(repo, ...args);
  assert.equal(result.status, 0, result.stderr);
  updated = (await state(repo))[0];
  assert.equal(updated.ownershipExtensions.length, 1);
  assert.equal(await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8'), afterFirstExtension);

  const beforeConflict = await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8');
  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'other.txt', '--reason', 'Another assignment owns this file');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts with active assignment/i);
  assert.equal(await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8'), beforeConflict);

  result = invoke(repo, 'handoff', '--owner', 'worker', '--task', 'ownership', '--result', 'Ownership history preserved');
  assert.equal(result.status, 0, result.stderr);
  const handedOff = (await state(repo))[0];
  const handoffEvidence = structuredClone(handedOff.handoffEvidence);
  const terminalState = await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8');
  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'later.mjs', '--reason', 'Must not amend a saved handoff');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminal entries/i);
  assert.deepEqual((await state(repo))[0].handoffEvidence, handoffEvidence);
  assert.equal(await readFile(join(repo, '.agent-work/state/active-tasks.json'), 'utf8'), terminalState);
});

test('status-only current and legacy coordinators do not block worker extensions', async (t) => {
  const { repo } = await fixture(t);
  let result = startWorker(repo, 'worker', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  result = startCoordinator(repo, 'coordinator', 'session');
  assert.equal(result.status, 0, result.stderr);

  const registry = join(repo, '.agent-work/state/active-tasks.json');
  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'Add the active integration helper');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await state(repo)).find((entry) => entry.owner === 'worker').ownedPaths, ['new-helper.mjs', 'owned.txt']);

  const entries = await state(repo);
  delete entries.find((entry) => entry.owner === 'coordinator').role;
  await writeFile(registry, `${JSON.stringify(entries, null, 2)}\n`);
  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.test.mjs', '--reason', 'Add the legacy integration test');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await state(repo)).find((entry) => entry.owner === 'worker').ownedPaths,
    ['new-helper.mjs', 'new-helper.test.mjs', 'owned.txt']);
});

test('explicit coordinator paths still conflict with worker extensions', async (t) => {
  const { repo } = await fixture(t);
  let result = startWorker(repo, 'worker', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  result = startCoordinator(repo, 'coordinator', 'session', 'other.txt');
  assert.equal(result.status, 0, result.stderr);
  const registry = join(repo, '.agent-work/state/active-tasks.json');
  const before = await readFile(registry, 'utf8');

  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'other.txt',
    '--reason', 'This coordinator already owns the file');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts with active assignment/i);
  assert.equal(await readFile(registry, 'utf8'), before);
});

test('the same owned file conflicts across distinct worktrees of a shared repository', async (t) => {
  const { directory, repo } = await fixture(t);
  let result = startWorker(repo, 'worker', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  const otherCheckout = join(directory, 'other-checkout');
  git(repo, ['worktree', 'add', '--quiet', '-b', 'other-worker', otherCheckout, 'HEAD']);
  result = startWorker(otherCheckout, 'other-worker', 'unrelated', 'other.txt');
  assert.equal(result.status, 0, result.stderr);

  const registry = join(repo, '.agent-work/state/active-tasks.json');
  const before = await readFile(registry, 'utf8');
  result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'other.txt', '--reason', 'Shared integration path');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflicts with active assignment/i);
  assert.equal(await readFile(registry, 'utf8'), before);
});

test('unknown active and blocked worker scopes and reservations block extensions', async (t) => {
  const { directory, repo } = await fixture(t);
  const result = startWorker(repo, 'worker', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  const registry = join(repo, '.agent-work/state/active-tasks.json');
  const entries = await state(repo);
  entries.push({ owner: 'legacy', task: 'unknown', role: 'worker', summary: 'Inherited assignment', next: 'Resolve ownership', status: 'active' });
  await writeFile(registry, `${JSON.stringify(entries, null, 2)}\n`);
  const before = await readFile(registry, 'utf8');

  const denied = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership', '--add-owned-path', 'new-helper.mjs', '--reason', 'Unknown legacy scope');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /unknown owned paths/i);
  assert.equal(await readFile(registry, 'utf8'), before);

  const blockedEntries = await state(repo);
  blockedEntries.find((entry) => entry.owner === 'legacy').status = 'blocked';
  await writeFile(registry, `${JSON.stringify(blockedEntries, null, 2)}\n`);
  const beforeBlocked = await readFile(registry, 'utf8');
  const blocked = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'another-helper.mjs', '--reason', 'Unknown blocked worker scope');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /unknown owned paths/i);
  assert.equal(await readFile(registry, 'utf8'), beforeBlocked);

  const reservationEntries = (await state(repo)).filter((entry) => entry.owner !== 'legacy');
  reservationEntries.push({
    owner: 'reserved-worker', task: 'unknown-reservation', session, summary: 'Reserved worker',
    next: 'Resolve reserved worker scope', status: 'active',
    reservation: {
      schemaVersion: 2,
      identity: { owner: 'reserved-worker', task: 'unknown-reservation', session },
      repository: join(repo, '.git'),
      base: { ref: 'refs/remotes/origin/development', sha: 'a'.repeat(40) },
      coordinatorCheckout: repo,
      primaryCheckout: repo,
    },
  });
  await writeFile(registry, `${JSON.stringify(reservationEntries, null, 2)}\n`);
  const beforeReservation = await readFile(registry, 'utf8');
  const reservation = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'reserved-helper.mjs', '--reason', 'Unknown reserved worker scope');
  assert.equal(reservation.status, 1);
  assert.match(reservation.stderr, /unknown owned paths/i);
  assert.equal(await readFile(registry, 'utf8'), beforeReservation);

  const foreign = join(directory, 'foreign-repository');
  await mkdir(foreign);
  git(foreign, ['init', '--quiet']);
  const missingCheckout = join(directory, 'removed-worker');
  const stale = {
    owner: 'stale-worker', task: 'unknown-checkout', session, role: 'worker',
    summary: 'Inherited assignment', next: 'Resolve the missing checkout', status: 'active',
    checkout: missingCheckout, ownedPaths: ['new-helper.mjs'],
    binding: {
      schemaVersion: 1, identity: { owner: 'stale-worker', task: 'unknown-checkout', session },
      checkout: missingCheckout, repository: join(foreign, '.git'), branch: null,
      base: { ref: 'existing-checkout', sha: null }, boundAt: '2026-10-25T00:00:00.000Z',
    },
  };
  const onlyCurrent = (await state(repo)).filter((entry) => entry.owner !== 'legacy' && entry.owner !== 'reserved-worker');
  onlyCurrent.push(stale);
  await writeFile(registry, `${JSON.stringify(onlyCurrent, null, 2)}\n`);
  const beforeMissingCheckout = await readFile(registry, 'utf8');
  const missing = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'Unknown checkout cannot prove disjoint ownership');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /conflicts with active assignment/i);
  assert.equal(await readFile(registry, 'utf8'), beforeMissingCheckout);
});

test('duplicate, unsafe, and symlinked paths are refused without registry writes', async (t) => {
  const { directory, repo } = await fixture(t);
  const started = startWorker(repo, 'worker', 'ownership');
  assert.equal(started.status, 0, started.stderr);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'target.mjs'), 'outside\n');
  const link = join(repo, 'linked');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const registry = join(repo, '.agent-work/state/active-tasks.json');

  const rejectedPaths = [
    ['owned.txt'],
    ['../escape.mjs'],
    ['.agent-work/state/escape.json'],
    ['linked/target.mjs'],
  ];
  for (const paths of rejectedPaths) {
    const before = await readFile(registry, 'utf8');
    const args = ['update', '--owner', 'worker', '--task', 'ownership'];
    for (const path of paths) args.push('--add-owned-path', path);
    args.push('--reason', 'Must reject unsafe ownership');
    const result = invoke(repo, ...args);
    assert.equal(result.status, 1, `${paths.join(', ')} unexpectedly succeeded`);
    assert.equal(await readFile(registry, 'utf8'), before);
  }

  const unboundEntries = await state(repo);
  delete unboundEntries[0].binding;
  await writeFile(registry, `${JSON.stringify(unboundEntries, null, 2)}\n`);
  const beforeUnbound = await readFile(registry, 'utf8');
  const unbound = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'Must retain binding evidence');
  assert.equal(unbound.status, 1);
  assert.match(unbound.stderr, /unbound/i);
  assert.equal(await readFile(registry, 'utf8'), beforeUnbound);

  const beforeDuplicateFlags = await readFile(registry, 'utf8');
  const duplicateFlags = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--add-owned-path', 'new-helper.mjs', '--reason', 'Repeated flags');
  assert.equal(duplicateFlags.status, 1);
  assert.equal(await readFile(registry, 'utf8'), beforeDuplicateFlags);
});

test('ownership extension history has a fixed bound', async (t) => {
  const { repo } = await fixture(t);
  const started = startWorker(repo, 'worker', 'ownership');
  assert.equal(started.status, 0, started.stderr);
  const registry = join(repo, '.agent-work/state/active-tasks.json');
  const entries = await state(repo);
  const paths = Array.from({ length: 32 }, (_, index) => `history-${String(index).padStart(2, '0')}.txt`);
  entries[0].ownedPaths = ['owned.txt', ...paths];
  entries[0].ownershipExtensions = paths.map((path, index) => ({
    paths: [path], reason: `Recorded extension ${index}`, at: '2026-10-25T00:00:00.000Z',
  }));
  await writeFile(registry, `${JSON.stringify(entries, null, 2)}\n`);
  const before = await readFile(registry, 'utf8');

  const result = invoke(repo, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'History bound reached');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /history is full/i);
  assert.equal(await readFile(registry, 'utf8'), before);
});

test('extension preserves readiness and only permits the matching active worker checkout', async (t) => {
  const { directory, repo, worker, baseSha } = await reservedFixture(t);
  let result = invoke(repo, 'reserve', '--owner', 'worker', '--task', 'ownership', '--session', session,
    '--summary', 'Own a bounded file set', '--next', 'Implement and verify', '--owned-path', 'owned.txt', '--base-sha', baseSha);
  assert.equal(result.status, 0, result.stderr);
  git(repo, ['worktree', 'add', '--quiet', '-b', 'ownership-worker', worker, baseSha]);
  result = invoke(repo, 'bind', '--owner', 'worker', '--task', 'ownership', '--worktree', worker);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'ownership');
  assert.equal(result.status, 0, result.stderr);
  const before = (await state(repo))[0];
  const binding = structuredClone(before.binding);
  const readiness = structuredClone(before.readiness);

  const otherCheckout = join(directory, 'other-checkout');
  git(repo, ['worktree', 'add', '--quiet', '-b', 'other-checkout', otherCheckout, baseSha]);
  const registry = join(repo, '.agent-work/state/active-tasks.json');
  const beforeWrongCheckout = await readFile(registry, 'utf8');
  result = invoke(otherCheckout, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'Wrong checkout must fail');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bound worker checkout|command must run/i);
  assert.equal(await readFile(registry, 'utf8'), beforeWrongCheckout);

  result = invoke(worker, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'new-helper.mjs', '--reason', 'Helper path discovered after readiness');
  assert.equal(result.status, 0, result.stderr);
  let updated = (await state(repo))[0];
  assert.deepEqual(updated.binding, binding);
  assert.deepEqual(updated.readiness, readiness);
  assert.deepEqual(updated.ownedPaths, ['new-helper.mjs', 'owned.txt']);

  result = invoke(worker, 'update', '--owner', 'worker', '--task', 'ownership', '--status', 'blocked');
  assert.equal(result.status, 0, result.stderr);
  const blockedState = await readFile(registry, 'utf8');
  result = invoke(worker, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'blocked-helper.mjs', '--reason', 'Blocked workers cannot extend');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /active worker assignment/i);
  assert.equal(await readFile(registry, 'utf8'), blockedState);
  result = invoke(worker, 'update', '--owner', 'worker', '--task', 'ownership', '--status', 'active');
  assert.equal(result.status, 0, result.stderr);

  result = invoke(worker, 'handoff', '--owner', 'worker', '--task', 'ownership', '--result', 'Readiness retained');
  assert.equal(result.status, 0, result.stderr);
  updated = (await state(repo))[0];
  const handoffEvidence = structuredClone(updated.handoffEvidence);
  const beforeTerminalRetry = await readFile(registry, 'utf8');
  result = invoke(worker, 'update', '--owner', 'worker', '--task', 'ownership',
    '--add-owned-path', 'later.mjs', '--reason', 'Cannot amend handed-off ownership');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminal entries/i);
  assert.deepEqual((await state(repo))[0].handoffEvidence, handoffEvidence);
  assert.equal(await readFile(registry, 'utf8'), beforeTerminalRetry);
});
