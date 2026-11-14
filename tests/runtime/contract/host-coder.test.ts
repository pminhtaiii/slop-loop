import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostCoderGeneration } from '../../../src/runtime/host-coder.ts';
import {
  computeAdmissionDigest,
  computeCanonicalSha256,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type RepositoryAdmissionContextV02,
  type RepositoryPortV02,
} from '../../../src/contracts/foundation/uc03.ts';
import { computeContextDigest } from '../../../src/foundation/model.ts';
import type { ExecutionGuardReadCapability } from '../../../src/foundation/repository-types.ts';
import type { CoderTurnInputV02 } from '../../../src/uc03/agent-types.ts';
import { generate } from '../../../src/uc03/graph-nodes.ts';
import type { UC03GraphConfig } from '../../../src/uc03/graph-types.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { createFixtureBugTask, createFixtureCheckDefinition, createFixtureProviderAdmissionContextV02, createFixtureProviderRequest, createFixtureTaskState } from '../support/uc03/port-fixtures.ts';
import { createTestProviderAdmissionTrustedContextV02 } from '../support/uc03/state-fixtures.ts';

const budget = { maxModelCalls: 4, maxActiveMs: 10_000, maxRepairs: 1, maxReplans: 3 } as const;

function input(taskId: string, runId: string): CoderTurnInputV02 {
  return {
    task: { taskId } as CoderTurnInputV02['task'],
    state: { taskId, runId } as CoderTurnInputV02['state'],
    purpose: 'propose-plan',
    evidence: [],
    admission: {} as CoderTurnInputV02['admission'],
  };
}

function ports(overrides: { readonly guardedRead?: unknown; readonly checkResolver?: unknown } = {}) {
  const model = { provenance: 'mock', propose: async () => ({ outcome: 'denied' }) } as unknown as ModelPortV02;
  const repository = {
    listDir: async () => [],
    readFile: async () => undefined,
    searchCode: async () => [],
    applyPatch: async () => undefined,
    runCommand: async () => undefined,
    runTests: async () => undefined,
    inspectDiff: async () => undefined,
  } as unknown as RepositoryPortV02;
  const guardedRead = overrides.guardedRead ?? { provenance: 'mock', mediateRead: async () => undefined };
  const checkResolver = overrides.checkResolver ?? (async () => undefined);
  return { model, repository, guardedRead, checkResolver };
}

test('host coder allocates one agent per task/run and reuses it for continuation', () => {
  const portsForCoder = ports();
  const generation = createHostCoderGeneration({
    model: portsForCoder.model,
    repository: portsForCoder.repository,
    guardedRead: portsForCoder.guardedRead as ExecutionGuardReadCapability,
    admissionContextForCheck: portsForCoder.checkResolver as NonNullable<Parameters<typeof createHostCoderGeneration>[0]['admissionContextForCheck']>,
    budget,
  });
  const agentFor = generation.agentFor;
  assert.ok(agentFor);

  const firstAttempt = agentFor(input('task-a', 'run-1'));
  const secondAttemptSameRun = agentFor(input('task-a', 'run-1'));
  const nextRun = agentFor(input('task-a', 'run-2'));
  const otherTask = agentFor(input('task-b', 'run-1'));

  assert.strictEqual(firstAttempt, secondAttemptSameRun);
  assert.notStrictEqual(firstAttempt, nextRun);
  assert.notStrictEqual(firstAttempt, otherTask);
  assert.equal(firstAttempt.counters.modelCalls, 0);
  assert.equal(nextRun.counters.modelCalls, 0);
  assert.equal(otherTask.counters.modelCalls, 0);
});

test('host coder refuses when mediated read or exact check admission is missing', () => {
  const portsForCoder = ports();
  const common = {
    model: portsForCoder.model,
    repository: portsForCoder.repository,
    budget,
  };

  assert.throws(
    () => createHostCoderGeneration({ ...common, guardedRead: undefined as unknown as ExecutionGuardReadCapability, admissionContextForCheck: portsForCoder.checkResolver as never }),
    /GUARDED_READ_REQUIRED/u,
  );
  assert.throws(
    () => createHostCoderGeneration({ ...common, guardedRead: portsForCoder.guardedRead as ExecutionGuardReadCapability, admissionContextForCheck: undefined }),
    /CHECK_ADMISSION_REQUIRED/u,
  );
});

