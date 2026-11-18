/**
 * T051 — controlled proof for the real containment probe's admission and kill-witness logic.
 *
 * No Docker, daemon, profile or provider: the doubles are the ones `real-tier-task-binding.test.ts`
 * uses (a scanned fixture profile, a counting spawn and fetch, a catalog on disk). The hostile admission
 * the probe sends is built by `uc03-real-containment-evidence.ts`, the module the probe imports, over a
 * view issued by the production builder, and then run through the production guard and the bound task
 * port's own claim. A negative row only means something if the positive row claims, so the positive
 * row's CLAIMED is asserted here.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256, computeCommandViewDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { ExecutionLimits, RepositoryAdmissionContextV02, TaskState, TaskWorkspace } from '../../../src/contracts/foundation/uc03.ts';
import { buildDockerCommandView, DEFAULT_EXCLUSIONS_POLICY_VERSION } from '../../../src/foundation/docker-view-builder.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest, computeWorkspaceVolumeIds } from '../../../src/foundation/docker-workspace-policy.ts';
import type { CanonicalRepositorySnapshot, DockerLifecycleController, MaterializeViewParams } from '../../../src/foundation/docker-workspace-types.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { commandExecutionLimits, dockerCommandView, snapshotRepositoryAdmission } from '../../../src/foundation/repository-admission.ts';
import { resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { executionProfileOf } from '../../../src/runtime/real-tier-execution-profile.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import {
  createContainerTrap,
  hostileAdmission,
  hostileCommand,
  measuredAdmissionView,
  memoryKillWitnessed,
  parseInspected,
  REFUSAL_REASONS,
  refusalContexts,
} from './uc03-real-containment-evidence.ts';

const fixture = createScanFixture('t051-evidence-', 't051-evidence-digest-key');
const REV = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PINS = { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])) };
const IDENTITY = { profileId: 'profile-001', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST };
const REQUIRED_FILES = ['src/calculator.py', 'tests/test_calculator.py'] as const;
const FILES: Readonly<Record<string, string>> = {
  'src/calculator.py': 'def divide(a, b):\n    return a / b\n',
  'tests/test_calculator.py': 'from src.calculator import divide\n\n\ndef test_divide():\n    assert divide(10, 2) == 5\n',
  'tests/test_malicious.py': 'def test_contained():\n    assert True\n',
};

/** The repository revision digest `WorkspaceFilesystemPort` would measure for these files. */
function revisionOf(files: Readonly<Record<string, string>>): string {
  return computeCanonicalSha256(
    Object.keys(files)
      .sort()
      .map(path => `${path}\0${computeFileDigest(files[path] ?? '')}\n`)
      .join(''),
  );
}

/** The controller the production view builder materializes into: it returns the canonical snapshot and keeps the views it was given. */
class SnapshotController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  readonly snapshot: CanonicalRepositorySnapshot;
  readonly materialized: string[] = [];
  private readonly volumes = new Set<string>();
  constructor(snapshot: CanonicalRepositorySnapshot) {
    this.snapshot = snapshot;
  }
  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
  }
  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }
  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }
  async getCanonicalSnapshot(): Promise<CanonicalRepositorySnapshot> {
    return this.snapshot;
  }
  async materializeView(params: MaterializeViewParams): Promise<void> {
    this.materialized.push(params.view.viewId);
  }
}

interface Harness {
  readonly assembly: RealTierAssembly;
  readonly owners: ReturnType<RealTierAssembly['owners']['taskOwners']>;
  readonly state: TaskState;
  readonly spawns: () => number;
  readonly input: Parameters<typeof refusalContexts>[0];
  readonly policy: { readonly isolationProfileRef: string; readonly limits: ExecutionLimits };
  readonly published: { readonly viewDigest: string };
}

