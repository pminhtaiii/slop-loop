/**
 * T059 round-3 gate: the findings the first gate file does not cover (real-tier contract §(f) T028
 * row; host contract §7).
 *
 * Every row uses doubles and temp roots: `fetch` is a counting fake, the clock is injected and no
 * Docker, network or live endpoint is reached. Sentinels are RFC 5737 / `.invalid` values and a
 * synthetic key, exactly as the first gate file documents.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { runC10Witness, allowedProviderResponse } from './uc03-success-real-c10.ts';
import { createOperatorDecisionSource, type OperatorIo } from './uc03-success-real-operator.ts';
import { resolvePinnedGrader } from './uc03-success-real-grader.ts';
import { judgeC16Report } from './uc03-success-real-c16.ts';
import { checkEvidence } from './uc03-success-real-evidence.ts';
import { artifactName, writeCampaign, type PendingArtifact, type StageRecord } from './uc03-success-real-record.ts';
import { createScanFixture, type ScanFixture } from '../unit/real-tier-scan-fixtures.ts';

const fixture: ScanFixture = createScanFixture('t059-gate2-', 't059-gate2-digest-key');
const MODEL = 'po/deepseek-ai/deepseek-v4.1-flash-1017';
const REV = 'e'.repeat(40);
const CASE = 'C01';
const REPOSITORY_FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;

const tempRoot = (label: string): string => mkdtempSync(join(tmpdir(), `t059b-${label}-`));

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

/* ------------------------------------------------ SPEC-W5-104: the C10 witness */

