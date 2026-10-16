import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, changedLines, runWorkflow, workflowSummary } from '../../scripts/agents/pr-workflow.mjs';

function evidence() {
  return {
    head: 'abc',
    pr: { state: 'OPEN', headRefOid: 'abc', headRefName: 'feat/001-example', title: 'feat/001-example: add the example workflow', baseRefName: 'development', reviewDecision: 'APPROVED',
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [{ author: { login: 'coderabbitai', __typename: 'Bot' }, state: 'APPROVED', commit: { oid: 'abc' } }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } },
    checks: ['contributor-checks (ubuntu-latest)', 'contributor-checks (windows-latest)', 'runtime-checks (ubuntu-latest)', 'runtime-checks (windows-latest)'].map((name, id) => ({ id, name, head_sha: 'abc', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } })),
  };
}

test('current-head CI allows human review without CodeRabbit approval', () => {
  const e = evidence();
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.nodes[0].commit.oid = 'old';
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.nodes = [];
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
});

test('merge and unknown commands are rejected before executing anything', async () => {
  let called = false;
  await assert.rejects(runWorkflow(['merge'], { execute() { called = true; } }), /Usage/);
  assert.equal(called, false);
});

test('PR titles require their branch prefix and a short summary', () => {
  const e = evidence();
  e.pr.title = `${e.pr.headRefName}: add the example workflow`;
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  for (const title of [e.pr.headRefName, `${e.pr.headRefName}: `, 'feat/002-other: summary', `${e.pr.headRefName}: ${'x'.repeat(81)}`, `${e.pr.headRefName}: two\nlines`]) {
    e.pr.title = title;
    assert.equal(assess(e).status, 'BLOCKED', title);
  }
});

test('publishing rejects missing or invalid summaries before executing commands', async () => {
  let called = false;
  for (const args of [[], ['--summary', ' '], ['--summary', 'x'.repeat(81)], ['--summary', 'two\nlines']]) {
    await assert.rejects(runWorkflow(['publish', '--body-file', 'body.md', ...args], { execute() { called = true; } }), /summary/);
  }
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

test('unresolved comments remain visible and advisory while incomplete or mismatched evidence blocks', () => {
  const e = evidence();
  e.pr.reviewThreads.nodes.push({ id: 'thread', isResolved: false, isOutdated: true });
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  assert.equal(assess(e).unresolved[0].id, 'thread');
  e.pr.reviewThreads.nodes = [];
  e.pr.reviews.nodes[0].author.__typename = 'User';
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviews.pageInfo.hasPreviousPage = true;
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.reviews.pageInfo.hasPreviousPage = false;
  e.pr.headRefOid = 'different';
  assert.equal(assess(e).status, 'BLOCKED');
  const waiting = evidence();
  waiting.pr.reviews.nodes[0].commit.oid = 'old';
  waiting.pr.reviewDecision = 'CHANGES_REQUESTED';
  waiting.pr.reviewThreads.nodes = [{ id: 'old-finding', isResolved: false }];
  assert.equal(assess(waiting).status, 'READY_FOR_HUMAN', 'comments are advisory under the human merge policy');
});

test('PR sizing reports generated changes and binaries separately without hiding them', () => {
  assert.deepEqual(changedLines('700\t400\tsrc/code.ts\n200\t100\tpackage-lock.json\n-\t-\tasset.png\n'), { reviewable: 1100, generated: 300, binaries: 1, overTarget: true });
});

test('routine summaries expose comments and log paths without historical command output', () => {
  const summary = workflowSummary({ schemaVersion: 1, repairRounds: [], localVerification: { head: 'abc', tests: 'private lengthy test transcript' }, gateLogs: { tests: { status: 'passed', log: 'tests.log', exitCode: 0, summary: 'lengthy output' } }, observation: { unresolved: [{ id: 'thread', isOutdated: false, comments: { nodes: [{ url: 'https://example.invalid/comment', body: 'lengthy comment' }] } }] } });
  assert.equal(summary.localVerifiedHead, 'abc');
  assert.equal(summary.logs.tests.log, 'tests.log');
  assert.equal(summary.unresolved[0].id, 'thread');
  assert.doesNotMatch(JSON.stringify(summary), /lengthy/);
  assert.equal(workflowSummary({ schemaVersion: 1, repairRounds: [], observation: { reason: 'Update the feature branch against development.' } }).reason, 'Update the feature branch against development.');
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
    if (binary === 'git') {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'push') { e.pr.headRefOid = git('rev-parse', 'HEAD'); for (const check of e.checks) check.head_sha = e.pr.headRefOid; return ''; }
      return git(...args);
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(created && e.pr.state === 'OPEN' ? [{ ...e.pr }] : []);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(e.pr);
    if (args[0] === 'pr' && args[1] === 'create') { created = true; return e.pr.url; }
    if (args[0] === 'pr' && args[1] === 'ready') { e.pr.isDraft = false; return ''; }
    if (args[0] === 'pr' && args[1] === 'comment') { comments.push({ body: args[args.indexOf('--body') + 1] }); return ''; }
    if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: e.pr } } });
    if (args[0] === 'api' && args.at(-1).includes('/comments?')) return JSON.stringify([comments]);
    if (args[0] === 'api') return JSON.stringify([{ check_runs: e.checks }]);
    return '';
  };
  const run = (...args) => runWorkflow([...args, ...(args[0] === 'publish' ? ['--summary', 'add the example workflow'] : []), '--root', root], { execute });
  let revision = 0;
  const advance = async () => { await writeFile(join(root, 'change.md'), `repair ${++revision}\n`); git('add', 'change.md'); git('commit', '--quiet', '-m', `repair ${revision}`); };
  return { root, body, e, calls, run, execute, advance, fail: () => { failGate = true; } };
}

