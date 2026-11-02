import assert from 'node:assert/strict';
import test from 'node:test';
import type { BugTask, CheckDefinition, CheckResult, ModelPort, ModelPortResult, RepositoryPort, SourceEvidence, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { createCoderAgent, parseCoderProposal, type CoderBudget } from '../../../src/uc03/agent.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureProviderRequest, createFixtureSourceEvidence, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

const USAGE = { inputTokens: 100, outputTokens: 20, costUsd: 0.001, billableTokens: 120 };
const BUDGET: CoderBudget = { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };
const DIFF = ['--- a/src/calculator.py', '+++ b/src/calculator.py', '@@ -1,2 +1,2 @@', ' def divide(a, b):', '-    return a / b', '+    return a / b', ''].join('\n');

function content(value: unknown): string {
  return JSON.stringify(value);
}

function observed(body: unknown): ModelPortResult {
  return { outcome: 'observed', result: { proposal: { proposalId: 'p-1', content: content(body) }, observedUsage: USAGE } };
}

function fakeRepository() {
  const calls: string[] = [];
  const repository: RepositoryPort = {
    provenance: 'mock',
    async listDir(path) {
      calls.push(`listDir:${path}`);
      return ['src'];
    },
    async readFile(path): Promise<SourceEvidence> {
      calls.push(`readFile:${path}`);
      return createFixtureSourceEvidence({ path });
    },
    async searchCode(query) {
      calls.push(`searchCode:${query}`);
      return [createFixtureSourceEvidence()];
    },
    async applyPatch() {
      calls.push('applyPatch');
      return { applied: false, newRevisionDigest: '' };
    },
    async runCommand() {
      calls.push('runCommand');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async runTests(check: CheckDefinition): Promise<CheckResult> {
      calls.push(`runTests:${check.checkId}`);
      return { checkId: check.checkId, outcome: 'pass' };
    },
    async inspectDiff() {
      calls.push('inspectDiff');
      return { diff: '', diffDigest: '', changedFiles: [] };
    },
  };
  return { calls, repository };
}

function setup(
  respond: (state: TaskState) => ModelPortResult | Promise<ModelPortResult>,
  overrides?: { readonly budget?: CoderBudget; readonly state?: Partial<TaskState>; readonly task?: Partial<BugTask>; readonly now?: () => number },
) {
  const task = createFixtureBugTask(overrides?.task);
  const state = createFixtureTaskState({ taskContext: task, ...overrides?.state });
  const request = createFixtureProviderRequest();
  const evidence = [createFixtureSourceEvidence()];
  const modelCalls: TaskState[] = [];
  const propose: ModelPort['propose'] = async current => {
    modelCalls.push(current);
    return respond(current);
  };
  const repo = fakeRepository();
  const agent = createCoderAgent({ propose, repository: repo.repository, budget: overrides?.budget ?? BUDGET, now: overrides?.now });
  return { task, state, request, evidence, modelCalls, repo, agent };
}

const PLAN = {
  kind: 'propose-plan',
  proposalId: 'plan-1',
  diagnosis: 'divide does not guard a zero denominator',
  strategy: 'raise CalculationError when b is zero',
  suspectedLocations: ['src/calculator.py'],
  scopedPaths: ['src/calculator.py'],
  evidenceRefs: ['src/calculator.py'],
};

const FIX_PLAN = {
  planVersion: 1,
  diagnosis: 'd',
  suspectedCauseLocations: ['src/calculator.py'],
  evidenceRefs: ['src/calculator.py'],
  strategy: 's',
  scopedChanges: ['src/calculator.py'],
  checkSetDigest: 'sha256:c',
  baselineRef: 'sha256:b',
  strategyDigest: 'sha256:plan',
};

test('parses each of the five proposal variants', () => {
  const cases: readonly unknown[] = [
    { kind: 'inspect', proposalId: 'i-1', operation: 'list_dir', args: { path: 'src' } },
    { kind: 'inspect', proposalId: 'i-2', operation: 'read_file', args: { path: 'src/calculator.py' } },
    { kind: 'inspect', proposalId: 'i-3', operation: 'search_code', args: { query: 'def divide' } },
    { kind: 'inspect', proposalId: 'i-4', operation: 'run_check', args: { checkId: 'check-pytest-reproduction' } },
    PLAN,
    { kind: 'propose-patch', proposalId: 'patch-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' },
    { kind: 'request-info', proposalId: 'q-1', questions: [{ questionId: 'q1', text: 'Which exception type is expected?' }], evidenceRefs: [] },
    { kind: 'stop', proposalId: 's-1', reasonCode: 'reproduction-unclear', summary: 'No failing test found', evidenceRefs: [] },
  ];
  for (const body of cases) {
    const result = parseCoderProposal(content(body));
    assert.equal(result.ok, true, JSON.stringify(body));
  }
});

test('rejects malformed, unknown-kind, extra-field and multi-action proposals', () => {
  const cases: readonly { readonly raw: string; readonly code: string }[] = [
    { raw: '{', code: 'MALFORMED_JSON' },
    { raw: '[]', code: 'INVALID_TYPE' },
    { raw: content({ kind: 'deploy', proposalId: 'x' }), code: 'UNKNOWN_KIND' },
    { raw: content({ kind: 'stop', proposalId: 's-1', reasonCode: 'r', summary: 's', evidenceRefs: [], actions: [] }), code: 'UNKNOWN_PROPERTY' },
    { raw: content({ ...PLAN, executable: 'bash' }), code: 'UNKNOWN_PROPERTY' },
    { raw: content({ kind: 'inspect', proposalId: 'i-1', operation: 'run_check', args: { checkId: 'c', argv: ['-x'] } }), code: 'UNKNOWN_PROPERTY' },
    { raw: content({ ...PLAN, evidenceRefs: ['a'], secondAction: { kind: 'stop' } }), code: 'UNKNOWN_PROPERTY' },
    { raw: content({ kind: 'inspect', proposalId: 'bad id', operation: 'list_dir', args: { path: 'src' } }), code: 'INVALID_IDENTIFIER' },
    { raw: content({ kind: 'inspect', proposalId: 'i-1', operation: 'shell', args: {} }), code: 'UNKNOWN_OPERATION' },
  ];
  for (const { raw, code } of cases) {
    const result = parseCoderProposal(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.ok ? undefined : result.errors[0]?.code, code, raw);
  }
});

test('rejects absolute, escaping and protected paths', () => {
  for (const path of [
    '/etc/passwd',
    'C:/secrets.txt',
    '../outside.py',
    './src/calculator.py',
    'src/../x.py',
    'agents.md',
    '.git/config',
    'eval/uc03/private/answer.json',
    'private/grading/key.json',
  ]) {
    const result = parseCoderProposal(content({ kind: 'inspect', proposalId: 'i-1', operation: 'read_file', args: { path } }));
    assert.equal(result.ok, false, path);
  }
});

test('enforces every UTF-8 byte and list bound', () => {
  const big = (bytes: number): string => 'a'.repeat(bytes);
  const cases: readonly { readonly body: unknown; readonly code: string }[] = [
    { body: { ...PLAN, diagnosis: big(4097) }, code: 'INVALID_PROSE' },
    { body: { ...PLAN, diagnosis: 'é'.repeat(2049) }, code: 'INVALID_PROSE' },
    { body: { kind: 'inspect', proposalId: 'i-1', operation: 'search_code', args: { query: big(1025) } }, code: 'QUERY_TOO_LONG' },
    { body: { kind: 'inspect', proposalId: 'i-1', operation: 'list_dir', args: { path: `${big(520)}/x.py` } }, code: 'PATH_TOO_LONG' },
    { body: { kind: 'inspect', proposalId: big(129), operation: 'list_dir', args: { path: 'src' } }, code: 'INVALID_IDENTIFIER' },
    { body: { ...PLAN, evidenceRefs: [big(129)] }, code: 'REF_TOO_LONG' },
    { body: { ...PLAN, scopedPaths: Array.from({ length: 17 }, (_, index) => `src/f${String(index)}.py`) }, code: 'LIST_TOO_LONG' },
    { body: { ...PLAN, evidenceRefs: [] }, code: 'LIST_TOO_LONG' },
    { body: { kind: 'propose-patch', proposalId: 'p-1', diff: `${DIFF}${big(48 * 1024)}`, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }, code: 'DIFF_TOO_LONG' },
    { body: { kind: 'request-info', proposalId: 'q-1', questions: [], evidenceRefs: [] }, code: 'LIST_TOO_LONG' },
    { body: { kind: 'stop', proposalId: 's-1', reasonCode: 'Success', summary: 'done', evidenceRefs: [] }, code: 'UNSAFE_REASON' },
    {
      body: {
        kind: 'request-info',
        proposalId: 'q-1',
        questions: [
          { questionId: 'q1', text: 'a' },
          { questionId: 'q1', text: 'b' },
        ],
        evidenceRefs: [],
      },
      code: 'DUPLICATE_QUESTION',
    },
  ];
  for (const { body, code } of cases) {
    const result = parseCoderProposal(content(body));
    assert.equal(result.ok, false, code);
    assert.equal(result.ok ? undefined : result.errors[0]?.code, code);
  }
  const oversized = `{"kind":"stop","proposalId":"s-1","reasonCode":"r","summary":"${big(64 * 1024)}","evidenceRefs":[]}`;
  assert.equal(parseCoderProposal(oversized).ok, false);
});

test('rejects a non-unified diff without touching the repository', async () => {
  const context = setup(() => observed({ kind: 'propose-patch', proposalId: 'p-1', diff: 'not a diff', targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }));
  const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.outcome === 'invalid' ? result.reason : '', 'PROPOSAL_INVALID:DIFF_NOT_UNIFIED');
  assert.deepEqual(context.repo.calls, []);
});

test('dispatches only admitted inspect tools through the repository', async () => {
  for (const [body, expected] of [
    [{ kind: 'inspect', proposalId: 'i-1', operation: 'list_dir', args: { path: 'src' } }, 'listDir:src'],
    [{ kind: 'inspect', proposalId: 'i-2', operation: 'read_file', args: { path: 'src/calculator.py' } }, 'readFile:src/calculator.py'],
    [{ kind: 'inspect', proposalId: 'i-3', operation: 'search_code', args: { query: 'divide' } }, 'searchCode:divide'],
    [{ kind: 'inspect', proposalId: 'i-4', operation: 'run_check', args: { checkId: 'check-pytest-reproduction' } }, 'runTests:check-pytest-reproduction'],
  ] as const) {
    const context = setup(() => observed(body));
    const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
    assert.equal(result.outcome, 'proposal');
    assert.deepEqual(context.repo.calls, [expected]);
  }
});

test('refuses an unconfigured check id before any tool call', async () => {
  const context = setup(() => observed({ kind: 'inspect', proposalId: 'i-1', operation: 'run_check', args: { checkId: 'check-hidden-grader' } }));
  const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.outcome === 'invalid' ? result.reason : '', 'CHECK_NOT_CONFIGURED');
  assert.deepEqual(context.repo.calls, []);
});