test('C10 witness exhausts the run call ceiling and refuses the next call with zero extra fetches', async () => {
  // The task ledger is generous; the run ceiling is what the witness must trip.
  const catalog = catalogWith(taskOf({ budgetLimits: { maxReplanCount: 3, maxTokens: 2_000_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 } }), undefined);
  let fetches = 0;
  // One allowed call fills a single-call run ceiling; the extra call is the one that must refuse.
  const assembly = resolveOrThrow(catalog.env, {
    fetch: async () => {
      fetches += 1;
      return allowedProviderResponse(MODEL);
    },
  });
  const binding = await bindRealTierTask(assembly, { caseId: CASE, ...pinsOf(assembly) });
  assert.equal(binding.status, 'task-bound', JSON.stringify(binding));
  if (binding.status !== 'task-bound') return;
  const owners = assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId });
  const head = (): { controlVersion: number; epoch: number } => {
    const journal = owners.statePort.getJournalSnapshot(binding.ids.taskId) as { readonly controlVersion?: number; readonly epoch?: number };
    return { controlVersion: journal.controlVersion ?? 1, epoch: journal.epoch ?? 1 };
  };
  const counts = (): { claims: number; attempts: number; outcomes: number } => {
    const journal = owners.statePort.getJournalSnapshot(binding.ids.taskId) as { readonly claims?: readonly unknown[]; readonly attempts?: readonly unknown[]; readonly outcomes?: readonly unknown[] };
    return { claims: journal.claims?.length ?? 0, attempts: journal.attempts?.length ?? 0, outcomes: journal.outcomes?.length ?? 0 };
  };
  // A claim needs a published authority at the generation the admission names; the seed head carries none.
  const owner = owners.statePort as unknown as { publishAuthority(input: unknown): Promise<{ readonly status: string }> };
  const publication = await owner.publishAuthority({
    authorityRef: { policyId: binding.task.configId, policyVersion: binding.task.configVersion, configId: binding.task.configId, configVersion: binding.task.configVersion, issuerKeyRef: `host-${binding.task.configId}`, decisionAuthorityGeneration: 2 },
  });
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  // The task is at Validate; a pre-plan provider admission is only legal at Investigate.
  const seeded = (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState;
  await owners.statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);

  const body = await runC10Witness({
    port: binding.ports.modelPort,
    fetches: () => fetches,
    journal: counts,
    control: head,
    task: binding.task,
    state: async () => (await owners.statePort.loadTask(binding.ids.taskId)) as TaskState,
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    ceiling: { totalModelCalls: assembly.profile.limits.totalModelCalls, perRunInputTokens: assembly.profile.runLimits.perRunInputTokens, perRunOutputTokens: assembly.profile.runLimits.perRunOutputTokens },
    generation: 2,
    commandViewDigest: null,
  });
  // One refusal, and the fetch count grew by exactly the allowed calls — the refused one never dispatched.
  assert.equal(body.dispatch.refusals, 1, `exactly one refusal: ${JSON.stringify(body.dispatch)}`);
  // The port maps a limiter refusal to a pending outcome; the zero-dispatch fact is the fetch count.
  assert.equal(body.dispatch.reason, 'PROVIDER_OUTCOME_PENDING', 'the refusal is the run limiter refusal path');
  assert.equal(body.dispatch.fetchesAfter - body.dispatch.fetchesBefore, 1, 'the allowed call dispatched once; the refused call added no fetch');
  assert.ok(body.journal.claimsAfter > body.journal.claimsBefore, 'a durable reservation was opened');
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
    assert.deepEqual([...withoutCapability.missing].sort(), ['grader.executor', 'grader.isolationAuthority']);
  }
  // With the two capabilities supplied, the grader is constructed from the pinned material.
  const capability = {
    isolationAuthority: { admit: () => ({ kind: 'injected-mock-isolation-admission' as const, admissionId: 'adm-1' }) },
    executor: { executorId: 'exec-1', execute: () => ({}) },
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

/* ------------------------------------- SPEC-W5-105/106: artifacts and the checker */

/** A complete v2 campaign directory whose artifacts are supplied, so the checker can judge them. */
function campaignDir(records: readonly StageRecord[], artifacts: readonly PendingArtifact[], dir = tempRoot('evidence')): string {
  writeCampaign(
    dir,
    {
      campaignId: 'campaign-1',
      candidateSha: REV,
      mode: 'campaign',
      passed: records.every(entry => entry.outcome === 'pass'),
      startedAt: 1,
      finishedAt: 2,
      bindings: { 'candidate-sha': REV, 'profile-digest': `sha256:${'a'.repeat(64)}`, 'endpoint-digest': `sha256:${'b'.repeat(64)}`, model: MODEL },
      records,
    },
    artifacts,
  );
  return dir;
}

const CASES: readonly StageRecord[] = [
  { stage: 'case', outcome: 'pass', caseId: 'C01', facts: { grade: 'pass' } },
  { stage: 'case', outcome: 'pass', caseId: 'C02', facts: { grade: 'pass' } },
  { stage: 'case', outcome: 'pass', caseId: 'C16', facts: { derivedFrom: 'C01' } },
  { stage: 'case', outcome: 'pass', caseId: 'C10', facts: {} },
];
const STAGES: readonly StageRecord[] = [
  { stage: 'preflight', outcome: 'pass' },
  { stage: 'conformance', outcome: 'pass' },
];
const grade = (caseId: string) => ({ caseId, criterionId: `c-${caseId}`, grade: 'pass', reason: 'criteria-satisfied', evidenceIds: [], snapshot: { snapshotId: `s-${caseId}`, digest: `sha256:${'d'.repeat(64)}` }, evidenceDigest: `sha256:${'e'.repeat(64)}`, criteriaDigest: `sha256:${'f'.repeat(64)}`, limitations: [] });
const evidenceBody = (caseId: string) => ({ schema: 'uc03-case-evidence/1', campaignId: 'campaign-1', caseId, attempt: 1, identity: { taskId: `t-${caseId}`, runId: `r-${caseId}`, workspaceId: `w-${caseId}` }, evidence: { grade: grade(caseId) }, accounting: { claims: 1, attempts: 1, outcomes: 1 } });
const FULL_ARTIFACTS: readonly PendingArtifact[] = [
  ['C01', 1, 'evidence', evidenceBody('C01')],
  ['C02', 1, 'evidence', evidenceBody('C02')],
  ['C16', 1, 'c16', { schema: 'uc03-c16-report/1', campaignId: 'campaign-1', caseId: 'C16', attempt: 1, derivedFrom: 'C01', sourceArtifact: 'evidence-C01-1.json', verdict: 'pass', report: { present: true, outcome: 'COMPLETED', isComplete: true, diffDigest: `sha256:${'c'.repeat(64)}`, evidenceRefs: ['ev-1'], changedFiles: ['src/calculator.py'], bytes: 512, reportDigest: `sha256:${'d'.repeat(64)}` } }],
  ['C10', 1, 'c10', { schema: 'uc03-c10-witness/1', campaignId: 'campaign-1', caseId: 'C10', attempt: 1, identity: { taskId: 't', runId: 'r', workspaceId: 'w' }, provider: { providerId: 'p', modelId: MODEL, configId: 'c', configVersion: '1' }, limits: { totalModelCalls: 2, perRunInputTokens: 4, perRunOutputTokens: 4, budgetRefs: [] }, dispatch: { fetchesBefore: 0, fetchesAfter: 2, refusals: 1, reason: 'RUN_USAGE_LIMIT_REACHED' }, journal: { claimsBefore: 0, claimsAfter: 3, outcomesBefore: 0, outcomesAfter: 2 }, commandViewDigest: null, disclosure: 'fixture' }],
];

const scanOf = () => ({ env: fixture.envOf(), repositoryRoot: tempRoot('repo') });

test('the checker accepts a complete campaign and refuses a passing label with no artifact', () => {
  const clean = campaignDir([...STAGES, ...CASES], FULL_ARTIFACTS);
  assert.deepEqual(checkEvidence({ evidenceDir: clean, ...scanOf() }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });

  // The same passing labels, but the C01 artifact is deleted: the label alone must not pass.
  const missing = campaignDir([...STAGES, ...CASES], FULL_ARTIFACTS.filter(([, , kind, body]) => !(kind === 'evidence' && (body as { caseId: string }).caseId === 'C01')));
  const missingResult = checkEvidence({ evidenceDir: missing, ...scanOf() });
  assert.equal(missingResult.exitCode, 1);
  assert.match(missingResult.output, /case:C01:missing-artifact/u);
});

test('the checker refuses an artifact whose digest or attribution does not match its record', () => {
  const tampered = campaignDir([...STAGES, ...CASES], FULL_ARTIFACTS);
  // Rewrite the C02 artifact after the record pinned its digest: a swapped file is a refusal.
  writeFileSync(join(tampered, artifactName('C02', 1, 'evidence')), JSON.stringify({ ...evidenceBody('C02'), evidence: {} }), 'utf8');
  const digestResult = checkEvidence({ evidenceDir: tampered, ...scanOf() });
  assert.equal(digestResult.exitCode, 1);
  assert.match(digestResult.output, /artifact-digest-mismatch/u);

  // A consistent artifact that claims another case is misattributed, not accepted.
  const misattributed = campaignDir([...STAGES, ...CASES], [
    ['C01', 1, 'evidence', evidenceBody('C01')],
    ['C02', 1, 'evidence', { ...evidenceBody('C02'), caseId: 'C01' }],
    FULL_ARTIFACTS[2] as PendingArtifact,
    FULL_ARTIFACTS[3] as PendingArtifact,
  ]);
  const misResult = checkEvidence({ evidenceDir: misattributed, ...scanOf() });
  assert.equal(misResult.exitCode, 1);
  assert.match(misResult.output, /case:C02:artifact-misattributed/u);
});

test('an evidence-less earlier case never renames a later case artifact', () => {
  // C01 has no artifact, C02 does: the tuple keeps C02's file at its own name (STD-W5-106).
  const dir = campaignDir(
    [...STAGES, ...CASES],
    [
      ['C02', 1, 'evidence', evidenceBody('C02')],
      FULL_ARTIFACTS[2] as PendingArtifact,
      FULL_ARTIFACTS[3] as PendingArtifact,
    ],
  );
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('evidence-') || name.startsWith('c16-') || name.startsWith('c10-')).sort(), ['c10-C10-1.json', 'c16-C16-1.json', 'evidence-C02-1.json']);
  assert.equal(readdirSync(dir).includes('evidence-C01-1.json'), false, 'no artifact is misnamed for the evidence-less case');
});

