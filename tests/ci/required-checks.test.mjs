import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVE_POLICY_ID,
  CHECK_JOBS,
  GITHUB_ACTIONS_APP_ID,
  MUTATION_CHECK_NAME,
  POLICIES,
  createPolicyState,
  evaluateRequired,
  parseHistoricalBindings,
  resolvePolicy,
} from '../../scripts/ci/required-checks.mjs';

const OLD = [
  'contributor-checks (ubuntu-latest)',
  'contributor-checks (windows-latest)',
  'runtime-checks (ubuntu-latest)',
  'runtime-checks (windows-latest)',
];
const NEW = [
  'static-lint',
  'static-types',
  'repository-policy',
  'pr-metadata',
  'build (ubuntu-latest)',
  'build (windows-latest)',
  'contributor-tooling-tests (ubuntu-latest)',
  'contributor-tooling-tests (windows-latest)',
  'runtime-tests (ubuntu-latest)',
  'runtime-tests (windows-latest)',
];

const sha = (char) => char.repeat(40);
const mergeSha = (char) => char.repeat(64);

function binding(overrides = {}) {
  return {
    repositoryId: 1419608901,
    number: 117,
    head: sha('a'),
    headRepositoryId: 1419608901,
    tree: sha('b'),
    policy: 'ci-v1',
    ...overrides,
  };
}

function mergedPr(overrides = {}) {
  return {
    state: 'MERGED',
    repositoryId: 1419608901,
    number: 117,
    head: sha('a'),
    headRepositoryId: 1419608901,
    tree: sha('b'),
    ...overrides,
  };
}

function config(entries) {
  return JSON.stringify({ schemaVersion: 1, entries });
}

test('each policy owns one immutable ordered name list and no aggregate or mutation gate', () => {
  assert.deepEqual([...POLICIES['ci-v1'].required], OLD);
  assert.deepEqual([...POLICIES['ci-v2'].required], NEW);
  assert.equal(new Set(NEW).size, NEW.length);
  assert.equal(Object.values(POLICIES).some((policy) => policy.required.includes(MUTATION_CHECK_NAME)), false);
  assert.equal(Object.isFrozen(POLICIES['ci-v2'].required), true);
  assert.throws(() => { POLICIES['ci-v2'].required.push('extra'); });
});

test('stage A2 makes ci-v2 the only active current policy and ci-v1 historical', () => {
  assert.equal(ACTIVE_POLICY_ID, 'ci-v2', 'the activation switch is this single reviewed constant');
  const state = createPolicyState(ACTIVE_POLICY_ID);
  assert.deepEqual([...state.policy.required], NEW);
  assert.deepEqual([...state.historical], ['ci-v1'], 'ci-v1 stays assessable only through a binding');
  assert.throws(() => createPolicyState('ci-v9'), /Unknown check policy/);
  assert.throws(() => createPolicyState(undefined), /Unknown check policy/);
  // The mutation report is never required; all ten required names and the report are distinct jobs.
  assert.equal(NEW.includes(MUTATION_CHECK_NAME), false);
});

test('the active policy is a constant, not a value read from the environment or PR input', () => {
  assert.equal(ACTIVE_POLICY_ID, 'ci-v2');
  for (const name of ['CHECK_POLICY', 'CI_POLICY', 'ACTIVE_POLICY_ID', 'GITHUB_BASE_REF', 'GITHUB_HEAD_REF']) {
    process.env[name] = 'ci-v1';
    try {
      assert.deepEqual([...createPolicyState(ACTIVE_POLICY_ID).policy.required], NEW, `${name} must not select a policy`);
      assert.ok(ACTIVE_POLICY_ID in POLICIES);
    } finally {
      delete process.env[name];
    }
  }
  // resolvePolicy takes the policy as an argument and reads bindings only from the audited state, so a
  // PR object can smuggle in neither a policy nor the binding that would justify one.
  assert.throws(() => resolvePolicy(createPolicyState('ci-v2'), { policyId: 'ci-v1', pr: mergedPr() }), /audited binding/i);
  assert.throws(() => resolvePolicy(createPolicyState('ci-v2'), { policyId: 'ci-v1', pr: mergedPr({ binding: binding() }) }), /audited binding/i, 'a binding smuggled through the PR is ignored');
});

