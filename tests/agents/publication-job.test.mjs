import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicationJob, runPublicationJob } from '../../scripts/agents/publication-job.mjs';
import { runWorkflow } from '../../scripts/agents/pr-workflow.mjs';
import { checkout } from './support/pr-workflow-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'publication-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'feat/tooling-example');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(resolve(root, '.gitignore'), '.agent-work/\nbody.md\n');
  git('add', '.gitignore'); git('commit', '-m', 'fixture');
  await writeFile(resolve(root, 'body.md'), 'original body');
  const args = ['--root', root];
  const start = extra => publicationJob(['start', ...args, '--body-file', resolve(root, 'body.md'), '--summary', 'add example', ...(extra ?? [])], { launch: async () => 1234 });
  const status = id => publicationJob(['status', ...args, '--id', id]);
  return { root, git, start, status };
}

test('retained job freezes body and candidate; duplicate starts cannot launch another gate', async t => {
  const f = await fixture(t);
  const job = await f.start(['--skip-review-request']);
  assert.equal(job.status, 'STARTED');
  assert.match(job.next, /Yield now/);
  await assert.rejects(f.start(), /unfinished/);
  await writeFile(resolve(f.root, 'body.md'), 'edited after launch');
  let calls = 0;
  const result = await runPublicationJob(f.root, job.id, { workflow: async (args, options) => {
    calls++;
    assert.deepEqual(options.expectedCandidate, { head: job.head, branch: job.branch });
    assert.equal(args[0], 'publish');
    assert.ok(args.includes('--skip-review-request'));
    assert.ok(!args.includes('--mode'));
    assert.equal(await readFile(args[args.indexOf('--body-file') + 1], 'utf8'), 'original body');
    return { publishedHead: job.head, status: 'PUBLISHED' };
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal((await f.status(job.id)).result.publishedHead, job.head);
  await assert.rejects(runPublicationJob(f.root, job.id), /state mismatch/);
});

test('candidate change during initial live reads refuses before gates or remote writes', async t => {
  const f = await checkout(t);
  const expectedCandidate = { head: f.e.head, branch: f.e.pr.headRefName };
  let changed = false;
  const execute = (binary, args) => {
    if (!changed && binary === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      changed = true;
      const result = spawnSync('git', ['commit', '--allow-empty', '-m', 'concurrent change'], { cwd: f.root, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
    return f.execute(binary, args);
  };
  await assert.rejects(runWorkflow(['publish', '--root', f.root, '--body-file', f.body, '--summary', 'add example'], { execute, expectedCandidate }), /Checkout changed since job launch/);
  assert.equal(changed, true);
  assert.equal(f.calls.some(([binary, ...args]) => binary === process.execPath || binary === 'git' && args[0] === 'push' || binary === 'gh' && ['create', 'edit', 'comment'].includes(args[1])), false);
});

test('oversized body is refused before launching a job', async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.root, 'body.md'), Buffer.alloc(65_537, 65));
  await assert.rejects(f.start(), /65536 bytes/);
});

test('changed candidate refuses publication before any workflow effect', async t => {
  const f = await fixture(t);
  const job = await f.start();
  f.git('commit', '--allow-empty', '-m', 'changed');
  let called = false;
  const result = await runPublicationJob(f.root, job.id, { workflow: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.status, 'FAILED');
  assert.match(result.error, /Checkout changed/);
  assert.equal((await f.status(job.id)).status, 'FAILED');
});

test('launch and gate failures are retained without claiming success', async t => {
  const f = await fixture(t);
  await assert.rejects(publicationJob(['start', '--root', f.root, '--body-file', resolve(f.root, 'body.md'), '--summary', 'add example'], { launch: async () => { throw Error('spawn failed'); } }), /spawn failed/);
  const job = await f.start();
  const result = await runPublicationJob(f.root, job.id, { workflow: async () => { throw Error('gate failed'); } });
  assert.equal(result.status, 'FAILED');
  assert.equal((await f.status(job.id)).error, 'gate failed');
  assert.equal(result.result, undefined);
});

test('invalid options and dirty checkout refuse before launch', async t => {
  const f = await fixture(t);
  await assert.rejects(publicationJob(['status', '--root', f.root, '--id', '../escape']), /Invalid job/);
  await assert.rejects(publicationJob(['start', '--root', f.root, '--mode', 'push-only']), /Unknown option/);
  await writeFile(resolve(f.root, 'dirty.txt'), 'dirty');
  await assert.rejects(f.start(), /Commit scoped changes/);
});

test('detached child survives launcher exit and retains its completion output', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const marker = resolve(f.root, '.agent-work', 'detached-marker');
  const job = await f.start();
  const module = pathToFileURL(resolve('scripts/agents/publication-job.mjs')).href;
  const child = `import {writeFile} from 'node:fs/promises'; setTimeout(async()=>{console.log('completed');await writeFile(${JSON.stringify(marker)},'complete');},500);`;
  const parent = `import {launchDetached} from ${JSON.stringify(module)};await launchDetached(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{cwd:${JSON.stringify(f.root)},log:${JSON.stringify(job.log)}});`;
  const launched = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(launched.status, 0, launched.stderr);
  const deadline = Date.now() + 5000;
  let content;
  while (Date.now() < deadline) {
    try { content = await readFile(marker, 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(done => setTimeout(done, 50));
  }
  assert.equal(content, 'complete');
  assert.match(await readFile(job.log, 'utf8'), /completed/);
});