test('the selected run agent mediates inspect, uses exact check admission, and keeps counters per run', async () => {
  const check = createFixtureCheckDefinition();
  const taskA = createFixtureBugTask({ taskId: 'task-a', requiredChecks: [check] });
  const taskB = createFixtureBugTask({ taskId: 'task-b', requiredChecks: [check] });
  const stateA1 = createFixtureTaskState({ taskId: taskA.taskId, runId: 'run-a1', taskContext: taskA, requiredCheckIds: [check.checkId] });
  const stateA2 = createFixtureTaskState({ taskId: taskA.taskId, runId: 'run-a2', taskContext: taskA, requiredCheckIds: [check.checkId] });
  const stateB1 = createFixtureTaskState({ taskId: taskB.taskId, runId: 'run-b1', taskContext: taskB, requiredCheckIds: [check.checkId] });
  const responses = [
    JSON.stringify({ kind: 'inspect', proposalId: 'i-a1', operation: 'read_file', args: { path: 'src/calculator.py' } }),
    JSON.stringify({
      kind: 'propose-plan',
      proposalId: 'p-a1',
      diagnosis: 'd',
      strategy: 's',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['evidence-baseline-001'],
    }),
    JSON.stringify({ kind: 'inspect', proposalId: 'i-b1', operation: 'run_check', args: { checkId: check.checkId } }),
    JSON.stringify({
      kind: 'propose-plan',
      proposalId: 'p-b1',
      diagnosis: 'd',
      strategy: 's',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['evidence-baseline-001'],
    }),
    JSON.stringify({ kind: 'inspect', proposalId: 'i-a2', operation: 'read_file', args: { path: 'src/calculator.py' } }),
    JSON.stringify({
      kind: 'propose-plan',
      proposalId: 'p-a2',
      diagnosis: 'd',
      strategy: 's',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['evidence-baseline-001'],
    }),
    JSON.stringify({ kind: 'inspect', proposalId: 'i-a1-next', operation: 'run_check', args: { checkId: check.checkId } }),
    JSON.stringify({
      kind: 'propose-plan',
      proposalId: 'p-a1-next',
      diagnosis: 'd',
      strategy: 's',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['evidence-baseline-001'],
    }),
  ];
  const model: ModelPortV02 = {
    provenance: 'mock',
    async propose(_state, _evidence, request) {
      const content = responses.shift();
      assert.ok(content, 'the expected controlled response is available');
      return { outcome: 'observed', result: { proposal: { proposalId: request.providerRequestId, content } } };
    },
  };
  const repository = new FakeRepositoryPort({ initialRevision: taskA.initialRevisionDigest, initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' } });
  const readKinds: string[] = [];
  const guardedRead: ExecutionGuardReadCapability = {
    provenance: 'mock',
    capabilityId: 'guarded-read-test',
    taskId: taskA.taskId,
    workspaceId: stateA1.workspaceId,
    async mediateRead<T>(operation: { readonly kind: 'list' | 'read' | 'search'; readonly execute: () => Promise<T> }): Promise<T> {
      readKinds.push(operation.kind);
      return operation.execute();
    },
  };
  const checkRequests: { readonly action: RepositoryAdmissionContextV02['action']; readonly state: typeof stateA1 }[] = [];
  const checkContext = { action: { actionId: check.checkId, kind: 'run_command' }, receipt: 'owner-issued-check-context' } as unknown as RepositoryAdmissionContextV02;
  const generation = createHostCoderGeneration({
    model,
    repository: repository as unknown as RepositoryPortV02,
    guardedRead,
    admissionContextForCheck: request => {
      checkRequests.push({ action: request.action, state: request.currentState as typeof stateA1 });
      return checkContext;
    },
    budget,
  });
  let requestIndex = 0;
  const coderAdmission: NonNullable<UC03GraphConfig['coderAdmission']> = ({ task, state, purpose, evidence }) => {
    const request = createFixtureProviderRequest({
      providerRequestId: `req-${++requestIndex}`,
      taskId: state.taskId,
      runId: state.runId,
      role: 'coder',
      purpose,
      contextDigest: computeContextDigest(state, evidence),
      reservationRef: `res-${requestIndex}`,
    });
    const raw = createFixtureProviderAdmissionContextV02({
      providerRequest: request,
      expectedTaskStateVersion: state.stateVersion,
      runnableNode: state.node,
      planApplicability: 'pre-plan-diagnostic',
      diagnosticPurpose: 'host-coder-test',
      taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    }) as unknown as Record<string, unknown>;
    delete raw['planBindingDigest'];
    delete raw['planDecisionRef'];
    raw['admissionDigest'] = computeAdmissionDigest(raw);
    const context = raw as unknown as ProviderAdmissionContextV02;
    return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
  };
  const config: UC03GraphConfig = { mode: 'production', generationV02: generation, coderAdmission };
  const agentFor = generation.agentFor;
  assert.ok(agentFor);

  const run = async (task: typeof taskA, state: typeof stateA1) => {
    const result = await generate(config, task, state, 'propose-plan', []);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(result.ok ? result.proposal.kind : null, 'propose-plan');
    return agentFor({ task, state, purpose: 'propose-plan', evidence: [], admission: {} as never });
  };

  const runA1 = await run(taskA, stateA1);
  assert.equal(runA1.counters.modelCalls, 2);
  const runB1 = await run(taskB, stateB1);
  assert.equal(runB1.counters.modelCalls, 2, 'a previous run’s higher counter cannot alias this run');
  const runA2 = await run(taskA, stateA2);
  assert.equal(runA2.counters.modelCalls, 2, 'a fresh attempt of the same task gets a fresh budget');

  const continuedA1 = await run(taskA, stateA1);
  assert.strictEqual(continuedA1, runA1);
  assert.equal(continuedA1.counters.modelCalls, 4, 'continuation reuses the same run agent and its counters');
  assert.deepEqual(readKinds, ['read', 'read']);
  assert.equal(checkRequests.length, 2);
  assert.deepEqual(
    checkRequests.map(item => item.action),
    [
      { actionId: check.checkId, kind: 'run_command', executable: check.executable, argv: [...check.argv], workingDirectory: check.workingDirectory, purpose: check.purpose },
      { actionId: check.checkId, kind: 'run_command', executable: check.executable, argv: [...check.argv], workingDirectory: check.workingDirectory, purpose: check.purpose },
    ],
  );
  assert.equal(checkRequests[0]?.state.runId, stateB1.runId);
  assert.equal(checkRequests[1]?.state.runId, stateA1.runId);
  assert.equal(responses.length, 0);
});