test('missing and duplicate case ids are both refused', () => {
  const unlabelled = campaignDir([...STAGES, ...CASES, { stage: 'case', outcome: 'pass' }], FULL_ARTIFACTS);
  const unResult = checkEvidence({ evidenceDir: unlabelled, ...scanOf() });
  assert.equal(unResult.exitCode, 1);
  assert.match(unResult.output, /case:unlabelled/u);

  const duplicated = campaignDir([...STAGES, ...CASES, { stage: 'case', outcome: 'pass', caseId: 'C01', facts: { grade: 'pass' } }], FULL_ARTIFACTS);
  const dupResult = checkEvidence({ evidenceDir: duplicated, ...scanOf() });
  assert.equal(dupResult.exitCode, 1);
  assert.match(dupResult.output, /case:C01:duplicate/u);
});

test('each campaign writes its own directory, so no later observation overwrites an earlier one', async () => {
  const root = tempRoot('runs');
  const { runCampaign } = await import('./uc03-success-real-run.ts');
  const catalog = catalogWith(taskOf(), undefined);
  const base = { env: catalog.env, repositoryRoot: tempRoot('repo'), evidenceDir: root, candidateSha: REV, runCases: async () => [] as never };
  await runCampaign({ ...base, mode: 'campaign', clock: () => 1_700_000_000_000, preflight: async () => ({ ok: false, reasonCode: 'docker-unavailable' }) });
  await runCampaign({ ...base, mode: 'campaign', clock: () => 1_700_000_100_000, preflight: async () => ({ ok: false, reasonCode: 'docker-unavailable' }) });
  const dirs = readdirSync(root).filter(name => name.startsWith('campaign-'));
  assert.equal(dirs.length, 2, 'two campaigns keep two directories');
  for (const name of dirs) assert.equal(readFileSync(join(root, name, 'campaign.json'), 'utf8').length > 0, true);
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
  const dir = join(root, readdirSync(root).find(name => name.startsWith('campaign-')) as string);
  const record = JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')) as { records: readonly StageRecord[] };
  const preflight = record.records.find(entry => entry.stage === 'preflight');
  assert.equal(preflight?.facts?.['grader-status'], 'unavailable', 'the refusal is retained, not just printed');
  assert.match(String(preflight?.facts?.['grader-missing']), /grader\.isolationAuthority/u, 'the missing inputs are named');
});
