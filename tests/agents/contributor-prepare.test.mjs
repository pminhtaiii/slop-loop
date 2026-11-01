import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { contributorPrepare } from '../../scripts/agents/contributor-prepare.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'contributor-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'context'));
  await writeFile(resolve(root, 'context/active_task.md'), '# Active task\n<!-- active-task:start -->\n```json\n[]\n```\n<!-- active-task:end -->\n');
  await writeFile(resolve(root, '.gitignore'), '.agent-work/\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=feat/tooling-demo');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(resolve(root, 'source.txt'), 'candidate\n');
  git('add', '.gitignore', 'context/active_task.md', 'source.txt');
  git('commit', '--quiet', '-m', 'fixture');
  const ancestorHead = git('rev-parse', 'HEAD');
  await writeFile(resolve(root, 'follow-up.txt'), 'local follow-up\n');
  git('add', 'follow-up.txt');
  git('commit', '--quiet', '-m', 'local follow-up');
  return { root, git, ancestorHead, head: git('rev-parse', 'HEAD') };
}

function executor({ head, registerHead = head, pullRequests, pullRequestResponses = [pullRequests], calls, dirty = '', mergeBase = '0'.repeat(40), startErrorAfterPersist = false, postStartBranch, postStartHead, postStartDirty }) {
  let pullRequestIndex = 0;
  let started = false;
  return (binary, args, cwd) => {
    calls.push([binary, ...args]);
    if (binary === 'git') {
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/example/repo.git';
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse' && ['HEAD', 'origin/development'].includes(args[1])) return head;
      if (args[0] === 'rev-parse' && args[1] === '--verify') return started ? postStartHead ?? registerHead : registerHead;
      if (args[0] === 'rev-list') return '0\t0';
      if (args[0] === 'status') return started ? postStartDirty ?? dirty : dirty;
      if (args[0] === 'merge-base') return mergeBase;
      if (args[0] === 'diff') return '';
      if (args[0] === 'branch') return 'feat/tooling-demo';
      if (args[0] === 'symbolic-ref') return started ? postStartBranch ?? 'feat/tooling-demo' : 'feat/tooling-demo';
      if (args[0] === '--version') return 'git version 2.46.0';
    }
    if (binary === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(pullRequestResponses[Math.min(pullRequestIndex++, pullRequestResponses.length - 1)]);
      if (args[0] === '--version') return 'gh version 2.56.0';
      if (args[0] === 'auth' && args[1] === 'status') return 'Logged in';
    }
    if (binary === process.execPath) {
      const result = spawnSync(binary, args, { cwd, encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      started = true;
      if (startErrorAfterPersist) throw new Error('simulated lost reply after registration');
      return result.stdout.trim();
    }
    throw new Error(`Unexpected command: ${binary} ${args.join(' ')}`);
  };
}

test('merged PR preparation requires a new branch before worker registration', async t => {
  const f = await fixture(t);
  const calls = [];
  const beforeBranch = f.git('branch', '--show-current');
  const report = await contributorPrepare([
    '--root', f.root,
    '--register',
    '--owner', 'worker',
    '--task', 'T001',
    '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation',
    '--next', 'Run focused checks',
    '--owned-path', 'source.txt',
    '--next-branch', 'feat/tooling-next',
  ], {
    execute: executor({ head: f.head, calls, pullRequests: [{ number: 17, state: 'MERGED', mergedAt: '2026-10-30T10:00:00Z', url: 'https://github.com/example/repo/pull/17', headRefName: 'feat/tooling-demo', baseRefName: 'development' }] }),
  });

  assert.equal(report.status, 'NEEDS_NEXT_BRANCH', JSON.stringify(report));
  assert.equal(report.pullRequest.state, 'MERGED');
  assert.equal(report.nextCommand.command, 'node');
  assert.equal(report.nextCommand.args[1], 'prepare-next');
  assert.equal(report.nextCommand.args.at(-1), 'feat/tooling-next');
  assert.equal(report.nextCommand.args[report.nextCommand.args.indexOf('--root') + 1], f.root);
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  assert.equal(f.git('branch', '--show-current'), beforeBranch);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')),{ code: 'ENOENT' });
});

test('open PR with a stale live head is not considered ready', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare(['--root', f.root], {
    execute: executor({
      head: f.head,
      calls,
      pullRequests: [{ number: 21, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/21', headRefName: 'feat/tooling-demo', baseRefName: 'development', headRefOid: 'f'.repeat(40) }],
    }),
  });

  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some(message => /live PR head is not contained/i.test(message)));
  assert.equal(calls.some(([binary, ...args]) => binary === 'git' && args[0] === 'merge-base'), true);
});

test('open PR with a missing live head blocks readiness', async t => {
  const f = await fixture(t);
  const report = await contributorPrepare(['--root', f.root], {
    execute: executor({
      head: f.head,
      calls: [],
      pullRequests: [{ number: 23, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/23', headRefName: 'feat/tooling-demo', baseRefName: 'development' }],
    }),
  });

  assert.equal(report.status, 'BLOCKED');
  assert.match(report.blockers.at(-1), /live PR head SHA is missing or invalid/i);
});

test('open PR with a malformed live head blocks before ancestry lookup', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare(['--root', f.root], {
    execute: executor({
      head: f.head,
      calls,
      pullRequests: [{ number: 25, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/25', headRefName: 'feat/tooling-demo', baseRefName: 'development', headRefOid: 'f'.repeat(39) }],
    }),
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(calls.some(([binary, ...args]) => binary === 'git' && args[0] === 'merge-base'), false);
});

test('open PR head may be an ancestor of the prepared local follow-up', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare(['--root', f.root], {
    execute: executor({
      head: f.head,
      calls,
      mergeBase: f.ancestorHead,
      pullRequests: [{ number: 24, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/24', headRefName: 'feat/tooling-demo', baseRefName: 'development', headRefOid: f.ancestorHead }],
    }),
  });

  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.equal(report.pullRequest.head, f.ancestorHead);
  assert.ok(calls.some(([binary, ...args]) => binary === 'git' && args[0] === 'merge-base' && args[1] === f.ancestorHead && args[2] === f.head));
});

test('closed PR preparation blocks worker registration', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T002', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Inspect the closed PR', '--owned-path', 'source.txt',
  ], {
    execute: executor({ head: f.head, calls, pullRequests: [{ number: 18, state: 'CLOSED', mergedAt: null, url: 'https://github.com/example/repo/pull/18', headRefName: 'feat/tooling-demo', baseRefName: 'development' }] }),
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.pullRequest.state, 'CLOSED');
  assert.equal(report.assignment.registered, false);
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')),{ code: 'ENOENT' });
});

test('merged PR remains a next-branch route even when other preflight blockers exist', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T004', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Use a fresh branch', '--owned-path', 'source.txt',
    '--next-branch', 'feat/tooling-next',
  ], {
    execute: executor({ head: f.head, calls, dirty: ' M source.txt', pullRequests: [{ number: 19, state: 'MERGED', mergedAt: '2026-10-30T10:00:00Z', url: 'https://github.com/example/repo/pull/19', headRefName: 'feat/tooling-demo', baseRefName: 'development' }] }),
  });

  assert.equal(report.status, 'NEEDS_NEXT_BRANCH');
  assert.equal(report.pullRequest.state, 'MERGED');
  assert.equal(report.checkout.dirty, true);
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')),{ code: 'ENOENT' });
});

test('ready preparation registers a worker bound to the checked branch and head', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T003', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Run focused checks', '--owned-path', 'source.txt',
  ], { execute: executor({ head: f.head, calls, pullRequests: [] }) });

  assert.equal(report.status, 'READY', JSON.stringify(report));
  assert.equal(report.assignment.registered, true);
  assert.equal(report.assignment.role, 'worker');
  assert.equal(report.assignment.binding.branch, 'refs/heads/feat/tooling-demo');
  assert.equal(report.assignment.binding.base.sha, f.head);
  const entries = JSON.parse(await readFile(resolve(f.root, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(entries[0].owner, 'worker');
  assert.equal(entries[0].task, 'T003');
  const start = calls.find(([binary, ...args]) => binary === process.execPath && args.some(argument => String(argument).endsWith('active-task.mjs')));
  assert.ok(start);
  assert.ok(start.includes('--expected-branch'));
  assert.ok(start.includes('feat/tooling-demo'));
  assert.ok(start.includes('--expected-head'));
  assert.ok(start.includes(f.head));
  assert.ok(start.includes('--require-clean'));
});

test('preparation refuses registration when the checkout head changes after preflight', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T005', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Rerun preparation', '--owned-path', 'source.txt',
  ], { execute: executor({ head: f.head, registerHead: 'f'.repeat(40), calls, pullRequests: [] }) });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.assignment.registered, false);
  assert.match(report.blockers.at(-1), /Checkout changed after preparation/);
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')),{ code: 'ENOENT' });
});

