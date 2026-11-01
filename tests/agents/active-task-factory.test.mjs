import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const activeTaskCli = resolve('scripts/agents/active-task.mjs');
const factoryStateCli = resolve('scripts/agents/factory-state.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function run(root, script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args, '--root', root], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { factoryManaged = true, start = true } = {}) {
  await mkdir(join(process.cwd(), '.agent-work'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.agent-work', 'active-task-factory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'context'));
  await writeFile(join(root, 'context', 'active_task.md'), '# Active task\n');
  await writeFile(join(root, '.gitignore'), '.agent-work/\n');
  await writeFile(join(root, 'source.txt'), 'authorization');
  await writeFile(join(root, 'code.txt'), 'candidate');
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  if (start) {
    const started = run(
      root,
      activeTaskCli,
      'start',
      '--owner',
      'worker',
      '--task',
      'task',
      '--session',
      '2026-10-31/test',
      '--role',
      'worker',
      '--summary',
      'fixture',
      '--next',
      'test',
      '--owned-path',
      'code.txt',
      ...(factoryManaged ? ['--factory-managed'] : []),
    );
    assert.equal(started.status, 0, started.stderr);
  }
  const session = join(root, '.agent-work', '2026-10-31', 'test');
  await mkdir(session, { recursive: true });
  await writeFile(join(session, 'log.txt'), 'focused check output');
  return { root, session, state: join(root, '.agent-work', 'state', 'active-tasks.json') };
}

async function makeBundle(f) {
  const captured = JSON.parse(run(f.root, factoryStateCli, 'capture').stdout);
  const identity = { owner: 'worker', task: 'task', session: '2026-10-31/test', checkout: f.root };
  const manifest = {
    schemaVersion: 1,
    identity,
    candidateSha256: captured.candidateSha256,
    ownedPaths: ['code.txt'],
    authorization: { declared: true, sources: [{ path: 'source.txt', sha256: hash('authorization') }] },
    criteria: [{ id: 'criterion-1', source: 'source.txt', allowedTiers: ['local'], requiredChecks: ['check-1'] }],
  };
  const artifactBytes = 'focused check output';
  const manifestFile = join(f.session, 'manifest.json');
  const evidenceFile = join(f.session, 'evidence.json');
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(manifestFile, manifestBytes);
  const evidence = {
    schemaVersion: 1,
    identity,
    manifestSha256: hash(manifestBytes),
    candidateSha256: captured.candidateSha256,
    criteria: [
      {
        id: 'criterion-1',
        status: 'passed',
        tier: 'local',
        checks: [{ id: 'check-1', status: 'passed', command: 'node --test', exitCode: 0, artifacts: [{ path: '.agent-work/2026-10-31/test/log.txt', sha256: hash(artifactBytes) }] }],
      },
    ],
  };
  await writeFile(evidenceFile, JSON.stringify(evidence));
  return { manifestFile, evidenceFile, evidence };
}

function pin(root, bundle) {
  return run(root, activeTaskCli, 'pin-factory-handoff', '--owner', 'worker', '--task', 'task', '--manifest', bundle.manifestFile, '--evidence', bundle.evidenceFile);
}

function handoff(root, ...args) {
  return run(root, activeTaskCli, 'handoff', '--owner', 'worker', '--task', 'task', '--result', 'Checks recorded', ...args);
}

test('factory-managed handoff blocks when the coordinator has not pinned evidence', async t => {
  const f = await fixture(t);
  const before = await readFile(f.state, 'utf8');
  const result = run(f.root, activeTaskCli, 'handoff', '--owner', 'worker', '--task', 'task', '--result', 'Checks recorded');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /coordinator.*pin|pin.*manifest/i);
  assert.equal(await readFile(f.state, 'utf8'), before);
});

test('coordinator can pin complete evidence and a worker cannot replace its judging materials at handoff', async t => {
  const f = await fixture(t);
  const bundle = await makeBundle(f);
  const pinned = pin(f.root, bundle);
  assert.equal(pinned.status, 0, pinned.stderr);
  const active = JSON.parse(await readFile(f.state, 'utf8'))[0];
  assert.equal(active.status, 'active');
  assert.equal(active.factoryHandoff.manifestSha256, hash(await readFile(bundle.manifestFile)));
  assert.equal(active.factoryHandoff.evidenceSha256, hash(await readFile(bundle.evidenceFile)));

  const before = await readFile(f.state, 'utf8');
  const replacement = handoff(f.root, '--manifest', bundle.manifestFile, '--evidence', bundle.evidenceFile);
  assert.equal(replacement.status, 1);
  assert.match(replacement.stderr, /Invalid or duplicate option: --manifest/);
  assert.equal(await readFile(f.state, 'utf8'), before);

  const completed = handoff(f.root);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8'))[0].status, 'handed-off');
});

