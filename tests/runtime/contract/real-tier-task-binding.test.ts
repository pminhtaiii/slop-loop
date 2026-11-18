/**
 * T061 — per-task real-tier binding (host contract §1 second stage, real-tier contract §(a)
 * "Production task binding").
 *
 * Every row builds the T050 set with injected doubles and a temp state root, so no row fetches, spawns
 * or reaches Docker. The binding rows count the two dispatch doubles and the persisted task file, and
 * each refusal row asserts its bounded code plus zero task writes. Sentinels are RFC 5737 / `.invalid`
 * values and a synthetic key; no real host, port or credential appears anywhere.
 *
 * A bound task is a prerequisite, never G-OWNERS evidence, and never a real execution claim.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, CONTRACT_VERSION } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { HostActionContext } from '../../../src/runtime/host-action-context.ts';
import type { BugTask, FixPlan, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest, computeWorkspaceVolumeIds } from '../../../src/foundation/docker-workspace-policy.ts';
import { createHostAssembly, resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, executionProfileOf, pinnedExecutionProfileOf, type RealTierBindingOptions, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import type { RealTierTaskBinding } from '../../../src/runtime/real-tier-owners.ts';
import { DEFAULT_EXCLUSIONS_POLICY_VERSION } from '../../../src/foundation/docker-view-builder.ts';
import { retainedDiffSource } from '../../../src/runtime/real-tier-task-producers.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';
import { prepareAssembly } from '../../../src/cli/evaluate-host.ts';
import type { HostConfiguration } from '../../../src/cli/evaluate-host.ts';
import { providerSpecs, repositoryResourceSpecs, stageReservation } from '../../../src/persistence/adapters/state-port-v02-ledgers.ts';
import { trustedExpectedContext } from '../../../src/uc03/graph-validation.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t061-binding-', 't061-binding-digest-key');
/** The pinned contract the T050 owner deliveries declare; the host file must echo it. */
const CONTRACT = 'uc03-host-composition/2';
const REV = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PINS = { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REV])) };
const IDENTITY = { profileId: 'profile-001', profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST };
const CASE = 'C01';

interface Effects {
  fetch: number;
  spawn: number;
}

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `t061-${label}-`));
}

function entriesUnder(root: string): string[] {
  // A directory that does not exist yet is the strongest form of "no write".
  return existsSync(root) ? readdirSync(root, { recursive: true }).map(entry => String(entry)) : [];
}

/** Names and byte contents: a refusal that rewrites a file with equal bytes is still a write. */
function storeFingerprint(root: string): string {
  const lines = entriesUnder(root)
    .sort()
    .map(entry => {
      const path = join(root, entry);
      return `${entry}\0${statSync(path, { throwIfNoEntry: false })?.isFile() === true ? sha256Text(readFileSync(path, 'utf8')) : '<dir>'}`;
    });
  return lines.join('\n');
}

function dependencies(overrides: Partial<RealTierDependencies> = {}): { readonly deps: RealTierDependencies; readonly effects: Effects; readonly stateRoot: string } {
  const effects: Effects = { fetch: 0, spawn: 0 };
  const stateRoot = tempRoot('state');
  const spawn: StructuredSpawn = async (): Promise<StructuredSpawnResult> => {
    effects.spawn += 1;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const fetchDouble: typeof globalThis.fetch = async () => {
    effects.fetch += 1;
    throw new Error('the binding stages must never fetch');
  };
  return { effects, stateRoot, deps: { env: fixture.envOf(), fetch: fetchDouble, spawn, stateRoot, revision: REV, ...overrides } };
}

/** A pinned task at the profile's own limits; the per-case values stay small and synthetic. */
function taskOf(overrides: Partial<BugTask> = {}): BugTask {
  return {
    taskId: 'task-calc-001',
    repositoryId: 'repo-calc',
    initialRevisionDigest: revisionOf(REPOSITORY_FILES),
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises CalculationError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        purpose: 'reproduction',
        workingDirectory: 'tests',
        timeoutMs: 30_000,
        maxOutputBytes: 1_048_576,
      },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
    ...overrides,
  };
}

interface Fixture {
  readonly catalogDir: string;
  readonly catalogPath: string;
  readonly repositoryDir: string;
  readonly task: BugTask;
}

/** The repository revision digest `WorkspaceFilesystemPort` would measure, computed from written bytes. */
function revisionOf(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map(path => `${path}\0${computeFileDigest(files[path] ?? '')}\n`);
  return computeCanonicalSha256(lines.join(''));
}

const REPOSITORY_FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;