/** A bound real-tier task (row (q)'s doubles), moved to `Investigate`, with a view issued by the production builder. */
async function harness(): Promise<Harness> {
  const catalogDir = mkdtempSync(join(tmpdir(), 't051-evidence-catalog-'));
  mkdirSync(join(catalogDir, 'repository', 'src'), { recursive: true });
  writeFileSync(join(catalogDir, 'repository', 'src', 'calculator.py'), FILES['src/calculator.py'] ?? '', 'utf8');
  const task = {
    taskId: 'task-calc-001',
    repositoryId: 'repo-calc',
    initialRevisionDigest: revisionOf({ 'src/calculator.py': FILES['src/calculator.py'] ?? '' }),
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises CalculationError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction' as const, workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
  };
  const document = { task, repositoryRoot: 'repository' };
  const fixturePath = join(catalogDir, 'case.json');
  writeFileSync(fixturePath, JSON.stringify(document), 'utf8');
  const catalogPath = join(catalogDir, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [
        {
          catalogEntryId: 'entry-C01',
          caseId: 'C01',
          version: '1.0.0',
          caseDigest: sha256Text('case'),
          publicTaskDigest: sha256Text('public-task'),
          initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''),
          fixturePath,
          fixtureDigest: sha256Text(JSON.stringify(document)),
          grader: { version: '1.0.0', digest: sha256Text('grader'), path: join(catalogDir, 'grader.json') },
        },
      ],
    }),
    'utf8',
  );

  let spawns = 0;
  const spawn: StructuredSpawn = async (): Promise<StructuredSpawnResult> => {
    spawns += 1;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const dependencies: RealTierDependencies = {
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    fetch: (async () => {
      throw new Error('the T051 evidence test makes no model calls');
    }) as typeof globalThis.fetch,
    spawn,
    stateRoot: mkdtempSync(join(tmpdir(), 't051-evidence-state-')),
    revision: REV,
  };
  const resolved = resolveRealTierAssembly(dependencies);
  assert.equal(resolved.status, 'assembly-ready');
  const assembly = resolved as RealTierAssembly;
  const bound = await bindRealTierTask(assembly, { caseId: 'C01', pins: PINS, identity: IDENTITY, readTextFile: undefined, retainedRoot: join(mkdtempSync(join(tmpdir(), 't051-evidence-retained-')), 'artifacts') });
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') throw new Error('unreachable');

  const owners = assembly.owners.taskOwners({ taskId: bound.ids.taskId, workspaceId: bound.ids.workspaceId, repositoryId: bound.task.repositoryId });
  const seeded = (await owners.statePort.loadTask(bound.ids.taskId)) as TaskState;
  await owners.statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  const state = (await owners.statePort.loadTask(bound.ids.taskId)) as TaskState;

  const label = assembly.profile.image.label;
  const workspace: TaskWorkspace = {
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    containerImageDigest: assembly.profile.image.imageId,
    repoVolumeId: computeWorkspaceVolumeIds(state.taskId, state.workspaceId).repoVolumeId,
    scratchVolumeId: computeWorkspaceVolumeIds(state.taskId, state.workspaceId).scratchVolumeId,
    expectedRepoState: state.repositoryRevisionDigest,
  };
  const controller = new SnapshotController({
    canonicalRevisionDigest: state.repositoryRevisionDigest,
    entries: Object.entries(FILES).map(([path, content]) => ({ path, kind: 'regular' as const, content, digest: computeFileDigest(content) })),
    exclusionsPolicyVersion: DEFAULT_EXCLUSIONS_POLICY_VERSION,
  });
  const operations: Parameters<typeof buildDockerCommandView>[2] = {
    getWorkspace: () => workspace,
    getCanonicalRevision: () => workspace.expectedRepoState,
    acquireReadLease: async () => ({ release: () => undefined }) as never,
    invalidateViews: () => undefined,
    publishView: () => undefined,
  };
  const admit = (params: Parameters<typeof buildDockerCommandView>[0]) => buildDockerCommandView(params, controller, operations);
  const profile = executionProfileOf(bound.task, label, { taskId: state.taskId, workspaceId: state.workspaceId });
  const view = await measuredAdmissionView(admit, state.workspaceId, REQUIRED_FILES, label);
  const published = (await admit({ workspaceId: state.workspaceId, requiredFiles: REQUIRED_FILES })).view;
  const authority = { policyId: bound.task.configId, policyVersion: bound.task.configVersion, configId: bound.task.configId, configVersion: bound.task.configVersion, issuerKeyRef: `host-${bound.task.configId}`, decisionAuthorityGeneration: 1 };
  return {
    assembly,
    owners,
    state,
    spawns: () => spawns,
    input: { state, view, profile, authority, checks: bound.task.requiredChecks },
    policy: { isolationProfileRef: label, limits: bound.task.limits },
    published,
  };
}

