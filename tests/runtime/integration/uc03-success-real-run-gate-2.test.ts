/**
 * T059 round-3 gate: the findings the first gate file does not cover (real-tier contract §(f) T028
 * row; host contract §7).
 *
 * Every row uses doubles and temp roots: `fetch` is a counting fake, the clock is injected and no
 * Docker, network or live endpoint is reached. Sentinels are RFC 5737 / `.invalid` values and a
 * synthetic key, exactly as the first gate file documents.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { resolveRealTierAssembly, type RealTierAssembly, type RealTierDependencies } from '../../../src/runtime/real-tier-assembly.ts';
import type { BugTask, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import type { HostModelTransport } from '../../../src/foundation/model.ts';
import { runC10Witness, allowedProviderResponse, judgeC10, journalViewOf, publishRunAuthority } from './uc03-success-real-c10.ts';
import { createOperatorDecisionSource, type OperatorIo } from './uc03-success-real-operator.ts';
import { resolvePinnedGrader } from './uc03-success-real-grader.ts';
import { judgeC16Report } from './uc03-success-real-c16.ts';
import { checkEvidence } from './uc03-success-real-evidence.ts';
import { RECEIPT_SCHEMA, artifactName, receiptName, type C10WitnessBody, type PendingArtifact, type StageRecord } from './uc03-success-real-record.ts';
import { FIXTURE_BINDING, PASSING_ROWS, STAGES, passingArtifacts, writeRecord } from './uc03-success-real-fixture.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t059-gate2-', 't059-gate2-digest-key');
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const REV = 'e'.repeat(40);
const CASE = 'C01';
const REPOSITORY_FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;

const tempRoot = (label: string): string => mkdtempSync(join(tmpdir(), `t059b-${label}-`));
const c10Of = (artifacts: readonly PendingArtifact[]): unknown => artifacts.find(([caseId]) => caseId === 'C10')?.[3];

function revisionOf(files: Readonly<Record<string, string>>): string {
  return computeCanonicalSha256(Object.keys(files).sort().map(path => `${path}\0${computeFileDigest(files[path] ?? '')}\n`).join(''));
}

function taskOf(overrides: Partial<BugTask> = {}): BugTask {
  return {
    taskId: 'task-gate2-001',
    repositoryId: 'repo-gate2',
    initialRevisionDigest: revisionOf(REPOSITORY_FILES),
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises CalculationError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
    ...overrides,
  };
}

/** A catalog whose one entry carries a grader object with a real, digest-pinned file. */
function catalogWith(task: BugTask, graderBody: unknown | undefined): { env: RealTierEnvironment; task: BugTask } {
  const dir = tempRoot('catalog');
  const repositoryDir = join(dir, 'repository');
  mkdirSync(join(repositoryDir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(REPOSITORY_FILES)) writeFileSync(join(repositoryDir, path), content, 'utf8');
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(dir, 'case.json');
  writeFileSync(fixturePath, document, 'utf8');
  const graderPath = join(dir, 'grader.json');
  const graderText = graderBody === undefined ? undefined : JSON.stringify(graderBody, null, 2);
  if (graderText !== undefined) writeFileSync(graderPath, graderText, 'utf8');
  else writeFileSync(graderPath, '{}', 'utf8');
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [
        {
          catalogEntryId: `entry-${CASE}`,
          caseId: CASE,
          initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''),
          fixturePath,
          fixtureDigest: sha256Text(document),
          grader: { version: '1.0.0', digest: `sha256:${sha256Text(graderText ?? '{}')}`, path: graderPath },
        },
      ],
    }),
    'utf8',
  );
  return { task, env: fixture.envOf({ catalog: { path: catalogPath } }) };
}

function resolveOrThrow(env: RealTierEnvironment, overrides: Partial<RealTierDependencies> = {}): RealTierAssembly {
  const stateRoot = tempRoot('state');
  const resolved = resolveRealTierAssembly({
    env,
    revision: REV,
    stateRoot,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    fetch: async () => {
      throw new Error('this stage must never fetch');
    },
    ...overrides,
  });
  assert.equal(resolved.status, 'assembly-ready', JSON.stringify(resolved));
  return resolved as RealTierAssembly;
}

function pinsOf(assembly: RealTierAssembly): { pins: { contractVersion: string; revisions: Record<string, string> }; identity: Record<string, string> } {
  return {
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: {
      profileId: 'uc03-runtime-evaluation-v1',
      profileDigest: assembly.metadata.profileDigest,
      configDigest: `sha256:${sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits }))}`,
      pricingDigest: `sha256:${sha256Text(JSON.stringify(assembly.profile.pricing))}`,
    },
  };
}

