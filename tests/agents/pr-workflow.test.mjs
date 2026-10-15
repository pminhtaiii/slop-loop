import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, changedLines, runWorkflow } from '../../scripts/agents/pr-workflow.mjs';

function evidence() {
  return {
    head: 'abc',
    pr: { state: 'OPEN', headRefOid: 'abc', headRefName: 'feat/001-example', title: 'feat/001-example', baseRefName: 'development', reviewDecision: 'APPROVED',
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ author: { login: 'coderabbitai', __typename: 'Bot' }, state: 'APPROVED', commit: { oid: 'abc' } }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } },
    checks: ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)'].map((name, id) => ({ id, name, head_sha: 'abc', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } })),
  };
}

test('only current-head CI and CodeRabbit approval make a PR ready for human approval', () => {
  const e = evidence();
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.nodes[0].commit.oid = 'old';
  assert.equal(assess(e).status, 'WAITING_REVIEW');
  e.pr.reviews.nodes = [];
  assert.equal(assess(e).status, 'WAITING_REVIEW');
});

test('merge and unknown commands are rejected before executing anything', async () => {
  let called = false;
  await assert.rejects(runWorkflow(['merge'], { execute() { called = true; } }), /Usage/);
  assert.equal(called, false);
});

test('failed, missing, skipped, spoofed, or superseded CI cannot be accepted', () => {
  for (const conclusion of ['failure', 'skipped', 'cancelled', 'neutral']) {
    const e = evidence(); e.checks[0].conclusion = conclusion;
    assert.equal(assess(e).status, 'NEEDS_FIX');
  }
  const e = evidence();
  e.checks[0].app.slug = 'another-app';
  assert.equal(assess(e).status, 'WAITING_CI');
  e.checks[0].app.slug = 'github-actions';
  e.checks[0].head_sha = 'old';
  assert.equal(assess(e).status, 'WAITING_CI');
  e.checks[0].head_sha = 'abc';
  e.checks.push({ ...e.checks[0], id: 99, status: 'in_progress', conclusion: null });
  assert.equal(assess(e).status, 'WAITING_CI');
});

test('unresolved, stale, spoofed, incomplete, or mismatched review evidence blocks readiness', () => {
  const e = evidence();
  e.pr.reviewThreads.nodes.push({ id: 'thread', isResolved: false, isOutdated: true });
  assert.equal(assess(e).status, 'NEEDS_FIX');
  e.pr.reviewThreads.nodes = [];
  e.pr.reviews.nodes[0].author.__typename = 'User';
  assert.equal(assess(e).status, 'WAITING_REVIEW');
  e.pr.reviews.pageInfo.hasPreviousPage = true;
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.reviews.pageInfo.hasPreviousPage = false;
  e.pr.headRefOid = 'different';
  assert.equal(assess(e).status, 'BLOCKED');
});

test('PR sizing reports generated changes and binaries separately without hiding them', () => {
  assert.deepEqual(changedLines('700\t400\tsrc/code.ts\n200\t100\tpackage-lock.json\n-\t-\tasset.png\n'), { reviewable: 1100, generated: 300, binaries: 1, overTarget: true });
});

async function checkout(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-workflow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--quiet'); git('config', 'user.name', 'Tests'); git('config', 'user.email', 'tests@example.invalid');
  await writeFile(join(root, '.gitignore'), '.agent-work/\n');
  git('add', '.gitignore'); git('commit', '--quiet', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/development', 'HEAD');
  git('checkout', '--quiet', '-b', 'feat/001-example');
  git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  await writeFile(join(root, 'change.md'), 'change\n'); git('add', 'change.md'); git('commit', '--quiet', '-m', 'feature');
  await mkdir(join(root, '.agent-work'));
  const body = join(root, '.agent-work/body.md'); await writeFile(body, 'Summary and verification');
  const head = git('rev-parse', 'HEAD');
  const e = evidence(); e.head = head; e.pr.headRefOid = head; e.pr.reviews.nodes[0].commit.oid = head;
  for (const check of e.checks) check.head_sha = head;
  Object.assign(e.pr, { number: 1, url: 'https://github.com/example/project/pull/1', isDraft: true });
  let created = false, failGate = false;
  const comments = [];
  const calls = [];
  const execute = (binary, args, cwd) => {
    calls.push([binary, ...args]);
    if (binary === process.execPath) { if (failGate) throw new Error('Local gate failed'); return 'passed'; }
    if (binary === 'git') { if (['fetch', 'push'].includes(args[0])) return ''; return git(...args); }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(created ? [{ ...e.pr }] : []);
    if (args[0] === 'pr' && args[1] === 'create') { created = true; return e.pr.url; }
    if (args[0] === 'pr' && args[1] === 'ready') { e.pr.isDraft = false; return ''; }
    if (args[0] === 'pr' && args[1] === 'comment') { comments.push({ body: args[args.indexOf('--body') + 1] }); return ''; }
    if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: e.pr } } });
    if (args[0] === 'api' && args.at(-1).includes('/comments?')) return JSON.stringify([comments]);
    if (args[0] === 'api') return JSON.stringify([{ check_runs: e.checks }]);
    return '';
  };
  const run = (...args) => runWorkflow([...args, '--root', root], { execute });
  return { root, body, e, calls, run, execute, fail: () => { failGate = true; } };
}