test('publish rejects tracked dependencies before tests, push, or PR creation', async (t) => {
  const f = await checkout(t);
  await mkdir(join(f.root, 'node_modules/lib'), { recursive: true });
  await writeFile(join(f.root, 'node_modules/lib/index.js'), 'export {};\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git('add', 'node_modules');
  git('commit', '--quiet', '-m', 'accidental dependencies');
  await assert.rejects(f.run('publish', '--body-file', f.body), /Installed dependencies must remain untracked/);
  assert.equal(f.calls.some((call) => call[0] === process.execPath || call[0] === 'gh' || call[1] === 'push'), false);
});

test('publishing is gated and repeatable; repair count survives new publishes and stops at three', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  await f.run('publish', '--body-file', f.body);
  assert.equal(f.calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 1);
  for (const call of f.calls.filter((call) => call[0] === 'gh' && call[1] === 'pr' && ['create', 'edit'].includes(call[2]))) {
    assert.equal(call[call.indexOf('--title') + 1], 'feat/001-example: add the example workflow');
  }
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
  await f.run('repair', '--reason', 'Diagnosed round 1');
  await assert.rejects(f.run('repair', '--reason', 'duplicate command'), /already reserved/);
  for (let round = 1; round < 3; round++) {
    await f.advance();
    await f.run('publish', '--body-file', f.body);
    assert.equal((await f.run('status')).status, 'AWAITING_HUMAN_MERGE');
    f.e.pr.reviews.nodes[0].commit.oid = f.e.pr.headRefOid;
    await f.run('repair', '--reason', `Diagnosed round ${round + 1}`);
  }
  assert.equal((await f.run('status')).status, 'AWAITING_HUMAN_MERGE', 'advisory comments do not block human review');
  await f.advance();
  await f.run('publish', '--body-file', f.body);
  f.e.pr.reviews.nodes[0].commit.oid = f.e.pr.headRefOid;
  assert.equal((await f.run('status')).status, 'AWAITING_HUMAN_MERGE');
  await assert.rejects(f.run('repair', '--reason', 'fourth'), /Three repair rounds/);
  const record = JSON.parse(await readFile(join(f.root, '.agent-work/pr-workflow/001-example.json'), 'utf8'));
  assert.equal(record.repairRounds.length, 3);
  assert.equal(new Set(record.repairRounds.map((round) => round.head)).size, 3);
});