/* ------------------------------------- SPEC-W5-104/203/204: the C10 witness */

/** The C10 witness over a freshly bound production port, with `fetch` supplied by the row. */
async function runBoundWitness(fetchImpl: () => Promise<Response>): Promise<{ body: C10WitnessBody; fetches: () => number; transport: HostModelTransport; original: HostModelTransport['execute'] }> {
  // The task ledger is generous; the run limit is what the witness must trip.
  const catalog = catalogWith(taskOf({ budgetLimits: { maxReplanCount: 3, maxTokens: 2_000_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 } }), undefined);
  let fetches = 0;
  const assembly = resolveOrThrow(catalog.env, {
    fetch: async () => {
      fetches += 1;
      return fetchImpl();
    },
  });
  const binding = await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) });
  assert.equal(binding.status, 'task-bound', JSON.stringify(binding));
  if (binding.status !== 'task-bound') throw new Error('unbound');
  const owner = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId }).statePort;
  const port = binding.ports.modelPort;
  assert.ok(port instanceof HostModelPortV02);
  const seeded = (await owner.loadTask(binding.ids.taskId)) as TaskState;
  await owner.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  assert.equal(await publishRunAuthority(owner as unknown as { publishAuthority(input: unknown): Promise<unknown> }, binding.task, 2), true);
  const original = port.options.transport.execute;
  const body = await runC10Witness({
    port,
    transport: port.options.transport,
    fetches: () => fetches,
    journal: () => journalViewOf(owner.getJournalSnapshot(binding.ids.taskId)),
    control: () => {
      const head = owner.getJournalSnapshot(binding.ids.taskId) as { readonly controlVersion?: number; readonly epoch?: number };
      return { controlVersion: head.controlVersion ?? 1, epoch: head.epoch ?? 1 };
    },
    task: binding.task,
    state: async () => (await owner.loadTask(binding.ids.taskId)) as TaskState,
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    campaignId: 'campaign-1',
    binding: FIXTURE_BINDING,
    ceiling: { totalModelCalls: assembly.profile.limits.totalModelCalls, perRunInputTokens: assembly.profile.runLimits.perRunInputTokens, perRunOutputTokens: assembly.profile.runLimits.perRunOutputTokens },
    generation: 2,
    commandViewDigest: null,
  });
  return { body, fetches: () => fetches, transport: port.options.transport, original };
}

test('C10 witness: the limiter refuses the over-limit call, that call adds no fetch, and the allowed call settles observed usage', async () => {
  const { body, fetches, transport, original } = await runBoundWitness(async () => allowedProviderResponse(MODEL));
  const { allowed, refused } = body.calls;
  assert.equal(judgeC10(body), undefined, JSON.stringify(body.calls));
  // The port reports every post-claim refusal as pending; the limiter verdict is the transport's own.
  assert.equal(refused.portOutcome, 'uncertain');
  assert.deepEqual([refused.transport?.outcome, refused.transport?.reasonCode], ['denied', 'RUN_USAGE_LIMIT_REACHED']);
  assert.equal(refused.fetchesAfter - refused.fetchesBefore, 0, 'the refused call dispatched nothing');
  assert.equal(allowed.fetchesAfter - allowed.fetchesBefore, 1, 'the allowed call dispatched once');
  assert.equal(fetches(), 1);
  // Reservation before the network, and observed-usage settlement for the allowed call only.
  assert.equal(allowed.transport?.claimsAtTransport, allowed.claims.after);
  assert.deepEqual(allowed.observedUsage, { inputTokens: 12, outputTokens: 4 });
  assert.deepEqual(allowed.outcomes.recorded, ['observed']);
  assert.deepEqual(refused.outcomes.recorded, ['uncertain'], 'the refused call is never settled as observed');
  assert.equal(transport.execute, original, 'the observer restores the real transport');
});

test('C10 witness: a failing allowed call is not a pass, even though the second call is still refused', async () => {
  const { body } = await runBoundWitness(async () => new Response('{}', { status: 503 }));
  // The 503 is dispatched and uncertain; the over-limit call is still limiter-refused.
  assert.equal(body.calls.allowed.portOutcome, 'uncertain');
  assert.equal(judgeC10(body), 'c10-allowed-not-observed');
});

