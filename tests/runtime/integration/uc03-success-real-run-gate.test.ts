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
import { computeContextDigest } from '../../../src/foundation/model.ts';
import { resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, executionProfileOf, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { deriveTrustedContext } from '../../../src/persistence/adapters/state-port-v02-admission.ts';
import { computeWorkspaceVolumeIds } from '../../../src/foundation/docker-workspace-policy.ts';
import { createCommandOutcomeReceipt, normalizeCommandResult, type NormalizedCommandResultV02 } from '../../../src/foundation/repository-command-outcome.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { parseCampaignArgs } from './uc03-success-real-entry.ts';
import { runCampaign, type CampaignOptions } from './uc03-success-real-run.ts';
import { runCaseStage } from './uc03-success-real-run-cases.ts';
import type { DecisionTarget } from './uc03-success-real-operator.ts';
import type { CaseGradeRequest, GradeOutcome } from './uc03-success-real-grader.ts';
import { checkEvidence } from './uc03-success-real-evidence.ts';
import { allowedProviderResponse } from './uc03-success-real-c10.ts';
import type { StageRecord } from './uc03-success-real-record.ts';
import { PASSING_ROWS, STAGES, gradeFor, passingCases, writeRecord } from './uc03-success-real-fixture.ts';
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

/** The grader seam that returns a validated grade. The campaign judge reads the receipt, never the workflow string (SPEC-W5-003). */
const gradePass = async (_assembly: RealTierAssembly, caseId: string, request: CaseGradeRequest): Promise<GradeOutcome> => {
  const grade = gradeFor(caseId, 'pass');
  return {
    grade,
    binding: {
      taskId: request.task.taskId,
      runId: 'run-1',
      workspaceId: 'ws-1',
      caseId,
      criterionId: grade.criterionId ?? `criterion-${caseId}`,
      criteriaDigest: grade.criteriaDigest,
      snapshotId: grade.snapshot?.snapshotId ?? `snap-${caseId}`,
      snapshotDigest: grade.snapshot?.digest ?? '',
      evidenceDigest: grade.evidenceDigest ?? '',
      tier: 'controlled-tier',
      executorId: 'mock-grader-executor',
      admissionId: request.requiresAdmission ? 'admission-1' : null,
    },
  };
};

/** The stage seam of a campaign whose four cases all pass, each with the artifact bound to this campaign. */
const passingStage: NonNullable<CampaignOptions['runCases']> = async (_assembly, stage) => passingCases(stage.campaignId, stage.binding);

function onlyReceipt(dir: string): { outcome: string; binding: Record<string, string>; reasonCode?: string } {
  const names = readdirSync(dir).filter(name => name.startsWith('conformance-'));
  assert.equal(names.length, 1, 'exactly one receipt');
  return JSON.parse(readFileSync(join(dir, names[0] as string), 'utf8')) as { outcome: string; binding: Record<string, string>; reasonCode?: string };
}

/** The retained campaign record, parsed as the checker would see it. */
function readCampaignRecord(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')) as Record<string, unknown>;
}

/** Each `--campaign` writes its own subdirectory, so the newest one holds this run's record. */
function campaignDirOf(dir: string): string {
  const subdirs = readdirSync(dir).filter(name => name.startsWith('campaign-'));
  assert.equal(subdirs.length >= 1, true, 'a campaign writes a per-campaign directory');
  return join(dir, subdirs.sort().at(-1) as string);
}

test('a campaign persists a versioned record and per-attempt case artifacts', async () => {
  const catalog = catalogFor();
  const evidenceDir = tempRoot('evidence');
  const result = await runCampaign(campaignOptions(catalog, evidenceDir, { runCases: passingStage }).options);
  assert.equal(result.exitCode, 0, JSON.stringify(result.records));
  const dir = campaignDirOf(evidenceDir);
  const record = readCampaignRecord(dir);
  assert.equal(record['schemaVersion'], 'uc03-campaign-record/2');
  assert.equal(record['passed'], true);
  assert.equal((record['bindings'] as Record<string, string>)['model'], MODEL);
  const verified = checkEvidence({ evidenceDir: dir, env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
  assert.deepEqual(verified, { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });
});

/* ------------------------------------------------------------------ argv */

test('argv: exactly one mode, a value for every flag that needs one', () => {
  assert.deepEqual(parseCampaignArgs(['--campaign', '--evidence', 'out']), { mode: 'campaign', evidenceDir: 'out' });
  assert.deepEqual(parseCampaignArgs(['--case', 'C01', '--evidence', 'out']), { mode: 'case', caseId: 'C01', evidenceDir: 'out' });
  assert.deepEqual(parseCampaignArgs(['--resume', 'uc04-journal:claim-1', '--evidence', 'out']), { mode: 'resume', resumeRef: 'uc04-journal:claim-1', evidenceDir: 'out' });
  // A malformed invocation never defaults to a campaign.
  for (const args of [
    [],
    ['--case'],
    ['--case', 'C01', '--campaign'],
    ['--unknown'],
    ['--case', 'C01', '--case', 'C02'],
    ['--resume', '../escape'],
    ['--resume', 'uc04-journal:x', '--case', 'C01'],
    ['--evidence', 'out'],
  ]) {
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
  // A preflight refusal writes no conformance receipt (only the campaign record of the failure).
  assert.deepEqual(
    readdirSync(options.evidenceDir).filter(name => name.startsWith('conformance-')),
    [],
    'a preflight refusal writes no receipt',
  );
  assert.equal(readCampaignRecord(campaignDirOf(options.evidenceDir))['passed'], false, 'the failed campaign is still retained as a record');
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

test('a profile model other than the pinned identity, or a whitespace-wrapped reply, is refused before any case', async () => {
  // A profile that selects the wrong model stops before any fetch or case dispatch (SPEC-W5-011).
  const offlineCatalog = catalogFor();
  const wrongProfile = { ...offlineCatalog, env: fixture.envOf({ provider: { ...fixture.PROVIDER, model: 'po/deepseek-ai/deepseek-v4.1-flash-9999' } }) };
  const dispatched: string[] = [];
  const wrongOptions = campaignOptions(wrongProfile, tempRoot('evidence'), {
    fetch: async () => {
      dispatched.push('fetch');
      return new Response('{}', { status: 200 });
    },
    runCases: async () => {
      dispatched.push('case');
      return [];
    },
  });
  const refused = await runCampaign(wrongOptions.options);
  assert.equal(refused.exitCode, 2);
  assert.deepEqual(dispatched, [], 'a wrong profile model dispatches neither fetch nor case');
  assert.deepEqual(
    refused.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [
      ['preflight', 'pass', undefined],
      ['conformance', 'fail', 'conformance-model-mismatch'],
    ],
  );

  // A reply carrying the right id plus whitespace is still a different identity: exact equality only.
  const padded = new Response(JSON.stringify({ model: `${MODEL} ` }), { status: 200 });
  const displaced: string[] = [];
  const paddedOptions = campaignOptions(catalogFor(), tempRoot('evidence'), {
    fetch: async () => {
      displaced.push('fetch');
      return padded;
    },
    runCases: async () => {
      displaced.push('case');
      return [];
    },
  });
  const paddedResult = await runCampaign(paddedOptions.options);
  assert.equal(paddedResult.exitCode, 2);
  assert.deepEqual(displaced, ['fetch'], 'a whitespace-wrapped model fetches once and no case dispatches');
  assert.deepEqual(
    paddedResult.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [
      ['preflight', 'pass', undefined],
      ['conformance', 'fail', 'conformance-model-mismatch'],
    ],
  );
});

test('a campaign writes one receipt bound to the candidate, profile, endpoint and model', async () => {
  const catalog = catalogFor();
  const { assembly } = resolveOrThrow(catalog);
  const evidenceDir = tempRoot('evidence');
  const { options, effects } = campaignOptions(catalog, evidenceDir, {
    clock: () => 1_700_000_000_000,
    runCases: passingStage,
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
    const result = await runCampaign({
      ...options,
      fetch: async () => {
        effects.fetch += 1;
        return new Response('{}', { status: 200 });
      },
    });
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
  const passing = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_000_000, runCases: passingStage });
  const failing = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_100_000, fetch: async () => new Response('{}', { status: 500 }) });
  const restore = campaignOptions(catalog, evidenceDir, { clock: () => 1_700_000_200_000, runCases: passingStage });
  const gate = async () => {
    const { options } = campaignOptions(catalog, evidenceDir, { mode: 'case', caseId: CASE, fetch: async () => new Response('{}', { status: 200 }), runCases: passingStage });
    return runCampaign(options);
  };

  assert.equal((await runCampaign(passing.options)).exitCode, 0);
  assert.equal((await gate()).exitCode, 0, 'a conformed campaign opens the gate');

  assert.equal((await runCampaign(failing.options)).exitCode, 2);
  const afterFailure = await gate();
  assert.equal(afterFailure.exitCode, 2, 'the newest campaign on this binding failed, so the gate closes');
  assert.deepEqual(
    afterFailure.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [['receipt', 'fail', 'receipt-stale']],
  );

  assert.equal((await runCampaign(restore.options)).exitCode, 0);
  assert.equal(readdirSync(evidenceDir).filter(name => name.startsWith('conformance-')).length, 3, 'each campaign keeps its own receipt');
  assert.equal((await gate()).exitCode, 0, 'the latest receipt on that binding decides');
});

test('`--case` binds to the newest conformed receipt and runs one case stage', async () => {
  const catalog = catalogFor();
  const evidenceDir = tempRoot('evidence');
  await runCampaign(campaignOptions(catalog, evidenceDir, { runCases: passingStage }).options);

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
      return (await passingStage(_assembly, stageOptions)).filter(entry => entry.record.caseId === CASE);
    },
  });
  const result = await runCampaign(options);
  assert.equal(result.exitCode, 0, JSON.stringify(result.records));
  assert.equal(effects.fetch, 0, 'a bound --case fetches nothing: its receipt already exists');
  assert.deepEqual(requested, [[CASE]], 'exactly the requested case runs');
});

test('the real case stage assembles a fresh host per case and records what it observed', async () => {
  const catalog = catalogFor();
  const { assembly } = resolveOrThrow(catalog);
  const pins = pinsOf(assembly);
  let assembled = 0;
  const assemble = () => {
    assembled += 1;
    return resolveOrThrow(catalog).assembly;
  };
  // The real stage: a fresh assembly per case, binding, the v0.2 graph entry and the owner journal,
  // with no injected verdict — the pinned grader supplies the outcome, never the status string.
  const [first] = await runCaseStage(assemble, { caseIds: [CASE], repositoryRoot: tempRoot('repo'), ...pins, grade: gradePass });
  // The workflow alone does not prove a repair; only the pinned grade is consulted for the verdict.
  assert.equal(first?.record.caseId, CASE);
  assert.equal(first?.record.stage, 'case');
  assert.equal(first?.record.outcome, 'pass', `the verdict follows the pinned grade, not the workflow string: ${JSON.stringify(first?.record)}`);
  assert.equal(first?.record.facts?.['workflow'], 'INCOMPLETE', 'the underlying workflow did not complete, and its status is retained as a fact');
  assert.equal(first?.evidence?.grade?.grade, 'pass', 'the retained grade is retained evidence, not the workflow string');
  assert.equal(assembled, 1, 'exactly one fresh assembly for one case');

  // With no grader the case stays not-run, never a pass, even when the workflow returned something.
  const [ungraded] = await runCaseStage(assemble, { caseIds: [CASE], repositoryRoot: tempRoot('repo'), ...pins });
  assert.deepEqual([ungraded?.record.outcome, ungraded?.record.reasonCode], ['not-run', 'grader-unavailable']);

  // A case id the catalog does not carry is a bounded refusal, not an invented task.
  const [missing] = await runCaseStage(assemble, { caseIds: ['C99'], repositoryRoot: tempRoot('repo'), ...pins, grade: gradePass });
  assert.deepEqual([missing?.record.outcome, missing?.record.reasonCode], ['not-run', 'catalog-entry-missing']);
});

test('C16 is judged from the C01 report on its own content, and C10 is never inferred from C01', async () => {
  const catalog = catalogFor();
  const { assembly } = resolveOrThrow(catalog);
  const pins = pinsOf(assembly);
  // C01 graded pass, yet this route's report cites no evidence: C16 is judged unsafe on the report's
  // own content and fails, never a pass carried over from the C01 grade (SPEC-W5-103).
  const outcomes = await runCaseStage(() => resolveOrThrow(catalog).assembly, { caseIds: ['C01', 'C16'], repositoryRoot: tempRoot('repo'), ...pins, grade: gradePass });
  const byId = new Map(outcomes.map(entry => [entry.record.caseId, entry.record]));
  const c16 = outcomes.find(entry => entry.record.caseId === 'C16');
  assert.equal(byId.get('C01')?.outcome, 'pass', 'C01 passes on its pinned grade');
  assert.equal(byId.get('C16')?.outcome, 'fail', 'C16 follows the report it was given, not the repair grade');
  assert.equal(byId.get('C16')?.reasonCode, 'c16-report-unprovenanced', 'an unprovenanced report is unsafe');
  assert.equal((c16?.derived?.body as { verdict: string }).verdict, 'fail', 'the artifact carries the predicate verdict');
  // C10 runs its own witness even when it is the only scheduled case, and never derives from C01.
  let dispatched = 0;
  // The task's token ledger must admit the over-limit reservation, so the limiter is what refuses it.
  const roomy = catalogFor(taskOf({ budgetLimits: { maxReplanCount: 3, maxTokens: 2_000_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 } }));
  const witness = (fetchImpl: () => Response, withCounter = true, source = roomy) =>
    runCaseStage(() => resolveOrThrow(source, { fetch: async () => (dispatched++, fetchImpl()) }).assembly, {
      caseIds: ['C10'],
      repositoryRoot: tempRoot('repo'),
      ...pins,
      grade: gradePass,
      ...(withCounter ? { fetches: () => dispatched } : {}),
    });
  const [passed] = await witness(() => allowedProviderResponse(MODEL));
  assert.equal(passed?.record.caseId, 'C10');
  assert.notEqual(passed?.record.facts?.['derivedFrom'], 'C01', 'C10 is never inferred from C01');
  assert.deepEqual(
    [passed?.record.outcome, passed?.record.facts?.['allowed-fetches'], passed?.record.facts?.['refused-fetches'], passed?.record.facts?.['refusal-reason']],
    ['pass', 1, 0, 'RUN_USAGE_LIMIT_REACHED'],
    JSON.stringify(passed?.record),
  );
  assert.equal(passed?.derived?.kind, 'c10', 'C10 carries its own witness artifact');
  // A failing allowed call is a failed witness, not a refusal; without a counter nothing can be disproved.
  const [failedAllowed] = await witness(() => new Response('{}', { status: 503 }));
  assert.deepEqual([failedAllowed?.record.outcome, failedAllowed?.record.reasonCode], ['fail', 'c10-allowed-not-observed']);
  // A task ledger below the run limit would refuse the request as a budget claim, so nothing is observed.
  const [tight] = await witness(() => allowedProviderResponse(MODEL), true, catalog);
  assert.deepEqual([tight?.record.outcome, tight?.record.reasonCode], ['not-run', 'c10-task-budget-below-run-limit']);
  const [uncounted] = await witness(() => allowedProviderResponse(MODEL), false);
  assert.deepEqual([uncounted?.record.outcome, uncounted?.record.reasonCode], ['not-run', 'c10-fetch-counter-unavailable']);
});

test('C02 binds its own fresh assembly and stays terminal at its expected clarification pause', async () => {
  const catalog = catalogFor(undefined, ['C02']);
  const { assembly } = resolveOrThrow(catalog);
  const pins = pinsOf(assembly);
  const seen: string[] = [];
  // Each case is a distinct task on its own assembly; one assembly can never carry two.
  const outcomes = await runCaseStage(
    () => {
      seen.push('assemble');
      return resolveOrThrow(catalog).assembly;
    },
    { caseIds: ['C01', 'C02'], repositoryRoot: tempRoot('repo'), ...pins, grade: gradePass, clarificationHold: (id: string) => id === 'C02' },
  );
  assert.equal(seen.length, 2, 'two distinct cases bind two fresh assemblies, never one shared task');
  assert.deepEqual(
    outcomes.map(entry => entry.record.caseId),
    ['C01', 'C02'],
  );
  // C02 is held for its expected clarification pause, so no plan decision is ever offered to it.
  assert.equal(outcomes[1]?.evidence?.approval, undefined, 'a clarification hold is never auto-approved');
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
  assert.deepEqual(
    result.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [['recovery', 'fail', 'continuation-blocked']],
  );
});

/** A resume stage over a stub assembly whose recovery gate answers one fixed decision. */
function resumeWith(decision: 'resume' | 'fresh-attempt' | 'blocked'): Promise<Awaited<ReturnType<typeof runCampaign>>> {
  const catalog = catalogFor();
  const counters: Effects = { fetch: 0, spawn: 0 };
  const assemble = () =>
    ({
      status: 'assembly-ready' as const,
      metadata: {
        profileDigest: `sha256:${'a'.repeat(64)}`,
        endpointDigest: `sha256:${'b'.repeat(64)}`,
        endpointScheme: 'https' as const,
        insecureHttpAcknowledged: false,
        model: MODEL,
        imageId: IMAGE_ID,
      },
      owners: { recoveryGate: { decide: async () => decision } },
    }) as unknown as RealTierAssembly;
  return runCampaign({
    mode: 'resume',
    resumeRef: 'uc04-journal:claim-recorded',
    env: catalog.env,
    repositoryRoot: tempRoot('repo'),
    evidenceDir: tempRoot('evidence'),
    candidateSha: REV,
    assemble,
    fetch: async () => {
      counters.fetch += 1;
      throw new Error('a resume query must not fetch');
    },
    spawn: async () => {
      counters.spawn += 1;
      throw new Error('a resume query must not spawn');
    },
  });
}

test('a resume admission exits 0 on a permitted resume, never 0 on a fresh-attempt or block', async () => {
  // A committed owner record permits a later continuation: the query itself is read-only and exits 0.
  const resumed = await resumeWith('resume');
  assert.equal(resumed.exitCode, 0, 'a permitted resume is a successful admission query');
  assert.deepEqual(
    resumed.records.map(entry => [entry.stage, entry.outcome, entry.facts?.['decision']]),
    [['recovery', 'pass', 'resume']],
  );

  // `fresh-attempt` is not replay authority, so it stays nonzero and effect-free.
  const fresh = await resumeWith('fresh-attempt');
  assert.equal(fresh.exitCode, 2, 'a fresh-attempt is not a successful resume');
  assert.deepEqual(
    fresh.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [['recovery', 'not-run', 'continuation-fresh-attempt']],
  );

  // An unknown/blocked continuation stays nonzero, the T059 prerequisite.
  const blocked = await resumeWith('blocked');
  assert.equal(blocked.exitCode, 2);
  assert.deepEqual(
    blocked.records.map(entry => [entry.stage, entry.outcome, entry.reasonCode]),
    [['recovery', 'fail', 'continuation-blocked']],
  );
});

/* ------------------------------------------------------------ evidence check */

const CLEAN_RECORD: readonly StageRecord[] = [...STAGES, ...PASSING_ROWS];

/**
 * SPEC-W5-002's live pause path needs a real model that produces a plan, so it is exercised at T054.
 * What this gate can prove with doubles: the runner never approves on its own. Without an injected
 * decision source no approval is ever recorded; with one, it is only consulted when the graph pauses.
 */
test('the case stage never approves a plan on its own; a decision source is not fabricated', async () => {
  const catalog = catalogFor();
  const decisions: string[] = [];
  const run = (decideApproval?: (caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined>) =>
    runCaseStage(() => resolveOrThrow(catalog).assembly, {
      caseIds: ['C01'],
      repositoryRoot: tempRoot('repo'),
      ...pinsOf(resolveOrThrow(catalog).assembly),
      grade: gradePass,
      ...(decideApproval ? { decideApproval } : {}),
    });
  const [silent] = await run();
  assert.equal(silent?.evidence?.approval, undefined, 'no decision source means nothing was approved');
  // No plan pause occurs without a live model, so even a supplied source is never auto-invoked.
  const [withSource] = await run(async caseId => {
    decisions.push(caseId);
    return 'approve';
  });
  assert.deepEqual(decisions, [], 'a decision is never fabricated when the graph does not pause');
  assert.equal(withSource?.evidence?.approval, undefined, 'no pause means no approval is recorded');
});

test('the checker passes a complete campaign record and fails a failed or not-run predicate', () => {
  const scan = { env: fixture.envOf(), repositoryRoot: tempRoot('repo') };
  const clean = tempRoot('clean');
  writeRecord(clean, CLEAN_RECORD);
  assert.deepEqual(checkEvidence({ evidenceDir: clean, ...scan }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });

  const cases = PASSING_ROWS;
  const rows: readonly (readonly [string, readonly StageRecord[], string])[] = [
    ['failed case', [...STAGES, { stage: 'case', outcome: 'fail', caseId: 'C01' }, ...cases.slice(1)], 'case:C01:fail'],
    [
      'not-run case',
      [...STAGES, cases[0] as StageRecord, { stage: 'case', outcome: 'not-run', caseId: 'C02', reasonCode: 'grader-unavailable' }, ...cases.slice(2)],
      'case:C02:not-run:grader-unavailable',
    ],
    ['failed stage', [{ stage: 'preflight', outcome: 'pass' }, { stage: 'conformance', outcome: 'fail', reasonCode: 'conformance-timeout' }, ...cases], 'conformance:fail:conformance-timeout'],
    ['missing preflight', [{ stage: 'conformance', outcome: 'pass' }, ...cases], 'preflight:missing'],
    ['missing C16', [...STAGES, ...cases.slice(0, 2)], 'case:missing:C16'],
    ['missing C10', [...STAGES, ...cases.slice(0, 3)], 'case:missing:C10'],
  ];
  for (const [label, records, expected] of rows) {
    const dir = tempRoot('evidence');
    writeRecord(dir, records);
    const result = checkEvidence({ evidenceDir: dir, ...scan });
    assert.equal(result.exitCode, 1, label);
    assert.ok(result.output.includes(expected), `${label}: expects ${expected} in ${result.output}`);
  }

  // A duplicate case row is never collapsed to its last value: the earlier failure must survive.
  const duplicate = tempRoot('duplicate');
  writeRecord(duplicate, [...STAGES, { stage: 'case', outcome: 'fail', caseId: 'C01' }, ...cases]);
  const dupResult = checkEvidence({ evidenceDir: duplicate, ...scan });
  assert.equal(dupResult.exitCode, 1, 'a passing duplicate never hides an earlier failed attempt');
});

test('the checker rejects incomplete, unpromoted and missing-prerequisite campaigns', () => {
  const scan = { env: fixture.envOf(), repositoryRoot: tempRoot('repo') };
  const cases = PASSING_ROWS;

  // C01 and C02 alone, with no prerequisite stage and no C16/C10, is not a campaign.
  const partial = tempRoot('partial');
  writeRecord(partial, cases.slice(0, 2));
  assert.equal(checkEvidence({ evidenceDir: partial, ...scan }).exitCode, 1, 'C01/C02 alone is incomplete, never clean');

  // Unusable input is exit 2, never a pass.
  assert.equal(checkEvidence({ evidenceDir: tempRoot('empty'), ...scan }).exitCode, 2);
  const invalid = tempRoot('invalid');
  writeFileSync(join(invalid, 'campaign.json'), '{"schemaVersion":"uc03-campaign-record/1","records":[{"stage":"case","outcome":"maybe"}]}', 'utf8');
  assert.equal(checkEvidence({ evidenceDir: invalid, ...scan }).exitCode, 2);
});

test('the checker never prints a credential hidden behind JSON Unicode escapes', () => {
  const dir = tempRoot('escape');
  mkdirSync(dir, { recursive: true });
  // The API credential, each character as a JSON \uXXXX escape in the *raw file text*. JSON.stringify
  // would re-escape the backslashes, so this writes the escaped form straight to disk: the directory
  // text scan sees no needle, but JSON.parse decodes it to the real credential in `reasonCode`.
  const escaped = [...fixture.KEY].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const raw = JSON.stringify({
    schemaVersion: 'uc03-campaign-record/1',
    bindings: { 'candidate-sha': REV, 'profile-digest': `sha256:${'a'.repeat(64)}`, 'endpoint-digest': `sha256:${'b'.repeat(64)}`, model: MODEL },
    records: [],
  }).replace('"records":[]', `"records":[{"stage":"case","outcome":"fail","caseId":"C01","reasonCode":"leak-${escaped}"}]`);
  writeFileSync(join(dir, 'campaign.json'), raw, 'utf8');
  const result = checkEvidence({ evidenceDir: dir, env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
  // The raw bytes hide the needle from the text scan; once parsed, the decoded value is rejected rather
  // than printed, so the credential never reaches the operator output.
  assert.notEqual(result.exitCode, 0, 'an escaped credential is a refusal, never a clean verdict');
  assert.ok(!result.output.includes(fixture.KEY), 'the decoded credential never reaches the operator output');
});

test('the checker fails on a T057 scan leak in the evidence directory', () => {
  const dir = tempRoot('leak');
  writeRecord(dir, CLEAN_RECORD);
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

/** A run-command admission bound to the task's persisted control head and command view. */
function commandContext(state: TaskState, task: BugTask, journal: { readonly controlVersion: number; readonly epoch: number }, actionId: string, generation: number): RepositoryAdmissionContextV02 {
  // A pre-plan diagnostic check's action purpose must equal the admission's `diagnosticPurpose`.
  const action: RunCommandAction = { actionId, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], workingDirectory: 'tests', purpose: 'investigate' };
  const isolationProfileRef = assembly_label();
  const actionDigest = computeActionDigest(action);
  const policyAuthorityRef = {
    policyId: task.configId,
    policyVersion: task.configVersion,
    configId: task.configId,
    configVersion: task.configVersion,
    issuerKeyRef: `host-${task.configId}`,
    decisionAuthorityGeneration: generation,
  };
  const commandView = {
    viewId: `view-${actionId}`,
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    canonicalRevision: state.repositoryRevisionDigest,
    admittedFiles: [{ path: 'tests/test_calculator.py', digest: computeCanonicalSha256('test-file') }],
    exclusionsPolicyVersion: '0.1.0',
    scratchIdentity: computeWorkspaceVolumeIds(state.taskId, state.workspaceId).scratchVolumeId,
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
  // The bound port holds the task's real profile, so the fixture must build the view it will carry.
  const trusted = deriveTrustedContext(context as unknown as RepositoryAdmissionContextV02, executionProfileOf(task, isolationProfileRef, state));
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
    const receipt = createCommandOutcomeReceipt(
      claim,
      attempt,
      context,
      'observed',
      normalizeCommandResult({
        plan: { checkId: 'check-1' },
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 12,
        timedOut: false,
        outcome: 'success',
        truncated: false,
      }) as NormalizedCommandResultV02,
    );
    const settled = await owners.statePort.recordOutcome(receipt);
    assert.equal(settled.outcome, 'settled', `${actionId}: the observed command must settle`);
  };

  const resourceRows = (state: TaskState): readonly { readonly scope: string; readonly kind: string; readonly consumed: number; readonly reserved: number }[] =>
    (state.budgetLedgers ?? [])
      .filter(ledger => ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind))
      .map(ledger => ({ scope: ledger.scope, kind: ledger.kind, consumed: ledger.consumed, reserved: ledger.reservations.reduce((sum, item) => sum + item.amount, 0) }));

  const before = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  assert.deepEqual(
    resourceRows(before).filter(row => row.reserved > 0),
    [],
    'the seed holds no reservation',
  );

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
    // shared owner state port), so both bound ports observe the real beginAttempt→transport sequence.
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