test('binds plan, info and stop proposals to observed evidence', async () => {
  for (const body of [
    PLAN,
    { kind: 'request-info', proposalId: 'q-1', questions: [{ questionId: 'q1', text: 'Which error?' }], evidenceRefs: ['src/calculator.py'] },
    { kind: 'stop', proposalId: 's-1', reasonCode: 'blocked', summary: 'No route', evidenceRefs: ['evidence-baseline-001'] },
  ]) {
    const context = setup(() => observed(body));
    const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
    assert.equal(result.outcome, 'proposal', JSON.stringify(body));
  }
  const unbound = setup(() => observed({ ...PLAN, evidenceRefs: ['evidence-unknown-999'] }));
  const result = await unbound.agent.turn(unbound.task, unbound.state, unbound.evidence, unbound.request);
  assert.equal(result.outcome === 'invalid' ? result.reason : '', 'EVIDENCE_NOT_BOUND');
});

test('binds a patch to the current plan and refuses private oracle paths', async () => {
  const plan = {
    planVersion: 1,
    diagnosis: 'zero denominator',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: ['src/calculator.py'],
    strategy: 'guard zero',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:checks',
    baselineRef: 'sha256:base',
    strategyDigest: 'sha256:plan',
  };
  const withPlan = { plan, node: 'Patch' as const };
  const accepted = setup(() => observed({ kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }), { state: withPlan });
  assert.equal((await accepted.agent.turn(accepted.task, accepted.state, accepted.evidence, accepted.request)).outcome, 'proposal');

  const cases: readonly { readonly body: unknown; readonly state: Partial<TaskState>; readonly reason: string }[] = [
    { body: { kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }, state: {}, reason: 'PATCH_WITHOUT_PLAN' },
    {
      body: { kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:stale' },
      state: withPlan,
      reason: 'PLAN_REF_MISMATCH',
    },
    {
      body: { kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/other.py'], approvedPlanRef: 'sha256:plan' },
      state: withPlan,
      reason: 'PATCH_PATH_MISMATCH',
    },
    {
      body: {
        kind: 'propose-patch',
        proposalId: 'p-1',
        diff: ['--- a/eval/uc03/private/answer.json', '+++ b/eval/uc03/private/answer.json', '@@ -1 +1 @@', '-x', '+y', ''].join('\n'),
        targetPaths: ['eval/uc03/private/answer.json'],
        approvedPlanRef: 'sha256:plan',
      },
      state: { plan: { ...plan, scopedChanges: ['eval/uc03/private/answer.json'] }, node: 'Patch' as const },
      reason: 'INVALID_PATH',
    },
  ];
  for (const { body, state, reason } of cases) {
    const context = setup(() => observed(body), { state });
    const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
    assert.equal(result.outcome, 'invalid', reason);
    assert.match(result.outcome === 'invalid' ? result.reason : '', new RegExp(reason));
    assert.deepEqual(context.repo.calls, []);
  }
});

test('counts model-output failures and never throws', async () => {
  const failures: readonly (() => ModelPortResult)[] = [
    () => ({ outcome: 'denied', reason: 'BUDGET' }),
    () => ({ outcome: 'uncertain', reason: 'TIMEOUT' }),
    () => ({ outcome: 'invalid', errors: [] }),
    () => ({ outcome: 'observed', result: { proposal: { proposalId: 'p-1', content: 'nope' }, observedUsage: USAGE } }),
  ];
  for (const respond of failures) {
    const context = setup(respond);
    const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
    assert.equal(result.outcome, 'invalid');
    assert.equal(context.agent.counters.modelOutputFailures, 1);
    assert.equal(context.agent.counters.modelCalls, 1);
  }
  const throwing = setup(() => {
    throw new Error('boom');
  });
  assert.equal((await throwing.agent.turn(throwing.task, throwing.state, throwing.evidence, throwing.request)).outcome, 'invalid');
  assert.equal(throwing.agent.counters.modelOutputFailures, 1);
});

test('makes no model call while a human decision is pending', async () => {
  for (const node of ['AwaitPlan', 'AwaitFeedback', 'NeedsInfo'] as const) {
    const context = setup(() => observed(PLAN), { state: { node } });
    const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
    assert.equal(result.outcome, 'waiting');
    assert.deepEqual(context.modelCalls, []);
    assert.equal(context.agent.counters.modelCalls, 0);
  }
});

test('enforces finite model-call, active-time, repair and replan budgets', async () => {
  const calls = setup(() => observed({ kind: 'inspect', proposalId: 'i-1', operation: 'list_dir', args: { path: 'src' } }), { budget: { ...BUDGET, maxModelCalls: 1 } });
  assert.equal((await calls.agent.turn(calls.task, calls.state, calls.evidence, calls.request)).outcome, 'proposal');
  const exhausted = await calls.agent.turn(calls.task, calls.state, calls.evidence, calls.request);
  assert.equal(exhausted.outcome === 'invalid' ? exhausted.reason : '', 'MODEL_CALL_BUDGET_EXHAUSTED');
  assert.equal(calls.modelCalls.length, 1);

  let clock = 0;
  const slow = setup(
    () => {
      clock += 5;
      return observed(PLAN);
    },
    { budget: { ...BUDGET, maxActiveMs: 3 }, now: () => clock },
  );
  assert.equal((await slow.agent.turn(slow.task, slow.state, slow.evidence, slow.request)).outcome, 'invalid');
  const timedOut = await slow.agent.turn(slow.task, slow.state, slow.evidence, slow.request);
  assert.equal(timedOut.outcome === 'invalid' ? timedOut.reason : '', 'ACTIVE_TIME_BUDGET_EXHAUSTED');
  assert.equal(slow.modelCalls.length, 1);

  const plan = {
    planVersion: 1,
    diagnosis: 'd',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: ['src/calculator.py'],
    strategy: 's',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:c',
    baselineRef: 'sha256:b',
    strategyDigest: 'sha256:plan',
  };
  const replans = setup(() => observed(PLAN), { state: { plan }, budget: { ...BUDGET, maxReplans: 0 } });
  const replanResult = await replans.agent.turn(replans.task, replans.state, replans.evidence, replans.request);
  assert.equal(replanResult.outcome === 'invalid' ? replanResult.reason : '', 'REPLAN_BUDGET_EXHAUSTED');

  const repairs = setup(() => observed({ kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }), {
    state: { plan, node: 'Repair' },
    budget: { ...BUDGET, maxRepairs: 0 },
  });
  const repairResult = await repairs.agent.turn(repairs.task, repairs.state, repairs.evidence, repairs.request);
  assert.equal(repairResult.outcome === 'invalid' ? repairResult.reason : '', 'REPAIR_BUDGET_EXHAUSTED');
});

test('allows only a replan proposal at AwaitFeedback and charges the replan budget', async () => {
  const context = setup(() => observed(PLAN), { state: { node: 'AwaitFeedback', plan: FIX_PLAN } });
  const replan = createFixtureProviderRequest({ purpose: 'propose-replan' });
  const result = await context.agent.turn(context.task, context.state, context.evidence, replan);
  assert.equal(result.outcome, 'proposal');
  assert.equal(context.agent.counters.replans, 1);
  assert.equal(context.agent.counters.modelCalls, 1);
  const before = context.agent.counters.replans;
  const again = await context.agent.turn(context.task, context.state, context.evidence, replan);
  assert.deepEqual(again, { outcome: 'invalid', reason: 'REPLAN_BUDGET_EXHAUSTED', counters: { ...context.agent.counters } });
  assert.equal(context.agent.counters.replans, before);

  const patch = createFixtureProviderRequest({ purpose: 'propose-patch' });
  const patched = await context.agent.turn(context.task, context.state, context.evidence, patch);
  assert.deepEqual(patched, { outcome: 'waiting', reason: 'HUMAN_WAIT:AwaitFeedback', counters: { ...context.agent.counters } });

  for (const node of ['NeedsInfo', 'AwaitPlan'] as const) {
    for (const purpose of ['propose-plan', 'propose-replan', 'propose-patch'] as const) {
      const waiting = setup(() => observed(PLAN), { state: { node, plan: FIX_PLAN } });
      const outcome = await waiting.agent.turn(waiting.task, waiting.state, waiting.evidence, createFixtureProviderRequest({ purpose }));
      assert.equal(outcome.outcome, 'waiting', `${node}/${purpose}`);
      assert.deepEqual(waiting.modelCalls, []);
      assert.equal(waiting.agent.counters.modelCalls, 0);
    }
  }
});

test('counts repairs and replans under budget without mutating inputs', async () => {
  const plan = {
    planVersion: 1,
    diagnosis: 'd',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: ['src/calculator.py'],
    strategy: 's',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:c',
    baselineRef: 'sha256:b',
    strategyDigest: 'sha256:plan',
  };
  const context = setup(() => observed({ kind: 'propose-patch', proposalId: 'p-1', diff: DIFF, targetPaths: ['src/calculator.py'], approvedPlanRef: 'sha256:plan' }), {
    state: { plan, node: 'Repair' },
  });
  const before = JSON.stringify({ task: context.task, state: context.state, evidence: context.evidence, request: context.request });
  const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
  assert.equal(result.outcome, 'proposal');
  assert.equal(context.agent.counters.repairs, 1);
  assert.equal(context.agent.counters.modelCalls, 1);
  assert.equal(JSON.stringify({ task: context.task, state: context.state, evidence: context.evidence, request: context.request }), before);
});

test('requires an explicit finite budget at construction', () => {
  const { repository } = fakeRepository();
  const propose: ModelPort['propose'] = async () => observed(PLAN);
  assert.throws(() => createCoderAgent({ propose, repository, budget: { ...BUDGET, maxModelCalls: Number.POSITIVE_INFINITY } }), /INVALID_BUDGET/u);
  assert.throws(() => createCoderAgent({ propose, repository, budget: undefined as unknown as CoderBudget }), /INVALID_BUDGET/u);
});

test('accepts unconfigured check ids only through task.requiredChecks', async () => {
  const task = createFixtureBugTask({ requiredChecks: [createFixtureCheckDefinition({ checkId: 'check-other' })] });
  const context = setup(() => observed({ kind: 'inspect', proposalId: 'i-1', operation: 'run_check', args: { checkId: 'check-pytest-reproduction' } }), { task, state: { taskContext: task } });
  const result = await context.agent.turn(context.task, context.state, context.evidence, context.request);
  assert.equal(result.outcome === 'invalid' ? result.reason : '', 'CHECK_NOT_CONFIGURED');
  assert.deepEqual(context.repo.calls, []);
});
