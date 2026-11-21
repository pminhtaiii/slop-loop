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
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture = createScanFixture('investigate-', 'investigate-profile-fixture');

async function setup() {
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
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [
      { checkId: 'check-zero', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: '/workspace/repo', timeoutMs: 1000, maxOutputBytes: 4096 },
    ],
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
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    stateRoot: join(root, 'state'),
    revision: 'a'.repeat(40),
    spawn: async (command, args, options) => {
      if (args[0] === 'run' && args.includes('pytest')) {
        baselineCalls++;
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

test('bound C01 investigates the mirrored repository and pauses for its calculator plan', async () => {
  const h = await setup();
  const result = await runUC03GraphV02(h.bound.task, h.bound.ports, h.config);
  assert.equal(result.outcome, 'pending-approval', JSON.stringify(result.reasons));
  assert.deepEqual(result.state?.plan?.scopedChanges, ['src/calculator.py']);
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
