import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow, workflowSummary } from '../../scripts/agents/pr-workflow.mjs';
import { packageScriptCommand } from '../../scripts/agents/workflow-gate.mjs';
import { checkout } from './support/pr-workflow-fixture.mjs';

const recordPath = root => join(root, '.agent-work/pr-workflow/010-tooling-example.json');
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const gitAt = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const gates = calls => calls.filter(call => call[0] === process.execPath || call[0] === packageScriptCommand('test:contributors').command);

test('push-only requires a non-empty reason before running commands', async t => {
  const f = await checkout(t);
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only'), /Push-only publication requires a non-empty --reason/);
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', '  '), /Push-only publication requires a non-empty --reason/);
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'unknown', '--reason', 'rationale'), /Publish --mode must be full or push-only/);
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'r'.repeat(2001)), /at most 2000 characters/);
  await assert.rejects(f.run('publish', '--body-file', f.body, '--reason', 'rationale without a mode'), /only valid with --mode push-only/);
  assert.deepEqual(f.calls, []);
});

test('default full publication runs local gates and records its verified head', async t => {
  const f = await checkout(t);
  const published = await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const contributorTests = packageScriptCommand('test:contributors');

  assert.equal(published.publicationMode, 'full');
  assert.equal(published.localVerifiedHead, published.publishedHead);
  assert.equal(workflowSummary(published).localGateStatus, 'passed');
  assert.ok(f.calls.some(call => call[0] === process.execPath && call[1].endsWith('check-context.mjs')));
  assert.ok(f.calls.some(call => call[0] === process.execPath && call[1].endsWith('check-runtime.mjs')));
  assert.ok(f.calls.some(call => call[0] === contributorTests.command && JSON.stringify(call.slice(1)) === JSON.stringify(contributorTests.args)));
});

test('push-only skips local gates, retains prior verification, repair history, and its reason', async t => {
  const f = await checkout(t);
  const full = await f.run('publish', '--body-file', f.body, '--skip-review-request');
  const reason = 'Explicit user request to publish this repair without rerunning local gates.';
  const path = recordPath(f.root);
  const prior = JSON.parse(await readFile(path, 'utf8'));
  prior.repairRounds = [{ head: full.publishedHead, reason: 'diagnosed first round', startedAt: '2026-10-25T00:00:00.000Z' }];
  await writeFile(path, JSON.stringify(prior));
  await f.advance();
  const from = f.calls.length;

  const published = await f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', reason, '--skip-review-request');
  const currentCalls = f.calls.slice(from);

  assert.equal(published.publicationMode, 'push-only');
  assert.equal(published.publicationReason, reason);
  assert.notEqual(published.publishedHead, full.publishedHead);
  assert.equal(published.localVerifiedHead, full.publishedHead);
  assert.equal(published.localVerification.head, full.publishedHead);
  assert.deepEqual(published.repairRounds, prior.repairRounds);
  assert.equal(gates(currentCalls).length, 0);
  assert.equal(workflowSummary(published).localGateStatus, 'skipped');
  const push = currentCalls.find(call => call[0] === 'git' && call[1] === 'push');
  assert.ok(push.includes('HEAD:refs/heads/feat/010-tooling-example'));
  assert.equal(push.some(arg => ['main', 'development'].includes(arg)), false);
});

for (const priorVerification of [false, true]) {
  test(`full publication checks dependencies after push-only with prior verification ${priorVerification}`, async t => {
    const f = await checkout(t);
    if (priorVerification) await f.run('publish', '--body-file', f.body, '--skip-review-request');
    await writeFile(join(f.root, 'package.json'), '{"private":true}\n');
    git(f.root, 'add', 'package.json');
    git(f.root, 'commit', '--quiet', '-m', 'change dependency inputs');
    await f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.', '--skip-review-request');
    await f.advance();
    const pushes = () => f.calls.filter(call => call[0] === 'git' && call[1] === 'push').length;
    const before = pushes();

    await assert.rejects(runWorkflow(['publish', '--body-file', f.body, '--summary', 'gate unverified dependencies', '--root', f.root], {
      execute(binary, args, cwd, timeout) {
        if (binary === process.execPath && args[0].endsWith('check-dependency-install.mjs')) throw new Error('Release age rejected');
        return f.execute(binary, args, cwd, timeout);
      },
    }), /Release age rejected/);
    assert.equal(pushes(), before);
  });
}

test('push-only keeps body and clean-checkout guards before writes', async t => {
  const f = await checkout(t);
  await writeFile(join(f.root, 'uncommitted.md'), 'dirty\n');
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.'), /checkout must be clean/);
  assert.equal(f.calls.some(call => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[1] === 'pr' && ['create', 'edit'].includes(call[2])), false);
  assert.equal(gates(f.calls).length, 0);
});

