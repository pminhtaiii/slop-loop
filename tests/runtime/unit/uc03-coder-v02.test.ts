/**
 * T026 — production coder turn (v0.2).
 *
 * The agent never claims: the model boundary owns claim/attempt/settle, so the only state methods
 * reachable from a turn are the ones the injected ModelPort calls itself. These tests assert that
 * behaviourally — a spy on the repository's statePort proves the agent adds no second claim.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeAdmissionDigest,
  computeCanonicalSha256,
  type CheckDefinition,
  type CheckResult,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type RepositoryAdmissionContextV02,
  type SourceEvidence,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import type { ExecutionGuardReadCapability, GuardedReadOperation } from '../../../src/foundation/repository-types.ts';
import { computeContextDigest, validateBaseModelInputs } from '../../../src/foundation/model.ts';
import { createCoderAgentV02, type CoderAgentV02Options } from '../../../src/uc03/agent.ts';
import { generate } from '../../../src/uc03/graph-nodes.ts';
import type { UC03GraphConfig } from '../../../src/uc03/graph-types.ts';
import type { CoderBudget, UC03CoderAdmission } from '../../../src/uc03/agent-types.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureProviderAdmissionContextV02, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { createTestProviderAdmissionTrustedContextV02 } from '../support/uc03/state-fixtures.ts';

const BUDGET: CoderBudget = { maxModelCalls: 3, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };
const PLAN = JSON.stringify({
  kind: 'propose-plan',
  proposalId: 'p-1',
  diagnosis: 'unhandled zero denominator',
  strategy: 'raise CalculationError when b is zero',
  suspectedLocations: ['src/calculator.py'],
  scopedPaths: ['src/calculator.py'],
  evidenceRefs: ['evidence-baseline-001'],
});

interface ModelCall {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
}

/** Records every dispatch so a test can prove zero calls rather than infer it. */
class RecordingModelPort implements ModelPortV02 {
  readonly provenance = 'mock' as const;
  readonly calls: ModelCall[] = [];
  readonly #respond: () => Promise<unknown>;
  readonly #validate: ((call: ModelCall) => void) | undefined;
  constructor(respond: () => Promise<unknown> = async () => ({ outcome: 'observed', result: { proposal: { proposalId: 'p-1', content: PLAN } } }), validate?: (call: ModelCall) => void) {
    this.#respond = respond;
    this.#validate = validate;
  }
  async propose(state: TaskState, evidence: readonly SourceEvidence[], request: ProviderRequest, context: ProviderAdmissionContextV02) {
    const call = { state, evidence, request, context };
    this.calls.push(call);
    this.#validate?.(call);
    return (await this.#respond()) as Awaited<ReturnType<ModelPortV02['propose']>>;
  }
}

/** Any reach into owner state from the agent would land here. */
function statePortSpy(): { port: Record<string, unknown>; calls: string[] } {
  const calls: string[] = [];
  const port: Record<string, unknown> = {};
  for (const method of ['loadTask', 'transition', 'claim', 'beginAttempt', 'recordOutcome', 'reconcileUncertain', 'closeUnattemptedClaim', 'recover']) {
    port[method] = async () => {
      calls.push(method);
      throw new Error(`AGENT_REACHED_OWNER_STATE:${method}`);
    };
  }
  return { port, calls };
}

function admit(
  state: TaskState,
  purpose: 'propose-plan' | 'propose-patch' | 'propose-repair' | 'propose-replan' = 'propose-plan',
  providerRequestId = 'req-v02-1',
  contextDigest = 'sha256:context-001',
): UC03CoderAdmission {
  const request: ProviderRequest = {
    providerRequestId,
    taskId: state.taskId,
    runId: state.runId,
    role: 'coder',
    purpose,
    providerId: 'provider-test',
    modelId: 'model-test-v1',
    configId: 'config-v1',
    pricingPolicyId: 'pricing-v1',
    contextDigest,
    timeoutMs: 30_000,
    maxInputTokens: 2_000,
    maxOutputTokens: 1_000,
    maxBillableTokens: 4_000,
    maxCostUsd: 0.1,
    reservationRef: 'bundle-001',
    dispatchState: 'reserved',
  };
  const context = createFixtureProviderAdmissionContextV02({
    providerRequest: request,
    expectedTaskStateVersion: state.stateVersion,
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'diagnose-zero-denominator',
    taskCriteriaDigest: computeCanonicalSha256(['criteria']),
    runnableNode: 'Investigate',
  });
  const prePlan = context as unknown as Record<string, unknown>;
  delete prePlan['planBindingDigest'];
  delete prePlan['planDecisionRef'];
  // The fixture seeds approved-plan fields and sealed a digest over them; deleting them without
  // resealing makes validateProviderAdmissionV02 reject the fixture itself (ADMISSION_DIGEST_MISMATCH).
  prePlan['admissionDigest'] = computeAdmissionDigest(prePlan);
  return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
}

function recordingGuardedRead(): { capability: ExecutionGuardReadCapability; kinds: string[] } {
  const kinds: string[] = [];
  const capability: ExecutionGuardReadCapability = {
    provenance: 'mock',
    capabilityId: 'cap-read-1',
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
      kinds.push(operation.kind);
      return operation.execute();
    },
  };
  return { capability, kinds };
}

