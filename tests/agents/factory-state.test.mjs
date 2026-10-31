import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const cli = resolve('scripts/agents/factory-state.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function run(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
  return { ...result, json: JSON.parse(result.stdout) };
}
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'factory-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
  await mkdir(join(root, 'context'));
  await writeFile(join(root, 'context', 'active_task.md'), '# Active task\n');
  await writeFile(join(root, 'source.txt'), 'authorization');
  await writeFile(join(root, 'code.txt'), 'baseline');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  await writeFile(join(root, 'code.txt'), 'dirty candidate');
  await mkdir(join(root, '.agent-work', 'state'), { recursive: true });
  await writeFile(join(root, '.git', 'info', 'exclude'), '.agent-work/\n');
  const identity = { owner: 'worker', task: 'task', session: '2026-10-31/test', checkout: root };
  const taskCli = resolve('scripts/agents/active-task.mjs');
  const started = spawnSync(process.execPath, [taskCli, 'start', '--root', root, '--owner', 'worker', '--task', 'task', '--session', identity.session, '--role', 'worker', '--summary', 'fixture', '--next', 'test', '--owned-path', 'code.txt'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const state = join(root, '.agent-work', 'state', 'active-tasks.json');
  const registry = JSON.parse(await readFile(state, 'utf8'));
  const candidateSha256 = run(root, 'capture').json.candidateSha256;
  const manifest = { schemaVersion: 1, identity, candidateSha256, ownedPaths: ['code.txt'], authorization: { declared: true, sources: [{ path: 'source.txt', sha256: hash('authorization') }] }, criteria: [{ id: 'criterion', source: 'source.txt', allowedTiers: ['local'], requiredChecks: ['test'] }] };
  const manifestFile = join(root, '.agent-work', 'manifest.json');
  const evidenceFile = join(root, '.agent-work', 'evidence.json');
  const save = async () => { const bytes = JSON.stringify(manifest); await writeFile(manifestFile, bytes); return hash(bytes); };
  const digest = await save();
  await writeFile(join(root, '.agent-work', 'log.txt'), 'test output');
  const artifact = { path: '.agent-work/log.txt', sha256: hash('test output') };
  const evidence = { schemaVersion: 1, manifestSha256: digest, candidateSha256, identity, criteria: [{ id: 'criterion', status: 'passed', tier: 'local', checks: [{ id: 'test', status: 'passed', command: 'node --test', exitCode: 0, artifacts: [artifact] }] }] };
  await writeFile(evidenceFile, JSON.stringify(evidence));
  const check = async (mode = 'handoff', expected = digest, evidenceHash) => run(root, 'check', '--mode', mode, '--manifest', manifestFile, '--manifest-sha256', expected, '--evidence', evidenceFile, '--evidence-sha256', evidenceHash ?? hash(await readFile(evidenceFile)));
  return { root, state, registry, manifest, evidence, evidenceFile, save, check };
}

test('valid bound dispatch and handoff; refusal leaves registry unchanged', async (t) => {
  const f = await fixture(t); const before = await readFile(f.state, 'utf8');
  assert.equal((await f.check('dispatch')).json.status, 'pass');
  assert.equal((await f.check()).json.status, 'pass');
  f.evidence.criteria[0].checks[0].status = 'skipped'; await writeFile(f.evidenceFile, JSON.stringify(f.evidence));
  assert.equal((await f.check()).json.status, 'blocked'); assert.equal(await readFile(f.state, 'utf8'), before);
});

test('fails closed for stale candidate, criteria, authorization and identities', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'code.txt'), 'changed'); assert.match((await f.check()).json.reasons[0], /Candidate changed/);
  await writeFile(join(f.root, 'code.txt'), 'dirty candidate');
  f.manifest.criteria[0].requiredChecks.push('other'); const changed = await f.save();
  assert.match((await f.check('handoff', changed)).json.reasons[0], /Evidence binding mismatch/);
  f.evidence.manifestSha256 = changed; await writeFile(f.evidenceFile, JSON.stringify(f.evidence));
  assert.match((await f.check('handoff', changed)).json.reasons[0], /Evidence checks mismatch/);
  f.manifest.authorization.declared = false; const unauthorized = await f.save(); assert.equal((await f.check('dispatch', unauthorized)).json.status, 'blocked');
  f.manifest.authorization.declared = true; f.manifest.identity.owner = 'impostor'; const wrong = await f.save(); assert.match((await f.check('dispatch', wrong)).json.reasons[0], /Assignment missing/);
  f.manifest.identity.owner = 'worker'; const restored = await f.save();
  await writeFile(join(f.root, 'source.txt'), 'changed source'); assert.match((await f.check('dispatch', restored)).json.reasons[0], /Authorization source changed/);
});

test('rejects conflicting ownership and missing, wrong-tier, or wrong-candidate evidence', async (t) => {
  const f = await fixture(t);
  f.registry.push({ ...f.registry[0], owner: 'other', task: 'other', ownedPaths: ['code.txt'] }); await writeFile(f.state, JSON.stringify(f.registry));
  assert.match((await f.check('dispatch')).json.reasons[0], /Conflicting ownership/);
  f.registry.pop(); await writeFile(f.state, JSON.stringify(f.registry));
  f.evidence.criteria = []; await writeFile(f.evidenceFile, JSON.stringify(f.evidence)); assert.match((await f.check()).json.reasons[0], /Evidence criteria mismatch/);
  f.evidence.criteria = [{ id: 'criterion', status: 'passed', tier: 'production', checks: [] }]; await writeFile(f.evidenceFile, JSON.stringify(f.evidence)); assert.match((await f.check()).json.reasons[0], /invalid criterion evidence/);
  f.evidence.criteria[0].tier = 'local'; f.evidence.candidateSha256 = '0'.repeat(64); await writeFile(f.evidenceFile, JSON.stringify(f.evidence)); assert.equal((await f.check()).json.status, 'blocked');
});

test('rejects tampered evidence and artifact bytes', async (t) => {
  const f = await fixture(t);
  assert.match((await f.check('handoff', undefined, '0'.repeat(64))).json.reasons[0], /Evidence hash mismatch/);
  await writeFile(join(f.root, '.agent-work', 'log.txt'), 'tampered');
  assert.match((await f.check()).json.reasons[0], /Invalid artifact/);
});