test('registration rechecks live PR identity and head before creating a worker', async t => {
  const f = await fixture(t);
  const calls = [];
  const row = { number: 22, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/22', headRefName: 'feat/tooling-demo', baseRefName: 'development', headRefOid: f.head };
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T007', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Inspect the changed PR head', '--owned-path', 'source.txt',
  ], {
    execute: executor({
      head: f.head,
      calls,
      pullRequestResponses: [[row], [{ ...row, headRefOid: 'f'.repeat(40) }]],
      mergeBase: f.head,
    }),
  });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.assignment.registered, false);
  assert.match(report.blockers.at(-1), /live PR head is not contained/i);
  assert.equal(calls.filter(([binary, ...args]) => binary === 'gh' && args[0] === 'pr' && args[1] === 'list').length, 2);
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')), { code: 'ENOENT' });
});

test('registration routes to a new branch if the PR merges during preparation', async t => {
  const f = await fixture(t);
  const calls = [];
  const row = { number: 26, state: 'OPEN', mergedAt: null, url: 'https://github.com/example/repo/pull/26', headRefName: 'feat/tooling-demo', baseRefName: 'development', headRefOid: f.head };
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T009', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Use a fresh branch', '--owned-path', 'source.txt', '--next-branch', 'feat/tooling-next',
  ], {
    execute: executor({
      head: f.head,
      calls,
      pullRequestResponses: [[row], [{ ...row, state: 'MERGED', mergedAt: '2026-10-31T10:00:00Z' }]],
      mergeBase: f.head,
    }),
  });

  assert.equal(report.status, 'NEEDS_NEXT_BRANCH');
  assert.equal(report.pullRequest.state, 'MERGED');
  assert.equal(report.nextCommand.args[1], 'prepare-next');
  assert.equal(report.nextCommand.args.at(-1), 'feat/tooling-next');
  assert.equal(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('active-task.mjs')), false);
  await assert.rejects(readFile(resolve(f.root, '.agent-work/state/active-tasks.json')), { code: 'ENOENT' });
});