function setup(options: Partial<CoderAgentV02Options> = {}) {
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const repository = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n', 'tests/test_calculator.py': 'def test_divide(): pass\n' },
  });
  const model = new RecordingModelPort();
  const agent = createCoderAgentV02({ model, repository, budget: BUDGET, ...options });
  return { task, state, repository, model, agent, admission: admit(state) };
}

test('the exact owner-issued context reaches the model fourth argument', async () => {
  const { task, state, model, agent, admission } = setup();
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission });
  assert.equal(result.outcome, 'proposal');
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]?.context, admission.context);
  assert.equal(model.calls[0]?.request, admission.request);
  assert.equal(model.calls[0]?.state, state);
});

test('the agent performs no claim, attempt or outcome of its own', async () => {
  const spy = statePortSpy();
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  // A RepositoryPort that also exposes owner state is exactly what a careless agent reaches for.
  const repository = Object.assign(new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }), { statePort: spy.port });
  const model = new RecordingModelPort();
  const agent = createCoderAgentV02({ model, repository, budget: BUDGET });
  await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.deepEqual(spy.calls, []);
  assert.equal(model.calls.length, 1);
});

test('a stale admission refuses with zero model calls', async () => {
  const { task, state, model, agent } = setup();
  const stale = admit({ ...state, stateVersion: state.stateVersion + 1 });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: stale });
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /ADMISSION/u);
  assert.equal(model.calls.length, 0);
});

test('a substituted request refuses with zero model calls', async () => {
  const { task, state, model, agent, admission } = setup();
  const substituted: UC03CoderAdmission = { ...admission, request: { ...admission.request, providerRequestId: 'req-other' } };
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: substituted });
  assert.equal(result.outcome, 'invalid');
  assert.equal(model.calls.length, 0);
});

test('a missing admission refuses with zero model calls', async () => {
  const { task, state, model, agent } = setup();
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: undefined as unknown as UC03CoderAdmission });
  assert.equal(result.outcome, 'invalid');
  assert.equal(model.calls.length, 0);
});

test('an uncertain model outcome is never replayed', async () => {
  const model = new RecordingModelPort(async () => ({ outcome: 'uncertain', reason: 'PROVIDER_OUTCOME_PENDING' }));
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const agent = createCoderAgentV02({ model, repository: new FakeRepositoryPort(), budget: BUDGET });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(result.outcome, 'unavailable');
  assert.equal(model.calls.length, 1);
});

test('an inspect read goes through the guarded capability and returns sanitized evidence', async () => {
  const read = recordingGuardedRead();
  const model = new RecordingModelPort(async () => ({
    outcome: 'observed',
    result: { proposal: { proposalId: 'p-2', content: JSON.stringify({ kind: 'inspect', proposalId: 'p-2', operation: 'read_file', args: { path: 'src/calculator.py' } }) } },
  }));
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const agent = createCoderAgentV02({ model, repository: new FakeRepositoryPort(), budget: BUDGET, guardedRead: read.capability });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(result.outcome, 'proposal');
  assert.deepEqual(read.kinds, ['read']);
  assert.ok(result.outcome === 'proposal' && result.tool?.kind === 'read-file');
  assert.equal(result.outcome === 'proposal' ? result.tool?.kind === 'read-file' && result.tool.evidence.path : null, 'src/calculator.py');
});

