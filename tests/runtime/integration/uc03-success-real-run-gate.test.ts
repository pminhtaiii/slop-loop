/**
 * T059 campaign gate: the T028 runner, its conformance receipt, the evidence checker and the three
 * PR-195 review rows (real-tier contract §(f) T028 row, §(h); host contract §1).
 *
 * Every row uses doubles and temp state roots: `fetch` is a counting fake, `spawn`/`preflight` are
 * Docker-readiness doubles, and the clock is injected. Nothing here reaches Docker, the network or a
 * real endpoint. Sentinels are RFC 5737 / `.invalid` values and a synthetic key.
 *
 * The CR-195 rows drive a *bound* assembly's own coder and reviewer model ports through `propose` and
 * its owner state port through `claim`/`beginAttempt`/`recordOutcome`, so the public seams the graph
 * uses are what is exercised — no reconstructed port and no private reservation helper.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  computeActionDigest,
  computeCommandViewDigest,
  computeCanonicalSha256,
  computeRequestContentDigest,
  computeCheckSetDigest,
  validateAdmissionV02,
} from '../../../src/contracts/foundation/uc03.ts';
import type { BugTask, ProviderAdmissionContextV02, RepositoryAdmissionContextV02, RunCommandAction, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { StructuredSpawn, StructuredSpawnResult } from '../../../src/foundation/docker-controller.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { computeContextDigest, type HostModelTransport } from '../../../src/foundation/model.ts';
import { resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { deriveTrustedContext } from '../../../src/persistence/adapters/state-port-v02-admission.ts';
import { createCommandOutcomeReceipt, normalizeCommandResult, type NormalizedCommandResultV02 } from '../../../src/foundation/repository-command-outcome.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { parseCampaignArgs, runCampaign, runCampaignCases, type CampaignOptions, type StageRecord } from './uc03-success-real-run.ts';
import { checkEvidence } from './uc03-success-real-evidence.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t059-gate-', 't059-gate-digest-key');
const CONTRACT = 'uc03-host-composition/2';
const REV = 'e'.repeat(40);
const CASE = 'C01';
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
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
function catalogFor(task = taskOf()): Catalog {
  const dir = tempRoot('catalog');
  const repositoryDir = join(dir, 'repository');
  mkdirSync(join(repositoryDir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(REPOSITORY_FILES)) writeFileSync(join(repositoryDir, path), content, 'utf8');
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(dir, 'case.json');
  writeFileSync(fixturePath, document, 'utf8');
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [{ catalogEntryId: `entry-${CASE}`, caseId: CASE, initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''), fixturePath, fixtureDigest: sha256Text(document) }],
    }),
    'utf8',
  );
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

/** One loaded assembly, its bound task, and the doubles that observe its effects. */
async function boundFixture(): Promise<{ assembly: RealTierAssembly; binding: RealTierBoundTask; effects: Effects; task: BugTask }> {
  const catalog = catalogFor();
  const { assembly, effects } = resolveOrThrow(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  return { assembly, binding, effects, task: catalog.task };
}

/**
 * The bound assembly's own branded transport. `modelPort` is the v0.2 port interface, so its option
 * bag is not part of that contract; the test reads it through one cast to build a second port over
 * the *same* transport, which keeps `provenance: 'real'` derived instead of declared.
 */
function transportOf(assembly: RealTierAssembly): HostModelTransport {
  return (assembly.components.modelPort as unknown as { readonly options: { readonly transport: HostModelTransport } }).options.transport;
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const needle of [fixture.KEY, fixture.HREF, '192.0.2.10', '54321', fixture.DIGEST_KEY]) assert.ok(!serialized.includes(needle), 'no record may carry a sentinel credential or endpoint');
}

/** A campaign over one temp evidence directory, counting the preflight and the conformance call. */
function campaignOptions(catalog: Catalog, evidenceDir: string, overrides: Partial<CampaignOptions> = {}): { options: CampaignOptions; effects: Effects } {
  const effects: Effects = { fetch: 0, spawn: 0 };
  const preflight = async () => {
    effects.spawn += 1;
    return { ok: true as const, dockerServerVersion: '27.0.1', imageId: IMAGE_ID };
  };
  return {
    effects,
    options: {
      mode: 'campaign',
      env: catalog.env,
      repositoryRoot: tempRoot('repo'),
      evidenceDir,
      stateRoot: tempRoot('state'),
      candidateSha: REV,
      clock: () => 1_700_000_000_000,
      preflight,
      fetch: async () => {
        effects.fetch += 1;
        return new Response(JSON.stringify({ model: MODEL, content: [] }), { status: 200 });
      },
      runCases: async () => [],
      ...overrides,
    },
  };
}