/** A catalog directory with one contained repository and one digest-pinned fixture file. */
function fixtureOf(task = taskOf(), repositoryRoot = 'repository'): Fixture {
  const catalogDir = tempRoot('catalog');
  const repositoryDir = join(catalogDir, 'repository');
  mkdirSync(join(repositoryDir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(REPOSITORY_FILES)) writeFileSync(join(repositoryDir, path), content, 'utf8');
  const fixturePath = join(catalogDir, 'case.json');
  const document = { task, repositoryRoot };
  writeFileSync(fixturePath, JSON.stringify(document), 'utf8');
  const catalogPath = join(catalogDir, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [
        {
          catalogEntryId: `entry-${CASE}`,
          caseId: CASE,
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
  return { catalogDir, catalogPath, repositoryDir, task };
}

function optionsOf(_catalog: Fixture, overrides: Partial<RealTierBindingOptions> = {}): RealTierBindingOptions {
  return { caseId: CASE, pins: PINS, identity: IDENTITY, readTextFile: undefined, ...overrides };
}

/** Every refusal names its code and leaves no task file behind, byte for byte. */
async function assertRefused(assembly: RealTierAssembly, options: RealTierBindingOptions, reasonCode: string): Promise<void> {
  // The v0.2 seed lives under the store's claim directory (`claims/<taskId>/v02/task.json`), so the
  // whole store base is what a refusal must leave untouched.
  const taskDirectory = assembly.owners.store.baseDir;
  const before = storeFingerprint(taskDirectory);
  const refused = await bindRealTierTask(assembly, options);
  assert.equal(refused.status, 'unavailable', 'this input must refuse the binding');
  if (refused.status !== 'unavailable') return;
  assert.equal(refused.reasonCode, reasonCode);
  assert.equal(storeFingerprint(taskDirectory), before, 'a refusal writes no task record and changes no store byte');
}

function assemblyOrThrow(overrides: Partial<RealTierDependencies> = {}): { assembly: RealTierAssembly; effects: Effects; stateRoot: string } {
  const { deps, effects, stateRoot } = dependencies(overrides);
  const resolved = resolveRealTierAssembly(deps);
  assert.equal(resolved.status, 'assembly-ready');
  return { assembly: resolved as RealTierAssembly, effects, stateRoot };
}

/** An assembly whose profile names `catalog` as its own `catalog.path`: the binding's only trust root. */
function assemblyFor(catalog: Fixture, overrides: Partial<RealTierDependencies> = {}): { assembly: RealTierAssembly; effects: Effects; stateRoot: string } {
  const env = fixture.envOf({ catalog: { path: catalog.catalogPath } });
  return assemblyOrThrow({ env, ...overrides });
}

function boundOrThrow(binding: Awaited<ReturnType<typeof bindRealTierTask>>): RealTierBoundTask {
  assert.equal(binding.status, 'task-bound', JSON.stringify(binding));
  return binding as RealTierBoundTask;
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of [fixture.KEY, fixture.HREF, '192.0.2.10', '54321', fixture.DIGEST_KEY]) assert.ok(!serialized.includes(needle), 'serialized output must not carry a sentinel');
}

test('(a) the static stage is ready through the CLI loader with zero fetches, spawns and task writes', () => {
  const { deps, effects, stateRoot } = dependencies();
  const created = createHostAssembly(deps);
  assert.ok('host' in created, JSON.stringify(created));
  if (!('host' in created)) return;

  const configuration: HostConfiguration = {
    identity: IDENTITY,
    pins: PINS,
    profileDigest: DIGEST,
    configDigest: DIGEST,
    pricingDigest: DIGEST,
    requestedModel: fixture.MODEL,
    adapterVersions: ['uc03-real-tier/1'],
  };
  const readiness = prepareAssembly(created.host, configuration);
  assert.equal(readiness?.status, 'ready', JSON.stringify(readiness));
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assert.deepEqual(entriesUnder(stateRoot), [], 'the static stage writes no task, store or approval file');
  // Assembly-ready only: an unbound context names no task, so the graph's own expectation check refuses it.
  const unbound = trustedExpectedContext({ trustedExpectedContext: created.assembly.config.trustedExpectedContext } as never, taskOf(), seedTaskForCheck(taskOf()));
  assert.equal(unbound, undefined);
  assertNoSecrets({ metadata: created.metadata, evidenceTier: created.assembly.evidenceTier });
});

function seedTaskForCheck(task: BugTask): TaskState {
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: task.taskId,
    runId: 'run-1',
    workspaceId: 'ws-1',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    node: 'Validate',
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [],
    risks: [],
    nextAction: 'x',
  };
}

test('(b) every unbound producer refuses with TASK_UNBOUND and no effect', async () => {
  const { assembly } = assemblyOrThrow();
  const producers = assembly.producers;
  await assert.rejects(async () => producers.guardedRead.mediateRead({ kind: 'list', execute: async () => null }), /TASK_UNBOUND/u);
  await assert.rejects(async () => producers.hostAuthority.loadSnapshot({} as never), /TASK_UNBOUND/u);
  assert.throws(() => producers.contextSource.observe('task-1', 'action-1'), /TASK_UNBOUND/u);
  await assert.rejects(async () => (producers.baselineEvidence.loadBaselineEvidence as (...args: unknown[]) => Promise<unknown>)('x'), /TASK_UNBOUND/u);
  for (const method of ['listDir', 'readFile', 'searchCode', 'applyPatch', 'runCommand', 'runTests', 'inspectDiff'] as const) {
    await assert.rejects(async () => (assembly.hostPorts.repositoryPort[method] as (...args: unknown[]) => Promise<unknown>)('x'), /TASK_UNBOUND/u, method);
  }
  await assert.rejects(async () => (assembly.hostPorts.executionGuard.validateAndExecute as (...args: unknown[]) => Promise<unknown>)('x'), /TASK_UNBOUND/u);
  assert.throws(() => (assembly.hostPorts.configPort.loadConfig as (taskId: string) => unknown)('task-1'), /TASK_UNBOUND/u);
});

test('(c) binding is ready, the context is accepted, and no fetch or spawn happens', async () => {
  const catalog = fixtureOf();
  const { assembly, effects } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));

  assert.equal(binding.readiness.status, 'ready');
  assert.equal(binding.evidenceTier, 'controlled-prerequisite');
  assert.equal(binding.ids.taskId.startsWith('task-'), true);
  const seeded = await assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId }).statePort.loadTask(binding.ids.taskId);
  assert.ok(seeded);
  assert.equal(trustedExpectedContext({ trustedExpectedContext: binding.config.trustedExpectedContext } as never, binding.task, seeded as TaskState)?.taskId, binding.ids.taskId);
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assertNoSecrets({ ids: binding.ids, evidenceTier: binding.evidenceTier, status: binding.status });
});