test('preflight reports freshness, dirty paths, naming, and size without publishing', async (t) => {
  const f = await checkout(t);
  const first = await f.run('preflight');
  assert.equal(first.status, 'READY_TO_WORK');
  assert.equal(first.ahead, 1);
  assert.equal(first.behind, 0);
  assert.equal(first.size.reviewable, 1);
  assert.equal(f.calls.some((call) => call[0] === 'gh' || call.includes('push') || call[0] === process.execPath), false);
  await writeFile(join(f.root, 'unfinished.md'), 'retain this work\n');
  const dirty = await f.run('preflight');
  assert.equal(dirty.status, 'BLOCKED');
  assert.match(dirty.dirty, /unfinished\.md/);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const advanced = git('commit-tree', 'HEAD^{tree}', '-p', 'origin/development', '-m', 'base advances');
  git('update-ref', 'refs/remotes/origin/development', advanced);
  assert.equal((await f.run('preflight')).behind, 1);
  git('checkout', '-b', 'wrong-name');
  assert.equal((await f.run('preflight')).branchValid, false);
  assert.equal(await readFile(join(f.root, 'unfinished.md'), 'utf8'), 'retain this work\n');
  await assert.rejects(runWorkflow(['preflight', '--root', f.root], { execute(binary, args, cwd, timeout) {
    if (binary === 'git' && args[0] === 'fetch') throw new Error('Fetch unavailable');
    return f.execute(binary, args, cwd, timeout);
  } }), /Fetch unavailable/);
});

