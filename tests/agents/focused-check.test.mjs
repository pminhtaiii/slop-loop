import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cli = resolve(project, 'scripts/agents/focused-check.mjs');

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'focused-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=feat/focused-check');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(resolve(root, '.gitignore'), '.agent-work/\n');
  await writeFile(resolve(root, 'spec.md'), 'approved focused check input\n');
  git('add', '.gitignore', 'spec.md');
  git('commit', '--quiet', '-m', 'fixture');
  return { root, git };
}

function invoke(root, mode, command = [process.execPath, '-e', "console.log('focused stdout');console.error('focused stderr')"]) {
  return spawnSync(process.execPath, [
    cli, mode, '--root', root, '--receipt', '.agent-work/2026-10-31/focused-check.json',
    '--input', 'spec.md', '--', ...command,
  ], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
}

test('first focused run captures both output streams and a receipt that verify can reuse', async t => {
  const f = await fixture(t);
  const marker = resolve(f.root, '.agent-work/2026-10-31/ran.txt');
  const command = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');console.log('focused stdout');console.error('focused stderr')`];
  const run = invoke(f.root, 'run', command);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'CAPTURED');
  assert.equal(report.outcome, 'passed');
  const receiptPath = resolve(f.root, '.agent-work/2026-10-31/focused-check.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(receipt.gate.exitCode, 0);
  assert.equal(receipt.output.capture, 'combined stdout/stderr');
  const log = await readFile(resolve(f.root, receipt.output.log), 'utf8');
  assert.match(log, /focused stdout/);
  assert.match(log, /focused stderr/);

  const reused = invoke(f.root, 'verify', command);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).status, 'REUSED');
  assert.equal(await readFile(marker, 'utf8'), 'x', 'verify reports reuse without executing the command again');
});

test('focused receipt verify rejects changed inputs and output artifacts', async t => {
  const f = await fixture(t);
  assert.equal(invoke(f.root, 'run').status, 0);
  let result = invoke(f.root, 'verify', [process.execPath, '-e', "console.log('different command')"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /command changed/i);
  await writeFile(resolve(f.root, 'spec.md'), 'changed input\n');
  result = invoke(f.root, 'verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate|input/i);
  await writeFile(resolve(f.root, 'spec.md'), 'approved focused check input\n');
  const receipt = JSON.parse(await readFile(resolve(f.root, '.agent-work/2026-10-31/focused-check.json'), 'utf8'));
  await writeFile(resolve(f.root, receipt.output.log), 'tampered output\n');
  result = invoke(f.root, 'verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /log|output/i);
  receipt.candidateSha256 = '0'.repeat(64);
  await writeFile(resolve(f.root, '.agent-work/2026-10-31/focused-check.json'), JSON.stringify(receipt));
  result = invoke(f.root, 'verify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /receipt digest/i);
});

test('failed first execution retains output and a non-reusable receipt', async t => {
  const f = await fixture(t);
  const run = invoke(f.root, 'run', [process.execPath, '-e', "console.log('before failure');console.error('failure detail');process.exitCode=7"]);
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'CAPTURED');
  assert.equal(report.outcome, 'failed');
  const receipt = JSON.parse(await readFile(resolve(f.root, '.agent-work/2026-10-31/focused-check.json'), 'utf8'));
  assert.equal(receipt.gate.exitCode, 7);
  assert.match(await readFile(resolve(f.root, receipt.output.log), 'utf8'), /failure detail/);
  const verify = invoke(f.root, 'verify', [process.execPath, '-e', "console.log('before failure');console.error('failure detail');process.exitCode=7"]);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /passed|failed|reusable/i);
});