test('(d) the seeded ledgers admit the first material replan and both admission spec sets resolve', async () => {
  // The direction authority is UC-05's; this row supplies it so the T044 accounting gate is what decides.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog, { verifyDirection: () => true });
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });

  const seeded = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  const ledgers = seeded.budgetLedgers ?? [];
  const replan = ledgers.find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
  assert.equal(replan?.limit, 3);
  assert.equal(replan?.configurationId, binding.task.configId);

  // `providerSpecs` and `repositoryResourceSpecs` are what the production admission path reads.
  const budgetRefs = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const providerContext = {
    subjectKind: 'provider-request',
    role: 'reviewer',
    budgetRefs,
    providerRequestId: 'req-1',
    finiteBounds: { maxBillableTokens: 1_000, maxCostUsd: 1, maxReviewerIterations: 1 },
  };
  assert.ok(providerSpecs(providerContext as never, ledgers), 'provider admission must resolve after the seed');
  const resourceContext = {
    subjectKind: 'repository-action',
    action: { kind: 'run_command', actionId: 'act-1' },
    reservationRefs: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'],
    finiteBounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 60, maxMemoryBytes: 2_147_483_648, maxProcessCount: 64 },
  };
  assert.ok(repositoryResourceSpecs(resourceContext as never, ledgers), 'resource admission must resolve after the seed');

  // The first real material replan through the T044 port, on a legal plan-bearing state of this task.
  // Validate -> Investigate -> AwaitPlan -> AwaitFeedback, one version per edge.
  const plan = planOf(binding.task);
  const step = async (next: Partial<TaskState>): Promise<void> => {
    const prior = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
    await owners.statePort.transition({ ...prior, ...next, stateVersion: prior.stateVersion + 1 }, prior.stateVersion);
  };
  await step({ node: 'Investigate', nextAction: 'propose-fix-plan', evidenceRefs: ['evi-1'] });
  await step({ node: 'AwaitPlan', nextAction: 'approve-fix-plan', planVersion: 1, plan });
  await step({ node: 'AwaitFeedback', nextAction: 'await-human-direction', planVersion: 1, plan, activeDecisionId: plan.decisionRef });
  const prior = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  assert.equal(prior.node, 'AwaitFeedback');

  const strategy = 'Check divisor == 0 and raise CalculationError';
  const candidate = { ...plan, strategy, strategyDigest: computeCanonicalSha256(strategy), decisionRef: undefined };
  const accepted = await owners.replanPort.accept({
    taskId: binding.ids.taskId,
    runId: binding.ids.runId,
    workspaceId: binding.ids.workspaceId,
    repositoryId: binding.task.repositoryId,
    configurationId: binding.task.configId,
    configurationVersion: binding.task.configVersion,
    proposalId: 'proposal-1',
    candidatePlan: candidate,
    candidatePlanDigest: computeCanonicalSha256(candidate),
    priorPlanVersion: 1,
    priorStateVersion: prior.stateVersion,
    priorReplanCount: 0,
    expectedNextReplanCount: 1,
    direction: {
      directive: 'revise',
      taskId: binding.ids.taskId,
      workspaceId: binding.ids.workspaceId,
      repositoryRevisionDigest: binding.task.initialRevisionDigest,
      stateVersion: prior.stateVersion,
      planVersion: 1,
      rejectedDecisionId: plan.decisionRef ?? '',
      strategyDigest: plan.strategyDigest,
    },
  });
  // The seeded ledgers are what makes this land: the assertion is the admitted outcome, not the refusal.
  assert.equal(accepted.outcome, 'accepted', JSON.stringify(accepted));
});

/** A recorded, approved plan at the task's own check set. */
function planOf(task: BugTask): FixPlan {
  const strategy = 'Check divisor == 0 before division';
  return {
    planVersion: 1,
    diagnosis: 'The divisor is not guarded',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-1'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: 'dec-plan-001',
  };
}

test('(e) a digest, revision, containment, task or replan-cap mismatch refuses before any write', async () => {
  const realRead = (path: string): string => readFileSync(path, 'utf8');
  // Fixture digest mismatch.
  const digestCase = fixtureOf();
  await assertRefused(
    assemblyFor(digestCase).assembly,
    optionsOf(digestCase, { readTextFile: path => (path.endsWith('case.json') ? '{"task":{},"repositoryRoot":"repository"}' : realRead(path)) }),
    'fixture-digest-mismatch',
  );

  // Revision mismatch: the catalog entry names another initial revision.
  const revisionCase = fixtureOf();
  const catalogText = realRead(revisionCase.catalogPath).replace(revisionCase.task.initialRevisionDigest.replace(/^sha256:/u, ''), 'd'.repeat(64));
  await assertRefused(assemblyFor(revisionCase).assembly, optionsOf(revisionCase, { readTextFile: path => (path.endsWith('catalog.json') ? catalogText : realRead(path)) }), 'revision-mismatch');

  // An escaping repositoryRoot: the fixture's own digest is recomputed over the escaping document.
  const escapeCase = fixtureOf();
  const escaping = JSON.stringify({ task: escapeCase.task, repositoryRoot: '../outside' });
  const escapeCatalog = JSON.stringify({
    catalog: [
      {
        catalogEntryId: 'entry-C01',
        caseId: CASE,
        fixturePath: join(escapeCase.catalogDir, 'case.json'),
        fixtureDigest: sha256Text(escaping),
        initialRepositoryDigest: escapeCase.task.initialRevisionDigest.replace(/^sha256:/u, ''),
      },
    ],
  });
  mkdirSync(join(escapeCase.catalogDir, '..', 'outside'), { recursive: true });
  await assertRefused(assemblyFor(escapeCase).assembly, optionsOf(escapeCase, { readTextFile: path => (path.endsWith('catalog.json') ? escapeCatalog : escaping) }), 'repository-root-escapes-catalog');

  // An invalid BugTask.
  const invalidCase = fixtureOf();
  const invalidDocument = JSON.stringify({ task: { ...invalidCase.task, goal: '' }, repositoryRoot: 'repository' });
  const invalidCatalog = JSON.stringify({
    catalog: [
      {
        catalogEntryId: 'entry-C01',
        caseId: CASE,
        fixturePath: join(invalidCase.catalogDir, 'case.json'),
        fixtureDigest: sha256Text(invalidDocument),
        initialRepositoryDigest: invalidCase.task.initialRevisionDigest.replace(/^sha256:/u, ''),
      },
    ],
  });
  await assertRefused(assemblyFor(invalidCase).assembly, optionsOf(invalidCase, { readTextFile: path => (path.endsWith('catalog.json') ? invalidCatalog : invalidDocument) }), 'task-invalid');

  // A maxReplanCount other than 3.
  const capCase = fixtureOf(taskOf({ budgetLimits: { maxReplanCount: 2, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 } }));
  await assertRefused(assemblyFor(capCase).assembly, optionsOf(capCase), 'replan-count-unsupported');
});