test('preflight measures the fetched development tip even without a tracking refspec', async (t) => {
  const f = await checkout(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const remote = join(f.root, '.agent-work/remote.git');
  git('init', '--bare', '--quiet', remote);
  git('push', remote, 'refs/remotes/origin/development:refs/heads/development');
  const advanced = git('commit-tree', 'HEAD^{tree}', '-p', 'origin/development', '-m', 'remote base advances');
  git('push', remote, `${advanced}:refs/heads/development`);
  git('config', `url.${remote.split('\\').join('/')}.insteadOf`, 'https://github.com/example/project.git');
  git('config', '--unset-all', 'remote.origin.fetch');
  const report = await runWorkflow(['preflight', '--root', f.root], { execute(binary, args, cwd, timeout) {
    // Keep the origin identity seam GitHub-shaped while real Git fetches a local remote.
    if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/example/project.git';
    const result = spawnSync(binary, args, { cwd, timeout, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  } });
  assert.equal(report.base, advanced);
  assert.equal(report.behind, 1);
  assert.equal(report.status, 'BLOCKED');
});

test('a failed local gate never pushes or opens a PR', async (t) => {
  const f = await checkout(t); f.fail();
  await assert.rejects(f.run('publish', '--body-file', f.body), /Local gate failed/);
  assert.equal(f.calls.some((call) => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[2] === 'create'), false);
});

test('configured paired publication refuses a missing submission remote before primary gates or writes', async t => {
  const f = await checkout(t);
  await writeFile(join(f.root, 'publication-targets.json'), JSON.stringify({ schemaVersion: 1, submission: { remote: 'submission', base: 'main' } }));
  const committed = spawnSync('git', ['add', 'publication-targets.json'], { cwd: f.root, windowsHide: true }); assert.equal(committed.status, 0);
  const saved = spawnSync('git', ['commit', '--quiet', '-m', 'enable paired publication'], { cwd: f.root, windowsHide: true }); assert.equal(saved.status, 0);
  f.calls.length = 0;
  await assert.rejects(f.run('publish', '--body-file', f.body), /submission|No such remote/);
  assert.equal(f.calls.some(call => call[0] === process.execPath || call[1] === 'push' || call[0] === 'gh' && ['create', 'edit'].includes(call[2])), false);
});

test('closed PRs skip expensive gates and PR changes during gates prevent push', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  f.e.pr.state = 'MERGED';
  f.calls.length = 0;
  await assert.rejects(f.run('publish', '--body-file', f.body), /closed or replaced/);
  assert.equal(f.calls.some(call => call[0] === process.execPath || call[1] === 'push'), false);
  f.e.pr.state = 'OPEN';
  for (const change of ['closed', 'head']) {
    f.calls.length = 0;
    const oldHead = f.e.pr.headRefOid;
    await assert.rejects(runWorkflow(['publish', '--body-file', f.body, '--summary', 'lifecycle race', '--root', f.root], {
      execute(binary, args, cwd, timeout) {
        const output = f.execute(binary, args, cwd, timeout);
        if (binary === process.execPath && args[0].endsWith('check-runtime.mjs')) {
          if (change === 'closed') f.e.pr.state = 'MERGED';
          else f.e.pr.headRefOid = 'external-commit';
        }
        return output;
      },
    }), /closed or replaced|changed during local gates/);
    assert.equal(f.calls.some(call => call[1] === 'push' || call[0] === 'gh' && ['edit', 'create'].includes(call[2])), false);
    f.e.pr.state = 'OPEN'; f.e.pr.headRefOid = oldHead;
  }
});

test('prepare-next preserves the merged feature and refuses dirty, unmerged or existing targets', async t => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  const target = 'feat/001-next-work';
  await assert.rejects(f.run('prepare-next', '--branch', target), /merged/);
  f.e.pr.state = 'MERGED';
  await writeFile(join(f.root, 'dirty.md'), 'keep me');
  await assert.rejects(f.run('prepare-next', '--branch', target), /clean/);
  assert.equal(await readFile(join(f.root, 'dirty.md'), 'utf8'), 'keep me');
  await rm(join(f.root, 'dirty.md'));
  await assert.rejects(f.run('prepare-next', '--branch', 'feat/001-example'), /exists|different/);
  const source = f.e.head;
  const result = await f.run('prepare-next', '--branch', target);
  assert.equal(result.branch, target);
  assert.equal(result.status, 'READY_TO_WORK');
  const git = (...args) => spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
  assert.equal(git('rev-parse', 'feat/001-example').stdout.trim(), source);
  assert.equal(git('rev-parse', 'HEAD').stdout.trim(), git('rev-parse', 'origin/development').stdout.trim());
  assert.notEqual(git('rev-parse', '--abbrev-ref', '@{upstream}').status, 0, 'new branch must not track development');
  assert.equal(f.calls.some(call => ['reset', 'clean'].includes(call[1]) || call.includes('--force')), false);
});

test('publication tracks the remote feature and post-squash preparation survives its remote deletion', async t => {
  const f = await checkout(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const remote = join(f.root, '.agent-work/remote.git');
  git('init', '--bare', '--quiet', remote);
  git('push', remote, 'refs/remotes/origin/development:refs/heads/development');
  git('config', `url.${remote.split('\\').join('/')}.insteadOf`, 'https://github.com/example/project.git');
  const execute = (binary, args, cwd, timeout) => {
    if (binary !== 'git') return f.execute(binary, args, cwd, timeout);
    if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/example/project.git';
    return git(...args);
  };
  await runWorkflow(['publish', '--root', f.root, '--body-file', f.body, '--summary', 'remote tracking'], { execute });
  assert.equal(git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat/001-example');
  const source = git('rev-parse', 'HEAD');
  const squash = git('commit-tree', 'HEAD^{tree}', '-p', 'origin/development', '-m', 'squash merge');
  git('push', remote, `${squash}:refs/heads/development`);
  git('push', remote, '--delete', 'feat/001-example');
  f.e.pr.state = 'MERGED';
  const result = await runWorkflow(['prepare-next', '--root', f.root, '--branch', 'feat/001-fresh'], { execute });
  assert.equal(result.head, squash);
  assert.equal(git('rev-parse', 'feat/001-example'), source);
  assert.equal(git('status', '--porcelain'), '');
});

test('bot review decisions are advisory while GitHub merge blockers remain enforced', () => {
  const e = evidence();
  e.pr.reviewDecision = 'REVIEW_REQUIRED';
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
  e.pr.reviewDecision = 'APPROVED';
  e.pr.mergeStateStatus = 'BLOCKED';
  e.pr.isDraft = false;
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.reviewDecision = 'CHANGES_REQUESTED';
  assert.equal(assess(e).status, 'BLOCKED', 'server-side merge blockers remain enforced');
  e.pr.reviewDecision = 'REVIEW_REQUIRED';
  assert.equal(assess(e).status, 'BLOCKED');
  e.pr.reviewDecision = 'APPROVED';
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

test('runtime CI must pass on the current head before readiness', () => {
  for (const name of ['runtime-checks (ubuntu-latest)', 'runtime-checks (windows-latest)']) {
    for (const state of ['missing', 'failure', 'pending', 'stale']) {
      const e = evidence();
      const check = e.checks.find((item) => item.name === name);
      if (state === 'missing') e.checks = e.checks.filter((item) => item !== check);
      if (state === 'failure') check.conclusion = 'failure';
      if (state === 'pending') check.status = 'in_progress';
      if (state === 'stale') check.head_sha = 'old';
      assert.equal(assess(e).status, state === 'failure' ? 'NEEDS_FIX' : 'WAITING_CI', `${name}: ${state}`);
    }
  }
});

test('runtime validation failure prevents publication', async (t) => {
  const f = await checkout(t);
  await assert.rejects(runWorkflow(['publish', '--body-file', f.body, '--summary', 'gate runtime', '--root', f.root], {
    execute(binary, args, cwd, timeout) {
      if (binary === process.execPath && args[0].endsWith('check-runtime.mjs')) throw new Error('Runtime typecheck failed');
      return f.execute(binary, args, cwd, timeout);
    },
  }), /Runtime typecheck failed/);
  assert.equal(f.calls.some((call) => call[1] === 'push' || call[0] === 'gh' && call[2] === 'create'), false);
});

test('dependency changes require a fresh install before publishing; documentation changes do not', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  await writeFile(join(f.root, 'package.json'), '{"private":true}\n');
  git('add', 'package.json'); git('commit', '--quiet', '-m', 'change dependency inputs');
  const run = () => runWorkflow(['publish', '--body-file', f.body, '--summary', 'gate dependencies', '--root', f.root], {
    execute(binary, args, cwd, timeout) {
      if (binary === process.execPath && args[0].endsWith('check-dependency-install.mjs')) throw new Error('Release age rejected');
      return f.execute(binary, args, cwd, timeout);
    },
  });
  const pushes = () => f.calls.filter((call) => call[1] === 'push').length;
  const before = pushes();
  await assert.rejects(run(), /Release age rejected/);
  assert.equal(pushes(), before);
  await f.run('publish', '--body-file', f.body);
  await f.advance();
  await run();
  assert.equal(pushes(), before + 2, 'unchanged dependencies permit documentation publication');
});

test('completion requires a clean published current head, linked PR and passing CI', async (t) => {
  const f = await checkout(t);
  await assert.rejects(f.run('complete'), /Missing PR accounting/);
  await f.run('publish', '--body-file', f.body);
  await assert.rejects(f.run('complete'), /linked/);
  const receipt = join(f.root, '.agent-work/app-state.json');
  await writeFile(receipt, JSON.stringify({ pullRequests: [] }));
  await assert.rejects(f.run('record-app-state', '--receipt', receipt), /linked PR/);
  await writeFile(receipt, JSON.stringify({ pullRequests: [{ url: f.e.pr.url, repository: 'example/project', number: 1 }] }));
  await f.run('record-app-state', '--receipt', receipt);
  assert.equal((await f.run('complete')).completion.head, f.e.head);
  f.e.checks[2].status = 'in_progress';
  await assert.rejects(f.run('complete'), /WAITING_CI/);
  f.e.checks[2].status = 'completed'; f.e.checks[2].conclusion = 'failure';
  await assert.rejects(f.run('complete'), /NEEDS_FIX/);
  f.e.checks[2].conclusion = 'success';
  await writeFile(join(f.root, 'dirty.md'), 'unpublished');
  await assert.rejects(f.run('complete'), /clean/);
  await rm(join(f.root, 'dirty.md'));
  await f.advance();
  await assert.rejects(f.run('complete'), /published|BLOCKED/);
});

test('paired publication resumes after a partial private PR failure and gates completion on both receipt links', async t => {
  const f = await checkout(t);
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const privateRemote = join(f.root, '.agent-work/private.git');
  const privateSeed = join(f.root, '.agent-work/private-seed');
  await mkdir(privateSeed);
  git(f.root, 'init', '--bare', '--initial-branch=main', privateRemote);
  git(f.root, 'init', '--initial-branch=main', privateSeed);
  git(privateSeed, 'config', 'user.name', 'Private Seed');
  git(privateSeed, 'config', 'user.email', 'private@example.invalid');
  await writeFile(join(privateSeed, 'README.md'), '# Unrelated coursework history\n');
  git(privateSeed, 'add', '.');
  git(privateSeed, 'commit', '--quiet', '-m', 'private initial history');
  git(privateSeed, 'remote', 'add', 'origin', privateRemote);
  git(privateSeed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  git(f.root, 'remote', 'add', 'submission', 'https://github.com/course/private.git');
  git(f.root, 'config', `url.${privateRemote.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/course/private.git');
  await writeFile(join(f.root, 'publication-targets.json'), JSON.stringify({ schemaVersion: 1, submission: { remote: 'submission', base: 'main' } }));
  git(f.root, 'add', 'publication-targets.json');
  git(f.root, 'commit', '--quiet', '-m', 'enable paired publication');

  const privateMain = git(f.root, 'ls-remote', 'submission', 'refs/heads/main').split(/\s+/)[0];
  const privatePrs = [];
  const pairedCalls = [];
  let failPrivateCreate = true;
  const privateHead = ref => {
    const output = git(f.root, 'ls-remote', '--heads', 'submission', ref);
    return output ? output.split(/\s+/)[0] : undefined;
  };
  const privateGh = args => {
    if (args[0] === 'repo' && args[1] === 'view') {
      return JSON.stringify(args[2] === 'course/private'
        ? { visibility: 'PRIVATE', isPrivate: true, viewerPermission: 'WRITE' }
        : { visibility: 'PUBLIC', isPrivate: false, viewerPermission: 'ADMIN' });
    }
    const repository = args[args.indexOf('--repo') + 1];
    if (repository !== 'course/private') return undefined;
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(privatePrs.map(({ number, url, baseRefName, headRefName, state }) => ({ number, url, baseRefName, headRefName, state })));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = privatePrs.find(item => item.number === Number(args[2]));
      if (!pr) throw new Error('Private PR not found');
      pr.headRefOid = privateHead(`refs/heads/${pr.headRefName}`);
      return JSON.stringify(pr);
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      if (failPrivateCreate) { failPrivateCreate = false; throw new Error('simulated private PR create failure'); }
      const number = 7;
      const pr = {
        number, url: `https://github.com/course/private/pull/${number}`, title: args[args.indexOf('--title') + 1],
        body: args[args.indexOf('--body') + 1], state: 'OPEN', isDraft: args.includes('--draft'),
        headRefName: args[args.indexOf('--head') + 1], baseRefName: args[args.indexOf('--base') + 1],
        headRefOid: privateHead(`refs/heads/${args[args.indexOf('--head') + 1]}`),
      };
      privatePrs.push(pr);
      return pr.url;
    }
    if (args[0] === 'pr' && args[1] === 'ready') {
      const pr = privatePrs.find(item => item.number === Number(args[2]));
      if (!pr) throw new Error('Private PR not found');
      pr.isDraft = false;
      return '';
    }
    throw new Error(`Unexpected private GitHub command: ${args.join(' ')}`);
  };
  const execute = (binary, args, cwd, timeout) => {
    if (binary === 'gh') {
      if (args[0] === 'repo' && args[1] === 'view' || args.includes('--repo') && args[args.indexOf('--repo') + 1] === 'course/private') {
        pairedCalls.push([binary, ...args]);
        return privateGh(args);
      }
      return f.execute(binary, args, cwd, timeout);
    }
    if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'submission') {
      return 'https://github.com/course/private.git';
    }
    if (binary === 'git' && (args[0] === 'fetch' && args.includes('submission') || args[0] === 'push' && args[1] === 'submission')) {
      pairedCalls.push([binary, ...args]);
      const result = spawnSync('git', args, { cwd, timeout, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    }
    return f.execute(binary, args, cwd, timeout);
  };
  const run = (...args) => runWorkflow([...args, '--root', f.root], { execute });
  const publish = () => run('publish', '--body-file', f.body, '--summary', 'add the paired workflow');

  await writeFile(f.body, 'Summary includes https://github.com/course/private/pull/7');
  f.calls.length = 0;
  await assert.rejects(publish(), /private/i);
  assert.equal(f.calls.some(call => call[0] === 'git' && call[1] === 'push' && call[2] === 'origin' || call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create'), false, 'private repository identity must be rejected before public publication');
  await writeFile(f.body, 'Summary and verification');

  await assert.rejects(publish(), /submission publication incomplete/);
  const recordPath = join(f.root, '.agent-work/pr-workflow/001-example.json');
  const partial = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(partial.status, 'PARTIAL_PUBLICATION');
  assert.ok(partial.pr, 'the public PR remains recorded after the private create failure');
  assert.equal(privatePrs.length, 0);

  const published = await publish();
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(privatePrs.length, 1);
  assert.equal(published.submission.number, 7);
  assert.equal(published.submission.head, privateHead('refs/heads/feat/001-example'));
  assert.equal(privateHead('refs/heads/main'), privateMain);
  assert.match(privatePrs[0].body, /https:\/\/github\.com\/example\/project\/pull\/1/);
  assert.doesNotMatch(await readFile(f.body, 'utf8'), /course\/private/);
  assert.equal(f.calls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 1);
  assert.equal(pairedCalls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 2, 'one failed create and one successful retry');

  const receiptPath = join(f.root, '.agent-work/app-state.json');
  const primaryOnly = { pullRequests: [{ url: published.url, repository: 'example/project', number: published.pr }] };
  await writeFile(receiptPath, JSON.stringify(primaryOnly));
  await assert.rejects(run('record-app-state', '--receipt', receiptPath), /both linked PRs|including submission/);
  await writeFile(receiptPath, JSON.stringify({ pullRequests: [
    ...primaryOnly.pullRequests,
    { url: published.submission.url, repository: published.submission.repository, number: published.submission.number },
  ] }));
  const linked = await run('record-app-state', '--receipt', receiptPath);
  assert.equal(linked.submissionAppLink.url, published.submission.url);

  const complete = await run('complete');
  assert.equal(complete.completion.submission.url, published.submission.url);
  assert.equal(complete.completion.submissionAppLink.url, published.submission.url);
  const ready = await run('ready');
  assert.equal(ready.status, 'AWAITING_HUMAN_MERGE');
  assert.equal(ready.submission.isDraft, false);
  assert.equal(privatePrs[0].isDraft, false);
  assert.equal(f.e.pr.isDraft, false);
});