test('push-only keeps the publication body validation before writes', async t => {
  const f = await checkout(t);
  await writeFile(f.body, '  \n');
  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.'), /PR body must contain/);
  assert.equal(f.calls.some(call => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[1] === 'pr' && ['create', 'edit'].includes(call[2])), false);
});

test('push-only rejects a branch behind fetched development', async t => {
  const f = await checkout(t);
  const feature = git(f.root, 'rev-parse', 'HEAD');
  const base = git(f.root, 'rev-parse', 'origin/development');
  git(f.root, 'switch', '--detach', base);
  await writeFile(join(f.root, 'development-only.md'), 'new base change\n');
  git(f.root, 'add', 'development-only.md');
  git(f.root, 'commit', '--quiet', '-m', 'advance development');
  git(f.root, 'update-ref', 'refs/remotes/origin/development', 'HEAD');
  git(f.root, 'switch', '--quiet', 'feat/010-tooling-example');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), feature);

  await assert.rejects(f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.'), /behind development/);
  assert.equal(f.calls.some(call => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create'), false);
});

test('push-only checks the head again before pushing', async t => {
  const f = await checkout(t);
  let statuses = 0;
  const execute = (binary, args, cwd, timeout) => {
    if (binary === 'git' && args[0] === 'status' && ++statuses === 2) {
      writeFileSync(join(f.root, 'change.md'), 'raced head change\n');
      git(f.root, 'add', 'change.md');
      git(f.root, 'commit', '--quiet', '-m', 'race publish head');
    }
    return f.execute(binary, args, cwd, timeout);
  };

  await assert.rejects(runWorkflow(['publish', '--body-file', f.body, '--summary', 'add the example workflow', '--mode', 'push-only', '--reason', 'User requested publication.', '--root', f.root], { execute }), /changed before push/);
  assert.equal(f.calls.some(call => call[0] === 'git' && call[1] === 'push' || call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create'), false);
});

test('push-only completion requires a matching published head and passing primary CI', async t => {
  const f = await checkout(t);
  const published = await f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.', '--skip-review-request');
  const path = recordPath(f.root);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: saved.url, repository: 'example/project', number: saved.pr };
  await writeFile(path, JSON.stringify(saved));

  const complete = await f.run('complete');
  assert.equal(complete.status, 'READY_FOR_HUMAN');
  assert.equal(complete.completion.head, published.publishedHead);
  assert.equal(complete.completion.localGates, 'skipped');
  assert.equal(workflowSummary(complete).localGateStatus, 'skipped');

  const stale = JSON.parse(await readFile(path, 'utf8'));
  await f.advance();
  await writeFile(path, JSON.stringify(stale));
  await assert.rejects(f.run('complete'), /published current head/);
});

test('push-only cannot complete from a failed primary current-head check', async t => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body, '--mode', 'push-only', '--reason', 'User requested publication.', '--skip-review-request');
  const path = recordPath(f.root);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.appLink = { url: saved.url, repository: 'example/project', number: saved.pr };
  await writeFile(path, JSON.stringify(saved));
  f.e.checks[0].conclusion = 'failure';

  await assert.rejects(f.run('complete'), /Completion blocked: NEEDS_FIX/);
});