test('(f) a stale pin refuses with zero writes; a genuinely post-seed failure keeps the task', async () => {
  // The stale pin is decidable before the seed, so it must not write anything (STD-W4-003).
  const staleCase = fixtureOf();
  const staleAssembly = assemblyFor(staleCase);
  const stale = { contractVersion: CONTRACT, revisions: { ...PINS.revisions, statePort: 'f'.repeat(40) } };
  await assertRefused(staleAssembly.assembly, optionsOf(staleCase, { pins: stale }), 'host-stale-revision');

  // A bound that is invalid is refused statically too: a zero TTL is decided before the seed.
  const invalidCase = fixtureOf();
  const invalidAssembly = assemblyFor(invalidCase);
  await assertRefused(invalidAssembly.assembly, optionsOf(invalidCase, { actionTtlMs: 0 }), 'options-invalid');
  assert.deepEqual(invalidAssembly.effects, { fetch: 0, spawn: 0 });
});

test('(f2) a capability that cannot be constructed is a bounded unavailable, and the task stays persisted', async () => {
  // The retained root is a path the store cannot capture into: the task is seeded first, so the
  // refusal must be bounded and must leave the seeded record in place (§ rows f and 5).
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const retained = join(catalog.catalogDir, 'not-a-directory');
  writeFileSync(retained, 'x', 'utf8');
  const bound = await bindRealTierTask(assembly, optionsOf(catalog, { retainedRoot: retained }));
  assert.equal(bound.status, 'unavailable');
  if (bound.status !== 'unavailable') return;
  assert.equal(bound.reasonCode, 'binding-unavailable');
  const persisted = await assembly.owners.components.statePort.loadTask(catalog.task.taskId);
  assert.ok(persisted, 'the seeded task survives the later construction failure');
  assert.equal(persisted.stateVersion, 1);
});

test('(g) binding an existing task loads it and never re-seeds or overwrites it', async () => {
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const ids = (kind: string): string => `${kind}-fixed-1`;
  const first = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog, { ids })));
  const owners = assembly.owners.taskOwners({ taskId: first.ids.taskId, workspaceId: first.ids.workspaceId, repositoryId: first.task.repositoryId });
  const before = await owners.statePort.loadTask(first.ids.taskId);

  const second = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog, { ids })));
  const after = await owners.statePort.loadTask(second.ids.taskId);
  assert.deepEqual(after, before, 'the existing task record is byte-identical');
  assert.equal(after?.stateVersion, 1);
});

test('(g2) two binds of the same case return the same identity, and both contexts are defined', async () => {
  // The persisted identity is authoritative: a second bind must not allocate new run/workspace ids.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const first = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const second = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  assert.deepEqual(second.ids, first.ids, 'a rebind reuses the persisted run and workspace');
  const persisted = (await assembly.owners.components.statePort.loadTask(first.ids.taskId)) as TaskState;
  assert.ok(trustedExpectedContext({ trustedExpectedContext: first.config.trustedExpectedContext } as never, first.task, persisted), 'the first context is defined');
  assert.ok(trustedExpectedContext({ trustedExpectedContext: second.config.trustedExpectedContext } as never, second.task, persisted), 'the second context is defined');
  assert.equal(second.config.trustedExpectedContext?.workspaceId, persisted.workspaceId);
});

test('(h) no serialized output contains the sentinel key or the endpoint URL', async () => {
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  assertNoSecrets({ ids: binding.ids, task: binding.task, repositoryRoot: binding.repositoryRoot, readiness: binding.readiness.status });
  assertNoSecrets(seedLedgers(binding.task));
});

test('(i) an unrelated catalog cannot be bound: the catalog is the profile own catalog.path', async () => {
  const own = fixtureOf();
  const { assembly } = assemblyFor(own);
  // A second, self-consistent catalog whose own fixture names another task entirely.
  const foreign = fixtureOf(taskOf({ taskId: 'task-foreign' }));
  // The caller cannot name a catalog at all, so a smuggled `catalogPath` is never read: the bound task
  // is the profile catalog's own, with the profile catalog's repository.
  const bound = boundOrThrow(await bindRealTierTask(assembly, { ...optionsOf(own), catalogPath: foreign.catalogPath } as never));
  assert.equal(bound.task.taskId, 'task-calc-001', 'the fixture comes from the profile catalog, never the caller one');
  assert.notEqual(bound.repositoryRoot, foreign.repositoryDir);
  assert.equal(bound.repositoryRoot, own.repositoryDir);

  // A rewrite of the profile catalog after it is loaded is refused where it breaks the pinned digest.
  writeFileSync(own.catalogPath, JSON.stringify({ catalog: [] }), 'utf8');
  const afterRewrite = await bindRealTierTask(assembly, optionsOf(own));
  assert.equal(afterRewrite.status, 'unavailable');
  if (afterRewrite.status !== 'unavailable') return;
  assert.equal(afterRewrite.reasonCode, 'catalog-entry-missing');
});