test('the probe hostile admission is CLAIMED by the bound task port through the production guard, and each refusal is its own', async () => {
  const h = await harness();
  const port = h.owners.statePort;
  const snapshotOf = async (): Promise<string> => computeCanonicalSha256({ task: await port.loadTask(h.state.taskId), journal: port.getJournalSnapshot(h.state.taskId) });

  let receiverCalls = 0;
  const claim: { receipt: Awaited<ReturnType<typeof port.claim>> | undefined } = { receipt: undefined };
  const claimOf = () => claim.receipt;
  const noop = async (): Promise<never> => {
    throw new Error('not used');
  };
  // What the production receiver does before it dispatches: normalize the admission, derive the limits,
  // then claim from the owner. The executor is not reached; the claim is the owner's admission decision.
  const repositoryPort = {
    executionGuardApiVersion: '0.2.0' as const,
    listDir: noop,
    readFile: noop,
    searchCode: noop,
    applyPatch: noop,
    runTests: noop,
    inspectDiff: noop,
    runCommand: async (_action: unknown, context: RepositoryAdmissionContextV02): Promise<never> => {
      receiverCalls += 1;
      const admitted = snapshotRepositoryAdmission(context, 'run_command');
      commandExecutionLimits(admitted, h.policy);
      claim.receipt = await port.claim(admitted);
      throw new Error('stop after the claim');
    },
  };
  const guard = createExecutionGuardV02({ ports: { statePort: port, repositoryPort: repositoryPort as never }, config: { provenance: 'real' } });
  const dispatch = async (context: RepositoryAdmissionContextV02) => {
    const before = await snapshotOf();
    const callsBefore = receiverCalls;
    claim.receipt = undefined;
    const result = await guard.validateAndExecute(context.action, (await port.loadTask(h.state.taskId)) as TaskState, context).catch((error: unknown) => ({ outcome: 'denied' as const, reason: String(error) }));
    return { result, receiverCalls: receiverCalls - callsBefore, claimed: claimOf(), unchanged: before === (await snapshotOf()) };
  };

  // The published v0.1 view and the admitted v0.2 view agree on the digest the Docker layer recomputes.
  const positive = hostileAdmission({ ...h.input, action: hostileCommand('act-guarded-hostile') });
  assert.equal(dockerCommandView(positive).viewDigest, h.published.viewDigest, 'the receiver finds the view the builder published');
  assert.equal(positive.commandView?.viewDigest, computeCommandViewDigest(positive.commandView as never), 'the v0.2 view digest hashes its own key set');

  const refusals = refusalContexts(h.input);
  for (const name of ['stale', 'forbidden', 'noView', 'noBounds'] as const) {
    const refused = await dispatch(refusals[name]);
    assert.equal(refused.result.outcome, 'denied', `${name}: ${JSON.stringify(refused.result)}`);
    assert.ok((refused.result as { reason?: string }).reason?.includes(REFUSAL_REASONS[name]), `${name}: ${JSON.stringify(refused.result)}`);
    assert.equal(refused.receiverCalls, 0, `${name} reached the receiver`);
    assert.ok(refused.unchanged, `${name} changed the task or journal`);
  }

  // A view naming an isolation profile the owner did not admit passes the guard and dies in the
  // receiver's resource-policy step, before any claim exists.
  const foreign = await dispatch(refusals.foreignIsolation);
  assert.equal(foreign.receiverCalls, 1);
  assert.equal(foreign.claimed, undefined, 'a foreign isolation view never reaches the claim');
  assert.ok(foreign.unchanged, 'a foreign isolation view changed the task or journal');

  // The admitted row, last: after the refusals left the port untouched, the same state claims.
  const admitted = await dispatch(positive);
  assert.equal(admitted.receiverCalls, 1, 'the admitted hostile command reaches the receiver exactly once');
  assert.equal(admitted.claimed?.status, 'claimed', JSON.stringify(admitted.claimed));
  assert.equal(admitted.claimed?.claimId, 'claim-act-guarded-hostile');
  assert.equal(h.spawns(), 0, 'no Docker process was started');
});