test('judgeC10 distinguishes a limiter refusal from any other refusal and disproves a fetch for the refused call', () => {
  interface Editable {
    calls: { allowed: Record<string, unknown>; refused: Record<string, unknown> };
    limits: Record<string, unknown>;
  }
  const base = (): Editable => structuredClone(c10Of(passingArtifacts())) as unknown as Editable;
  const mutate = (change: (body: Editable) => void): string | undefined => {
    const body = base();
    change(body);
    return judgeC10(body as unknown as C10WitnessBody);
  };
  const part = (call: Record<string, unknown>, key: string): Record<string, unknown> => call[key] as Record<string, unknown>;
  assert.equal(judgeC10(base() as unknown as C10WitnessBody), undefined);
  const rows: readonly (readonly [string, string, (body: Editable) => void])[] = [
    ['a non-limiter denial', 'c10-refusal-not-limiter', body => void (part(body.calls.refused, 'transport')['reasonCode'] = 'ENDPOINT_DRIFT')],
    ['an uncertain failure after dispatch', 'c10-refusal-not-limiter', body => void (part(body.calls.refused, 'transport')['outcome'] = 'uncertain')],
    ['a refusal the transport never saw', 'c10-refusal-not-limiter', body => void (body.calls.refused['transport'] = null)],
    ['a fetch for the refused call', 'c10-refused-dispatched', body => void (body.calls.refused['fetchesAfter'] = 2)],
    ['an allowed call that fetched twice', 'c10-allowed-dispatch-count', body => void (body.calls.allowed['fetchesAfter'] = 2)],
    ['an allowed call with no observed usage', 'c10-allowed-usage-unobserved', body => void (body.calls.allowed['observedUsage'] = null)],
    ['an allowed call that settled uncertain', 'c10-allowed-not-settled', body => void (part(body.calls.allowed, 'outcomes')['recorded'] = ['uncertain'])],
    ['an allowed call with no prior reservation', 'c10-allowed-no-reservation', body => void (part(body.calls.allowed, 'transport')['claimsAtTransport'] = 0)],
    ['a refused call with no prior reservation', 'c10-refused-no-reservation', body => void (part(body.calls.refused, 'transport')['claimsAtTransport'] = 1)],
    ['a refused call settled observed', 'c10-refused-settled-observed', body => void (part(body.calls.refused, 'outcomes')['recorded'] = ['uncertain', 'observed'])],
    ['a refused call inside the limit', 'c10-refused-not-over-limit', body => void (part(body.calls.refused, 'declared')['maxInputTokens'] = 400_000)],
  ];
  for (const [label, expected, change] of rows) assert.equal(mutate(change), expected, label);
  // The one-fetch token-limit witness is correct under the default 24-call limit; no call exhaustion is required.
  assert.equal(
    mutate(body => void (body.limits['totalModelCalls'] = 24)),
    undefined,
  );
});

/* ---------------------------------------- SPEC-W5-101: nothing approves itself */

test('the operator decision source approves nothing on end of input or an unrecognised word', async () => {
  const answers = [[''], ['yes'], []];
  for (const script of answers) {
    const written: string[] = [];
    let index = 0;
    const io: OperatorIo = { write: line => written.push(line), read: async () => (index < script.length ? script[index++] : undefined) };
    const decide = createOperatorDecisionSource(io);
    const calls: unknown[] = [];
    const target = {
      taskId: 'task-x',
      console: {
        presentation: async () => ({ ok: true as const, value: { taskId: 'task-x', presentation: { decisionId: 'dec-1', requestVersion: 1, presentationDigest: `sha256:${'a'.repeat(64)}`, elements: { action: 'a', necessity: 'n', targets: [], consequences: 'c', verificationStatus: 'v' } } } }),
        decide: async (input: unknown) => {
          calls.push(input);
          return { ok: true as const, value: {} };
        },
      },
    };
    const decision = await decide(CASE, target);
    assert.equal(decision, undefined, `no decision for ${JSON.stringify(script)}`);
    assert.deepEqual(calls, [], 'the service is never called without an explicit choice');
    assert.ok(
      written.some(line => line.includes('Nothing was approved') || line.includes('No explicit decision')),
      'the operator is told nothing was approved',
    );
  }
});

test('the operator decision source forwards the shown digest and version for an explicit approve', async () => {
  const io: OperatorIo = { write: () => undefined, read: async () => 'approve' };
  const digest = `sha256:${'a'.repeat(64)}`;
  let forwarded: Record<string, unknown> | undefined;
  const target = {
    taskId: 'task-x',
    console: {
      presentation: async () => ({ ok: true as const, value: { taskId: 'task-x', presentation: { decisionId: 'dec-1', requestVersion: 3, presentationDigest: digest, elements: { action: 'a', necessity: 'n', targets: [], consequences: 'c', verificationStatus: 'v' } } } }),
      decide: async (input: unknown) => {
        forwarded = input as Record<string, unknown>;
        return { ok: true as const, value: {} };
      },
    },
  };
  assert.equal(await createOperatorDecisionSource(io)(CASE, target), 'approve');
  assert.equal(forwarded?.['presentationDigest'], digest, 'the exact shown digest is forwarded');
  assert.equal(forwarded?.['expectedVersion'], 3, 'the exact shown version is forwarded');
  assert.equal(forwarded?.['decision'], 'approve');
});