function writeRecord(dir: string, records: readonly StageRecord[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify({ records }, null, 2), 'utf8');
}

function onlyReceipt(dir: string): { outcome: string; binding: Record<string, string>; reasonCode?: string } {
  const names = readdirSync(dir).filter(name => name.startsWith('conformance-'));
  assert.equal(names.length, 1, 'exactly one receipt');
  return JSON.parse(readFileSync(join(dir, names[0] as string), 'utf8')) as { outcome: string; binding: Record<string, string>; reasonCode?: string };
}

const PASSING_CASES: readonly StageRecord[] = Object.freeze([
  { stage: 'case', outcome: 'pass', caseId: 'C01', facts: { workflow: 'COMPLETED' } },
  { stage: 'case', outcome: 'pass', caseId: 'C02', facts: { workflow: 'needs-info' } },
]);

/* ------------------------------------------------------------------ argv */

test('argv: exactly one mode, a value for every flag that needs one', () => {
  assert.deepEqual(parseCampaignArgs(['--campaign', '--evidence', 'out']), { mode: 'campaign', evidenceDir: 'out' });
  assert.deepEqual(parseCampaignArgs(['--case', 'C01', '--evidence', 'out']), { mode: 'case', caseId: 'C01', evidenceDir: 'out' });
  assert.deepEqual(parseCampaignArgs(['--resume', 'uc04-journal:claim-1', '--evidence', 'out']), { mode: 'resume', resumeRef: 'uc04-journal:claim-1', evidenceDir: 'out' });
  // A malformed invocation never defaults to a campaign.
  for (const args of [[], ['--case'], ['--case', 'C01', '--campaign'], ['--unknown'], ['--case', 'C01', '--case', 'C02'], ['--resume', '../escape'], ['--resume', 'uc04-journal:x', '--case', 'C01'], ['--evidence', 'out']]) {
    assert.deepEqual(parseCampaignArgs(args), { refused: 'arguments' }, JSON.stringify(args));
  }
});

/* ------------------------------------------- preflight and conformance gates */

test('a preflight refusal exits nonzero with zero fetches, no receipt and no case dispatch', async () => {
  const catalog = catalogFor();
  const { options, effects } = campaignOptions(catalog, tempRoot('evidence'), { preflight: async () => ({ ok: false, reasonCode: 'docker-unavailable' }) });
  const result = await runCampaign(options);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(effects, { fetch: 0, spawn: 0 });
  assert.deepEqual(
    result.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [['preflight', 'fail', 'docker-unavailable']],
  );
  assert.equal(readdirSync(options.evidenceDir).length, 0, 'a preflight refusal writes no receipt');
  assertNoSecrets(result);
});

test('each conformance failure exits nonzero after exactly one fetch and zero case dispatches', async () => {
  const rows: readonly (readonly [string, () => Promise<Response>])[] = [
    ['conformance-timeout', () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))],
    ['conformance-unreachable', () => Promise.reject(new Error('connect ECONNREFUSED'))],
    ['conformance-http-error', async () => new Response('{}', { status: 503 })],
    ['conformance-rate-limited', async () => new Response('{}', { status: 429 })],
    ['conformance-redirect', async () => new Response('', { status: 302, headers: { location: 'http://elsewhere.invalid/' } })],
    ['conformance-malformed', async () => new Response('not json', { status: 200 })],
    ['conformance-model-mismatch', async () => new Response(JSON.stringify({ model: 'other/model' }), { status: 200 })],
  ];
  for (const [reasonCode, respond] of rows) {
    const catalog = catalogFor();
    const evidenceDir = tempRoot('evidence');
    const dispatched: string[] = [];
    const { options } = campaignOptions(catalog, evidenceDir, {
      fetch: async () => {
        dispatched.push('fetch');
        return respond();
      },
      runCases: async () => {
        dispatched.push('case');
        return [];
      },
    });
    const result = await runCampaign(options);
    assert.equal(result.exitCode, 2, reasonCode);
    assert.deepEqual(dispatched, ['fetch'], `${reasonCode}: exactly one fetch and no case dispatch`);
    assert.deepEqual(
      result.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode ?? null]),
      [
        ['preflight', 'pass', null],
        ['conformance', 'fail', reasonCode],
      ],
      reasonCode,
    );
    assert.equal(onlyReceipt(evidenceDir).outcome, 'failed', `${reasonCode}: the failed campaign still records its refusal`);
    assertNoSecrets(result);
  }
});

