import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/agents/active-task.mjs');
const session = '2026-10-22/binding-test';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function invoke(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
}

function taskArgs(owner = 'worker') {
  return ['--owner', owner, '--task', 'binding', '--session', session, '--summary', 'Bind before editing', '--next', 'Verify the worker worktree', '--owned-path', 'owned.txt'];
}

function alternateCase(path) {
  const index = path.search(/[a-z]/i);
  if (index === -1) return path;
  const letter = path[index];
  return path.slice(0, index) + (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()) + path.slice(index + 1);
}

async function fixture(t, { originDevelopment = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'active-task-binding-'));
  const repo = join(directory, 'repo');
  const origin = join(directory, 'origin.git');
  await mkdir(repo);
  git(directory, ['init', '--quiet', '--bare', origin]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(repo, ['init', '--quiet', '-b', 'development']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await mkdir(join(repo, 'context'));
  await writeFile(join(repo, 'context/active_task.md'), '# Active task\nPermanent instructions.\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\nPermanent footer.\n');
  await writeFile(join(repo, '.gitignore'), '.agent-work/\n');
  await writeFile(join(repo, 'owned.txt'), 'original\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', origin]);
  if (originDevelopment) {
    git(repo, ['push', '--quiet', 'origin', 'HEAD:refs/heads/development']);
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/development']);
    git(repo, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/development:refs/remotes/origin/development']);
  }
  const worker = join(directory, 't3-app', 'worker');
  await mkdir(dirname(worker), { recursive: true });
  return { directory, origin, repo, worker, baseSha };
}

function reserve(root, baseSha, owner = 'worker') {
  return invoke(root, 'reserve', ...taskArgs(owner), '--base-sha', baseSha);
}

function stateFile(repo) {
  return join(repo, '.agent-work/state/active-tasks.json');
}

async function advanceBareDevelopment(directory, origin, fileName) {
  const peer = join(directory, 'origin-writer');
  git(directory, ['clone', '--quiet', origin, peer]);
  await writeFile(join(peer, fileName), 'origin moved ahead\n');
  git(peer, ['add', fileName]);
  git(peer, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'advance bare origin']);
  const remoteSha = git(peer, ['rev-parse', 'HEAD']);
  git(peer, ['push', '--quiet', 'origin', 'HEAD:refs/heads/development']);
  return remoteSha;
}

async function state(repo) {
  return JSON.parse(await readFile(stateFile(repo), 'utf8'));
}

async function addWorker(repo, worker, baseSha, branch = 'worker') {
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, worker, baseSha]);
  return realpath(worker);
}

test('reserve records only fetched-base provenance, then bind, edit, hand off, and verify through the public CLI', async (t) => {
  const { directory, origin, repo, worker, baseSha } = await fixture(t);
  let result = reserve(repo, baseSha);
  assert.equal(result.status, 0, result.stderr);
  let entries = await state(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'active');
  assert.equal(entries[0].role, 'worker');
  assert.equal(entries[0].checkout, undefined);
  assert.equal(entries[0].head, undefined);
  assert.equal(entries[0].binding, undefined);
  assert.equal(entries[0].reservation.schemaVersion, 2);
  assert.equal(entries[0].reservation.coordinatorCheckout, await realpath(repo));
  assert.equal(entries[0].reservation.primaryCheckout, await realpath(repo));
  assert.deepEqual(entries[0].reservation.base, { ref: 'refs/remotes/origin/development', sha: baseSha });

  const advancedRemoteSha = await advanceBareDevelopment(directory, origin, 'remote-advance.txt');
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/development']), baseSha, 'pushing to the local bare origin must leave the cached tracking ref stale');
  assert.notEqual(advancedRemoteSha, baseSha);

  await addWorker(repo, worker, baseSha);
  const before = await readFile(stateFile(repo), 'utf8');
  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unbound/i);
  result = invoke(worker, 'handoff', '--owner', 'worker', '--task', 'binding', '--result', 'Must reject an unbound worker');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unbound/i);
  assert.equal(await readFile(stateFile(repo), 'utf8'), before);

  result = invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker);
  assert.equal(result.status, 0, result.stderr);
  entries = await state(repo);
  assert.equal(entries.length, 1);
  assert.equal(await realpath(entries[0].checkout), await realpath(worker));
  assert.equal(entries[0].binding.branch, 'refs/heads/worker');
  assert.equal(entries[0].binding.base.sha, baseSha);
  assert.deepEqual(entries[0].binding.identity, { owner: 'worker', task: 'binding', session });

  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
  let readiness = (await state(repo))[0].readiness;
  assert.deepEqual(readiness.identity, { owner: 'worker', task: 'binding', session });
  assert.equal(readiness.checkout, await realpath(worker));
  assert.equal(readiness.repository, await realpath(join(repo, '.git')));
  assert.equal(readiness.branch, 'refs/heads/worker');
  assert.deepEqual(readiness.base, { ref: 'refs/remotes/origin/development', sha: baseSha });
  const originalReadyAt = readiness.readyAt;
  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 0, result.stderr);
  readiness = (await state(repo))[0].readiness;
  assert.equal(readiness.readyAt, originalReadyAt, 'repeated readiness must preserve the original receipt');

  await writeFile(join(worker, 'owned.txt'), 'edited after binding\n');
  git(worker, ['add', 'owned.txt']);
  git(worker, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'worker edit']);
  const workerHead = git(worker, ['rev-parse', 'HEAD']);
  assert.notEqual(workerHead, baseSha);
  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await state(repo))[0].readiness.readyAt, originalReadyAt, 'repeated readiness must not reset after edits');
  result = invoke(worker, 'handoff', '--owner', 'worker', '--task', 'binding', '--result', 'Owned path committed and captured');
  assert.equal(result.status, 0, result.stderr);
  entries = await state(repo);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'handed-off');
  assert.equal(entries[0].binding.base.sha, baseSha);
  assert.equal(entries[0].handoffEvidence.revision, workerHead);

  result = invoke(repo, 'verify-handoff', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified, true);
});