test('an inactive policy is refused rather than silently substituted', () => {
  const state = createPolicyState('ci-v1');
  assert.throws(() => resolvePolicy(state, { policyId: 'ci-v2' }), /not active/);
  assert.throws(() => resolvePolicy(state, { policyId: 'ci-v3' }), /Unknown check policy/);
  assert.throws(() => resolvePolicy(state, {}), /Unknown check policy/);
  const current = resolvePolicy(state, { policyId: 'ci-v1' });
  assert.equal(current.historical, false);
  assert.deepEqual([...current.policy.required], OLD);
});

test('after activation an open head cannot select ci-v1 while an exact merged head can', () => {
  const state = createPolicyState('ci-v2', [binding()]);
  assert.deepEqual([...state.policy.required], NEW);
  assert.deepEqual([...state.historical], ['ci-v1']);

  assert.equal(resolvePolicy(state, { policyId: 'ci-v2' }).historical, false);
  assert.equal(resolvePolicy(state, { policyId: 'ci-v2', pr: mergedPr() }).historical, false, 'current policy ignores historical identity');

  const exact = resolvePolicy(state, { policyId: 'ci-v1', pr: mergedPr() });
  assert.equal(exact.historical, true);
  assert.deepEqual([...exact.policy.required], OLD);

  for (const stateName of ['OPEN', 'CLOSED']) {
    assert.throws(() => resolvePolicy(state, { policyId: 'ci-v1', pr: mergedPr({ state: stateName }) }), /merged/i, stateName);
  }
  const substitutions = {
    repositoryId: 999,
    number: 118,
    head: sha('c'),
    headRepositoryId: 555,
    tree: sha('d'),
  };
  for (const [field, value] of Object.entries(substitutions)) {
    assert.throws(() => resolvePolicy(state, { policyId: 'ci-v1', pr: mergedPr({ [field]: value }) }), /identity/i, field);
  }
  assert.throws(() => resolvePolicy(createPolicyState('ci-v2'), { policyId: 'ci-v1', pr: mergedPr() }), /audited binding/i, 'an empty audited list admits no historical policy');
  assert.throws(() => resolvePolicy(state, { policyId: 'ci-v1' }), /merged/i);
});

test('an identity field missing on both sides is not a match', () => {
  // Comparing folded(undefined) === folded(undefined) would make an unaudited pairing look equal, so a
  // binding that names no identity must not admit a pull request that names none either.
  const state = createPolicyState('ci-v2', [{ policy: 'ci-v1' }]);
  assert.throws(
    () => resolvePolicy(state, { policyId: 'ci-v1', pr: { state: 'MERGED' } }),
    /audited binding/i,
    'two absences are an unaudited identity, not a matching one',
  );
});

test('an upper-case binding matches the same identity in either case', () => {
  const upper = binding({ head: sha('a').toUpperCase(), tree: sha('b').toUpperCase() });
  const state = createPolicyState('ci-v2', [upper]);
  const resolved = resolvePolicy(state, { policyId: 'ci-v1', pr: mergedPr() });
  assert.equal(resolved.historical, true, 'hex case is not identity');
  assert.deepEqual(parseHistoricalBindings(config([upper])), [upper], 'stored values keep their supplied case');
});

test('historical bindings reject wildcards, duplicates, unknown policies and unknown keys', () => {
  assert.deepEqual(parseHistoricalBindings(config([binding()])), [binding()]);

  const wildcards = [
    binding({ head: '*' }),
    binding({ tree: 'b*' }),
    binding({ head: sha('a').replace(/a$/, '?') }),
    binding({ number: '*' }),
    binding({ repositoryId: '14*' }),
  ];
  for (const entry of wildcards) assert.throws(() => parseHistoricalBindings(config([entry])), /wildcard|identity|invalid/i, JSON.stringify(entry));

  assert.throws(() => parseHistoricalBindings(config([binding(), binding({ number: 117 })])), /duplicate/i);
  assert.throws(() => parseHistoricalBindings(config([binding({ policy: 'ci-v2' })])), /policy/i);
  assert.throws(() => parseHistoricalBindings(config([binding({ convention: 3 })])), /convention/i);
  assert.throws(() => parseHistoricalBindings(config([binding({ extra: 1 })])), /unknown/i);
  assert.throws(() => parseHistoricalBindings(config([binding({ head: sha('a').slice(0, 39) })])), /identity/i);
  assert.throws(() => parseHistoricalBindings('{'), /JSON/i);
  assert.throws(() => parseHistoricalBindings(JSON.stringify({ schemaVersion: 2, entries: [] })), /schema/i);
  assert.throws(() => parseHistoricalBindings(JSON.stringify({ schemaVersion: 1 })), /entries/i);
  assert.deepEqual(parseHistoricalBindings(config([])), []);
  assert.deepEqual(parseHistoricalBindings(config([binding({ head: mergeSha('a'), tree: mergeSha('b') })])), [binding({ head: mergeSha('a'), tree: mergeSha('b') })]);
});

