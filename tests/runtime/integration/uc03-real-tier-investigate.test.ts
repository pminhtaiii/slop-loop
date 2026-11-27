import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateProviderAdmissionV02, type BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { microUsd } from '../../../src/foundation/deepseek-transport-request.ts';
import { resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { createHostCoderGeneration } from '../../../src/runtime/host-coder.ts';
import { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { recordClarificationAnswer } from '../../../src/uc03/clarification.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('investigate-', 'investigate-profile-fixture');

async function setup(nodeId = false, customResponses?: readonly Record<string, unknown>[]) {
  const target = nodeId ? 'tests/test_calculator.py::test_divide_zero' : 'tests/test_calculator.py';
  const root = mkdtempSync(join(tmpdir(), 'investigate-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  const source = 'def divide(a, b):\n    return a / b\n';
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), source);
  writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), 'def test_divide_zero():\n    assert False\n');
  const revision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-investigate',
    repositoryId: 'repo-calculator',
    initialRevisionDigest: revision,
    goal: 'Handle zero denominator',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'CalculationError',
    reproduction: `pytest -q ${target}`,
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-zero', executable: 'pytest', argv: ['-q', target], purpose: 'reproduction', workingDirectory: '/workspace/repo', timeoutMs: 1000, maxOutputBytes: 4096 }],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096, maxCpuCores: 1, maxMemoryBytes: 1048576, maxPids: 16 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-investigate',
    configVersion: '1.0.0',
  };
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, document);
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', fixturePath, fixtureDigest: sha256Text(document), initialRepositoryDigest: revision.slice(7) }] }));
  const docker = createVolumeSpawn();
  let baselineCalls = 0;
  let fetches = 0;
  let admissions = 0;
  const fetchBodies: string[] = [];
  const responses = customResponses ?? [
    { kind: 'inspect', proposalId: 'inspect-source', operation: 'read_file', args: { path: 'src/calculator.py' } },
    {
      kind: 'propose-plan',
      proposalId: 'plan-zero',
      diagnosis: 'The denominator is unchecked',
      strategy: 'Raise CalculationError for zero',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['src/calculator.py'],
    },
  ];
  const assembly = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath }, runLimits: { perRunInputTokens: 32768, perRunOutputTokens: 8192 } }),
    stateRoot: join(root, 'state'),
    revision: 'a'.repeat(40),
    spawn: async (command, args, options) => {
      if (args[0] === 'run' && args.includes('pytest')) {
        baselineCalls++;
        assert.equal(args.at(-1), target);
        const mount = args.find(arg => arg.includes('target=/workspace/repo'));
        const volume = docker.volumes.get(mount?.match(/source=([^,]+)/u)?.[1] ?? '');
        assert.equal(volume?.get('src/calculator.py')?.toString(), source);
        assert.ok(volume?.has('tests/test_calculator.py'));
        return { exitCode: 1, stdout: 'FAILED tests/test_calculator.py::test_divide_zero - ZeroDivisionError', stderr: '', timedOut: false };
      }
      return docker.spawn(command, args, options);
    },
    fetch: async (_input, init) => {
      assert.equal(admissions, fetches + 1);
      fetchBodies.push(String(init?.body ?? ''));
      const response = responses[fetches++];
      assert.ok(response, 'unexpected provider call');
      return new Response(
        JSON.stringify({
          id: `response-${fetches}`,
          type: 'message',
          role: 'assistant',
          model: fixture.MODEL,
          content: [{ type: 'text', text: JSON.stringify(response) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(assembly.status, 'assembly-ready');
  if (assembly.status !== 'assembly-ready') throw new Error('assembly unavailable');
  const bound = await bindRealTierTask(assembly, {
    caseId: 'C01',
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: { profileId: 'investigate-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  });
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') throw new Error('binding unavailable');
  const resolver = bound.config.coderAdmission;
  assert.equal(typeof resolver, 'function');
  const coderAdmission: typeof resolver = async input => {
    const admission = await resolver?.(input);
    if (admission) {
      const validated = validateProviderAdmissionV02(admission.context, admission.trustedContext);
      assert.equal(validated.ok, true, JSON.stringify(validated));
      const request = admission.request;
      assert.equal(request.maxInputTokens, 32768 - admissions * 100);
      assert.equal(request.maxOutputTokens, 8192 - admissions * 50);
      assert.equal(request.maxBillableTokens, 40960 - admissions * 150);
      assert.equal(request.maxCostUsd, microUsd(assembly.profile.pricing, request.maxInputTokens, request.maxOutputTokens, request.maxInputTokens) / 1_000_000);
      admissions++;
    }
    return admission;
  };
  const generation = createHostCoderGeneration({
    model: bound.ports.modelPort,
    repository: bound.ports.repositoryPort,
    guardedRead: bound.ports.guardedRead,
    admissionContextForCheck: bound.config.trustedExpectedContext.admissionContextForCheck,
    budget: { maxModelCalls: 4, maxActiveMs: 60000, maxRepairs: 2, maxReplans: 3 },
  });
  const config = {
    ...bound.config,
    coderAdmission,
    generation,
  };
  const owner = assembly.owners.taskOwners({ ...bound.ids, repositoryId: task.repositoryId }).statePort;
  return { bound, config, owner, fetchBodies, counts: () => ({ baselineCalls, fetches, admissions }) };
}

test('bound C01 investigates the mirrored repository and pauses for its calculator plan', async () => {
  const h = await setup();
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(result.outcome, 'pending-approval', JSON.stringify(result.reasons));
  assert.deepEqual(result.state?.plan?.scopedChanges, ['src/calculator.py']);
  assert.deepEqual(h.counts(), { baselineCalls: 1, fetches: 2, admissions: 2 });
});

test('bound C01 admits a pytest node ID and keeps the exact pinned selector at execution', async () => {
  const h = await setup(true);
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(result.outcome, 'pending-approval', JSON.stringify(result.reasons));
  assert.deepEqual(h.counts(), { baselineCalls: 1, fetches: 2, admissions: 2 });
});

for (const refusal of ['missing-owner', 'moved-journal'] as const)
  test(`both resolvers refuse ${refusal}`, async () => {
    const h = await setup();
    const state = await h.owner.loadTask(h.bound.task.taskId);
    assert.ok(state);
    const investigating = { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate' as const, nextAction: 'propose-fix-plan' as const };
    await h.owner.transition(investigating, state.stateVersion);
    if (refusal === 'missing-owner') h.owner.readVerificationAuthoritySnapshot = async () => null;
    else {
      const original = h.owner.getJournalSnapshot.bind(h.owner);
      h.owner.getJournalSnapshot = id => ({ ...(original(id) as object), controlVersion: 999 });
    }
    const check = h.bound.task.requiredChecks[0];
    assert.ok(check);
    assert.equal(
      await h.bound.config.trustedExpectedContext.admissionContextForCheck?.({
        check,
        action: { actionId: 'refusal-check', kind: 'run_command', executable: check.executable, argv: check.argv, workingDirectory: check.workingDirectory ?? '.', purpose: check.purpose },
        currentState: investigating,
      }),
      undefined,
    );
    assert.equal(await h.bound.config.coderAdmission?.({ task: h.bound.task, state: investigating, purpose: 'propose-plan', evidence: [] }), undefined);
    assert.deepEqual(h.counts(), { baselineCalls: 0, fetches: 0, admissions: 0 });
  });

for (const removed of ['check', 'coder'] as const)
  test(`removing the ${removed} resolver stops at Investigate`, async () => {
    const h = await setup();
    const withoutCheck = { ...h.config.trustedExpectedContext };
    delete withoutCheck.admissionContextForCheck;
    const config = removed === 'coder' ? { ...h.config, coderAdmission: undefined } : { ...h.config, trustedExpectedContext: withoutCheck };
    const result = await runUC03GraphV02(h.bound.task, h.bound.ports, config);
    assert.notEqual(result.outcome, 'pending-approval');
    assert.equal(result.state?.node, 'Investigate');
    assert.equal(h.counts().fetches, 0);
  });

test('recorded and resumed clarification answer reaches the real coder transport request on resume', async () => {
  const questionText = 'How should Calculator.divide(10, 0) behave?';
  const answerText = 'Raise CalculationError with message cannot divide by zero';
  const h = await setup(false, [
    { kind: 'inspect', proposalId: 'inspect-source', operation: 'read_file', args: { path: 'src/calculator.py' } },
    {
      kind: 'request-info',
      proposalId: 'clarify-divide',
      questions: [{ questionId: 'q-divide-zero', text: questionText }],
      evidenceRefs: ['src/calculator.py'],
    },
    {
      kind: 'propose-plan',
      proposalId: 'plan-zero',
      diagnosis: 'The denominator is unchecked',
      strategy: 'Raise CalculationError for zero',
      suspectedLocations: ['src/calculator.py'],
      scopedPaths: ['src/calculator.py'],
      evidenceRefs: ['src/calculator.py'],
    },
  ]);

  const paused = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(paused.outcome, 'needs-info', JSON.stringify(paused.reasons));
  assert.ok(paused.state);
  assert.equal(paused.state.node, 'NeedsInfo');
  assert.equal(h.fetchBodies.length, 2);

  for (const bodyText of h.fetchBodies) {
    const parsed = JSON.parse(bodyText) as { messages: readonly [{ content: string }] };
    const prompt = JSON.parse(parsed.messages[0].content) as Record<string, unknown>;
    assert.equal('reporterClarification' in prompt, false);
  }

  const answered = await recordClarificationAnswer({
    statePort: h.owner,
    prior: paused.state,
    answer: { recorderRef: 'operator-console-1', items: [{ questionId: 'q-divide-zero', text: answerText }] },
  });
  assert.equal(answered.state.node, 'Investigate');

  const resumed = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config, answered.state);
  assert.equal(resumed.outcome, 'pending-approval', JSON.stringify(resumed.reasons));
  assert.equal(h.fetchBodies.length, 3);

  const resumedBody = JSON.parse(h.fetchBodies[2] ?? '') as { messages: readonly [{ content: string }] };
  const resumedPrompt = JSON.parse(resumedBody.messages[0].content) as {
    task: { goal: string; acceptanceCriteria: readonly string[] };
    request: { role: string; purpose: string };
    reporterClarification?: {
      source: string;
      isUntrustedReporterInput: boolean;
      answerDigest: string;
      questions: readonly { questionId: string; text: string }[];
      answers: readonly { questionId: string; text: string }[];
    };
  };
  assert.equal(resumedPrompt.request.role, 'coder');
  assert.equal(resumedPrompt.request.purpose, 'propose-plan');
  assert.equal(resumedPrompt.task.goal, h.bound.task.goal);
  assert.deepEqual(resumedPrompt.task.acceptanceCriteria, h.bound.task.acceptanceCriteria);
  assert.deepEqual(resumedPrompt.reporterClarification, {
    source: 'reporter-supplied',
    isUntrustedReporterInput: true,
    answerDigest: answered.state.clarification?.answer?.answerDigest,
    questions: [{ questionId: 'q-divide-zero', text: questionText }],
    answers: [{ questionId: 'q-divide-zero', text: answerText }],
  });
});
