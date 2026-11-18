/** Bound production coder/reviewer dispatch: current control permits one fetch; a late pause permits none. Controlled ports only. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeRequestContentDigest, validateAdmissionV02 } from '../../../src/contracts/foundation/uc03.ts';
import type { BugTask, ProviderAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeContextDigest } from '../../../src/foundation/model.ts';
import { resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t059-gate-', 't059-gate-digest-key');
const CONTRACT = 'uc03-host-composition/2';
const REV = 'e'.repeat(40);
const CASE = 'C01';
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const REPOSITORY_FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;

interface Effects {
  fetch: number;
  spawn: number;
}

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `t059-${label}-`));
}

function revisionOf(files: Readonly<Record<string, string>>): string {
  const lines = Object.keys(files)
    .sort()
    .map(path => `${path}\0${computeFileDigest(files[path] ?? '')}\n`);
  return computeCanonicalSha256(lines.join(''));
}

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
      { checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
    ...overrides,
  };
}

interface Catalog {
  readonly task: BugTask;
  readonly env: RealTierEnvironment;
}

/** A temp catalog with one contained repository, one digest-pinned fixture and its profile. */
function catalogFor(task = taskOf(), extraCases: readonly string[] = []): Catalog {
  const dir = tempRoot('catalog');
  const repositoryDir = join(dir, 'repository');
  mkdirSync(join(repositoryDir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(REPOSITORY_FILES)) writeFileSync(join(repositoryDir, path), content, 'utf8');
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(dir, 'case.json');
  writeFileSync(fixturePath, document, 'utf8');
  const catalogPath = join(dir, 'catalog.json');
  const entryOf = (caseId: string) => ({
    catalogEntryId: `entry-${caseId}`,
    caseId,
    initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    fixtureDigest: sha256Text(document),
  });
  writeFileSync(catalogPath, JSON.stringify({ catalog: [entryOf(CASE), ...extraCases.map(entryOf)] }), 'utf8');
  return { task, env: fixture.envOf({ catalog: { path: catalogPath } }) };
}

function spawnDouble(effects: Effects): StructuredSpawn {
  return async (): Promise<StructuredSpawnResult> => {
    effects.spawn += 1;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
}

/** The pins and identity the T057 host template derives, so a campaign binds without a host file. */
function pinsOf(assembly: RealTierAssembly): { pins: { contractVersion: string; revisions: Record<string, string> }; identity: Record<string, string> } {
  return {
    pins: { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: {
      profileId: 'uc03-runtime-evaluation-v1',
      profileDigest: assembly.metadata.profileDigest,
      configDigest: `sha256:${sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits }))}`,
      pricingDigest: `sha256:${sha256Text(JSON.stringify(assembly.profile.pricing))}`,
    },
  };
}

function resolveOrThrow(catalog: Catalog, overrides: Partial<RealTierDependencies> = {}): { assembly: RealTierAssembly; effects: Effects; stateRoot: string } {
  const effects: Effects = { fetch: 0, spawn: 0 };
  const stateRoot = tempRoot('state');
  const resolved = resolveRealTierAssembly({
    env: catalog.env,
    revision: REV,
    stateRoot,
    spawn: spawnDouble(effects),
    fetch: async () => {
      effects.fetch += 1;
      throw new Error('this stage must never fetch');
    },
    ...overrides,
  });
  assert.equal(resolved.status, 'assembly-ready', JSON.stringify(resolved));
  return { assembly: resolved as RealTierAssembly, effects, stateRoot };
}

function boundOrThrow(binding: Awaited<ReturnType<typeof bindRealTierTask>>): RealTierBoundTask {
  assert.equal(binding.status, 'task-bound', JSON.stringify(binding));
  return binding as RealTierBoundTask;
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of [fixture.KEY, fixture.HREF, '192.0.2.10', '54321', fixture.DIGEST_KEY]) assert.ok(!serialized.includes(needle), 'no record may carry a sentinel credential or endpoint');
}

function providerContext(
  state: TaskState,
  task: BugTask,
  journal: { readonly controlVersion: number; readonly epoch: number },
  role: 'coder' | 'reviewer',
  providerRequestId: string,
  generation: number,
): ProviderAdmissionContextV02 {
  const reservationRef = `res-${providerRequestId}`;
  const budgetRefs = [
    `b-tokens-${providerRequestId}`,
    `b-cost-${providerRequestId}`,
    `r-tokens-${providerRequestId}`,
    `r-cost-${providerRequestId}`,
    ...(role === 'reviewer' ? [`b-iter-${providerRequestId}`] : []),
  ];
  const providerIdentity = {
    providerId: 'provider-deepseek',
    modelId: MODEL,
    configId: task.configId,
    configVersion: task.configVersion,
    pricingPolicyId: task.configId,
    pricingPolicyVersion: task.configVersion,
    issuerKeyRef: `host-${task.configId}`,
    decisionAuthorityGeneration: generation,
  };
  const providerRequest = {
    providerRequestId,
    taskId: state.taskId,
    runId: state.runId,
    role,
    purpose: role === 'reviewer' ? 'final-review' : 'propose_fix_plan',
    providerId: providerIdentity.providerId,
    modelId: MODEL,
    configId: task.configId,
    pricingPolicyId: task.configId,
    contextDigest: computeContextDigest(state, []),
    timeoutMs: 60_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    maxBillableTokens: 12_000,
    maxCostUsd: 0.5,
    reservationRef,
    dispatchState: 'reserved' as const,
  };
  const requestContentDigest = computeRequestContentDigest(providerRequest);
  const providerAdmissionReceipt = {
    receiptId: `par-${providerRequestId}`,
    receiptDigest: sha256Text(`rec-${providerRequestId}`),
    providerRequestId,
    role,
    requestContentDigest,
    providerId: providerIdentity.providerId,
    modelId: MODEL,
    configId: task.configId,
    configVersion: task.configVersion,
    decisionAuthorityGeneration: generation,
  };
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: journal.controlVersion,
    expectedEpoch: journal.epoch,
    taskId: state.taskId,
    runId: state.runId,
    runnableNode: state.node,
    providerRequest,
    providerRequestId,
    role,
    requestContentDigest,
    providerIdentity,
    providerAdmissionReceipt,
    requestReservationReceipt: reservationRef,
    budgetRefs,
    finiteBounds: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxBillableTokens: 12_000, maxCostUsd: 0.5, ...(role === 'reviewer' ? { maxReviewerIterations: 2 } : {}) },
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
  };
  // The fixture is checked against the canonical validator before it is handed to a port.
  const admitted = validateAdmissionV02(context, {
    subjectKind: 'provider-request',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: journal.controlVersion,
    expectedEpoch: journal.epoch,
    taskId: state.taskId,
    runId: state.runId,
    runnableNode: state.node,
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    role,
    providerRequestId,
    requestContentDigest,
    providerAdmissionReceiptRef: providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: providerAdmissionReceipt.receiptDigest,
    requestReservationReceipt: reservationRef,
    budgetRefs,
    providerIdentity,
    requestLimits: { timeoutMs: 60_000, maxInputTokens: 8_000, maxOutputTokens: 2_000, maxBillableTokens: 12_000, maxCostUsd: 0.5, ...(role === 'reviewer' ? { maxReviewerIterations: 2 } : {}) },
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return admitted.value as ProviderAdmissionContextV02;
}

test('CR-195-A: both bound model ports admit one request and dispatch exactly once each', async () => {
  const catalog = catalogFor();
  const dispatched: { role: string; body: string }[] = [];
  const { assembly, effects } = resolveOrThrow(catalog, {
    fetch: async (_url, init) => {
      effects.fetch += 1;
      const body = typeof init?.body === 'string' ? init.body : '';
      dispatched.push({ role: body.includes('"role":"reviewer"') || body.length > 0 ? 'unknown' : 'unknown', body });
      // The raw payload is the messages envelope; the role is not in it, so the reply is role-agnostic.
      return new Response(JSON.stringify({ id: 'msg-1', model: MODEL, content: [{ type: 'text', text: '{"status":"accepted","findings":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } }), {
        status: 200,
      });
    },
  });
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  // A pre-plan provider admission is only legal at Investigate, so the bound task moves there first.
  const { owners, state } = await investigating(assembly, binding, catalog.task);

  const run = async (role: 'coder' | 'reviewer', providerRequestId: string) => {
    const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as { readonly controlVersion: number; readonly epoch: number };
    const context = providerContext(state, catalog.task, journal, role, providerRequestId, 2);
    const port = role === 'coder' ? binding.ports.modelPort : binding.ports.reviewerModelPort;
    return port.propose(state, [], context.providerRequest, context);
  };

  const before = effects.fetch;
  const coder = await run('coder', 'req-coder-1');
  assert.equal(coder.outcome, 'observed', JSON.stringify(coder));
  assert.equal(effects.fetch - before, 1, 'the coder port dispatches exactly once');

  const afterCoder = effects.fetch;
  const reviewer = await run('reviewer', 'req-reviewer-1');
  assert.equal(reviewer.outcome, 'observed', JSON.stringify(reviewer));
  assert.equal(effects.fetch - afterCoder, 1, 'the reviewer port dispatches exactly once');

  // Two distinct accounted chains on the one bound task, both settled.
  const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as {
    readonly claims: readonly { readonly claimId: string; readonly status: string }[];
    readonly outcomes: readonly { readonly claimId: string; readonly outcome: string }[];
  };
  assert.deepEqual(journal.claims.map(claim => claim.claimId).sort(), ['claim-req-coder-1', 'claim-req-reviewer-1']);
  assert.equal(journal.outcomes.length, 2);
  assert.equal(
    journal.claims.every(claim => claim.status === 'settled'),
    true,
    'both claims settle',
  );
  assert.equal(dispatched.length, 2);
  assertNoSecrets({ coder, reviewer });
});

/* ----------------------------------- CR-195 (C): public state-port accounting */
async function publishGeneration(binding: RealTierBoundTask, task: BugTask, generation: number): Promise<void> {
  // `publishAuthority` is the durable owner's own adapter method (real-tier Â§(b)5), beside the contract;
  // only the task-bound port names the task it publishes for, so the unbound one refuses with `conflict`.
  const owner = binding.ports.statePort as unknown as { publishAuthority(input: unknown): Promise<{ readonly status: string }> };
  const receipt = await owner.publishAuthority({
    authorityRef: {
      policyId: task.configId,
      policyVersion: task.configVersion,
      configId: task.configId,
      configVersion: task.configVersion,
      issuerKeyRef: `host-${task.configId}`,
      decisionAuthorityGeneration: generation,
    },
  });
  assert.equal(receipt.status, 'published', JSON.stringify(receipt));
}

/** One bound task, its generation-2 authority published, moved to the pre-plan Investigate node. */
async function investigating(
  assembly: RealTierAssembly,
  binding: RealTierBoundTask,
  task: BugTask,
): Promise<{ owners: ReturnType<RealTierAssembly['owners']['taskOwners']>; state: TaskState; journal: { readonly controlVersion: number; readonly epoch: number } }> {
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  await publishGeneration(binding, task, 2);
  const seeded = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  await owners.statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  const state = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as { readonly controlVersion: number; readonly epoch: number };
  return { owners, state, journal };
}

/**
 * CR-195-FENCE. A control pause persisted after `beginAttempt` returns a durable attempt and before
 * transport must make both bound production ports refuse with zero fetches (SPEC-W5-001). The fence
 * lands inside the assembly's own `statePort.beginAttempt`, so both ports observe the real sequence;
 * the assembly's `currentDispatchAuthority` reads the bound task's durable control head just before
 * `executeTransport`, which is where the constant actor callbacks can no longer hide the pause.
 */
test('CR-195-FENCE: a fence after beginAttempt makes both bound production ports refuse with zero fetches', async () => {
  for (const role of ['coder', 'reviewer'] as const) {
    const catalog = catalogFor();
    const effects: Effects = { fetch: 0, spawn: 0 };
    // A fenced dispatch must not reach the transport, so the counting fake would throw if it did.
    const { assembly } = resolveOrThrow(catalog, {
      fetch: async () => {
        effects.fetch += 1;
        throw new Error('a fenced port must not fetch');
      },
    });
    const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
    const { owners, state, journal } = await investigating(assembly, binding, catalog.task);
    const context = providerContext(state, catalog.task, journal, role, `req-fenced-${role}`, 2);
    // The fence lands inside beginAttempt of the very port the model port dispatches through (the
    // shared owner state port), so both bound ports observe the real beginAttemptâ†’transport sequence.
    const modelState = assembly.components.statePort;
    const ownBegin = modelState.beginAttempt.bind(modelState);
    modelState.beginAttempt = async (claimId: string, executor: never) => {
      const attempt = await ownBegin(claimId, executor);
      await owners.statePort.setTaskControl(state.taskId, 'paused', `fence-cr-195-${role}`);
      return attempt;
    };
    const port = role === 'coder' ? binding.ports.modelPort : binding.ports.reviewerModelPort;
    const result = await port.propose(state, [], context.providerRequest, context);
    assert.equal(result.outcome, 'denied', `${role}: a fenced port must refuse`);
    assert.equal(result.reason, 'FENCED_EXECUTOR', `${role}: the refusal names the fence`);
    assert.equal(effects.fetch, 0, `${role}: zero fetches escape the fence`);
    const control = await owners.statePort.getJournalSnapshot(state.taskId);
    assert.equal((control as { mode: string }).mode, 'paused', `${role}: the fence is durable before transport`);
  }
});

test('CR-195-FENCE observed: a fence between claim and beginAttempt refuses with zero fetches', async () => {
  const catalog = catalogFor();
  const effects: Effects = { fetch: 0, spawn: 0 };
  const { assembly } = resolveOrThrow(catalog, {
    fetch: async () => {
      effects.fetch += 1;
      throw new Error('a fenced port must not fetch');
    },
  });
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  const { owners, state, journal } = await investigating(assembly, binding, catalog.task);
  const context = providerContext(state, catalog.task, journal, 'coder', 'req-fenced-early', 2);
  // The distinct earlier race: the fence lands inside `claim` of the port the model port dispatches
  // through, before any attempt exists. It is refused even earlier (ATTEMPT_DENIED), not by the
  // final authority check.
  const modelState = assembly.components.statePort;
  const ownClaim = modelState.claim.bind(modelState);
  modelState.claim = async (admission: never) => {
    const claim = await ownClaim(admission);
    await owners.statePort.setTaskControl(state.taskId, 'paused', 'fence-cr-195-early');
    return claim;
  };
  const refused = await binding.ports.modelPort.propose(state, [], context.providerRequest, context);
  assert.equal(refused.outcome, 'denied');
  assert.equal(refused.reason, 'ATTEMPT_DENIED: Mismatched provider attempt');
  assert.equal(effects.fetch, 0, 'the claim-to-attempt fence admits no transport call');
});