test('every required name maps to a workflow job so counterparts can be required', () => {
  for (const policy of Object.values(POLICIES)) {
    for (const name of policy.required) {
      assert.ok(CHECK_JOBS[name], `missing job mapping for ${name}`);
      assert.match(CHECK_JOBS[name].workflow, /^\.github\/workflows\/[a-z-]+\.yml$/);
      assert.ok(CHECK_JOBS[name].job.length > 0);
    }
  }
  assert.equal(CHECK_JOBS[MUTATION_CHECK_NAME], undefined);
});

function run(name, overrides = {}) {
  return { id: 1, name, head_sha: sha('a'), status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, details_url: `https://example.invalid/${name}`, ...overrides };
}

test('a complete set of current-head successful checks is ready', () => {
  const policy = POLICIES['ci-v1'];
  const result = evaluateRequired({ policy, head: sha('a'), checks: OLD.map((name, index) => run(name, { id: index + 1 })) });
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.failed, []);
});

test('missing, pending, skipped, cancelled and latest-failure results are never ready', () => {
  const policy = POLICIES['ci-v2'];
  const complete = NEW.map((name, index) => run(name, { id: index + 1 }));
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: complete }).status, 'READY');

  const without = (name) => complete.filter((check) => check.name !== name);
  for (const name of NEW) {
    const missing = evaluateRequired({ policy, head: sha('a'), checks: without(name) });
    assert.equal(missing.status, 'WAITING', name);
    assert.deepEqual(missing.missing, [name]);

    for (const [status, conclusion] of [['in_progress', null], ['queued', null], ['completed', 'skipped'], ['completed', 'cancelled'], ['completed', 'failure'], ['completed', 'timed_out']]) {
      const checks = complete.map((check) => check.name === name ? { ...check, status, conclusion } : check);
      const result = evaluateRequired({ policy, head: sha('a'), checks });
      const expected = status === 'completed' ? 'FAILED' : 'WAITING';
      assert.equal(result.status, expected, `${name} ${status}/${conclusion}`);
      if (expected === 'FAILED') assert.deepEqual(result.failed, [name]);
    }
  }
});

test('latest rerun supersedes an older success and foreign head or app never counts', () => {
  const policy = POLICIES['ci-v1'];
  const base = OLD.map((name, index) => run(name, { id: index + 1 }));
  const withRerun = [...base, run(OLD[0], { id: 50, conclusion: 'failure' })];
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: withRerun }).status, 'FAILED');

  const recovered = [...base, run(OLD[0], { id: 50, conclusion: 'failure' }), run(OLD[0], { id: 51 })];
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: recovered }).status, 'READY');

  const staleHead = base.map((check, index) => index === 0 ? { ...check, head_sha: sha('c') } : check);
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: staleHead }).status, 'WAITING');
  assert.deepEqual(evaluateRequired({ policy, head: sha('a'), checks: staleHead }).missing, [OLD[0]]);

  const foreignApp = base.map((check, index) => index === 1 ? { ...check, app: { slug: 'other-app' } } : check);
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: foreignApp }).status, 'WAITING');

  const otherAppId = base.map((check, index) => index === 2 ? { ...check, app: { slug: 'github-actions', id: 1 } } : check);
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: otherAppId, appId: GITHUB_ACTIONS_APP_ID }).status, 'WAITING');
  assert.equal(evaluateRequired({ policy, head: sha('a'), checks: otherAppId }).status, 'READY');
});

test('input is validated before assessment and never mutated', () => {
  const policy = POLICIES['ci-v1'];
  const checks = OLD.map((name, index) => run(name, { id: index + 1 }));
  const snapshot = JSON.stringify(checks);
  evaluateRequired({ policy, head: sha('a'), checks });
  assert.equal(JSON.stringify(checks), snapshot);

  assert.throws(() => evaluateRequired({ policy, head: 'abc', checks }), /head/i);
  assert.throws(() => evaluateRequired({ policy, head: sha('a'), checks: {} }), /array/i);
  assert.throws(() => evaluateRequired({ policy: 'ci-v1', head: sha('a'), checks }), /policy/i);
  assert.throws(() => evaluateRequired({ policy, head: sha('a'), checks: [null] }), /check/i);
});