test('ready preparation forwards the optional factory-managed flag to active-task start', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--factory-managed', '--owner', 'worker', '--task', 'T006', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Pin factory evidence', '--owned-path', 'source.txt',
  ], { execute: executor({ head: f.head, calls, pullRequests: [] }) });

  assert.equal(report.status, 'READY');
  assert.equal(report.assignment.registered, true);
  const entries = JSON.parse(await readFile(resolve(f.root, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(entries[0].factoryManaged, true);
  assert.ok(calls.some(([binary, ...args]) => binary === process.execPath && args.includes('--factory-managed')));
});

test('worker start error reports the persisted assignment instead of claiming registration failed', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T008', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Inspect the retained assignment', '--owned-path', 'source.txt',
  ], { execute: executor({ head: f.head, calls, pullRequests: [], startErrorAfterPersist: true }) });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.assignment.registered, true, JSON.stringify(report));
  assert.equal(report.assignment.binding.branch, 'refs/heads/feat/tooling-demo');
  assert.match(report.blockers.at(-1), /after recording the worker assignment/i);
  assert.equal(report.nextCommand.args[1], 'list');
  const entries = JSON.parse(await readFile(resolve(f.root, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(entries[0].task, 'T008');
});

test('checkout change after worker start remains truthfully registered and blocks recovery', async t => {
  const f = await fixture(t);
  const calls = [];
  const report = await contributorPrepare([
    '--root', f.root,
    '--register', '--owner', 'worker', '--task', 'T010', '--session', '2026-10-31/worker',
    '--summary', 'Continue implementation', '--next', 'Recover the changed checkout', '--owned-path', 'source.txt',
  ], { execute: executor({ head: f.head, calls, pullRequests: [], postStartBranch: 'feat/raced' }) });

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.assignment.registered, true, JSON.stringify(report));
  assert.equal(report.assignment.binding.branch, 'refs/heads/feat/tooling-demo');
  assert.match(report.blockers.at(-1), /checkout changed after registration/i);
  const entries = JSON.parse(await readFile(resolve(f.root, '.agent-work/state/active-tasks.json'), 'utf8'));
  assert.equal(entries[0].binding.branch, 'refs/heads/feat/tooling-demo');
  assert.equal(entries[0].task, 'T010');
});

test('dirtyPaths strips the porcelain prefix from trimmed and untrimmed status lines', async t => {
  const f = await fixture(t);
  const raw = ' M source.txt\nM  staged.txt\nA  added.txt\n?? untracked.txt\n';
  const report = await contributorPrepare(['--root', f.root], {
    execute: executor({ head: f.head, calls: [], dirty: raw.trim(), pullRequests: [] }),
  });

  assert.deepEqual(report.checkout.dirtyPaths, ['source.txt', 'staged.txt', 'added.txt', 'untracked.txt']);
});