test('incomplete evidence cannot be pinned, and stale candidate or evidence blocks without registry mutation', async t => {
  const f = await fixture(t);
  const bundle = await makeBundle(f);
  bundle.evidence.criteria[0].checks = [];
  await writeFile(bundle.evidenceFile, JSON.stringify(bundle.evidence));
  const before = await readFile(f.state, 'utf8');
  const incomplete = pin(f.root, bundle);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /Evidence checks mismatch/);
  assert.equal(await readFile(f.state, 'utf8'), before);

  bundle.evidence.criteria[0].checks = [
    { id: 'check-1', status: 'passed', command: 'node --test', exitCode: 0, artifacts: [{ path: '.agent-work/2026-10-31/test/log.txt', sha256: hash('focused check output') }] },
  ];
  await writeFile(bundle.evidenceFile, JSON.stringify(bundle.evidence));
  const completePin = pin(f.root, bundle);
  assert.equal(completePin.status, 0, completePin.stderr);
  const pinnedState = await readFile(f.state, 'utf8');

  await writeFile(join(f.root, 'code.txt'), 'stale candidate');
  const staleCandidate = handoff(f.root);
  assert.equal(staleCandidate.status, 1);
  assert.match(staleCandidate.stderr, /Candidate changed/);
  assert.equal(await readFile(f.state, 'utf8'), pinnedState);

  await writeFile(join(f.root, 'code.txt'), 'candidate');
  await writeFile(bundle.evidenceFile, `${await readFile(bundle.evidenceFile, 'utf8')} `);
  const staleEvidence = handoff(f.root);
  assert.equal(staleEvidence.status, 1);
  assert.match(staleEvidence.stderr, /Evidence hash mismatch/);
  assert.equal(await readFile(f.state, 'utf8'), pinnedState);
});

test('legacy workers retain the existing handoff path', async t => {
  const f = await fixture(t, { factoryManaged: false });
  const completed = handoff(f.root);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(await readFile(f.state, 'utf8'))[0].status, 'handed-off');
});

test('reassignment preserves factory opt-in but drops identity-bound final pins', async t => {
  const f = await fixture(t);
  const bundle = await makeBundle(f);
  const pinned = pin(f.root, bundle);
  assert.equal(pinned.status, 0, pinned.stderr);
  const reassigned = run(
    f.root,
    activeTaskCli,
    'reassign',
    '--owner',
    'worker',
    '--task',
    'task',
    '--new-owner',
    'successor',
    '--session',
    '2026-10-31/successor',
    '--reason',
    'Continue the registered work',
  );
  assert.equal(reassigned.status, 0, reassigned.stderr);
  const [source, successor] = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(source.status, 'reassigned');
  assert.equal(successor.factoryManaged, true);
  assert.equal(Object.hasOwn(successor, 'factoryHandoff'), false);
});

test('malformed factory markers and pins are rejected by the CLI without rewriting the registry', async t => {
  const f = await fixture(t);
  const original = JSON.parse(await readFile(f.state, 'utf8'));
  original[0].factoryManaged = 'true';
  await writeFile(f.state, JSON.stringify(original));
  const malformedMarkerState = await readFile(f.state, 'utf8');
  const malformedMarker = handoff(f.root);
  assert.equal(malformedMarker.status, 1);
  assert.match(malformedMarker.stderr, /Invalid factory-managed assignment marker/);
  assert.equal(await readFile(f.state, 'utf8'), malformedMarkerState);

  original[0].factoryManaged = true;
  original[0].factoryHandoff = { schemaVersion: 1, manifestPath: 'relative.json', manifestSha256: 'a'.repeat(64), evidencePath: 'evidence.json', evidenceSha256: 'b'.repeat(64) };
  await writeFile(f.state, JSON.stringify(original));
  const malformedPinState = await readFile(f.state, 'utf8');
  const malformedPin = handoff(f.root);
  assert.equal(malformedPin.status, 1);
  assert.match(malformedPin.stderr, /Invalid factory handoff pin/);
  assert.equal(await readFile(f.state, 'utf8'), malformedPinState);
});

test('guarded start refuses checkout identity drift before writing an assignment', async t => {
  for (const drift of ['branch', 'head', 'dirty']) {
    await t.test(drift, async st => {
      const f = await fixture(st, { start: false });
      const expectedBranch = git(f.root, 'branch', '--show-current');
      const expectedHead = git(f.root, 'rev-parse', 'HEAD');
      if (drift === 'branch') git(f.root, 'switch', '--quiet', '--create', 'branch-after-preflight');
      if (drift === 'head') {
        await writeFile(join(f.root, 'code.txt'), 'new committed code');
        git(f.root, 'add', 'code.txt');
        git(f.root, 'commit', '--quiet', '-m', 'advance after preflight');
      }
      if (drift === 'dirty') await writeFile(join(f.root, 'code.txt'), 'dirty after preflight');

      const result = run(
        f.root,
        activeTaskCli,
        'start',
        '--owner',
        'worker',
        '--task',
        'task',
        '--session',
        '2026-11-01/test',
        '--role',
        'worker',
        '--summary',
        'guarded start',
        '--next',
        'test expected identity',
        '--owned-path',
        'code.txt',
        '--factory-managed',
        '--expected-branch',
        expectedBranch,
        '--expected-head',
        expectedHead,
        '--require-clean',
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, drift === 'branch' ? /--expected-branch/i : drift === 'head' ? /--expected-head/i : /clean checkout/i);
      await assert.rejects(readFile(f.state), { code: 'ENOENT' });
    });
  }
});