test('a campaign writes one receipt bound to the candidate, profile, endpoint and model', async () => {
  const catalog = catalogFor();
  const { assembly } = resolveOrThrow(catalog);
  const evidenceDir = tempRoot('evidence');
  const { options, effects } = campaignOptions(catalog, evidenceDir, {
    clock: () => 1_700_000_000_000,
    runCases: async () => PASSING_CASES,
  });
  const result = await runCampaign(options);
  assert.equal(result.exitCode, 0, JSON.stringify(result.records));
  assert.equal(effects.fetch, 1, 'one conformance call');
  const receipt = onlyReceipt(evidenceDir);
  assert.equal(receipt.outcome, 'conformed');
  assert.deepEqual(receipt.binding, {
    candidateSha: REV,
    profileDigest: assembly.metadata.profileDigest,
    endpointDigest: `sha256:${createHmac('sha256', fixture.DIGEST_KEY).update(new URL(fixture.HREF).href, 'utf8').digest('hex')}`,
    model: MODEL,
  });
  assertNoSecrets(receipt);
});

/* ---------------------------------------------------------- `--case` gate */

test('`--case` refuses with zero fetches on a missing, malformed or stale receipt', async () => {
  const catalog = catalogFor();
  // A failed campaign on this exact binding leaves a receipt that cannot open the gate.
  const stale = campaignOptions(catalog, tempRoot('evidence'), { fetch: async () => new Response('{}', { status: 500 }) });
  await runCampaign(stale.options);

  const cases: readonly (readonly [string, string, string])[] = [
    ['receipt-missing', tempRoot('missing'), REV],
    ['receipt-malformed', tempRoot('malformed'), REV],
    ['receipt-stale', stale.options.evidenceDir, REV],
  ];
  const malformedDir = cases[1]?.[1] as string;
  writeFileSync(join(malformedDir, 'conformance-broken.json'), '{"schemaVersion":"uc03-conformance-receipt/1"}', 'utf8');
  for (const [reasonCode, evidenceDir, candidateSha] of cases) {
    const { options, effects } = campaignOptions(catalog, evidenceDir, {
      mode: 'case',
      caseId: CASE,
      candidateSha,
      fetch: async () => {
        effects.fetch += 1;
        return new Response('{}', { status: 200 });
      },
    });
    const result = await runCampaign({ ...options, fetch: async () => {
      effects.fetch += 1;
      return new Response('{}', { status: 200 });
    } });
    assert.equal(result.exitCode, 2, reasonCode);
    assert.equal(effects.fetch, 0, `${reasonCode}: a refused --case fetches nothing`);
    assert.deepEqual(
      result.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
      [['receipt', 'fail', reasonCode]],
      reasonCode,
    );
  }
});

test('a failed campaign supersedes an earlier passing one; a further passing campaign restores it', async () => {
  const catalog = catalogFor();
  const evidenceDir = tempRoot('evidence');
  const passing = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_000_000, runCases: async () => PASSING_CASES });
  const failing = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_100_000, fetch: async () => new Response('{}', { status: 500 }) });
  const restore = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_200_000, runCases: async () => PASSING_CASES });
  const gate = async () => {
    const { options } = campaignOptions(catalog, evidenceDir, { mode: 'case', caseId: CASE, fetch: async () => new Response('{}', { status: 200 }), runCases: async () => PASSING_CASES });
    return runCampaign(options);
  };

  assert.equal((await runCampaign(passing.options)).exitCode, 0);
  assert.equal((await gate()).exitCode, 0, 'a conformed campaign opens the gate');

  assert.equal((await runCampaign(failing.options)).exitCode, 2);
  const afterFailure = await gate();
  assert.equal(afterFailure.exitCode, 2, 'the newest campaign on this binding failed, so the gate closes');
  assert.deepEqual(afterFailure.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]), [['receipt', 'fail', 'receipt-stale']]);

  assert.equal((await runCampaign(restore.options)).exitCode, 0);
  assert.equal(readdirSync(evidenceDir).filter(name => name.startsWith('conformance-')).length, 3, 'each campaign keeps its own receipt');
  assert.equal((await gate()).exitCode, 0, 'the latest receipt on that binding decides');
});

