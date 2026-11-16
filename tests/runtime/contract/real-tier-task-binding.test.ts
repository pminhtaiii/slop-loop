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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, CONTRACT_VERSION } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { HostActionContext } from '../../../src/runtime/host-action-context.ts';
import type { BugTask, FixPlan, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { createHostAssembly, resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, type RealTierBindingOptions, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';
import { prepareAssembly } from '../../../src/cli/evaluate-host.ts';
import type { HostConfiguration } from '../../../src/cli/evaluate-host.ts';
import { providerSpecs, repositoryResourceSpecs } from '../../../src/persistence/adapters/state-port-v02-ledgers.ts';
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

/** Every refusal names its code and leaves no task file behind. */
async function assertRefused(assembly: RealTierAssembly, options: RealTierBindingOptions, reasonCode: string): Promise<void> {
  // The v0.2 seed lives under the store's claim directory (`claims/<taskId>/v02/task.json`), so the
  // whole store base is what a refusal must leave untouched.
  const taskDirectory = assembly.owners.store.baseDir;
  const before = entriesUnder(taskDirectory);
  const refused = await bindRealTierTask(assembly, options);
  assert.equal(refused.status, 'unavailable', 'this input must refuse the binding');
  if (refused.status !== 'unavailable') return;
  assert.equal(refused.reasonCode, reasonCode);
  assert.deepEqual(entriesUnder(taskDirectory), before, 'a refusal writes no task record');
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
  const admitted = await owners.approvalService.requestDecision(request);
  assert.equal(admitted.status, 'pending');
  assert.equal(admitted.decisionId, 'decision-1');

  // A stale request names another revision than the one the host measured: refused as stale, never
  // admitted. The action is registered at the measured revision, so only the binding disagrees.
  const staleAction = { ...action, actionId: 'decision-2' };
  assert.equal((await source.register({ ...registration, action: staleAction, facts: { ...registration.facts, registeredActionDigest: computeActionDigest(staleAction) } })).actionId, 'decision-2');
  const staleRequest = { ...request, decisionId: 'decision-2', normalizedActionDigest: computeActionDigest(staleAction), repositoryRevisionDigest: `sha256:${'e'.repeat(64)}` };
  await assert.rejects(owners.approvalService.requestDecision(staleRequest), (error: unknown) => (error as { outcome?: string }).outcome === 'stale');
});
