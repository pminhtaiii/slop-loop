import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { recordVerificationReceipt, verificationSummary, verifyVerificationReceipt } from '../../scripts/agents/verification-receipt.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verification-receipt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Verification Tests');
  git('config', 'user.email', 'verification@example.invalid');
  await writeFile(join(root, '.gitignore'), '.agent-work/\n');
  await writeFile(join(root, 'brief.md'), 'Criterion C1: deny stale approval.\n');
  await writeFile(join(root, 'source.mjs'), 'export const result = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'candidate');
  git('switch', '--quiet', '-c', 'feat/tooling-verification');
  const head = git('rev-parse', 'HEAD');
  await mkdir(join(root, '.agent-work/state'), { recursive: true });
  const coordinator = { owner: 'coordinator', agentId: '/root' };
  const implementers = [{ owner: 'implementer', agentId: '/root/worker' }];
  const merger = { owner: 'merger', task: 'verify', session: '2026-11-10/fixture', agentId: '/root/merger' };
  const registry = [
    { owner: coordinator.owner, task: 'batch', role: 'coordinator', status: 'active', checkout: root, session: merger.session },
    {
      owner: merger.owner,
      task: merger.task,
      session: merger.session,
      role: 'worker',
      status: 'active',
      checkout: root,
      binding: {
        schemaVersion: 1,
        identity: { owner: merger.owner, task: merger.task, session: merger.session },
        checkout: root,
        repository: resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir')),
        branch: 'refs/heads/feat/tooling-verification',
        base: { ref: 'existing-checkout', sha: head },
        boundAt: new Date().toISOString(),
      },
    },
  ];
  const registryPath = join(root, '.agent-work/state/active-tasks.json');
  await writeFile(registryPath, JSON.stringify(registry));
  const source = { path: 'brief.md', sha256: digest(await readFile(join(root, 'brief.md'))) };
  const input = { path: 'source.mjs', sha256: digest(await readFile(join(root, 'source.mjs'))) };
  const artifact = { path: '.agent-work/result.log', sha256: digest('expected denial; observed denial\n') };
  await writeFile(join(root, artifact.path), 'expected denial; observed denial\n');
  const manifest = {
    schemaVersion: 1,
    head,
    coordinator,
    implementers,
    merger,
    sources: [source],
    inputs: [input],
    criteria: [{ id: 'C1', source: 'brief.md', expected: 'Stale approval is denied.', allowedTiers: ['controlled'], requiredChecks: ['denial'] }],
  };
  const receipt = {
    schemaVersion: 1,
    head,
    criteria: [
      {
        id: 'C1',
        status: 'passed',
        tier: 'controlled',
        observed: 'Stale approval denied.',
        checks: [{ id: 'denial', status: 'passed', command: 'node --test denial.test.mjs', exitCode: 0, artifacts: [artifact] }],
      },
    ],
  };
  const manifestPath = '.agent-work/manifest.json',
    receiptPath = '.agent-work/receipt.json';
  const save = async () => {
    const bytes = JSON.stringify(manifest);
    const manifestSha256 = digest(bytes);
    receipt.manifestSha256 = manifestSha256;
    await writeFile(join(root, manifestPath), bytes);
    await writeFile(join(root, receiptPath), JSON.stringify(receipt));
    return { root, git, manifestPath, manifestSha256, receiptPath };
  };
  return { root, git, head, manifest, receipt, artifact, registry, registryPath, save };
}

test('records independent merger evidence and derives criterion results from retained receipts', async t => {
  const f = await fixture(t);
  const verification = await recordVerificationReceipt(await f.save());
  assert.equal(verification.head, f.head);
  assert.equal(verificationSummary(verification).status, 'passed');
  assert.equal((await verifyVerificationReceipt({ root: f.root, git: f.git, verification })).status, 'passed');
});

test('old evidence cannot approve a new commit or a dirty checkout', async t => {
  const f = await fixture(t);
  const verification = await recordVerificationReceipt(await f.save());
  await writeFile(join(f.root, 'source.mjs'), 'export const result = 2;\n');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /clean/);
  f.git('add', 'source.mjs');
  f.git('commit', '--quiet', '-m', 'new candidate');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /candidate|head/i);
});

test('completion rechecks immutable manifests, receipts and evidence artifacts', async t => {
  const f = await fixture(t);
  const verification = await recordVerificationReceipt(await f.save());
  const path = join(f.root, f.artifact.path);
  await writeFile(path, 'changed claim\n');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /artifact|hash/i);
  await writeFile(path, 'expected denial; observed denial\n');
  await writeFile(join(f.root, '.agent-work/receipt.json'), JSON.stringify({ ...f.receipt, criteria: [] }));
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /receipt.*hash/i);
  await f.save();
  await writeFile(join(f.root, '.agent-work/manifest.json'), '{}');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /manifest.*hash/i);
});

test('merger must be registered, bound and distinct from coordinator and implementers', async t => {
  const f = await fixture(t);
  for (const field of ['owner', 'agentId']) {
    const original = f.manifest.merger[field];
    for (const other of [f.manifest.coordinator, ...f.manifest.implementers]) {
      f.manifest.merger[field] = other[field];
      await assert.rejects(recordVerificationReceipt(await f.save()), /distinct/);
    }
    f.manifest.merger[field] = original;
  }
  await writeFile(f.registryPath, JSON.stringify([f.registry[0]]));
  await assert.rejects(recordVerificationReceipt(await f.save()), /registered merger/i);
});

test('missing and inconclusive criteria remain incomplete and cannot approve completion', async t => {
  const f = await fixture(t);
  f.receipt.criteria = [];
  let verification = await recordVerificationReceipt(await f.save());
  assert.equal(verificationSummary(verification).status, 'incomplete');
  assert.equal(verificationSummary(verification).criteria[0].status, 'not-run');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /incomplete/);
  f.receipt.criteria = [{ id: 'C1', status: 'blocked', tier: 'controlled', observed: 'Local timeout; exact-head CI pending.', checks: [] }];
  verification = await recordVerificationReceipt(await f.save());
  assert.equal(verificationSummary(verification).criteria[0].status, 'blocked');
  await assert.rejects(verifyVerificationReceipt({ root: f.root, git: f.git, verification }), /incomplete/);
});

test('claimed passes require all declared checks and retained passing artifacts', async t => {
  const f = await fixture(t);
  const check = f.receipt.criteria[0].checks[0];
  f.receipt.criteria[0].checks = [];
  await assert.rejects(recordVerificationReceipt(await f.save()), /required checks/);
  f.receipt.criteria[0].checks = [check];
  check.exitCode = 1;
  await assert.rejects(recordVerificationReceipt(await f.save()), /passing check/);
  check.exitCode = 0;
  f.receipt.criteria[0].tier = 'real';
  await assert.rejects(recordVerificationReceipt(await f.save()), /tier/);
});

test('rejects traversal and linked evidence without following it outside the checkout', async t => {
  const f = await fixture(t);
  f.artifact.path = '../outside.log';
  await assert.rejects(recordVerificationReceipt(await f.save()), /Unsafe/);
  const link = join(f.root, '.agent-work/linked');
  await symlink(tmpdir(), link, 'junction');
  f.artifact.path = '.agent-work/linked/outside.log';
  await assert.rejects(recordVerificationReceipt(await f.save()), /linked|regular/);
});