/* -------------------------------------------- SPEC-W5-102: the grader inputs */

test('the pinned grader names its missing inputs and never fabricates a grade', () => {
  // A pinned grader file with a real criterion and profile: the material a catalog can carry.
  const material = {
    criteria: { digest: `sha256:${'a'.repeat(64)}`, criteria: [{ criterionId: 'criterion-C01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' }] },
    profile: { profileId: 'pinned-grader', digest: `sha256:${'a'.repeat(64)}`, bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 } },
    graderPayload: null,
  };
  const assembly = resolveOrThrow(catalogWith(taskOf(), material).env);
  // No live isolation authority or executor: the two inputs no pinned file can carry.
  const withoutCapability = resolvePinnedGrader(assembly, CASE, undefined);
  assert.equal(withoutCapability.status, 'unavailable');
  if (withoutCapability.status === 'unavailable') {
    assert.equal(withoutCapability.reasonCode, 'grader-capability-unavailable');
    assert.deepEqual([...withoutCapability.missing].sort(), ['grader.executor', 'grader.finalTree', 'grader.isolationAuthority']);
  }
  // With the two capabilities supplied, the grader is constructed from the pinned material.
  const capability = {
    isolationAuthority: { admit: () => ({ kind: 'injected-mock-isolation-admission' as const, admissionId: 'adm-1' }) },
    executor: { executorId: 'exec-1', execute: () => ({}) },
    finalTree: { freezeFinalTree: () => ({}), recheckCurrentFinalTree: () => ({}) },
  };
  const withCapability = resolvePinnedGrader(assembly, CASE, capability);
  assert.notEqual(withCapability.status, 'unavailable', 'pinned material plus capabilities resolves a grader');
});

test('a catalog entry with no grader file is a bounded refusal, not a fabricated pass', () => {
  const assembly = resolveOrThrow(catalogWith(taskOf(), undefined).env);
  const resolution = resolvePinnedGrader(assembly, 'C99', undefined);
  assert.equal(resolution.status, 'unavailable');
  if (resolution.status === 'unavailable') assert.equal(resolution.reasonCode, 'grader-catalog-entry-missing');
});

/* --------------------------------------- SPEC-W5-103: the C16 safe report */

test('C16 is judged on the report content: absent, unsafe and unprovenanced reports fail', () => {
  assert.equal(judgeC16Report(undefined).reasonCode, 'c16-report-missing');
  const base = { taskId: 't', runId: 'r', repositoryId: 'repo', outcome: 'COMPLETED' as const, isComplete: true, limitations: [], failureReasons: [], safeNextAction: 'none', milestones: [], generatedAt: '2026-11-18T00:00:00.000Z' };
  const usage = { tokensConsumed: 1, costUsd: 0, replanCount: 0, perLedger: [] };
  const report = (overrides: Record<string, unknown> = {}) => ({ ...base, diff: { diffDigest: `sha256:${'c'.repeat(64)}`, changedFiles: ['src/calculator.py'] }, evidence: { verificationRefs: [], reviewRef: 'rev-1', evidenceRefs: ['ev-1'] }, usage, ...overrides });
  assert.equal(judgeC16Report(report() as never).ok, true, 'a bounded, provenanced report passes');
  assert.equal(judgeC16Report(report({ evidence: { verificationRefs: [], evidenceRefs: [] } }) as never).reasonCode, 'c16-report-unprovenanced');
  assert.equal(judgeC16Report(report({ diff: { diffDigest: null, changedFiles: [] } }) as never).reasonCode, 'c16-report-incomplete');
});

/* ------------------------- SPEC-W5-105/106/206/207: artifacts, binding and the checker */

