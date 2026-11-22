import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, validateProviderAdmissionV02, type BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { microUsd } from '../../../src/foundation/deepseek-transport-request.ts';
import { resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { createHostCoderGeneration } from '../../../src/runtime/host-coder.ts';
import { runBaselineChecks } from '../../../src/uc03/investigation-baseline-checks.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('baseline-wd-', 'baseline-wd-fixture');

async function setup() {
  const target = 'tests/test_calculator.py';
  const root = mkdtempSync(join(tmpdir(), 'baseline-wd-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  const source = 'def divide(a, b):\n    return a / b\n';
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), source);
  writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), 'def test_divide_zero():\n    assert False\n');
  const revision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-baseline-wd',
    repositoryId: 'repo-calculator',
    initialRevisionDigest: revision,
    goal: 'Handle zero denominator',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'CalculationError',
    reproduction: `pytest -q ${target}`,
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-zero', executable: 'pytest', argv: ['-q', target], purpose: 'reproduction', timeoutMs: 1000, maxOutputBytes: 4096 }],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096, maxCpuCores: 1, maxMemoryBytes: 1048576, maxPids: 16 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-baseline-wd',
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
  const responses = [
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
    fetch: async () => {
      assert.equal(admissions, fetches + 1);
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
    identity: { profileId: 'baseline-wd-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
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
      assert.equal(request.maxInputTokens, admissions === 0 ? 32768 : 32668);
      assert.equal(request.maxOutputTokens, admissions === 0 ? 8192 : 8142);
      assert.equal(request.maxBillableTokens, admissions === 0 ? 40960 : 40810);
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
  return { bound, config, owner, counts: () => ({ baselineCalls, fetches, admissions }) };
}

test('Row A: bound real-tier task whose pinned checks omit workingDirectory admits tests working directory at Investigate and drives baseline investigation', async () => {
  const h = await setup();
  const state = await h.owner.loadTask(h.bound.task.taskId);
  assert.ok(state);
  const investigating = { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate' as const, nextAction: 'propose-fix-plan' as const };
  await h.owner.transition(investigating, state.stateVersion);
  const check = h.bound.task.requiredChecks[0];
  assert.ok(check);
  assert.equal(check.workingDirectory, undefined);

  // Direct admissionContextForCheck call: non-undefined when action.workingDirectory is 'tests'
  const admission = await h.bound.config.trustedExpectedContext.admissionContextForCheck?.({
    check,
    action: {
      actionId: check.checkId,
      kind: 'run_command',
      executable: check.executable,
      argv: check.argv,
      workingDirectory: 'tests',
      purpose: check.purpose,
    },
    currentState: investigating,
  });
  assert.ok(admission !== undefined, 'admissionContextForCheck must admit action with tests workingDirectory');

  // Driving the baseline investigation: assert the check is admitted, not refused with ADMISSION_DENIED
  const baselineRun = await runBaselineChecks({
    rawExpectedContext: h.config.trustedExpectedContext,
    repository: h.bound.ports.repositoryPort,
    expectedTaskId: h.bound.task.taskId,
    expectedRevisionDigest: h.bound.task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(h.bound.task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(h.bound.task.requiredChecks),
    requiredChecks: h.bound.task.requiredChecks,
  });
  assert.equal(baselineRun.status, 'checks');
  const checkResult = baselineRun.checkResults.find(r => r.checkId === check.checkId);
  assert.ok(checkResult);
  assert.notEqual(checkResult.outputExcerpt, 'ADMISSION_DENIED: Missing admission context for required check');
});

test('Row B: the same check with an action whose working directory differs is refused', async () => {
  const h = await setup();
  const state = await h.owner.loadTask(h.bound.task.taskId);
  assert.ok(state);
  const investigating = { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate' as const, nextAction: 'propose-fix-plan' as const };
  await h.owner.transition(investigating, state.stateVersion);
  const check = h.bound.task.requiredChecks[0];
  assert.ok(check);
  assert.equal(check.workingDirectory, undefined);
  const admission = await h.bound.config.trustedExpectedContext.admissionContextForCheck?.({
    check,
    action: {
      actionId: check.checkId,
      kind: 'run_command',
      executable: check.executable,
      argv: check.argv,
      workingDirectory: 'src',
      purpose: check.purpose,
    },
    currentState: investigating,
  });
  assert.equal(admission, undefined, 'admissionContextForCheck must refuse action with differing workingDirectory');
});