test('(j) the bound repository port measures a real diff for a changed fixture file', async () => {
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  // Change a file in the target repository, then measure it through the bound port.
  writeFileSync(join(binding.repositoryRoot, 'src/calculator.py'), 'def divide(a, b):\n    if b == 0:\n        raise CalculationError\n    return a / b\n', 'utf8');
  const measured = await binding.ports.repositoryPort.inspectDiff(binding.task.initialRevisionDigest);
  assert.deepEqual(measured.changedFiles, ['src/calculator.py']);
  assert.equal(measured.diff.includes('-    return a / b'), true);
  assert.match(measured.diffDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('(k) the bound approval service admits a valid request and refuses a stale one', async () => {
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  await approvalScenario(binding, owners.approvalService);
});

/**
 * Register one action through the binding's returned source, then assert the valid request is
 * admitted and the stale one is refused. `approvalService` is whatever the cached owners expose.
 */
async function approvalScenario(binding: RealTierBoundTask, approvalService: { requestDecision: (request: never) => Promise<{ status: string }> }): Promise<void> {
  // A genuinely unconfigured command is APPROVAL_REQUIRED under the default policy, so it can be
  // requested; the binding's own context source is what makes the request admissible at all.
  // The graph names a decision's action by its own decision id; a first request has no stored record.
  const action = { actionId: 'decision-1', kind: 'run_command' as const, executable: 'pytest', argv: ['-x', 'tests/test_calculator.py'], workingDirectory: 'tests' };
  const revision = await new WorkspaceFilesystemPort({ root: binding.repositoryRoot }).getCurrentRevisionDigest();
  const source = binding.ports.contextSource as HostActionContext;
  const policyIdentity = { policyId: binding.task.configId, policyVersion: binding.task.configVersion, configId: binding.task.configId, configVersion: binding.task.configVersion };
  const registration = {
    action,
    facts: {
      taskId: binding.ids.taskId,
      workspaceId: binding.ids.workspaceId,
      repositoryId: binding.task.repositoryId,
      repositoryRevisionDigest: revision,
      policyIdentity,
      registeredActionDigest: computeActionDigest(action),
      continuationRef: 'continuation-1',
      role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: 'tests', constrainedCapability: 'constrained-tests' },
      patch: null,
      plan: null,
    },
    elements: { action: 'Run tests', necessity: 'Verify', targets: ['tests/test_calculator.py'], consequences: 'Runs tests', verificationStatus: 'Not executed' },
  };
  assert.equal((await source.register(registration)).actionId, 'decision-1');
  const request = {
    decisionId: 'decision-1',
    actionKind: 'action' as const,
    normalizedActionDigest: computeActionDigest(action),
    taskId: binding.ids.taskId,
    workspaceId: binding.ids.workspaceId,
    repositoryRevisionDigest: revision,
    policyId: binding.task.configId,
    policyVersion: binding.task.configVersion,
    status: 'pending' as const,
  };
  // A valid request through the bound service is admitted, not unavailable: the context source is wired.
  const admitted = await approvalService.requestDecision(request as never);
  assert.equal(admitted.status, 'pending');
  assert.equal((admitted as { decisionId?: string }).decisionId, 'decision-1');

  // A stale request names another revision than the one the host measured: refused as stale, never
  // admitted. The action is registered at the measured revision, so only the binding disagrees.
  const staleAction = { ...action, actionId: 'decision-2' };
  assert.equal((await source.register({ ...registration, action: staleAction, facts: { ...registration.facts, registeredActionDigest: computeActionDigest(staleAction) } })).actionId, 'decision-2');
  const staleRequest = { ...request, decisionId: 'decision-2', normalizedActionDigest: computeActionDigest(staleAction), repositoryRevisionDigest: `sha256:${'e'.repeat(64)}` };
  await assert.rejects(approvalService.requestDecision(staleRequest as never), (error: unknown) => (error as { outcome?: string }).outcome === 'stale');
}

test('(k2) after two binds, the second returned source is the one the cached approval service observes', async () => {
  // One task has exactly one context source and one action registry (SPEC-W4-103/STD-W4-102): the
  // approval registration made through the second bind's source must be visible to the cached owners.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const first = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const second = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  assert.equal(second.ids.taskId, first.ids.taskId);
  const owners = assembly.owners.taskOwners({ taskId: second.ids.taskId, workspaceId: second.ids.workspaceId, repositoryId: second.task.repositoryId });
  await approvalScenario(second, owners.approvalService);
});

test('(k3) the owner cache reuses only a matching rebind and refuses one whose security facts differ', async () => {
  // The cached owner set freezes its port's profile and control seed and its approval profile. A later
  // taskOwners call must not silently keep the first call's facts, and must keep working for the
  // ordinary rebind, which passes a fresh profile closure resolving to the same values every time.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const ids = { taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId };
  const policy = { policyId: binding.task.configId, policyVersion: binding.task.configVersion, configId: binding.task.configId, configVersion: binding.task.configVersion };
  const authorityRef = { ...policy, issuerKeyRef: `host-${binding.task.configId}`, decisionAuthorityGeneration: 1 };
  const profile = (): ReturnType<typeof executionProfileOf> => executionProfileOf(binding.task, assembly.profile.image.label, binding.ids);
  const cached = assembly.owners.taskOwners({ ...ids, policyIdentity: policy, authorityRef, executionProfile: profile });
  assert.equal(
    cached.statePort,
    assembly.owners.taskOwners({ ...ids, policyIdentity: { ...policy }, authorityRef: { ...authorityRef }, executionProfile: profile }).statePort,
    'an equivalent rebind reuses the cached owners',
  );

  assert.equal(assembly.owners.taskOwners(ids), cached, 'identity-only lookup reuses matching owners');
  assert.throws(() => assembly.owners.taskOwners({ ...ids, workspaceId: 'ws-other' }), /approval-operation-denied/u);
  assert.throws(() => assembly.owners.taskOwners({ ...ids, repositoryId: 'repo-other' }), /approval-operation-denied/u);

  const rows: readonly (readonly [string, Partial<RealTierTaskBinding>])[] = [
    ['another workspace', { workspaceId: 'ws-other' }],
    ['another repository', { repositoryId: 'repo-other' }],
    ['another authority generation', { authorityRef: { ...authorityRef, decisionAuthorityGeneration: 2 } }],
    ['another policy identity', { policyIdentity: { ...policy, configVersion: '9.9.9' } }],
    ['another execution profile', { executionProfile: () => ({ ...profile(), commandBounds: { ...profile().commandBounds, maxMemoryBytes: 1 } }) }],
  ];
  for (const [label, override] of rows) {
    assert.throws(() => assembly.owners.taskOwners({ ...ids, policyIdentity: policy, authorityRef, executionProfile: profile, ...override }), /approval-operation-denied/u, label);
  }

  // The reachable failure the finding named: a first direct call that omits the profile leaves the
  // synthetic constants cached, so a later call supplying one is refused rather than quietly reusing them.
  const fresh = assemblyFor(fixtureOf()).assembly;
  const bare = { taskId: 'task-unprofiled-1', workspaceId: 'ws-unprofiled-1', repositoryId: 'repo-calc' };
  fresh.owners.taskOwners(bare);
  assert.throws(() => fresh.owners.taskOwners({ ...bare, executionProfile: profile }), /approval-operation-denied/u);

  // Through the bind path, a differing policy identity is a bounded refusal before any seed or rebind.
  const changedPolicy = await bindRealTierTask(assembly, optionsOf(catalog, { policyIdentity: { ...policy, configVersion: '9.9.9' } }));
  assert.equal(changedPolicy.status, 'unavailable');
  if (changedPolicy.status !== 'unavailable') return;
  assert.equal(changedPolicy.reasonCode, 'binding-unavailable');
  assert.equal((await assembly.owners.components.statePort.loadTask(binding.ids.taskId))?.stateVersion, 1, 'the seeded task is unchanged');
});

test('(l) an empty identity refuses before any write, leaving the whole store byte-identical', async () => {
  // The identity is pre-checkable, so it is validated before the seed and before the retention (STD-W4-003).
  const catalog = fixtureOf();
  const { assembly, effects, stateRoot } = assemblyFor(catalog);
  await assertRefused(assembly, optionsOf(catalog, { identity: {} }), 'host-incomplete-identity');
  assert.deepEqual(entriesUnder(stateRoot), [], 'the refused bind leaves no store, approval or artifact file');
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
});

test('(n) a second task on one assembly refuses, and rebinding the same task still works', async () => {
  // The shared approval port resolves `classify`/`resolve` by the sole bound task, so one assembly is
  // one task (the planned runners build one assembly per task). A different task refuses with no write.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const first = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));

  // A second catalog entry in the same catalog directory, naming a different task on the same repository.
  const secondDocument = { task: taskOf({ taskId: 'task-other' }), repositoryRoot: 'repository' };
  const secondPath = join(catalog.catalogDir, 'case-2.json');
  writeFileSync(secondPath, JSON.stringify(secondDocument), 'utf8');
  const entries = JSON.parse(readFileSync(catalog.catalogPath, 'utf8')) as { catalog: Record<string, unknown>[] };
  entries.catalog.push({ ...entries.catalog[0], catalogEntryId: 'entry-C02', caseId: 'C02', fixturePath: secondPath, fixtureDigest: sha256Text(JSON.stringify(secondDocument)) });
  writeFileSync(catalog.catalogPath, JSON.stringify(entries), 'utf8');

  const before = storeFingerprint(assembly.owners.store.baseDir);
  const second = await bindRealTierTask(assembly, optionsOf(catalog, { caseId: 'C02' }));
  assert.equal(second.status, 'unavailable', JSON.stringify(second));
  if (second.status !== 'unavailable') return;
  assert.equal(second.reasonCode, 'assembly-task-bound');
  assert.equal(storeFingerprint(assembly.owners.store.baseDir), before, 'the refused second task writes nothing');

  // A rebind of the bound task reuses its persisted ids, so it stays legal.
  const again = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  assert.deepEqual(again.ids.taskId, first.ids.taskId);
});

test('(n2) STD-CR-001: two concurrent binds of different tasks admit exactly one', async () => {
  // Both calls start before either awaits; a check-then-register guard would let both seed.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const secondDocument = { task: taskOf({ taskId: 'task-other' }), repositoryRoot: 'repository' };
  const secondPath = join(catalog.catalogDir, 'case-2.json');
  writeFileSync(secondPath, JSON.stringify(secondDocument), 'utf8');
  const entries = JSON.parse(readFileSync(catalog.catalogPath, 'utf8')) as { catalog: Record<string, unknown>[] };
  entries.catalog.push({ ...entries.catalog[0], catalogEntryId: 'entry-C02', caseId: 'C02', fixturePath: secondPath, fixtureDigest: sha256Text(JSON.stringify(secondDocument)) });
  writeFileSync(catalog.catalogPath, JSON.stringify(entries), 'utf8');

  const [first, second] = await Promise.all([bindRealTierTask(assembly, optionsOf(catalog)), bindRealTierTask(assembly, optionsOf(catalog, { caseId: 'C02' }))]);
  assert.equal(first.status, 'task-bound');
  assert.equal(second.status, 'unavailable');
  if (second.status === 'unavailable') assert.equal(second.reasonCode, 'assembly-task-bound');
  assert.equal(await assembly.owners.components.statePort.loadTask('task-other'), null, 'the refused task is never seeded');
});

test('(o) a baseline command settles its reservation and a same-sized verification command is still admitted', async () => {
  // One command settles its whole per-command reservation, so a per-command limit as the cumulative
  // budget would exhaust it at the baseline. The seeded limit is that limit times the command allowance.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const seeded = (await assembly.owners
    .taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId })
    .statePort.loadTask(binding.ids.taskId)) as TaskState;
  // Worked by hand for this fixture (1 check; 2 repairs; 3 replans → 7 commands): [per command, cumulative].
  const expected: Readonly<Record<string, readonly [number, number]>> = {
    timeoutMs: [30_000, 210_000],
    maxOutputBytes: [1_048_576, 7_340_032],
    maxCpuSeconds: [60, 420],
    maxMemoryBytes: [2_147_483_648, 15_032_385_536],
    maxProcessCount: [64, 448],
  };
  for (const [kind, [amount, cumulative]] of Object.entries(expected)) {
    const ledger = (seeded.budgetLedgers ?? []).find(row => row.scope === 'task' && row.kind === kind);
    assert.ok(ledger, `${kind} must be seeded`);
    assert.equal(ledger.limit, cumulative, `${kind} carries one command allowance per bound command`);
    const reserve = (current: typeof ledger, keyedId: string) => stageReservation(current, { reservationId: `${kind}-${keyedId}`, keyedId, amount }, 'reserve');
    const reserved = reserve(ledger, 'baseline');
    assert.ok(reserved, `${kind} must admit the baseline reservation`);
    const settled = stageReservation(reserved, { reservationId: `${kind}-baseline`, keyedId: 'baseline', amount }, 'settle');
    assert.ok(settled, `${kind} must settle the baseline reservation`);
    assert.equal(settled.consumed, amount);
    assert.ok(reserve(settled, 'verify'), `${kind} must still admit a same-sized verification reservation`);
  }
});