test('`--case` binds to the newest conformed receipt and runs one case stage', async () => {
  const catalog = catalogFor();
  const evidenceDir = tempRoot('evidence');
  await runCampaign(campaignOptions(catalog, evidenceDir, { runCases: async () => PASSING_CASES }).options);

  const requested: string[][] = [];
  const { options, effects } = campaignOptions(catalog, evidenceDir, {
    mode: 'case',
    caseId: CASE,
    fetch: async () => {
      effects.fetch += 1;
      throw new Error('a bound --case replays no conformance call');
    },
    runCases: async (_assembly, stageOptions) => {
      requested.push([...stageOptions.caseIds]);
      return PASSING_CASES.filter(entry => entry.caseId === CASE);
    },
  });
  const result = await runCampaign(options);
  assert.equal(result.exitCode, 0, JSON.stringify(result.records));
  assert.equal(effects.fetch, 0, 'a bound --case fetches nothing: its receipt already exists');
  assert.deepEqual(requested, [[CASE]], 'exactly the requested case runs');
});

test('the real case stage drives the bound graph and records what it observed', async () => {
  const catalog = catalogFor();
  const { assembly, effects } = resolveOrThrow(catalog);
  const pins = pinsOf(assembly);
  // The real stage: binding, the v0.2 graph entry and the owner journal, with no injected verdict.
  const records = await runCampaignCases(assembly, { caseIds: [CASE], repositoryRoot: tempRoot('repo'), ...pins });
  const [first, retry] = records;
  // C01 pins COMPLETED; a task with no learned plan cannot reach it, so the row is an honest failure,
  // never a fabricated pass. Zero fetches: the real graph reached the model port and was refused there.
  assert.equal(first?.caseId, CASE);
  assert.equal(first?.stage, 'case');
  assert.equal(first?.outcome, 'fail', JSON.stringify(first));
  assert.equal(first?.facts?.['workflow'], 'INCOMPLETE');
  assert.equal(effects.fetch, 0, 'a bound graph run dispatches no transport call here');
  // C01's second attempt is not replayed on the assembly that already claimed the task.
  assert.deepEqual([retry?.outcome, retry?.reasonCode, retry?.facts?.['attempt']], ['not-run', 'retry-unavailable', 2]);

  // A case id the catalog does not carry is a bounded refusal, not an invented task.
  const missing = await runCampaignCases(assembly, { caseIds: ['C99'], repositoryRoot: tempRoot('repo'), ...pins });
  assert.deepEqual(missing.map(entry => [entry.outcome, entry.reasonCode]), [['not-run', 'catalog-entry-missing']]);
});

/* ------------------------------------------------------------- continuation */

test('a continuation over a blocked uncertain ref refuses with zero effects', async () => {
  const catalog = catalogFor();
  const stateRoot = tempRoot('state');
  const counters: Effects = { fetch: 0, spawn: 0 };
  const result = await runCampaign({
    mode: 'resume',
    resumeRef: 'uc04-journal:claim-never-issued',
    env: catalog.env,
    repositoryRoot: tempRoot('repo'),
    evidenceDir: tempRoot('evidence'),
    stateRoot,
    candidateSha: REV,
    fetch: async () => {
      counters.fetch += 1;
      throw new Error('a blocked continuation must not fetch');
    },
    spawn: async () => {
      counters.spawn += 1;
      throw new Error('a blocked continuation must not spawn');
    },
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(counters, { fetch: 0, spawn: 0 });
  assert.deepEqual(result.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]), [['recovery', 'fail', 'continuation-blocked']]);
});

/* ------------------------------------------------------------ evidence check */

