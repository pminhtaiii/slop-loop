import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assess, runWorkflow } from '../../scripts/agents/pr-workflow.mjs';
import { workflowSummary } from '../../scripts/agents/pr-workflow-status.mjs';
import { ACTIVE_POLICY_ID, POLICIES, createPolicyState, evaluateRequired, resolvePolicy } from '../../scripts/ci/required-checks.mjs';
import { checkout, evidence, requiredChecks } from './support/pr-workflow-fixture.mjs';

const scoped = (overrides = {}) => {
  const e = evidence(), branch = 'feat/tooling-example';
  Object.assign(e.pr, { headRefName: branch, title: `${branch}: add the example workflow` }, overrides);
  return { ...e, convention: 2 };
};

test('a body-only edit at an unchanged head cannot ride an older passing same-head check', () => {
  const green = scoped();
  assert.equal(assess(green).status, 'READY_FOR_HUMAN', 'the valid candidate is unaffected');
  for (const body of ['plain text', '## Summary\n\nchange\n\n## Evidence\n\nchecks\n\n## Merge Danger\n\n**Door:** revert.\n\n**Blast Radius:** tooling.\n\n## Summary\n\nsecond']) {
    const edited = scoped({ body });
    edited.checks = green.checks.map((check) => ({ ...check }));
    const result = assess(edited);
    assert.equal(result.status, 'BLOCKED', body.slice(0, 20));
    assert.doesNotMatch(result.reason, /plain text|change|revert/, 'the reason names the field and rule, never the body');
  }
  assert.equal(assess(scoped({ body: undefined })).status, 'BLOCKED', 'a missing live body is not a skip');
  assert.equal(assess(scoped({ isDraft: true })).status, 'READY_FOR_HUMAN', 'a validated draft stays a separate human state');
});

test('status refuses live metadata edited after the passing same-head check and unreadable metadata', async (t) => {
  const f = await checkout(t);
  await f.run('publish', '--body-file', f.body);
  assert.equal((await f.run('status')).status, 'READY_FOR_HUMAN');
  f.e.pr.body = 'plain text';
  assert.equal((await f.run('status')).status, 'BLOCKED', 'green checks on the same head do not admit an edited body');
  f.e.pr.body = '## Summary\n\nStandardize tooling.\n\n## Evidence\n\nVerified.\n\n## Merge Danger\n\n**Door:** revert.\n\n**Blast Radius:** tooling.';
  assert.equal((await f.run('status')).status, 'READY_FOR_HUMAN');
  await assert.rejects(runWorkflow(['status', '--root', f.root], {
    execute(binary, args, cwd, timeout) {
      if (binary === 'gh' && args[0] === 'api' && args[1] === 'graphql') throw new Error('simulated metadata read failure');
      return f.execute(binary, args, cwd, timeout);
    },
  }), /metadata could not be read/);
  const record = JSON.parse(await readFile(join(f.root, '.agent-work/pr-workflow/010-tooling-example.json'), 'utf8'));
  assert.equal(record.status, 'BLOCKED', 'a failed metadata read stays non-ready');
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
  for (const name of ['runtime-tests (ubuntu-latest)']) {
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
  assert.equal(ACTIVE_POLICY_ID, 'ci-v3', 'Ubuntu-only activation keeps ci-v3 current; a consumer never changes the policy');
  // The retained policy must be readable, not merely stored.
  assert.equal(workflowSummary(record).checkPolicy, ACTIVE_POLICY_ID);

  // An unrecognised retained policy is refused instead of being trusted or ignored.
  record.checkPolicy = 'ci-v9';
  await writeFile(join(f.root, '.agent-work/pr-workflow/010-tooling-example.json'), `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(f.run('status'), /unknown check policy/i);
});

test('a ci-v3 selection resolves the seven ci-v3 names and demotes ci-v1 to an audited binding', () => {
  const v2 = resolvePolicy(createPolicyState('ci-v3'), { policyId: 'ci-v3' });
  assert.equal(v2.historical, false);
  assert.deepEqual([...v2.policy.required], [...POLICIES['ci-v3'].required]);
  assert.equal(v2.policy.required.length, 7);
  // Literal names, not a recomputation of createPolicyState: an oracle that recomputes the state it is
  // checking cannot detect a wrong activation.
  assert.equal(ACTIVE_POLICY_ID, 'ci-v3', 'production readiness selects ci-v3');
  assert.ok(v2.policy.required.includes('pr-metadata'), 'the activation add is still required');
  assert.ok(!v2.policy.required.includes('contributor-checks (ubuntu-latest)'), 'no legacy name survives into ci-v3');
  // After the switch ci-v1 is historical-only: no merged binding means no ci-v1 assessment at all.
  assert.deepEqual([...createPolicyState(ACTIVE_POLICY_ID).historical], ['ci-v1', 'ci-v2']);
  assert.throws(() => resolvePolicy(createPolicyState(ACTIVE_POLICY_ID), { policyId: 'ci-v1', pr: { state: 'OPEN' } }), /merged pull request/);
});

test('ci-v3 and ci-v1 names never satisfy each other, in the selector or the consumer', () => {
  const head = 'a'.repeat(40);
  const runs = (names) => names.map((name, id) => ({ id: id + 1, name, head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }));
  const oldRuns = runs(POLICIES['ci-v1'].required), newRuns = runs(POLICIES['ci-v3'].required);
  const againstOld = evaluateRequired({ policy: POLICIES['ci-v1'], head, checks: newRuns });
  assert.equal(againstOld.status, 'WAITING');
  assert.deepEqual(againstOld.missing, [...POLICIES['ci-v1'].required]);
  const againstNew = evaluateRequired({ policy: POLICIES['ci-v3'], head, checks: oldRuns });
  assert.equal(againstNew.status, 'WAITING');
  assert.deepEqual(againstNew.missing, [...POLICIES['ci-v3'].required]);

  // The consumer selects ci-v3, so ci-v1 names alone leave every current requirement missing.
  const e = evidence();
  e.checks = oldRuns.map((check) => ({ ...check, head_sha: e.head }));
  assert.equal(assess(e).status, 'WAITING_CI');
  // And a ci-v3 head is the one that reads as ready.
  e.checks = newRuns.map((check) => ({ ...check, head_sha: e.head }));
  assert.equal(assess(e).status, 'READY_FOR_HUMAN');
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
