import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, type BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { runBaselineChecks } from '../../../src/uc03/investigation-baseline-checks.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('baseline-wd-', 'baseline-wd-fixture');

async function setup(checkWorkingDirectory?: string) {
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
    requiredChecks: [
      {
        checkId: 'check-zero',
        executable: 'pytest',
        argv: ['-q', target],
        purpose: 'reproduction',
        ...(checkWorkingDirectory !== undefined ? { workingDirectory: checkWorkingDirectory } : {}),
        timeoutMs: 1000,
        maxOutputBytes: 4096,
      },
    ],
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
      throw new Error('unexpected provider call');
    },
  });
  assert.equal(assembly.status, 'assembly-ready');
  if (assembly.status !== 'assembly-ready') throw new Error('assembly unavailable');
  const options = {
    caseId: 'C01',
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: { profileId: 'baseline-wd-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  };
  return { root, task, assembly, options, docker, counts: () => ({ baselineCalls }) };
}

test('Row A: a catalog check that omits workingDirectory is refused by bindRealTierTask and no task is seeded', async () => {
  const h = await setup();
  const result = await bindRealTierTask(h.assembly, h.options);
  assert.deepEqual(result, {
    status: 'unavailable',
    reasonCode: 'check-working-directory-invalid',
    path: '$.task.requiredChecks[0].workingDirectory',
  });
  assert.equal(await h.assembly.owners.components.statePort.loadTask(h.task.taskId), null);
});

test('Row A2: a relative working directory is refused the same way', async () => {
  const h = await setup('tests');
  const result = await bindRealTierTask(h.assembly, h.options);
  assert.deepEqual(result, {
    status: 'unavailable',
    reasonCode: 'check-working-directory-invalid',
    path: '$.task.requiredChecks[0].workingDirectory',
  });
  assert.equal(await h.assembly.owners.components.statePort.loadTask(h.task.taskId), null);
});

test('Row B: keep a check with workingDirectory: /workspace/repo that binds, and an action with a different working directory is refused while matching is admitted', async () => {
  const h = await setup('/workspace/repo');
  const bound = await bindRealTierTask(h.assembly, h.options);
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') throw new Error('binding unavailable');

  const owner = h.assembly.owners.taskOwners({ ...bound.ids, repositoryId: h.task.repositoryId }).statePort;
  const state = await owner.loadTask(bound.task.taskId);
  assert.ok(state);
  const investigating = { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate' as const, nextAction: 'propose-fix-plan' as const };
  await owner.transition(investigating, state.stateVersion);
  const check = bound.task.requiredChecks[0];
  assert.ok(check);
  assert.equal(check.workingDirectory, '/workspace/repo');

  // Direct admissionContextForCheck call: refused (undefined) when action.workingDirectory differs
  const refusedAdmission = await bound.config.trustedExpectedContext.admissionContextForCheck?.({
    check,
    action: {
      actionId: check.checkId,
      kind: 'run_command',
      executable: check.executable,
      argv: check.argv,
      workingDirectory: '/workspace/scratch',
      purpose: check.purpose,
    },
    currentState: investigating,
  });
  assert.equal(refusedAdmission, undefined, 'admissionContextForCheck must refuse action with differing workingDirectory');

  // Direct admissionContextForCheck call: non-undefined when action.workingDirectory is '/workspace/repo'
  const matchingAdmission = await bound.config.trustedExpectedContext.admissionContextForCheck?.({
    check,
    action: {
      actionId: check.checkId,
      kind: 'run_command',
      executable: check.executable,
      argv: check.argv,
      workingDirectory: '/workspace/repo',
      purpose: check.purpose,
    },
    currentState: investigating,
  });
  assert.ok(matchingAdmission !== undefined, 'admissionContextForCheck must admit action with /workspace/repo workingDirectory');

  // Driving the baseline investigation: assert the check is admitted, not refused with ADMISSION_DENIED
  const baselineRun = await runBaselineChecks({
    rawExpectedContext: bound.config.trustedExpectedContext,
    repository: bound.ports.repositoryPort,
    expectedTaskId: bound.task.taskId,
    expectedRevisionDigest: bound.task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(bound.task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(bound.task.requiredChecks),
    requiredChecks: bound.task.requiredChecks,
  });
  assert.equal(baselineRun.status, 'checks');
  const checkResult = baselineRun.checkResults.find(r => r.checkId === check.checkId);
  assert.ok(checkResult);
  assert.notEqual(checkResult.outputExcerpt, 'ADMISSION_DENIED: Missing admission context for required check');
});