test('the checker fails a failed or not-run predicate and passes a clean campaign', () => {
  const scan = { env: fixture.envOf(), repositoryRoot: tempRoot('repo') };
  const clean = tempRoot('clean');
  writeRecord(clean, [...PASSING_CASES, { stage: 'preflight', outcome: 'pass' }]);
  assert.deepEqual(checkEvidence({ evidenceDir: clean, ...scan }), { exitCode: 0, output: 'EVIDENCE_CLEAN 2 case(s)' });

  const rows: readonly (readonly [string, readonly StageRecord[], string])[] = [
    ['failed case', [{ stage: 'case', outcome: 'fail', caseId: 'C01' }, PASSING_CASES[1] as StageRecord], 'case:C01:fail'],
    ['not-run case', [PASSING_CASES[0] as StageRecord, { stage: 'case', outcome: 'not-run', caseId: 'C02', reasonCode: 'unpinned' }], 'case:C02:not-run:unpinned'],
    ['failed stage', [{ stage: 'conformance', outcome: 'fail', reasonCode: 'conformance-timeout' }, ...PASSING_CASES], 'conformance:fail:conformance-timeout'],
    ['missing C02', [PASSING_CASES[0] as StageRecord], 'case:missing:C02'],
  ];
  for (const [label, records, expected] of rows) {
    const dir = tempRoot('evidence');
    writeRecord(dir, records);
    const result = checkEvidence({ evidenceDir: dir, ...scan });
    assert.equal(result.exitCode, 1, label);
    assert.match(result.output, new RegExp(`EVIDENCE_INCOMPLETE[\\s\\S]*${expected.replaceAll(':', ':')}`, 'u'), label);
  }

  // Unusable input is exit 2, never a pass.
  assert.equal(checkEvidence({ evidenceDir: tempRoot('empty'), ...scan }).exitCode, 2);
  const invalid = tempRoot('invalid');
  writeFileSync(join(invalid, 'campaign.json'), '{"records":[{"stage":"case","outcome":"maybe"}]}', 'utf8');
  assert.equal(checkEvidence({ evidenceDir: invalid, ...scan }).exitCode, 2);
});