const scanOf = () => ({ env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
type Bodies = Record<string, Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

const of = (bodies: Bodies, caseId: string): Record<string, any> => bodies[caseId] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The complete artifact set keyed by case id, as editable plain data. */
function editableArtifacts(): Bodies {
  return Object.fromEntries(passingArtifacts().map(([caseId, , , body]) => [caseId, structuredClone(body) as Record<string, any>])); // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Writes a complete campaign whose artifact bodies were edited first; digests are recomputed by the writer. */
function editedCampaign(edit: (bodies: Bodies) => void, records: readonly StageRecord[] = [...STAGES, ...PASSING_ROWS]): string {
  const bodies = editableArtifacts();
  edit(bodies);
  const dir = tempRoot('evidence');
  writeRecord(dir, records, passingArtifacts().map(([caseId, attempt, kind]) => [caseId, attempt, kind, bodies[caseId]] as PendingArtifact));
  return dir;
}

test('the checker accepts a complete campaign and refuses a passing label with no artifact', () => {
  const clean = tempRoot('evidence');
  writeRecord(clean, [...STAGES, ...PASSING_ROWS]);
  assert.deepEqual(checkEvidence({ evidenceDir: clean, ...scanOf() }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });

  // Each case's artifact deleted in turn: the label alone must not pass.
  for (const caseId of ['C01', 'C02', 'C16', 'C10']) {
    const dir = tempRoot('evidence');
    writeRecord(dir, [...STAGES, ...PASSING_ROWS], passingArtifacts().filter(([id]) => id !== caseId));
    const result = checkEvidence({ evidenceDir: dir, ...scanOf() });
    assert.equal(result.exitCode, 1, caseId);
    assert.ok(result.output.includes(`case:${caseId}:missing-artifact`), `${caseId}: ${result.output}`);
  }
});

test('the checker refuses an artifact whose digest or attribution does not match its record', () => {
  const tampered = tempRoot('evidence');
  writeRecord(tampered, [...STAGES, ...PASSING_ROWS]);
  // Rewrite the C02 artifact after the record pinned its digest: a swapped file is a refusal.
  writeFileSync(join(tampered, artifactName('C02', 1, 'evidence')), JSON.stringify({ evidence: {} }), 'utf8');
  const digestResult = checkEvidence({ evidenceDir: tampered, ...scanOf() });
  assert.equal(digestResult.exitCode, 1);
  assert.match(digestResult.output, /artifact\[1\]:digest-mismatch/u);

  // A consistent artifact that claims another case is misattributed, not accepted.
  const misResult = checkEvidence({ evidenceDir: editedCampaign(bodies => void (of(bodies, 'C02')['caseId'] = 'C01')), ...scanOf() });
  assert.equal(misResult.exitCode, 1);
  assert.match(misResult.output, /case:C02:artifact-misattributed/u);
});

/** Each required item, corrupted or removed on its own, with correctly recomputed artifact hashes (SPEC-W5-206/207). */
const MUTATIONS: readonly (readonly [string, (bodies: Bodies) => void, string])[] = [
  ['a foreign campaign id', bodies => void (of(bodies, 'C02')['campaignId'] = 'campaign-9'), 'case:C02:artifact-campaign'],
  ['a missing campaign id', bodies => void delete of(bodies, 'C01')['campaignId'], 'case:C01:artifact-campaign'],
  ['an empty campaign id', bodies => void (of(bodies, 'C10')['campaignId'] = ''), 'case:C10:artifact-campaign'],
  ['a wrong attempt', bodies => void (of(bodies, 'C02')['attempt'] = 2), 'case:C02:artifact-attempt'],
  ['a foreign candidate', bodies => void (of(bodies, 'C10')['binding'].candidateSha = 'f'.repeat(40)), 'case:C10:artifact-binding'],
  ['a foreign profile digest', bodies => void (of(bodies, 'C01')['binding'].profileDigest = `sha256:${'0'.repeat(64)}`), 'case:C01:artifact-binding'],
  ['a foreign endpoint digest', bodies => void (of(bodies, 'C02')['binding'].endpointDigest = `sha256:${'0'.repeat(64)}`), 'case:C02:artifact-binding'],
  ['a foreign model', bodies => void (of(bodies, 'C16')['binding'].model = 'other/model'), 'case:C16:artifact-binding'],
  ['a missing binding', bodies => void delete of(bodies, 'C01')['binding'], 'case:C01:artifact-binding'],
  ['a mismatched final snapshot', bodies => void (of(bodies, 'C01')['finalSnapshotDigest'] = `sha256:${'0'.repeat(64)}`), 'case:C01:final-snapshot-mismatch'],
  ['a missing final snapshot', bodies => void (of(bodies, 'C02')['finalSnapshotDigest'] = null), 'case:C02:final-snapshot-mismatch'],
  ['a retained snapshot that is not the graded one', bodies => void (of(bodies, 'C02')['evidence'].snapshot.digest = `sha256:${'0'.repeat(64)}`), 'case:C02:snapshot-mismatch'],
  ['an evidence digest the grade does not name', bodies => void (of(bodies, 'C01')['evidence'].evidenceDigest = `sha256:${'0'.repeat(64)}`), 'case:C01:snapshot-mismatch'],
  ['a grade with no snapshot', bodies => void delete of(bodies, 'C01')['evidence'].grade.snapshot, 'case:C01:grade-unbound'],
  ['a grade with no criteria digest', bodies => void delete of(bodies, 'C02')['evidence'].grade.criteriaDigest, 'case:C02:grade-unbound'],
  ['a grade for another case', bodies => void (of(bodies, 'C02')['evidence'].grade.caseId = 'C01'), 'case:C02:grade-case-mismatch'],
  ['a failed grade behind a passing row', bodies => void (of(bodies, 'C01')['evidence'].grade.grade = 'fail'), 'case:C01:label-unsubstantiated'],
  ['a missing identity', bodies => void delete of(bodies, 'C01')['identity'], 'case:C01:identity-missing'],
  ['missing accounting', bodies => void delete of(bodies, 'C02')['accounting'], 'case:C02:accounting-missing'],
  ['missing owner revisions', bodies => void delete of(bodies, 'C01')['evidence'].ownerRevisions, 'case:C01:owner-revisions-missing'],
  ['a missing plan approval', bodies => void delete of(bodies, 'C01')['evidence'].approval, 'case:C01:approval-missing'],
  ['a rejected plan approval', bodies => void (of(bodies, 'C01')['evidence'].approval.decided = 'reject'), 'case:C01:approval-missing'],
  ['a missing diff digest', bodies => void delete of(bodies, 'C01')['evidence'].diffDigest, 'case:C01:diff-missing'],
  ['a cost with no estimate label', bodies => void delete of(bodies, 'C01')['evidence'].usage.costLabel, 'case:C01:usage-unlabelled'],
  ['a C16 report derived from other bytes', bodies => void (of(bodies, 'C16')['sourceDigest'] = `sha256:${'0'.repeat(64)}`), 'case:C16:report-source-mismatch'],
  ['a C16 report of another digest', bodies => void (of(bodies, 'C16')['report'].reportDigest = `sha256:${'0'.repeat(64)}`), 'case:C16:report-source-mismatch'],
  ['a C16 report on another snapshot', bodies => void (of(bodies, 'C16')['finalSnapshotDigest'] = `sha256:${'0'.repeat(64)}`), 'case:C16:final-snapshot-mismatch'],
  ['a C16 report with a failed verdict', bodies => void (of(bodies, 'C16')['verdict'] = 'fail'), 'case:C16:report-unsafe'],
  ['a C16 report citing no evidence', bodies => void (of(bodies, 'C16')['report'].evidenceRefs = []), 'case:C16:report-unprovenanced'],
  ['a C10 witness with no limiter verdict', bodies => void (of(bodies, 'C10')['calls'].refused.transport = null), 'case:C10:c10-refusal-not-limiter'],
  ['a C10 witness whose refused call fetched', bodies => void (of(bodies, 'C10')['calls'].refused.fetchesAfter = 2), 'case:C10:c10-refused-dispatched'],
  ['a C10 witness with the old shape', bodies => void (of(bodies, 'C10')['schema'] = 'uc03-c10-witness/1'), 'case:C10:artifact-schema'],
];

test('every required item, removed or corrupted on its own, makes the checker refuse', () => {
  for (const [label, edit, expected] of MUTATIONS) {
    const result = checkEvidence({ evidenceDir: editedCampaign(edit), ...scanOf() });
    assert.equal(result.exitCode, 1, `${label}: ${result.output}`);
    assert.ok(result.output.includes(expected), `${label}: expects ${expected} in ${result.output}`);
  }
});

test('the checker binds the campaign to its conformance receipt and to the pinned record values', () => {
  const rows: readonly (readonly [string, (dir: string) => void, string])[] = [
    ['a missing receipt', dir => rmSync(join(dir, receiptName('campaign-1'))), 'receipt:missing'],
    ['a failed receipt', dir => writeFileSync(join(dir, receiptName('campaign-1')), JSON.stringify({ schemaVersion: RECEIPT_SCHEMA, campaignId: 'campaign-1', binding: FIXTURE_BINDING, outcome: 'failed', finishedAt: 2 })), 'receipt:not-conformed'],
    ['a receipt for another binding', dir => writeFileSync(join(dir, receiptName('campaign-1')), JSON.stringify({ schemaVersion: RECEIPT_SCHEMA, campaignId: 'campaign-1', binding: { ...FIXTURE_BINDING, model: 'other/model' }, outcome: 'conformed', finishedAt: 2 })), 'receipt:binding-mismatch'],
    ['a receipt for another campaign', dir => writeFileSync(join(dir, receiptName('campaign-1')), JSON.stringify({ schemaVersion: RECEIPT_SCHEMA, campaignId: 'campaign-2', binding: FIXTURE_BINDING, outcome: 'conformed', finishedAt: 2 })), 'receipt:campaign-mismatch'],
    ['a malformed receipt', dir => writeFileSync(join(dir, receiptName('campaign-1')), '{}'), 'receipt:malformed'],
    ['a model that is not the pinned one', dir => editRecord(dir, record => void (record.bindings.model = 'other/model')), 'record:model-not-pinned'],
    ['a missing image identity', dir => editRecord(dir, record => void delete record.bindings.image), 'EVIDENCE_RECORD_INVALID'],
    ['a record that is not a campaign', dir => editRecord(dir, record => void (record.mode = 'case')), 'record:not-a-campaign'],
    ['a candidate that is not the bound one', dir => editRecord(dir, record => void (record.candidateSha = 'f'.repeat(40))), 'record:candidate-invalid'],
  ];
  for (const [label, change, expected] of rows) {
    const dir = tempRoot('evidence');
    writeRecord(dir, [...STAGES, ...PASSING_ROWS]);
    change(dir);
    const result = checkEvidence({ evidenceDir: dir, ...scanOf() });
    assert.notEqual(result.exitCode, 0, label);
    assert.ok(result.output.includes(expected), `${label}: expects ${expected} in ${result.output}`);
  }
  // An artifact for a case the campaign does not schedule is refused too.
  const extra = tempRoot('evidence');
  writeRecord(extra, [...STAGES, ...PASSING_ROWS], [...passingArtifacts(), ['C99', 1, 'evidence', { caseId: 'C99' }]]);
  assert.match(checkEvidence({ evidenceDir: extra, ...scanOf() }).output, /artifact:unexpected-case/u);
});

/** Edits the retained record in place; its artifacts and receipt are untouched. */
function editRecord(dir: string, change: (record: any) => void): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const path = join(dir, 'campaign.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  change(record);
  writeFileSync(path, JSON.stringify(record), 'utf8');
}

test('the checker accepts the evidence directory itself and judges its newest campaign directory', () => {
  const parent = tempRoot('parent');
  const older = join(parent, 'campaign-1700000000000-campaign-all');
  const newest = join(parent, 'campaign-1700000100000-campaign-all');
  writeRecord(older, [...STAGES, ...PASSING_ROWS]);
  writeRecord(newest, [...STAGES, ...PASSING_ROWS]);
  // A later single-case invocation is its own directory and never decides the campaign.
  writeRecord(join(parent, 'campaign-1700000200000-case-C01'), [...STAGES, ...PASSING_ROWS]);
  assert.deepEqual(checkEvidence({ evidenceDir: parent, ...scanOf() }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });
  // A newer failed campaign is not rescued by an older clean one.
  const failedDir = join(parent, 'campaign-1700000300000-campaign-all');
  writeRecord(failedDir, [...STAGES, ...PASSING_ROWS.slice(0, 3), { stage: 'case', outcome: 'fail', caseId: 'C10', reasonCode: 'c10-allowed-not-observed' }]);
  const result = checkEvidence({ evidenceDir: parent, ...scanOf() });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /case:C10:fail:c10-allowed-not-observed/u);
  assert.equal(checkEvidence({ evidenceDir: tempRoot('empty'), ...scanOf() }).exitCode, 2, 'a directory with no campaign is unusable input');
});

test('an artifact path hiding the credential behind JSON escapes is never echoed', () => {
  const dir = tempRoot('evidence');
  writeRecord(dir, [...STAGES, ...PASSING_ROWS]);
  const escaped = [...fixture.KEY].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  // Written as raw text: the directory scan sees no needle, JSON.parse decodes the credential into `path`.
  const raw = readFileSync(join(dir, 'campaign.json'), 'utf8').replace('"path": "evidence-C01-1.json"', `"path": "${escaped}"`);
  assert.notEqual(raw, readFileSync(join(dir, 'campaign.json'), 'utf8'), 'the escaped path was written');
  writeFileSync(join(dir, 'campaign.json'), raw, 'utf8');
  const result = checkEvidence({ evidenceDir: dir, env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
  assert.notEqual(result.exitCode, 0);
  assert.ok(!result.output.includes(fixture.KEY), 'the decoded credential never reaches the operator output');
  assert.match(result.output, /artifact\[0\]:unreadable/u, 'the failure is a bounded code naming an index');
});

test('an evidence-less earlier case never renames a later case artifact', () => {
  // C01 has no artifact, C02 does: the tuple keeps C02's file at its own name (STD-W5-106).
  const dir = tempRoot('evidence');
  writeRecord(dir, [...STAGES, ...PASSING_ROWS], passingArtifacts().filter(([id]) => id !== 'C01'));
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('evidence-') || name.startsWith('c16-') || name.startsWith('c10-')).sort(), ['c10-C10-1.json', 'c16-C16-1.json', 'evidence-C02-1.json']);
});

test('missing and duplicate case ids are both refused', () => {
  const unlabelled = tempRoot('evidence');
  writeRecord(unlabelled, [...STAGES, ...PASSING_ROWS, { stage: 'case', outcome: 'pass' }]);
  const unResult = checkEvidence({ evidenceDir: unlabelled, ...scanOf() });
  assert.equal(unResult.exitCode, 1);
  assert.match(unResult.output, /case:unlabelled/u);

  const duplicated = tempRoot('evidence');
  writeRecord(duplicated, [...STAGES, ...PASSING_ROWS, PASSING_ROWS[0] as StageRecord]);
  const dupResult = checkEvidence({ evidenceDir: duplicated, ...scanOf() });
  assert.equal(dupResult.exitCode, 1);
  assert.match(dupResult.output, /case:C01:duplicate/u);
});

test('every invocation writes its own directory, so no later observation overwrites an earlier one', async () => {
  const root = tempRoot('runs');
  const { runCampaign } = await import('./uc03-success-real-run.ts');
  const catalog = catalogWith(taskOf(), undefined);
  const failingCase = async () => [{ record: { stage: 'case' as const, outcome: 'fail' as const, caseId: 'C01', reasonCode: 'observed-failure' } }];
  const base = { env: catalog.env, repositoryRoot: tempRoot('repo'), evidenceDir: root, candidateSha: REV, clock: () => 1_700_000_000_000, preflight: async () => ({ ok: true as const, dockerServerVersion: '27.0.1', imageId: `sha256:${'a'.repeat(64)}` }), fetch: async () => allowedProviderResponse(MODEL) };
  // The same instant three times, then a case and a resume: nothing may share or replace a directory.
  const first = await runCampaign({ ...base, mode: 'campaign', runCases: failingCase });
  const second = await runCampaign({ ...base, mode: 'campaign', runCases: failingCase });
  const single = await runCampaign({ ...base, mode: 'case', caseId: 'C01', runCases: async () => [] });
  const resumed = await runCampaign({ ...base, mode: 'resume', resumeRef: 'uc04-journal:claim-1' });
  const dirs = [first, second, single, resumed].map(result => result.evidenceDir);
  assert.equal(new Set(dirs).size, 4, 'four invocations keep four directories');
  for (const result of [first, second, single, resumed]) assert.ok(result.output.includes(JSON.stringify(result.evidenceDir).slice(1, -1)), 'the result names its exact directory');
  assert.equal(readdirSync(root).filter(name => name.startsWith('campaign-')).length, 4);
  assert.ok(!dirs.some(dir => dir.includes('claim-1')), 'a resume reference never becomes a file name');
  // The failed first observation survives the later single-case invocation byte for byte.
  const record = JSON.parse(readFileSync(join(first.evidenceDir, 'campaign.json'), 'utf8')) as { records: readonly StageRecord[] };
  assert.deepEqual(record.records.filter(row => row.stage === 'case').map(row => [row.caseId, row.outcome, row.reasonCode]), [['C01', 'fail', 'observed-failure']]);
  // A writer never replaces an existing record, even when asked to.
  assert.throws(() => writeRecord(first.evidenceDir, [...STAGES, ...PASSING_ROWS]), /CAMPAIGN_EXISTS/u);
});

test('an unavailable grader is retained in the record with the exact missing inputs', async () => {
  const root = tempRoot('grader-disclosure');
  const { runCampaign } = await import('./uc03-success-real-run.ts');
  const catalog = catalogWith(taskOf(), undefined);
  // Conformance must pass before cases; the fake reply carries the pinned model identity.
  const result = await runCampaign({
    mode: 'campaign',
    env: catalog.env,
    repositoryRoot: tempRoot('repo'),
    evidenceDir: root,
    candidateSha: REV,
    clock: () => 1_700_000_000_000,
    preflight: async () => ({ ok: true, dockerServerVersion: '27.0.1', imageId: `sha256:${'a'.repeat(64)}` }),
    fetch: async () => new Response(JSON.stringify({ model: MODEL, content: [] }), { status: 200 }),
    runCases: async () => [],
  });
  assert.equal(result.exitCode, 2, 'a campaign whose grader is unavailable is not a pass');
  const record = JSON.parse(readFileSync(join(result.evidenceDir, 'campaign.json'), 'utf8')) as { records: readonly StageRecord[] };
  const preflight = record.records.find(entry => entry.stage === 'preflight');
  assert.equal(preflight?.facts?.['grader-status'], 'unavailable', 'the refusal is retained, not just printed');
  assert.match(String(preflight?.facts?.['grader-missing']), /grader\.isolationAuthority/u, 'the missing inputs are named');
});