test('(p) a capture that fails mid-measurement leaves no retained tree, and a retry still captures', async () => {
  // A failure after the copy must discard the temporary copy: a partial retainedRoot would make the
  // retry skip capture and measure the wrong base. A file larger than the read bound is the failure.
  const root = tempRoot('retained');
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'src/calculator.py'), 'x'.repeat(200), 'utf8');
  const baseRevision = await new WorkspaceFilesystemPort({ root: repositoryRoot }).getCurrentRevisionDigest();
  const retainedRoot = join(root, 'retained-tree');
  const options = { retainedRoot, repositoryRoot, taskId: 'task-calc-001', workspaceId: 'ws-1', repositoryId: 'repo-calc', baseRevision, maxDiffBytes: 1_048_576 };
  await assert.rejects(retainedDiffSource({ ...options, maxFileBytes: 10 }).prepare(), /FILE_TOO_LARGE/u);
  assert.equal(existsSync(retainedRoot), false, 'the failed capture leaves no retained tree');
  assert.deepEqual(readdirSync(root).sort(), ['repository'], 'and no temporary sibling');

  await retainedDiffSource({ ...options, maxFileBytes: 1_048_576 }).prepare();
  assert.equal(existsSync(retainedRoot), true, 'the retry captures the tree');
});

test('(m) a mutated retained tree refuses at rebind instead of binding ready', async () => {
  // §7 requires the exact immutable base: the retained bytes are re-measured at bind, not trusted.
  const catalog = fixtureOf();
  const { assembly } = assemblyFor(catalog);
  const first = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog)));
  const retained = join(assembly.profile.artifacts.retainRoot, 'repository', first.ids.taskId);
  assert.deepEqual(
    entriesUnder(retained).filter(entry => entry.startsWith('src')),
    ['src', join('src', 'calculator.py')],
  );
  writeFileSync(join(retained, 'src', 'calculator.py'), 'def divide(a, b):\n    return b / a\n', 'utf8');

  const second = await bindRealTierTask(assembly, optionsOf(catalog));
  assert.equal(second.status, 'unavailable', JSON.stringify(second));
  if (second.status !== 'unavailable') return;
  assert.equal(second.reasonCode, 'binding-unavailable');
});