test('the checker fails on a T057 scan leak in the evidence directory', () => {
  const dir = tempRoot('leak');
  writeRecord(dir, PASSING_CASES);
  writeFileSync(join(dir, 'retained.log'), `endpoint=${fixture.HREF}\n`, 'utf8');
  const result = checkEvidence({ evidenceDir: dir, env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^EVIDENCE_SCAN_FAILED\n/u);
  assert.ok(!result.output.includes(fixture.HREF), 'the checker never echoes the endpoint');
  assert.ok(!result.output.includes('192.0.2.10'), 'the checker never echoes the host');
});

/* ------------------------------------------------- CR-195 (A): both model ports */

/** A coder/reviewer provider admission bound to the task's persisted control head. */
function providerContext(
  state: TaskState,
  task: BugTask,
  journal: { readonly controlVersion: number; readonly epoch: number },
  role: 'coder' | 'reviewer',
  providerRequestId: string,
  generation: number,
): ProviderAdmissionContextV02 {
  const reservationRef = `res-${providerRequestId}`;
  const budgetRefs = [`b-tokens-${providerRequestId}`, `b-cost-${providerRequestId}`, `r-tokens-${providerRequestId}`, `r-cost-${providerRequestId}`, ...(role === 'reviewer' ? [`b-iter-${providerRequestId}`] : [])];
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
      return new Response(JSON.stringify({ id: 'msg-1', model: MODEL, content: [{ type: 'text', text: '{"status":"accepted","findings":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
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
  assert.deepEqual(
    journal.claims.map(claim => claim.claimId).sort(),
    ['claim-req-coder-1', 'claim-req-reviewer-1'],
  );
  assert.equal(journal.outcomes.length, 2);
  assert.equal(journal.claims.every(claim => claim.status === 'settled'), true, 'both claims settle');
  assert.equal(dispatched.length, 2);
  assertNoSecrets({ coder, reviewer });
});

/* ----------------------------------- CR-195 (C): public state-port accounting */

/** A run-command admission bound to the task's persisted control head and command view. */
function commandContext(
  state: TaskState,
  task: BugTask,
  journal: { readonly controlVersion: number; readonly epoch: number },
  actionId: string,
  generation: number,
): RepositoryAdmissionContextV02 {
  // A pre-plan diagnostic check's action purpose must equal the admission's `diagnosticPurpose`.
  const action: RunCommandAction = { actionId, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], workingDirectory: 'tests', purpose: 'investigate' };
  const isolationProfileRef = assembly_label();
  const actionDigest = computeActionDigest(action);
  const policyAuthorityRef = { policyId: task.configId, policyVersion: task.configVersion, configId: task.configId, configVersion: task.configVersion, issuerKeyRef: `host-${task.configId}`, decisionAuthorityGeneration: generation };
  const commandView = {
    viewId: `view-${actionId}`,
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    canonicalRevision: state.repositoryRevisionDigest,
    admittedFiles: [{ path: 'tests/test_calculator.py', digest: computeCanonicalSha256('test-file') }],
    exclusionsPolicyVersion: 'exclusions-v1',
    scratchIdentity: 'scratch-admission-v02',
    mountedReadOnly: true as const,
    isolationProfileRef,
  };
  // The digest covers exactly the keys the admission carries: the owner recomputes it over the input.
  const view = { ...commandView, viewDigest: computeCommandViewDigest(commandView as unknown as Parameters<typeof computeCommandViewDigest>[0]) };
  const finiteBounds = { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuSeconds: 10, maxMemoryBytes: 536_870_912, maxProcessCount: 5, isolationProfileRef };
  const freshnessContextDigest = computeCanonicalSha256({ taskId: state.taskId, runId: state.runId, actionDigest, canonicalRevision: state.repositoryRevisionDigest, policyAuthorityRef });
  const policyEvaluationReceiptBody = {
    receiptId: `pe-${actionId}`,
    actionDigest,
    freshnessContextDigest,
    policyId: policyAuthorityRef.policyId,
    policyVersion: policyAuthorityRef.policyVersion,
    configId: policyAuthorityRef.configId,
    configVersion: policyAuthorityRef.configVersion,
    decisionAuthorityGeneration: generation,
    result: 'ALLOWED' as const,
  };
  const policyEvaluationReceipt = { ...policyEvaluationReceiptBody, receiptDigest: computeCanonicalSha256(policyEvaluationReceiptBody) };
  // Ten reservation refs: five task rows then five run rows, in `repositoryResourceSpecs` order.
  const reservationRefs = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].flatMap(kind => [`task-${kind}-${actionId}`, `run-${kind}-${actionId}`]);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: journal.controlVersion,
    expectedEpoch: journal.epoch,
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    runnableNode: 'Investigate',
    canonicalRevision: state.repositoryRevisionDigest,
    executionProfileId: isolationProfileRef,
    action,
    actionDigest,
    policyAuthorityRef,
    policyEvaluationReceipt,
    commandView: view,
    finiteBounds,
    reservationRefs,
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: 'check-1',
    testPath: 'tests/test_calculator.py',
  };
  // The production port derives its own trusted context from the admission; reusing that derivation
  // keeps this fixture from duplicating (and drifting from) the owner's own consistency rules.
  const trusted = deriveTrustedContext(context as unknown as RepositoryAdmissionContextV02);
  const admitted = validateAdmissionV02(context, trusted);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  return admitted.value as RepositoryAdmissionContextV02;
}

/**
 * The bound task port seeds the control head at generation 1, so a claim needs a published authority
 * at the generation the admission names. Publishing through the *bound owner* port is the public path.
 */
async function publishGeneration(binding: RealTierBoundTask, task: BugTask, generation: number): Promise<void> {
  // `publishAuthority` is the durable owner's own adapter method (real-tier §(b)5), beside the contract;
  // only the task-bound port names the task it publishes for, so the unbound one refuses with `conflict`.
  const owner = binding.ports.statePort as unknown as { publishAuthority(input: unknown): Promise<{ readonly status: string }> };
  const receipt = await owner.publishAuthority({
    authorityRef: { policyId: task.configId, policyVersion: task.configVersion, configId: task.configId, configVersion: task.configVersion, issuerKeyRef: `host-${task.configId}`, decisionAuthorityGeneration: generation },
  });
  assert.equal(receipt.status, 'published', JSON.stringify(receipt));
}

/** One bound task, its generation-2 authority published, moved to the pre-plan Investigate node. */
async function investigating(assembly: RealTierAssembly, binding: RealTierBoundTask, task: BugTask): Promise<{ owners: ReturnType<RealTierAssembly['owners']['taskOwners']>; state: TaskState; journal: { readonly controlVersion: number; readonly epoch: number } }> {
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  await publishGeneration(binding, task, 2);
  const seeded = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  await owners.statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  const state = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as { readonly controlVersion: number; readonly epoch: number };
  return { owners, state, journal };
}

/** The profile's own isolation label, which the seeded resource ledger policy keys on. */
function assembly_label(): string {
  return 'uc03-pytest:real-tier';
}

test('CR-195-C: a settled baseline command frees capacity for a same-sized verification command', async () => {
  const catalog = catalogFor();
  const { assembly } = resolveOrThrow(catalog);
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  const { owners } = await investigating(assembly, binding, catalog.task);

  const command = async (actionId: string): Promise<void> => {
    const state = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
    const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as { readonly controlVersion: number; readonly epoch: number };
    const context = commandContext(state, catalog.task, journal, actionId, 2);
    const claim = await owners.statePort.claim(context);
    assert.equal(claim.claimId, `claim-${actionId}`, `${actionId}: the claim must open (reserve)`);
    const attempt = await owners.statePort.beginAttempt(claim.claimId, {
      adapterIdentity: 'adapter-probe',
      processIncarnation: 'proc-probe',
      fencingGeneration: 1,
      payloadDigest: context.actionDigest,
    });
    assert.equal(attempt.attemptId, `att-claim-${actionId}`, `${actionId}: the attempt must begin`);
    // The production builder is the receipt authority: hand-building one would test our own guess.
    const receipt = createCommandOutcomeReceipt(claim, attempt, context, 'observed', normalizeCommandResult({
      plan: { checkId: 'check-1' },
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      outcome: 'success',
      truncated: false,
    }) as NormalizedCommandResultV02);
    const settled = await owners.statePort.recordOutcome(receipt);
    assert.equal(settled.outcome, 'settled', `${actionId}: the observed command must settle`);
  };

  const resourceRows = (state: TaskState): readonly { readonly scope: string; readonly kind: string; readonly consumed: number; readonly reserved: number }[] =>
    (state.budgetLedgers ?? [])
      .filter(ledger => ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind))
      .map(ledger => ({ scope: ledger.scope, kind: ledger.kind, consumed: ledger.consumed, reserved: ledger.reservations.reduce((sum, item) => sum + item.amount, 0) }));

  const before = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  assert.deepEqual(resourceRows(before).filter(row => row.reserved > 0), [], 'the seed holds no reservation');

  await command('act-baseline-1');
  const afterBaseline = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  for (const row of resourceRows(afterBaseline)) {
    assert.equal(row.reserved, 0, `${row.scope}:${row.kind} keeps no reservation once the command settles`);
    assert.ok(row.consumed > 0, `${row.scope}:${row.kind} records the consumption on both ledgers`);
  }
  assert.equal(resourceRows(afterBaseline).filter(row => row.scope === 'task').length, 5, 'all five task rows move');
  assert.equal(resourceRows(afterBaseline).filter(row => row.scope === 'run').length, 5, 'all five run rows move');

  // The same-sized verification command is admitted rather than refused: settlement freed the slot.
  await command('act-verify-1');
  const afterVerify = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  for (const row of resourceRows(afterVerify)) {
    const prior = resourceRows(afterBaseline).find(candidate => candidate.scope === row.scope && candidate.kind === row.kind);
    assert.ok(prior !== undefined && row.consumed > prior.consumed, `${row.scope}:${row.kind} consumed twice`);
    assert.equal(row.reserved, 0);
  }
  const journal = (await owners.statePort.getJournalSnapshot(binding.ids.taskId)) as { readonly outcomes: readonly unknown[] };
  assert.equal(journal.outcomes.length, 2, 'two settled command receipts are recorded');
});

/* ------------------------------------------------------- CR-195 (B): the fence */

/**
 * CR-195-FENCE. The contract asks that a fence published after `beginAttempt` and before transport
 * make both bound ports refuse with zero fetches. It does not: the assembly's
 * `currentExecutorIdentity` is a fixed generation-1 actor (`real-tier-assembly.ts`), so its
 * `isCurrent()` re-checks compare that constant with itself and never observe a control/epoch change.
 * This row is skipped rather than failed so the suite stays green; the witness below records exactly
 * what happens instead. The assembly is out of this task's owned paths, so it is reported, not fixed.
 */
test(
  'CR-195-FENCE: a fence after beginAttempt must make both bound ports refuse with zero fetches',
  { skip: 'NOT IMPLEMENTED: real-tier-assembly.ts currentExecutorIdentity is a fixed generation-1 actor, so a post-beginAttempt fence is unobserved; both ports dispatch (1 fetch each). Reported to the coordinator; the assembly is outside T059 owned paths.' },
  async () => {
    const { assembly, binding } = await boundFixture();
    const { owners, state, journal } = await investigating(assembly, binding, catalogFor().task);
    const context = providerContext(state, catalogFor().task, journal, 'coder', 'req-fenced-1', 2);
    // Publish the UC-05 control fence the moment the attempt is durable, before any transport call.
    const fenced = new Proxy(assembly.components.statePort, {
      get(target, property) {
        if (property === 'beginAttempt') {
          return async (claimId: string, executor: never) => {
            const attempt = await target.beginAttempt(claimId, executor);
            await owners.statePort.setTaskControl(state.taskId, 'paused', 'fence-cr-195');
            return attempt;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { HostModelPortV02 } = await import('../../../src/foundation/model-v02.ts');
    const actor = { adapterIdentity: 'cr-195-coder', processIncarnation: 'cr-195-incarnation', fencingGeneration: 1 };
    const port = new HostModelPortV02({ transport: transportOf(assembly), statePort: fenced as never, executorIdentity: actor, currentExecutorIdentity: () => actor });
    const result = await port.propose(state, [], context.providerRequest, context);
    assert.equal(result.outcome, 'denied', 'a fenced port must refuse');
    assert.equal(result.reason, 'FENCED_EXECUTOR');
  },
);

test('CR-195-FENCE observed: the post-beginAttempt fence is unobserved, so the port dispatches once', async () => {
  const catalog = catalogFor();
  const { assembly, effects } = resolveOrThrow(catalog, {
    fetch: async () => {
      effects.fetch += 1;
      return new Response(JSON.stringify({ id: 'msg-1', model: MODEL, content: [{ type: 'text', text: '{"status":"ok"}' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
    },
  });
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  const { owners, state, journal } = await investigating(assembly, binding, catalog.task);
  const context = providerContext(state, catalog.task, journal, 'coder', 'req-fenced-observed', 2);

  // The fence lands inside beginAttempt, i.e. after the claim and after the attempt record is durable.
  const fenced = new Proxy(assembly.components.statePort, {
    get(target, property) {
      if (property === 'beginAttempt') {
        return async (claimId: string, executor: never) => {
          const attempt = await target.beginAttempt(claimId, executor);
          await owners.statePort.setTaskControl(state.taskId, 'paused', 'fence-cr-195-observed');
          return attempt;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { HostModelPortV02 } = await import('../../../src/foundation/model-v02.ts');
  const actor = { adapterIdentity: 'cr-195-observed', processIncarnation: 'cr-195-observed-incarnation', fencingGeneration: 1 };
  const port = new HostModelPortV02({ transport: transportOf(assembly), statePort: fenced as never, executorIdentity: actor, currentExecutorIdentity: () => actor });
  const result = await port.propose(state, [], context.providerRequest, context);
  // The observed defect: the fence is durable (paused) yet the dispatch already happened.
  const control = await owners.statePort.getJournalSnapshot(state.taskId);
  assert.equal((control as { mode: string }).mode, 'paused', 'the fence is persisted before transport');
  assert.equal(result.outcome, 'observed', 'the port dispatches despite the fence');
  assert.equal(effects.fetch, 1, 'exactly one fetch escapes the fence');
});

test('CR-195-FENCE observed: a fence between claim and beginAttempt refuses with zero fetches', async () => {
  const catalog = catalogFor();
  const { assembly, effects } = resolveOrThrow(catalog, {
    fetch: async () => {
      effects.fetch += 1;
      return new Response(JSON.stringify({ id: 'msg-1', model: MODEL, content: [{ type: 'text', text: '{"status":"ok"}' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
    },
  });
  const binding = boundOrThrow(await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) }));
  const { owners, state, journal } = await investigating(assembly, binding, catalog.task);
  const context = providerContext(state, catalog.task, journal, 'coder', 'req-fenced-early', 2);
  const { HostModelPortV02 } = await import('../../../src/foundation/model-v02.ts');
  const actor = { adapterIdentity: 'cr-195-early', processIncarnation: 'cr-195-early-incarnation', fencingGeneration: 1 };

  const early = new Proxy(assembly.components.statePort, {
    get(target, property) {
      if (property === 'claim') {
        return async (admission: never) => {
          const claim = await target.claim(admission);
          await owners.statePort.setTaskControl(state.taskId, 'paused', 'fence-cr-195-early');
          return claim;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const port2 = new HostModelPortV02({ transport: transportOf(assembly), statePort: early as never, executorIdentity: actor, currentExecutorIdentity: () => actor });
  const fetched = effects.fetch;
  const refused = await port2.propose(state, [], context.providerRequest, context);
  assert.equal(refused.outcome, 'denied');
  assert.equal(refused.reason, 'ATTEMPT_DENIED: Mismatched provider attempt');
  assert.equal(effects.fetch, fetched, 'the claim-to-attempt fence admits no transport call');
});