test('push-only recovers a paired partial publish without resetting provenance or querying submission CI', async t => {
  const f = await checkout(t);
  const branch = 'feat/tooling-push-only';
  const reason = 'User requested publication without local gate execution.';
  git(f.root, 'switch', '--quiet', '-c', branch);
  Object.assign(f.e.pr, { headRefName: branch, title: `${branch}: add paired push-only publication` });
  await writeFile(join(f.root, 'publication-targets.json'), JSON.stringify({ schemaVersion: 1, submission: { remote: 'submission', base: 'development' } }));
  git(f.root, 'add', 'publication-targets.json');
  git(f.root, 'commit', '--quiet', '-m', 'enable paired publication');

  const seed = await mkdtemp(join(tmpdir(), 'pr-workflow-push-only-pair-'));
  t.after(() => rm(seed, { recursive: true, force: true }));
  const privateSeed = join(seed, 'seed');
  const privateRemote = join(seed, 'private.git');
  await mkdir(privateSeed);
  gitAt(privateSeed, 'init', '--quiet');
  gitAt(privateSeed, 'config', 'user.name', 'Tests');
  gitAt(privateSeed, 'config', 'user.email', 'tests@example.invalid');
  await writeFile(join(privateSeed, 'README.md'), '# Submission history\n');
  gitAt(privateSeed, 'add', '.');
  gitAt(privateSeed, 'commit', '--quiet', '-m', 'private initial history');
  gitAt(privateSeed, 'init', '--bare', '--quiet', privateRemote);
  gitAt(privateSeed, 'remote', 'add', 'origin', privateRemote);
  gitAt(privateSeed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  gitAt(privateSeed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/development');
  git(f.root, 'remote', 'add', 'submission', 'https://github.com/course/private.git');
  git(f.root, 'config', `url.${privateRemote.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/course/private.git');

  const privateMain = git(f.root, 'ls-remote', 'submission', 'refs/heads/main').split(/\s+/)[0];
  const privatePrs = [];
  const pairedCalls = [];
  let failPrivateCreate = true;
  let privateCiQueries = 0;
  const privateHead = reference => {
    const output = git(f.root, 'ls-remote', '--heads', 'submission', reference);
    return output ? output.split(/\s+/)[0] : undefined;
  };
  const privateGh = args => {
    if (args[0] === 'repo' && args[1] === 'view') {
      const isPrivate = args[2] === 'course/private';
      return JSON.stringify({ visibility: isPrivate ? 'PRIVATE' : 'PUBLIC', isPrivate, viewerPermission: 'WRITE' });
    }
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(privatePrs.map(({ number, url, baseRefName, headRefName, state }) => ({ number, url, baseRefName, headRefName, state })));
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
        body: readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'), state: 'OPEN', isDraft: args.includes('--draft'),
        headRefName: args[args.indexOf('--head') + 1], baseRefName: args[args.indexOf('--base') + 1],
        headRefOid: privateHead(`refs/heads/${args[args.indexOf('--head') + 1]}`),
      };
      privatePrs.push(pr);
      return pr.url;
    }
    throw new Error(`Unexpected private GitHub call: ${args.join(' ')}`);
  };
  const execute = (binary, args, cwd, timeout) => {
    if (binary === 'gh' && args[0] === 'api' && args.some(arg => arg.includes('course/private')) && args.some(arg => /\/(?:check-runs|statuses)(?:\?|$)/.test(arg))) {
      privateCiQueries++;
      throw new Error('submission CI must not be queried');
    }
    if (binary === 'gh' && (args[0] === 'repo' && args[1] === 'view' || args.includes('--repo') && args[args.indexOf('--repo') + 1] === 'course/private')) {
      pairedCalls.push([binary, ...args]);
      return privateGh(args);
    }
    if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'submission') return 'https://github.com/course/private.git';
    if (binary === 'git' && (args[0] === 'fetch' && args.includes('submission') || args[0] === 'push' && args[1] === 'submission')) {
      pairedCalls.push([binary, ...args]);
      const result = spawnSync('git', args, { cwd, timeout, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }
    return f.execute(binary, args, cwd, timeout);
  };
  const run = (...args) => runWorkflow([...args, '--root', f.root], { execute });
  const publish = () => run('publish', '--body-file', f.body, '--summary', 'add paired push-only publication', '--mode', 'push-only', '--reason', reason, '--skip-review-request');
  const recordPath = join(f.root, '.agent-work/pr-workflow/tooling-push-only.json');
  await mkdir(join(f.root, '.agent-work/pr-workflow'), { recursive: true });
  const repairRounds = [{ head: git(f.root, 'rev-parse', 'HEAD'), reason: 'preserved paired repair round', startedAt: '2026-10-25T00:00:00.000Z' }];
  await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, repository: 'example/project', branch, base: 'development', repairRounds, conventionVersion: 2 }));

  await assert.rejects(publish(), /submission publication incomplete/);
  const partial = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(partial.status, 'PARTIAL_PUBLICATION');
  assert.equal(partial.publicationMode, 'push-only');
  assert.equal(partial.publicationReason, reason);
  assert.equal(partial.publishedHead, git(f.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(partial.repairRounds, repairRounds);
  assert.equal(gates(f.calls).length, 0);

  const published = await publish();
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(published.publicationMode, 'push-only');
  assert.equal(published.publicationReason, reason);
  assert.deepEqual(published.repairRounds, repairRounds);
  assert.equal(privatePrs.length, 1);
  assert.equal(published.submission.head, privateHead(`refs/heads/${branch}`));
  assert.equal(privateHead('refs/heads/main'), privateMain);
  assert.equal(git(f.root, 'rev-parse', `${published.submission.head}^{tree}`), published.submission.sourceTree);
  assert.equal(pairedCalls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create').length, 1);
  assert.equal(privateCiQueries, 0);

  const current = await run('status');
  assert.equal(current.status, 'READY_FOR_HUMAN');
  assert.equal(current.submission.head, published.submission.head);
  assert.equal(privateCiQueries, 0);
});