test('a run-check without an owner admission is refused before the repository is touched', async () => {
  const asked: CheckDefinition[] = [];
  const model = new RecordingModelPort(async () => ({
    outcome: 'observed',
    result: { proposal: { proposalId: 'p-3', content: JSON.stringify({ kind: 'inspect', proposalId: 'p-3', operation: 'run_check', args: { checkId: 'check-pytest-reproduction' } }) } },
  }));
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const repository = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });
  const original = repository.runTests.bind(repository);
  repository.runTests = async (check: CheckDefinition) => {
    asked.push(check);
    return original(check);
  };
  const agent = createCoderAgentV02({ model, repository, budget: BUDGET });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /CHECK_ADMISSION/u);
  assert.deepEqual(asked, []);
});

test('a run-check with a fresh owner admission executes against that exact context', async () => {
  const check = createFixtureCheckDefinition();
  const admitted: unknown[] = [];
  const model = new RecordingModelPort(async () => ({
    outcome: 'observed',
    result: { proposal: { proposalId: 'p-4', content: JSON.stringify({ kind: 'inspect', proposalId: 'p-4', operation: 'run_check', args: { checkId: check.checkId } }) } },
  }));
  const task = createFixtureBugTask({ requiredChecks: [check] });
  const state = createFixtureTaskState({ node: 'Investigate', taskId: task.taskId });
  const repository = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });
  repository.runTests = async (_check: CheckDefinition, context: RepositoryAdmissionContextV02) => {
    admitted.push(context);
    return { checkId: check.checkId, outcome: 'fail', testedIds: [], diagnosticRefs: [], outputExcerpt: 'ZeroDivisionError' } as CheckResult;
  };
  const ownerContext = (() => {
    const base = admit(state).context as unknown as Record<string, unknown>;
    return { ...base, runnableNode: 'Investigate', checkId: check.checkId } as unknown as RepositoryAdmissionContextV02;
  })();
  const agent = createCoderAgentV02({
    model,
    repository,
    budget: BUDGET,
    admissionContextForCheck: () => ownerContext,
  });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(result.outcome, 'proposal');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0], ownerContext);
});

test('the existing finite budget still stops the loop', async () => {
  const model = new RecordingModelPort();
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const agent = createCoderAgentV02({ model, repository: new FakeRepositoryPort(), budget: { ...BUDGET, maxModelCalls: 1 } });
  await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  const second = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(second.outcome, 'invalid');
  assert.match(second.reason, /MODEL_CALL_BUDGET_EXHAUSTED/u);
  assert.equal(model.calls.length, 1);
});

test('request-info waits without a further model call', async () => {
  const model = new RecordingModelPort(async () => ({
    outcome: 'observed',
    result: { proposal: { proposalId: 'p-5', content: JSON.stringify({ kind: 'request-info', proposalId: 'p-5', questions: [{ questionId: 'q-1', text: 'which check?' }], evidenceRefs: [] }) } },
  }));
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const agent = createCoderAgentV02({ model, repository: new FakeRepositoryPort(), budget: BUDGET });
  const first = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(first.outcome, 'proposal');
  const paused = await agent.turn({ task, state: { ...state, node: 'NeedsInfo' }, purpose: 'propose-plan', evidence: [], admission: admit(state) });
  assert.equal(paused.outcome, 'waiting');
  assert.equal(model.calls.length, 1);
});

test('a propose-replan turn at AwaitFeedback passes the wait gate to the admission check', async () => {
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'AwaitFeedback' });
  const model = new RecordingModelPort();
  const agent = createCoderAgentV02({ model, repository: new FakeRepositoryPort(), budget: BUDGET });
  const result = await agent.turn({ task, state, purpose: 'propose-replan', evidence: [], admission: undefined as unknown as UC03CoderAdmission });
  assert.equal(result.outcome, 'invalid');
  assert.match(result.reason, /CODER_ADMISSION_MISSING/u);
  assert.equal(model.calls.length, 0);
});

