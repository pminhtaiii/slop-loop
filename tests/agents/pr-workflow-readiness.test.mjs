import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assess, runWorkflow } from '../../scripts/agents/pr-workflow.mjs';
import { workflowSummary } from '../../scripts/agents/pr-workflow-status.mjs';
import { ACTIVE_POLICY_ID, POLICIES, createPolicyState, evaluateRequired, resolvePolicy } from '../../scripts/ci/required-checks.mjs';
import { checkout, evidence, requiredChecks } from './support/pr-workflow-fixture.mjs';

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
  const record = join(f.root, '.agent-work/pr-workflow/010-tooling-example.json');
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
  // Literal names keep this a real oracle rather than a restatement of the production selector.
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

test('retained publication accounting records the active check policy without changing it', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  const record = JSON.parse(await readFile(join(f.root, '.agent-work/pr-workflow/010-tooling-example.json'), 'utf8'));
  assert.equal(record.checkPolicy, ACTIVE_POLICY_ID);
  assert.equal(ACTIVE_POLICY_ID, 'ci-v1', 'Stage A1 keeps ci-v1 current; ci-v2 is not activated by a consumer');
  // The retained policy must be readable, not merely stored.
  assert.equal(workflowSummary(record).checkPolicy, ACTIVE_POLICY_ID);

  // An unrecognised retained policy is refused instead of being trusted or ignored.
  record.checkPolicy = 'ci-v9';
  await writeFile(join(f.root, '.agent-work/pr-workflow/010-tooling-example.json'), `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(f.run('status'), /unknown check policy/i);
});

test('a ci-v2 selection resolves the ten ci-v2 names through the pure selector only', () => {
  const v2 = resolvePolicy(createPolicyState('ci-v2'), { policyId: 'ci-v2' });
  assert.equal(v2.historical, false);
  assert.deepEqual([...v2.policy.required], [...POLICIES['ci-v2'].required]);
  assert.equal(v2.policy.required.length, 10);
  assert.deepEqual([...createPolicyState(ACTIVE_POLICY_ID).policy.required], [...POLICIES['ci-v1'].required], 'production readiness still selects ci-v1');
});

test('ci-v2 and ci-v1 names never satisfy each other, in the selector or the consumer', () => {
  const head = 'a'.repeat(40);
  const runs = (names) => names.map((name, id) => ({ id: id + 1, name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }));
  const oldRuns = runs(POLICIES['ci-v1'].required), newRuns = runs(POLICIES['ci-v2'].required);
  const againstOld = evaluateRequired({ policy: POLICIES['ci-v1'], head, checks: newRuns });
  assert.equal(againstOld.status, 'WAITING');
  assert.deepEqual(againstOld.missing, [...POLICIES['ci-v1'].required]);
  const againstNew = evaluateRequired({ policy: POLICIES['ci-v2'], head, checks: oldRuns });
  assert.equal(againstNew.status, 'WAITING');
  assert.deepEqual(againstNew.missing, [...POLICIES['ci-v2'].required]);

  const e = evidence();
  e.checks = newRuns.map((check) => ({ ...check, head_sha: e.head }));
  assert.equal(assess(e).status, 'WAITING_CI');
});

test('the consumer refuses missing, failed, skipped, foreign-app and foreign-head required checks', () => {
  const states = {
    missing: (check, e) => { e.checks = e.checks.filter((item) => item !== check); },
    failure: (check) => { check.conclusion = 'failure'; },
    skipped: (check) => { check.conclusion = 'skipped'; },
    'foreign-app': (check) => { check.app = { slug: 'other-app' }; },
    'foreign-head': (check) => { check.head_sha = 'b'.repeat(40); },
  };
  for (const name of requiredChecks) {
    for (const [state, mutate] of Object.entries(states)) {
      const e = evidence();
      mutate(e.checks.find((item) => item.name === name), e);
      const expected = ['failure', 'skipped'].includes(state) ? 'NEEDS_FIX' : 'WAITING_CI';
      assert.equal(assess(e).status, expected, `${name}: ${state}`);
    }
  }
});