test('reserved binding refuses the coordinator checkout even when called from another checkout', async (t) => {
  const { repo, worker, baseSha } = await fixture(t);
  assert.equal(reserve(repo, baseSha).status, 0);
  await addWorker(repo, worker, baseSha);
  const before = await readFile(stateFile(repo), 'utf8');
  for (const [root, target] of [[repo, repo], [worker, repo]]) {
    const result = invoke(root, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', target);
    assert.equal(result.status, 1, `reserved primary checkout unexpectedly bound from ${root}`);
    assert.match(result.stderr, /coordinator|primary/i);
    assert.equal(await readFile(stateFile(repo), 'utf8'), before);
  }
  if (process.platform === 'win32') {
    const result = invoke(worker, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', alternateCase(repo));
    assert.equal(result.status, 1, 'case-variant primary path unexpectedly bound');
    assert.match(result.stderr, /coordinator|primary/i);
    assert.equal(await readFile(stateFile(repo), 'utf8'), before);
  }
});

test('reserved work edited before readiness cannot gain a pre-edit receipt or hand off', async (t) => {
  for (const mode of ['dirty', 'commit']) {
    const { repo, worker, baseSha } = await fixture(t);
    assert.equal(reserve(repo, baseSha).status, 0);
    await addWorker(repo, worker, baseSha);
    assert.equal(invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker).status, 0);
    await writeFile(join(worker, 'owned.txt'), `edited without readiness (${mode})\n`);
    if (mode === 'commit') {
      git(worker, ['add', 'owned.txt']);
      git(worker, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'edit before readiness']);
    }

    const before = await readFile(stateFile(repo), 'utf8');
    let result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
    assert.equal(result.status, 1, `late readiness unexpectedly succeeded (${mode}): ${result.stdout}`);
    assert.match(result.stderr, /before editing|creation base|clean/i);
    result = invoke(worker, 'handoff', '--owner', 'worker', '--task', 'binding', '--result', 'Skipped readiness');
    assert.equal(result.status, 1, `handoff without readiness unexpectedly succeeded (${mode}): ${result.stdout}`);
    assert.match(result.stderr, /edit-ready|readiness|ready/i);
    assert.equal(await readFile(stateFile(repo), 'utf8'), before, 'failed readiness and handoff must not mutate the assignment');
  }
});

test('handoff rejects stale readiness identity, checkout, or creation base', async (t) => {
  for (const mode of ['identity', 'checkout', 'base']) {
    const { repo, worker, baseSha } = await fixture(t);
    assert.equal(reserve(repo, baseSha).status, 0);
    await addWorker(repo, worker, baseSha);
    assert.equal(invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker).status, 0);
    assert.equal(invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding').status, 0);
    const path = stateFile(repo);
    const entries = await state(repo);
    if (mode === 'identity') entries[0].readiness.branch = 'refs/heads/stale-branch';
    else if (mode === 'checkout') entries[0].readiness.checkout = join(repo, 'moved-worker');
    else entries[0].readiness.base.sha = '0'.repeat(40);
    const stale = `${JSON.stringify(entries, null, 2)}\n`;
    await writeFile(path, stale);

    const result = invoke(worker, 'handoff', '--owner', 'worker', '--task', 'binding', '--result', 'Stale readiness must fail');
    assert.equal(result.status, 1, `${mode} readiness unexpectedly passed handoff`);
    assert.match(result.stderr, /readiness|identity|base|branch|checkout/i);
    assert.equal(await readFile(path, 'utf8'), stale, 'stale readiness failure must not mutate state');
  }
});