test('publishing is gated and repeatable; repair count survives new publishes and stops at three', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  await f.run('publish', '--body-file', f.body);
  assert.equal(f.calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment').length, 1);
  const savedPath = join(f.root, '.agent-work/pr-workflow/001-example.json');
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  delete saved.requestedReviewHead;
  await writeFile(savedPath, JSON.stringify(saved));
  await f.run('publish', '--body-file', f.body);
  assert.equal(f.calls.filter((call) => call[0] === 'gh' && call[2] === 'comment').length, 1, 'recover a successful comment response without a duplicate request');
  assert.equal((await f.run('ready')).status, 'AWAITING_HUMAN_MERGE');
  assert.equal((await f.run('status')).status, 'AWAITING_HUMAN_MERGE');
  assert.equal(f.calls.some((call) => call.includes('merge') || call.includes('--force')), false);
  f.e.pr.reviewThreads.nodes = [{ id: 'finding', isResolved: false }];
  for (let round = 0; round < 3; round++) await f.run('repair', '--reason', `Diagnosed round ${round + 1}`);
  await f.run('publish', '--body-file', f.body);
  assert.equal((await f.run('status')).status, 'BLOCKED');
  await assert.rejects(f.run('repair', '--reason', 'fourth'), /BLOCKED/);
  const record = JSON.parse(await readFile(join(f.root, '.agent-work/pr-workflow/001-example.json'), 'utf8'));
  assert.equal(record.repairRounds.length, 3);
});

test('a failed local gate never pushes or opens a PR', async (t) => {
  const f = await checkout(t); f.fail();
  await assert.rejects(f.run('publish', '--body-file', f.body), /Local gate failed/);
  assert.equal(f.calls.some((call) => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[2] === 'create'), false);
});

test('additional required reviews and non-draft merge blockers prevent readiness', () => {
  const e = evidence();
  e.pr.reviewDecision = 'REVIEW_REQUIRED';
  assert.equal(assess(e).status, 'WAITING_REVIEW');
  e.pr.reviewDecision = 'APPROVED';
  e.pr.mergeStateStatus = 'BLOCKED';
  e.pr.isDraft = false;
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.isDraft = true;
  assert.equal(assess(e).status, 'READY_FOR_HUMAN', 'a validated draft may move to ready, but cannot be merged by this helper');
});

test('missing accounting fails closed instead of granting a fresh budget to an existing PR', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  const record = join(f.root, '.agent-work/pr-workflow/001-example.json');
  await rm(record);
  for (const command of ['status', 'ready']) await assert.rejects(f.run(command), /Missing PR accounting/);
  await assert.rejects(f.run('repair', '--reason', 'try again'), /Missing PR accounting/);
  await assert.rejects(f.run('publish', '--body-file', f.body), /no local accounting/);
  assert.equal(f.calls.filter((call) => call[0] === 'gh' && call[2] === 'create').length, 1);
});

test('watch caps every observation and sleep to the remaining ten-minute deadline', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  f.e.checks[0].status = 'in_progress';
  let clock = 0;
  const result = await runWorkflow(['watch', '--root', f.root], {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    report: () => {},
    execute(binary, args, cwd, timeout) {
      if (binary === 'gh') clock += Math.min(timeout, 80_000);
      return f.execute(binary, args, cwd, timeout);
    },
  });
  assert.equal(result.status, 'TIMED_OUT');
  assert.ok(clock <= 600_000, `watch spent ${clock}ms`);
});