interface ClaimContextOptions {
  readonly actionId: string;
  readonly bounds?: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly maxCpuSeconds: number; readonly maxMemoryBytes: number; readonly maxProcessCount: number };
  readonly exclusionsPolicyVersion?: string;
  readonly scratchIdentity?: string;
}

/** One pre-plan diagnostic `run_command` admission over the view facts the tier's own profile names. */
function claimContextOf(binding: RealTierBoundTask, state: TaskState, assembly: RealTierAssembly, options: ClaimContextOptions): unknown {
  const limits = binding.task.limits;
  const action = { actionId: options.actionId, kind: 'run_command' as const, executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], workingDirectory: 'tests', purpose: 'investigate' };
  const actionDigest = computeActionDigest(action);
  const authority = {
    policyId: binding.task.configId,
    policyVersion: binding.task.configVersion,
    configId: binding.task.configId,
    configVersion: binding.task.configVersion,
    issuerKeyRef: `host-${binding.task.configId}`,
    decisionAuthorityGeneration: 1,
  };
  const { policyId, policyVersion, configId, configVersion, decisionAuthorityGeneration } = authority;
  const receiptBody = {
    receiptId: `pe-${options.actionId}`,
    actionDigest,
    freshnessContextDigest: computeCanonicalSha256({ freshness: options.actionId }),
    policyId,
    policyVersion,
    configId,
    configVersion,
    decisionAuthorityGeneration,
    result: 'ALLOWED' as const,
  };
  const commandView = {
    viewId: `view-${binding.ids.workspaceId}-${'a'.repeat(12)}`,
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    canonicalRevision: state.repositoryRevisionDigest,
    admittedFiles: [{ path: 'tests/test_calculator.py', digest: computeCanonicalSha256('test-file') }],
    exclusionsPolicyVersion: options.exclusionsPolicyVersion ?? DEFAULT_EXCLUSIONS_POLICY_VERSION,
    scratchIdentity: options.scratchIdentity ?? computeWorkspaceVolumeIds(state.taskId, state.workspaceId).scratchVolumeId,
    mountedReadOnly: true as const,
    isolationProfileRef: assembly.profile.image.label,
  };
  return {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    runnableNode: 'Investigate',
    canonicalRevision: state.repositoryRevisionDigest,
    executionProfileId: assembly.profile.image.label,
    action,
    actionDigest,
    policyAuthorityRef: authority,
    policyEvaluationReceipt: { ...receiptBody, receiptDigest: computeCanonicalSha256(receiptBody) },
    commandView: { ...commandView, viewDigest: computeCanonicalSha256(commandView) },
    finiteBounds: {
      ...(options.bounds ?? {
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        maxCpuSeconds: Math.max(1, Math.ceil((limits.maxCpuCores * limits.timeoutMs) / 1000)),
        maxMemoryBytes: limits.maxMemoryBytes,
        maxProcessCount: limits.maxPids,
      }),
      isolationProfileRef: assembly.profile.image.label,
    },
    reservationRefs: ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].flatMap(kind => [`task-${kind}-${options.actionId}`, `run-${kind}-${options.actionId}`]),
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(binding.task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(binding.task.requiredChecks),
    checkId: 'check-1',
    testPath: 'tests/test_calculator.py',
  };
}