test('reserve refuses a stale local branch, a feature commit, an unrelated SHA, or an unavailable origin branch', async (t) => {
  for (const mode of ['stale-development', 'feature-commit', 'unrelated-sha', 'missing-fetched-ref']) {
    const { directory, origin, repo, baseSha } = await fixture(t, { originDevelopment: mode !== 'missing-fetched-ref' });
    let requestedSha = baseSha;
    if (mode === 'stale-development') {
      await advanceBareDevelopment(directory, origin, 'new-development.txt');
      requestedSha = git(repo, ['rev-parse', 'refs/remotes/origin/development']);
    } else if (mode === 'feature-commit') {
      git(repo, ['checkout', '--quiet', '-b', 'feature']);
      await writeFile(join(repo, 'feature.txt'), 'feature tip\n');
      git(repo, ['add', 'feature.txt']);
      git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'feature tip']);
    } else if (mode === 'unrelated-sha') {
      const other = await mkdtemp(join(tmpdir(), 'unrelated-base-'));
      t.after(() => rm(other, { recursive: true, force: true }));
      git(other, ['init', '--quiet', '-b', 'development']);
      await writeFile(join(other, 'other.txt'), 'unrelated\n');
      git(other, ['add', 'other.txt']);
      git(other, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'unrelated']);
      requestedSha = git(other, ['rev-parse', 'HEAD']);
    }
    const result = reserve(repo, requestedSha);
    assert.equal(result.status, 1, `${mode} unexpectedly reserved: ${result.stdout}`);
    assert.match(result.stderr, /origin\/development|fetched base|does not match/i);
    assert.deepEqual(await state(repo).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  }
});