test('the pre-fix constructions are not claimed, so the positive row discriminates', async () => {
  const h = await harness();
  const port = h.owners.statePort;
  const good = hostileAdmission({ ...h.input, action: hostileCommand('act-prefix') });
  const claimOf = async (context: unknown) => port.claim(snapshotRepositoryAdmission(context, 'run_command'));

  // An ID-only receipt digest: the owner re-hashes the whole receipt body.
  const idOnly = { ...good, policyEvaluationReceipt: { ...good.policyEvaluationReceipt, receiptDigest: computeCanonicalSha256({ receiptId: good.policyEvaluationReceipt.receiptId }) } };
  assert.notEqual((await claimOf(idOnly)).claimId, 'claim-act-prefix', 'an ID-only receipt digest must not claim');

  // A digest over a mixed key set (v0.1 and v0.2 revision keys): normalization drops one, so it goes stale.
  const admittedView = { ...(good.commandView as unknown as Record<string, unknown>) };
  delete admittedView['viewDigest'];
  const mixedView = { ...admittedView, canonicalRevisionDigest: admittedView['canonicalRevision'] };
  const normalized = snapshotRepositoryAdmission({ ...good, commandView: { ...mixedView, viewDigest: computeCommandViewDigest(mixedView as never) } }, 'run_command');
  assert.notEqual((await port.claim(normalized)).claimId, 'claim-act-prefix', 'a mixed-key view digest must not claim');

  assert.equal((await claimOf(good)).claimId, 'claim-act-prefix', 'the probe construction claims on the same port');
});

test('the memory witness needs the executed container to be the OOM-killed one', () => {
  const killed = { exitCode: 137, timedOut: false, outcome: 'failure', durationMs: 400 };
  const oom = { name: 'ctr-a', oomKilled: true, exitCode: 137 };
  assert.equal(memoryKillWitnessed(killed, 'ctr-a', oom, 60_000), true);
  // SIGKILLed without an OOM verdict while some other container did OOM: not memory enforcement.
  assert.equal(memoryKillWitnessed(killed, 'ctr-a', { ...oom, oomKilled: false }, 60_000), false);
  assert.equal(memoryKillWitnessed(killed, 'ctr-a', { ...oom, name: 'oom-witness-other' }, 60_000), false);
  assert.equal(memoryKillWitnessed(killed, undefined, oom, 60_000), false);
  assert.equal(memoryKillWitnessed(killed, 'ctr-a', undefined, 60_000), false);
  assert.equal(memoryKillWitnessed(killed, 'ctr-a', { ...oom, exitCode: 1 }, 60_000), false);
  assert.equal(memoryKillWitnessed({ ...killed, durationMs: 61_000 }, 'ctr-a', oom, 60_000), false, 'an unbounded kill is not enforcement');
  assert.equal(memoryKillWitnessed({ ...killed, exitCode: 1 }, 'ctr-a', { ...oom, exitCode: 1 }, 60_000), false);
  assert.deepEqual(parseInspected('ctr-a', 'true 137\n'), oom);
  assert.equal(parseInspected('ctr-a', 'Error: No such container'), undefined);
  assert.equal(parseInspected('ctr-a', 'maybe 137'), undefined);
});

test('the container trap keeps only the armed run, drops only --rm and records its name', async () => {
  const seen: string[][] = [];
  const base: StructuredSpawn = async (_command, args) => {
    seen.push([...args]);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const trap = createContainerTrap(base);
  const options = { timeoutMs: 1, maxOutputBytes: 1 };
  const script = 'x=bytearray(2*1024**3)';
  const run = (name: string, tail: string) => ['run', '--rm', '--network=none', `--name=${name}`, 'image', 'python3', '-c', tail];

  await trap.spawn('docker', run('ctr-before', script), options);
  trap.arm(script);
  await trap.spawn('docker', run('ctr-other', 'print(1)'), options);
  await trap.spawn('docker', run('ctr-armed', script), options);
  await trap.spawn('docker', run('ctr-second', script), options);
  assert.equal(trap.disarm(), 'ctr-armed');
  assert.equal(trap.disarm(), undefined);

  assert.ok(seen[0]?.includes('--rm'), 'a run before arming is untouched');
  assert.ok(seen[1]?.includes('--rm'), 'another command keeps --rm');
  assert.deepEqual(seen[2], ['run', '--network=none', '--name=ctr-armed', 'image', 'python3', '-c', script], 'the armed run loses only --rm');
  assert.ok(seen[3]?.includes('--rm'), 'only the first armed run is kept');
});