test('AwaitFeedback without the replan purpose still waits', async () => {
  const { task, model, agent, admission } = setup();
  const state = createFixtureTaskState({ node: 'AwaitFeedback' });
  const result = await agent.turn({ task, state, purpose: 'propose-plan', evidence: [], admission });
  assert.equal(result.outcome, 'waiting');
  assert.match(result.reason, /^HUMAN_WAIT:AwaitFeedback$/u);
  assert.equal(model.calls.length, 0);
});

test('graph generation dispatches through the V02 model with observed evidence and no graph claim', async () => {
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const spy = statePortSpy();
  const repository = Object.assign(new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest, initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' } }), {
    statePort: spy.port,
  });
  const read = recordingGuardedRead();
  const responses = [JSON.stringify({ kind: 'inspect', proposalId: 'p-inspect', operation: 'read_file', args: { path: 'src/calculator.py' } }), PLAN];
  let responseId = 0;
  const model = new RecordingModelPort(
    async () => {
      const content = responses.shift();
      if (content === undefined) throw new Error('SCRIPT_EXHAUSTED');
      return { outcome: 'observed', result: { proposal: { proposalId: 'p-' + ++responseId, content } } };
    },
    call => assert.equal(validateBaseModelInputs(call.state, call.evidence, call.request).ok, true),
  );
  const agent = createCoderAgentV02({ model, repository, budget: BUDGET, guardedRead: read.capability });
  let admissionId = 0;
  const admissions: UC03CoderAdmission[] = [];
  const config: UC03GraphConfig = {
    mode: 'production',
    generationV02: { agent },
    coderAdmission: ({ state: currentState, purpose, evidence }) => {
      const admission = admit(currentState, purpose, 'req-graph-' + ++admissionId, computeContextDigest(currentState, evidence));
      admissions.push(admission);
      return admission;
    },
  };
  const planned = await generate(config, task, state, 'propose-plan', []);

  assert.ok(planned.ok && planned.proposal.kind === 'propose-plan');
  assert.deepEqual(read.kinds, ['read']);
  assert.equal(model.calls[0]?.context, admissions[0]?.context);
  assert.equal(model.calls[1]?.context, admissions[1]?.context);
  assert.deepEqual(
    model.calls[1]?.evidence.map(item => item.path),
    ['src/calculator.py'],
  );
  assert.equal(model.calls.length, 2);
  assert.notEqual(model.calls[0]?.request.providerRequestId, model.calls[1]?.request.providerRequestId);
  assert.deepEqual(spy.calls, []);
});

test('graph generation refuses to reuse an owner request within an inspect loop', async () => {
  const task = createFixtureBugTask();
  const state = createFixtureTaskState({ node: 'Investigate' });
  const spy = statePortSpy();
  const repository = Object.assign(new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest, initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' } }), {
    statePort: spy.port,
  });
  const read = recordingGuardedRead();
  const model = new RecordingModelPort(async () => ({
    outcome: 'observed',
    result: { proposal: { proposalId: 'p-inspect', content: JSON.stringify({ kind: 'inspect', proposalId: 'p-inspect', operation: 'read_file', args: { path: 'src/calculator.py' } }) } },
  }));
  const agent = createCoderAgentV02({ model, repository, budget: BUDGET, guardedRead: read.capability });
  const config: UC03GraphConfig = {
    mode: 'production',
    generationV02: { agent },
    coderAdmission: ({ state: currentState, purpose, evidence }) => admit(currentState, purpose, 'req-reused', computeContextDigest(currentState, evidence)),
  };

  const result = await generate(config, task, state, 'propose-plan', []);

  assert.deepEqual(result, { ok: false, reason: 'Coder admission reused a provider request within the generation loop' });
  assert.deepEqual(read.kinds, ['read']);
  assert.equal(model.calls.length, 1);
  assert.deepEqual(spy.calls, []);
});