/** The same bound port, moved to the pre-plan `Investigate` node one diagnostic admission expects. */
async function boundOwnersAtInvestigate(binding: RealTierBoundTask, assembly: RealTierAssembly): Promise<{ owners: ReturnType<RealTierAssembly['owners']['taskOwners']>; state: TaskState }> {
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  const seeded = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  await owners.statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  return { owners, state: (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState };
}

test('(q) the bound task port admits a real view carrying the task workspace scratch and its limits', async () => {
  // The view the Docker builder would issue: the workspace's own scratch volume, the builder's
  // exclusions version, and the pinned task's limits — none of them the port's synthetic constants.
  const catalog = fixtureOf();
  // Row (m) mutates the shared retained tree; this row's own root keeps the order of the file irrelevant.
  const retainedRoot = join(tempRoot('retained-q'), 'artifacts');
  const { assembly } = assemblyFor(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog, { retainedRoot })));
  const { owners, state } = await boundOwnersAtInvestigate(binding, assembly);

  const claim = await owners.statePort.claim(claimContextOf(binding, state, assembly, { actionId: 'act-q-1' }) as never);
  assert.equal(claim.claimId, 'claim-act-q-1', 'the bound task port must admit the real view it will be handed');
});

test('(r) the bound profile is pinned from the seeded task: mutating the returned task cannot move the ceiling', async () => {
  // One fresh assembly per scenario: the first claim holds the port, so a second claim would be
  // refused for that reason rather than for the ceiling under test.
  const scenarios = [
    {
      label: 'a task lowered after binding cannot withdraw the pinned ceiling',
      mutate: (task: BugTask) => ((task.limits as { maxMemoryBytes: number }).maxMemoryBytes = 1),
      bound: 'above',
      admitted: true,
    },
    {
      label: 'a task raised after binding cannot widen the pinned ceiling',
      mutate: (task: BugTask) => ((task.limits as { maxMemoryBytes: number }).maxMemoryBytes *= 2),
      bound: 'over',
      admitted: false,
    },
  ] as const;
  for (const scenario of scenarios) {
    const catalog = fixtureOf();
    const retainedRoot = join(tempRoot(`retained-r-${scenario.bound}`), 'artifacts');
    const { assembly } = assemblyFor(catalog);
    const binding = boundOrThrow(await bindRealTierTask(assembly, optionsOf(catalog, { retainedRoot })));
    const { owners, state } = await boundOwnersAtInvestigate(binding, assembly);
    const original = { ...binding.task.limits };
    const pinnedBounds = {
      timeoutMs: original.timeoutMs,
      maxOutputBytes: original.maxOutputBytes,
      maxCpuSeconds: Math.max(1, Math.ceil((original.maxCpuCores * original.timeoutMs) / 1000)),
      maxMemoryBytes: original.maxMemoryBytes,
      maxProcessCount: original.maxPids,
    };
    // The view asks for exactly the ceiling the profile was pinned with; only a live `task.limits` read moves it.
    const bounds = scenario.bound === 'over' ? { ...pinnedBounds, maxMemoryBytes: original.maxMemoryBytes + 1 } : pinnedBounds;

    scenario.mutate(binding.task);
    const claim = await owners.statePort.claim(claimContextOf(binding, state, assembly, { actionId: `act-r-${scenario.bound}`, bounds }) as never);
    assert.equal(claim.claimId === `claim-act-r-${scenario.bound}`, scenario.admitted, scenario.label);
  }

  // STD-W5-107 drift guard: the owner profile imports the builder's own default (no second literal),
  // so a builder default change surfaces here as a decision instead of silently refusing real claims.
  assert.equal(DEFAULT_EXCLUSIONS_POLICY_VERSION, '0.1.0', 'bumping the builder default is a deliberate change to real claims');
  assert.equal(pinnedExecutionProfileOf(taskOf(), 'uc03-pytest:real-tier').exclusionsPolicyVersion, DEFAULT_EXCLUSIONS_POLICY_VERSION);
});

test('an uncloneable binding publishes no owners and permits a valid retry', () => {
  const { assembly } = assemblyFor(fixtureOf());
  const ids = { taskId: 'task-clone-retry', workspaceId: 'ws-clone-retry', repositoryId: 'repo-calc' };
  const invalid = { policyId: 'policy', policyVersion: '1', configId: 'config', configVersion: '1', uncloneable: () => undefined };
  assert.throws(() => assembly.owners.taskOwners({ ...ids, policyIdentity: invalid }), /clone/u);
  const policy = { policyId: 'policy', policyVersion: '1', configId: 'config', configVersion: '1' };
  const owners = assembly.owners.taskOwners({ ...ids, policyIdentity: policy });
  policy.configVersion = '2';
  assert.equal(assembly.owners.taskOwners({ ...ids, policyIdentity: { ...policy, configVersion: '1' } }), owners);
  assert.throws(() => assembly.owners.taskOwners({ ...ids, policyIdentity: policy }), /approval-operation-denied/u);
});