test('reserve fetches a remote advance before comparing the supplied SHA and leaves no stale-base reservation', async (t) => {
  const { directory, origin, repo, baseSha } = await fixture(t);
  const remoteSha = await advanceBareDevelopment(directory, origin, 'remote-advance.txt');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/development']), baseSha);

  const result = reserve(repo, baseSha);
  assert.equal(result.status, 1, `stale fetched base unexpectedly reserved: ${result.stdout}`);
  assert.match(result.stderr, /fetched origin\/development|match.*base|fetch/i);
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/development']), remoteSha, 'reserve must refresh the tracking ref before comparing');
  assert.deepEqual(await state(repo).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('reserve fails closed when fetch fails even though a valid stale tracking ref exists', async (t) => {
  const { directory, repo, baseSha } = await fixture(t);
  git(repo, ['remote', 'set-url', 'origin', join(directory, 'missing-origin.git')]);
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/development']), baseSha);

  const result = reserve(repo, baseSha);
  assert.equal(result.status, 1, `reservation unexpectedly survived failed fetch: ${result.stdout}`);
  assert.match(result.stderr, /fetch.*failed|could not fetch|failed to fetch/i);
  assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/development']), baseSha, 'failed fetch must leave the old tracking ref untouched and unusable');
  assert.deepEqual(await state(repo).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('bind rejects wrong-repository, unregistered, symlinked, and wrong-base worktrees without creating owners', async (t) => {
  const { directory, repo, worker, baseSha } = await fixture(t);
  assert.equal(reserve(repo, baseSha).status, 0);
  const foreign = join(directory, 'foreign');
  await mkdir(foreign);
  git(foreign, ['init', '--quiet', '-b', 'worker']);
  await writeFile(join(foreign, 'foreign.txt'), 'different repository\n');
  git(foreign, ['add', 'foreign.txt']);
  git(foreign, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'foreign']);

  const unregistered = join(directory, 'unregistered');
  await mkdir(unregistered);
  const wrongBase = join(directory, 'wrong-base');
  await writeFile(join(repo, 'extra.txt'), 'wrong base\n');
  git(repo, ['add', 'extra.txt']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'wrong base']);
  const wrongSha = git(repo, ['rev-parse', 'HEAD']);
  await addWorker(repo, wrongBase, wrongSha, 'wrong-base');

  const validWorker = await addWorker(repo, worker, baseSha);
  const link = join(directory, 'worker-link');
  await symlink(validWorker, link, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readFile(stateFile(repo), 'utf8');
  for (const [label, path, pattern] of [
    ['wrong repository', foreign, /same repository|registered.*Git worktree/i],
    ['unregistered path', unregistered, /registered.*Git worktree/i],
    ['symbolic link', link, /symbolic link|real directory/i],
    ['wrong base', wrongBase, /base/i],
  ]) {
    const result = invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', path);
    assert.equal(result.status, 1, `${label} unexpectedly bound: ${result.stdout}`);
    assert.match(result.stderr, pattern);
    assert.equal(await readFile(stateFile(repo), 'utf8'), before);
    assert.equal((await state(repo)).length, 1, 'failed bind must not create a ghost owner');
  }
});

test('double binding and stale worktree identity fail without moving or duplicating the assignment', async (t) => {
  const { repo, worker, baseSha } = await fixture(t);
  assert.equal(reserve(repo, baseSha).status, 0);
  await addWorker(repo, worker, baseSha);
  assert.equal(invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker).status, 0);
  const before = await readFile(stateFile(repo), 'utf8');
  let result = invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already bound/i);
  assert.equal(await readFile(stateFile(repo), 'utf8'), before);

  git(worker, ['checkout', '--quiet', '-b', 'replacement-branch']);
  result = invoke(worker, 'edit-ready', '--owner', 'worker', '--task', 'binding');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /branch|identity/i);
  assert.equal((await state(repo)).length, 1);
});

test('malformed and stale reservation identities fail closed without rewriting state', async (t) => {
  for (const mode of ['malformed', 'stale-session']) {
    const { repo, worker, baseSha } = await fixture(t);
    assert.equal(reserve(repo, baseSha).status, 0);
    await addWorker(repo, worker, baseSha);
    const path = stateFile(repo);
    const entries = await state(repo);
    if (mode === 'malformed') entries[0].reservation.base.sha = 'not-a-commit';
    else entries[0].reservation.identity.session = '2026-10-21/old-session';
    const malformed = `${JSON.stringify(entries, null, 2)}\n`;
    await writeFile(path, malformed);
    const result = invoke(repo, 'bind', '--owner', 'worker', '--task', 'binding', '--worktree', worker);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid|identity|base/i);
    assert.equal(await readFile(path, 'utf8'), malformed);
  }
});

test('start remains an in-place backward-compatible worker assignment', async (t) => {
  const { repo } = await fixture(t);
  let result = invoke(repo, 'start', '--owner', 'legacy-worker', '--task', 'existing', '--session', session, '--role', 'worker', '--summary', 'Continue in this checkout', '--next', 'Edit here', '--owned-path', 'owned.txt');
  assert.equal(result.status, 0, result.stderr);
  let entries = await state(repo);
  assert.equal(entries.length, 1);
  assert.equal(await realpath(entries[0].checkout), await realpath(repo));
  assert.equal(entries[0].binding.branch, 'refs/heads/development');
  assert.equal(entries[0].binding.base.ref, 'existing-checkout');
  result = invoke(repo, 'edit-ready', '--owner', 'legacy-worker', '--task', 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await state(repo))[0].readiness, undefined, 'legacy existing-checkout bindings keep their compatibility path');
  result = invoke(repo, 'handoff', '--owner', 'legacy-worker', '--task', 'existing', '--result', 'Existing-checkout handoff remains supported');
  assert.equal(result.status, 0, result.stderr);
  entries = await state(repo);
  assert.equal(entries[0].status, 'handed-off');
  assert.equal(entries[0].readiness, undefined);
});

test('explicit legacy existing-checkout binding remains in place without a readiness receipt', async (t) => {
  const { repo } = await fixture(t);
  await mkdir(dirname(stateFile(repo)), { recursive: true });
  await writeFile(stateFile(repo), JSON.stringify([{
    owner: 'legacy-worker', task: 'existing', session, role: 'worker', checkout: repo,
    summary: 'Continue existing checkout', next: 'Bind without relocation', status: 'active', verification: '', ownedPaths: ['owned.txt'],
  }]));
  let result = invoke(repo, 'bind', '--owner', 'legacy-worker', '--task', 'existing', '--worktree', repo);
  assert.equal(result.status, 0, result.stderr);
  const entry = (await state(repo))[0];
  assert.equal(await realpath(entry.checkout), await realpath(repo));
  assert.equal(entry.binding.base.ref, 'existing-checkout');
  result = invoke(repo, 'edit-ready', '--owner', 'legacy-worker', '--task', 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await state(repo))[0].readiness, undefined);
  result = invoke(repo, 'handoff', '--owner', 'legacy-worker', '--task', 'existing', '--result', 'Legacy checkout migration remains supported');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await state(repo))[0].status, 'handed-off');
});
