/**
 * T059 round-4 gate: one doubled successful campaign, end to end (real-tier contract §(f) T028 row).
 *
 * The runner drives its default case stage over real bound assemblies; the only doubles are the
 * external edges: `fetch`, Docker readiness, the graph entry (no live model), the T046 decision, the
 * grader's isolation authority, hidden executor and final-tree port, and the evidence derivation. The
 * record the runner wrote is then read by the checker, which accepts it; each required item removed or
 * corrupted on its own, with the artifact digest recomputed, makes the checker refuse.
 *
 * Values are RFC 5737 / `.invalid` sentinels with a synthetic key; nothing reaches a network or Docker.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256, computeCommandViewDigest, type BugTask, type CommandView, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import { resolveRealTierAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { parseWorkflowFinalTree, type DerivedWorkflowFacts, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from '../../../eval/uc03/workflow-evidence-facts.ts';
import type { EvaluationGraderExecutionRequest, EvaluationGradingAdmissionRequest } from '../../../eval/uc03/types.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';

import { allowedProviderResponse } from './uc03-success-real-c10.ts';
import { checkEvidence } from './uc03-success-real-evidence.ts';
import { resolvePinnedGrader, type CaseGradeRequest, type GraderCapability } from './uc03-success-real-grader.ts';
import { PINNED_MODEL } from './uc03-success-real-provider.ts';
import { digestOf, serialize } from './uc03-success-real-record.ts';
import { runCampaign } from './uc03-success-real-run.ts';
import { runCaseStage } from './uc03-success-real-run-cases.ts';

const fixture = createScanFixture('t059-gate3-', 't059-gate3-digest-key');
const REV = 'e'.repeat(40);
const FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;
const DIFF = `sha256:${'c'.repeat(64)}`;
const FINAL_REVISION = `sha256:${'f'.repeat(64)}`;

const tempRoot = (label: string): string => mkdtempSync(join(tmpdir(), `t059c-${label}-`));

function taskOf(): BugTask {
  const initial = computeCanonicalSha256(
    Object.keys(FILES)
      .sort()
      .map(path => `${path}\0${computeFileDigest(FILES[path as keyof typeof FILES])}\n`)
      .join(''),
  );
  return {
    taskId: 'task-gate3-001',
    repositoryId: 'repo-gate3',
    initialRevisionDigest: initial,
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises CalculationError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 }],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    // The over-limit C10 reservation must fit the task's own token ledger, so only the limiter can refuse it.
    budgetLimits: { maxReplanCount: 3, maxTokens: 2_000_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
  };
}

/** A catalog carrying C01 and C02, each with the same digest-pinned grader material. */
function catalogEnv(): RealTierEnvironment {
  const task = taskOf();
  const dir = tempRoot('catalog');
  mkdirSync(join(dir, 'repository', 'src'), { recursive: true });
  for (const [path, content] of Object.entries(FILES)) writeFileSync(join(dir, 'repository', path), content, 'utf8');
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(dir, 'case.json');
  writeFileSync(fixturePath, document, 'utf8');
  const material = JSON.stringify({
    criteria: {
      digest: `sha256:${sha256Text('gate3-criteria')}`,
      criteria: [
        { criterionId: 'criterion-C01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' },
        { criterionId: 'criterion-C02', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null },
      ],
    },
    profile: { profileId: 'gate3-grader', digest: `sha256:${sha256Text('gate3-profile')}`, bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 } },
    graderPayload: null,
  });
  const graderPath = join(dir, 'grader.json');
  writeFileSync(graderPath, material, 'utf8');
  const entry = (caseId: string) => ({
    catalogEntryId: `entry-${caseId}`,
    caseId,
    initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    fixtureDigest: sha256Text(document),
    grader: { version: '1.0.0', digest: `sha256:${sha256Text(material)}`, path: graderPath },
  });
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [entry('C01'), entry('C02')] }), 'utf8');
  return fixture.envOf({ catalog: { path: catalogPath } });
}

/** The graph's final report: bounded, free of protected content and citing evidence. */
const finalReport = {
  taskId: 'task-gate3-001',
  runId: 'run',
  repositoryId: 'repo-gate3',
  outcome: 'COMPLETED',
  isComplete: true,
  diff: { diffDigest: DIFF, changedFiles: ['src/calculator.py'] },
  evidence: { verificationRefs: ['ver-1'], reviewRef: 'rev-1', evidenceRefs: ['ev-1'] },
  limitations: [],
  failureReasons: [],
  safeNextAction: 'none',
  usage: { tokensConsumed: 120, costUsd: 0.01, replanCount: 0, perLedger: [] },
  milestones: [],
  generatedAt: '2026-11-18T00:00:00.000Z',
};

/** Everything the grader boundary saw, so the row can prove what the runner handed it. */
interface Seen {
  admissions: EvaluationGradingAdmissionRequest[];
  executions: EvaluationGraderExecutionRequest[];
  derived: Parameters<NonNullable<GraderCapability['deriveFacts']>>[0][];
}

function treeOf(binding: FinalTreeBinding, content: string) {
  return { ...binding, snapshotId: 'full.tree.gate3', complete: true as const, files: [{ path: 'src/calculator.py', content }] };
}

/** The grader's three live capabilities as doubles; `state.drift` changes the tree after grading. */
function capability(seen: Seen, state: { drift: boolean; facts: boolean; hidden: 'pass' | 'fail' }): GraderCapability {
  const finalTree: TrustedFinalTreeSnapshotPort = {
    freezeFinalTree: binding => treeOf(binding, 'fixed'),
    recheckCurrentFinalTree: binding => treeOf(binding, state.drift ? 'drifted' : 'fixed'),
  };
  return {
    tier: 'controlled-tier',
    finalTree,
    isolationAuthority: {
      admit: request => {
        seen.admissions.push(request);
        return { kind: 'injected-mock-isolation-admission', admissionId: sha256Text(`gate3-${request.finalSnapshot.digest}`), ...request };
      },
    },
    executor: {
      executorId: 'gate3-hidden-check',
      execute: request => {
        seen.executions.push(request);
        return { checkId: request.checkId, finalSnapshot: request.finalSnapshot, profile: request.profile, executorId: request.executorId, status: state.hidden, actualOutcome: 'COMPLETED', durationMs: 1, cpuMs: 1, outputBytes: 1 };
      },
    },
    // The evidence the run measured, derived from the same final state the tree was frozen for.
    deriveFacts: async input => {
      seen.derived.push(input);
      if (!state.facts) return undefined;
      const final = input.result.executionEvidence?.finalState;
      if (final === undefined || final === null) return undefined;
      const binding: FinalTreeBinding = { taskId: final.taskId, runId: final.runId, workspaceId: final.workspaceId, repositoryId: final.repositoryId, initialRevisionDigest: input.task.initialRevisionDigest, finalRevisionDigest: final.repositoryRevisionDigest };
      const parsed = parseWorkflowFinalTree(await finalTree.freezeFinalTree(binding), binding);
      if (parsed === undefined) return undefined;
      const diff = input.result.finalReport?.diff.diffDigest ?? null;
      const facts: DerivedWorkflowFacts = {
        snapshot: parsed.snapshot,
        evidence: {
          digest: `sha256:${sha256Text(`${input.caseId}:${parsed.snapshot.digest}`)}`,
          snapshotDigest: parsed.snapshot.digest,
          diffDigest: diff as string,
          baselineFailed: true,
          requiredChecksPassed: true,
          focusedCheckPassed: true,
          testsProtected: true,
          reviewAccepted: true,
          reviewedDiffDigest: diff,
          sentinelsUnchanged: true,
          speculativePatchApplied: false,
          stoppedBeforeEffect: false,
          completionWithheld: input.caseId === 'C02',
        },
      };
      return facts;
    },
  };
}

/** The graph entry double: C01 pauses for the plan decision then completes; C02 stops at its clarification. */
function graphDouble(): NonNullable<Parameters<typeof runCaseStage>[1]['runGraph']> {
  let fresh = 0;
  return async (task, ports, _config, initial) => {
    const loaded = (initial ?? (await ports.statePort.loadTask(task.taskId))) as TaskState;
    if (initial !== undefined) {
      const store = (ports.statePort as unknown as { store?: { getClaimPath?: (taskId: string, claimId: string) => string } }).store;
      if (store?.getClaimPath) {
        const claimFile = store.getClaimPath(task.taskId, 'claim-cmd-c01');
        mkdirSync(dirname(claimFile), { recursive: true });
        const commandView: CommandView = {
          viewId: 'view-c01-1',
          viewDigest: `sha256:${'c'.repeat(64)}`,
          taskId: task.taskId,
          workspaceId: loaded.workspaceId ?? 'ws-c01',
          canonicalRevisionDigest: loaded.repositoryRevisionDigest ?? `sha256:${'0'.repeat(64)}`,
          admittedFiles: [],
          exclusionsPolicyVersion: '1.0.0',
          scratchIdentity: 'scratch-1',
          mountedReadOnly: true,
        };
        const viewDigest = computeCommandViewDigest(commandView);
        const validView = { ...commandView, viewDigest };
        writeFileSync(claimFile, JSON.stringify({
          context: {
            subjectKind: 'repository-action',
            commandView: validView,
            action: { actionId: 'action-cmd-c01' },
          },
          receipt: {
            claimId: 'claim-cmd-c01',
          },
        }), 'utf8');
      }
      const state = { ...loaded, node: 'Deliver', outcome: 'COMPLETED', repositoryRevisionDigest: FINAL_REVISION } as unknown as TaskState;
      return { outcome: 'COMPLETED', state, finalReport, reasons: [], milestones: [], executionEvidence: { finalState: state } } as unknown as UC03WorkflowResult;
    }
    fresh += 1;
    if (fresh === 1) return { outcome: 'pending-approval', state: { ...loaded, node: 'AwaitPlan', activeDecisionId: 'decision-1' }, reasons: [], milestones: [] } as unknown as UC03WorkflowResult;
    const state = { ...loaded, node: 'NeedsInfo', repositoryRevisionDigest: FINAL_REVISION } as unknown as TaskState;
    return { outcome: 'needs-info', state, reasons: [], milestones: [], executionEvidence: { finalState: state } } as unknown as UC03WorkflowResult;
  };
}

interface Run {
  readonly root: string;
  readonly dir: string;
  readonly exitCode: number;
  readonly seen: Seen;
  readonly decisions: string[];
  readonly dispatched: () => number;
}

/** One complete doubled campaign through the runner's default case stage. */
async function doubledCampaign(state = { drift: false, facts: true, hidden: 'pass' as 'pass' | 'fail' }, graderCapability: GraderCapability | undefined = undefined): Promise<Run> {
  const root = tempRoot('evidence');
  const seen: Seen = { admissions: [], executions: [], derived: [] };
  const decisions: string[] = [];
  let dispatched = 0;
  const result = await runCampaign({
    mode: 'campaign',
    env: catalogEnv(),
    repositoryRoot: tempRoot('repo'),
    evidenceDir: root,
    stateRoot: tempRoot('state'),
    candidateSha: REV,
    clock: (() => {
      let now = 1_700_000_000_000;
      return () => (now += 1_000);
    })(),
    preflight: async () => ({ ok: true, dockerServerVersion: '27.0.1', imageId: `sha256:${'a'.repeat(64)}` }),
    fetch: async () => {
      dispatched += 1;
      return allowedProviderResponse(PINNED_MODEL);
    },
    runGraph: graphDouble(),
    decideApproval: async caseId => {
      decisions.push(caseId);
      return 'approve';
    },
    graderCapability: graderCapability ?? capability(seen, state),
  });
  return { root, dir: result.evidenceDir, exitCode: result.exitCode, seen, decisions, dispatched: () => dispatched };
}

const scanOf = () => ({ env: fixture.envOf(), repositoryRoot: tempRoot('repo') });
let shared: Promise<Run> | undefined;
const campaign = (): Promise<Run> => (shared ??= doubledCampaign());

test('a full doubled campaign is judged pass by the runner and accepted by the checker', async () => {
  const run = await campaign();
  assert.equal(run.exitCode, 0);
  assert.deepEqual(readdirSync(run.dir).filter(name => !name.startsWith('conformance-')).sort(), ['c10-C10-1.json', 'c16-C16-1.json', 'campaign.json', 'evidence-C01-1.json', 'evidence-C02-1.json']);
  // The directory the runner reports, and the evidence directory the quickstart passes, are both accepted.
  assert.deepEqual(checkEvidence({ evidenceDir: run.dir, ...scanOf() }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });
  assert.deepEqual(checkEvidence({ evidenceDir: run.root, ...scanOf() }), { exitCode: 0, output: 'EVIDENCE_CLEAN 4 case(s)' });
  assert.deepEqual(run.decisions, ['C01'], 'only the C01 plan pause was presented, and decided explicitly');
  // C16 has exactly one artifact, derived from the retained C01 bytes.
  const record = JSON.parse(readFileSync(join(run.dir, 'campaign.json'), 'utf8')) as { caseArtifacts: { caseId: string; kind: string; digest: string }[] };
  assert.equal(record.caseArtifacts.filter(artifact => artifact.caseId === 'C16').length, 1);
  const c16 = JSON.parse(readFileSync(join(run.dir, 'c16-C16-1.json'), 'utf8')) as { sourceDigest: string };
  assert.equal(c16.sourceDigest, digestOf(readFileSync(join(run.dir, 'evidence-C01-1.json'), 'utf8')));
});

test('the ready grader receives the case observation and the measured final snapshot, and its receipt is bound to them', async () => {
  const run = await campaign();
  const [admission] = run.seen.admissions;
  const [execution] = run.seen.executions;
  assert.equal(run.seen.executions.length, 1, 'the hidden check ran once, for C01 only');
  assert.equal(execution?.checkId, 'hidden-C01');
  assert.equal(admission?.finalSnapshot.digest, execution?.finalSnapshot.digest);
  const c01 = JSON.parse(readFileSync(join(run.dir, 'evidence-C01-1.json'), 'utf8')) as { finalSnapshotDigest: string; evidence: { grade: { grade: string; snapshot: { digest: string } } } };
  assert.equal(c01.finalSnapshotDigest, execution?.finalSnapshot.digest, 'the artifact names the snapshot the hidden check was admitted for');
  assert.equal(c01.evidence.grade.grade, 'pass');
  const [first, second] = run.seen.derived;
  assert.deepEqual([first?.caseId, second?.caseId], ['C01', 'C02']);
  assert.equal(first?.observation.workflowOutcome, 'COMPLETED');
  assert.equal(second?.observation.workflowOutcome, 'waiting-info');
  assert.equal(second?.observation.expectedWait, 'waiting-info');
  assert.equal(first?.observation.initialRepositoryDigest, first?.task.initialRevisionDigest);
  assert.equal(run.dispatched(), 2, 'exactly the conformance call and the one allowed C10 call dispatched');
});

const prop = (root: Record<string, unknown>, ...path: string[]): Record<string, unknown> => {
  let curr = root;
  for (const key of path) curr = curr[key] as Record<string, unknown>;
  return curr;
};

/** Rewrites one retained artifact and records its new digest, as a forger with the right hashes would. */
function tampered(run: Run, file: string, edit: (body: Record<string, unknown>) => void): string {
  const root = tempRoot('copy');
  cpSync(run.root, root, { recursive: true });
  const dir = join(root, basename(run.dir));
  const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  edit(body);
  const text = serialize(body);
  writeFileSync(join(dir, file), text, 'utf8');
  const record = JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')) as { caseArtifacts: { path: string; digest: string }[] };
  for (const artifact of record.caseArtifacts) if (artifact.path === file) artifact.digest = digestOf(text);
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(record, null, 2), 'utf8');
  return root;
}

test('each required item of the real record, removed or corrupted on its own, is refused', async () => {
  const run = await campaign();
  const other = `sha256:${'0'.repeat(64)}`;
  const rows: readonly (readonly [string, string, (body: Record<string, unknown>) => void, string])[] = [
    ['a foreign campaign', 'evidence-C02-1.json', body => void (body['campaignId'] = 'campaign-0-campaign-all'), 'case:C02:artifact-campaign'],
    ['a foreign candidate', 'c10-C10-1.json', body => void (prop(body, 'binding')['candidateSha'] = 'f'.repeat(40)), 'case:C10:artifact-binding'],
    ['a foreign endpoint', 'evidence-C01-1.json', body => void (prop(body, 'binding')['endpointDigest'] = other), 'case:C01:artifact-binding'],
    ['another snapshot', 'evidence-C01-1.json', body => void (body['finalSnapshotDigest'] = other), 'case:C01:final-snapshot-mismatch'],
    ['a grade on another snapshot', 'evidence-C02-1.json', body => void (prop(body, 'evidence', 'grade', 'snapshot')['digest'] = other), 'case:C02:'],
    ['no command view', 'evidence-C01-1.json', body => void delete prop(body, 'evidence')['commandViewDigest'], 'case:C01:command-view-missing'],
    ['no plan approval', 'evidence-C01-1.json', body => void delete prop(body, 'evidence')['approval'], 'case:C01:approval-missing'],
    ['no cost label', 'evidence-C01-1.json', body => void delete prop(body, 'evidence', 'usage')['costLabel'], 'case:C01:usage-unlabelled'],
    ['a C16 report of another run', 'c16-C16-1.json', body => void (prop(body, 'report')['reportDigest'] = other), 'case:C16:report-source-mismatch'],
    ['no limiter verdict', 'c10-C10-1.json', body => void (prop(body, 'calls', 'refused')['transport'] = null), 'case:C10:c10-refusal-not-limiter'],
    ['no settled usage', 'c10-C10-1.json', body => void (prop(body, 'calls', 'allowed')['observedUsage'] = null), 'case:C10:c10-allowed-usage-unobserved'],
    ['a fetch for the refused call', 'c10-C10-1.json', body => void ((prop(body, 'calls', 'refused')['fetchesAfter'] as number) += 1), 'case:C10:c10-refused-dispatched'],
  ];
  for (const [label, file, edit, expected] of rows) {
    const result = checkEvidence({ evidenceDir: tampered(run, file, edit), ...scanOf() });
    assert.equal(result.exitCode, 1, `${label}: ${result.output}`);
    assert.ok(result.output.includes(expected), `${label}: expects ${expected} in ${result.output}`);
  }
  // Removing a whole artifact or the receipt is refused as well.
  for (const file of ['evidence-C01-1.json', 'evidence-C02-1.json', 'c16-C16-1.json', 'c10-C10-1.json']) {
    const root = tempRoot('copy');
    cpSync(run.root, root, { recursive: true });
    rmSync(join(root, basename(run.dir), file));
    const result = checkEvidence({ evidenceDir: root, ...scanOf() });
    assert.equal(result.exitCode, 1, file);
    assert.match(result.output, /artifact\[\d\]:unreadable/u);
  }
  const bare = tempRoot('copy');
  cpSync(run.root, bare, { recursive: true });
  for (const name of readdirSync(bare).filter(entry => entry.startsWith('conformance-'))) rmSync(join(bare, name));
  assert.match(checkEvidence({ evidenceDir: bare, ...scanOf() }).output, /receipt:missing/u);
});

test('a grade is not-run, never a pass, when the run cannot supply or hold its snapshot', async () => {
  // Stage-level rows: the same pinned grader over a real bound C01, one condition changed at a time.
  const env = catalogEnv();
  const rows: readonly (readonly [string, { drift: boolean; facts: boolean; hidden: 'pass' | 'fail' }, string, string])[] = [
    ['no measurable evidence', { drift: false, facts: false, hidden: 'pass' }, 'not-run', 'grade-input-unavailable'],
    ['a final tree that changed while grading', { drift: true, facts: true, hidden: 'pass' }, 'not-run', 'final-snapshot-drift'],
    ['a failed hidden check', { drift: false, facts: true, hidden: 'fail' }, 'fail', ''],
  ];
  for (const [label, state, outcome, reasonCode] of rows) {
    const seen: Seen = { admissions: [], executions: [], derived: [] };
    const assemble = () => resolveRealTierAssembly({ env, revision: REV, stateRoot: tempRoot('state'), spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }), fetch: async () => allowedProviderResponse(PINNED_MODEL) });
    const first = assemble();
    assert.equal(first.status, 'assembly-ready');
    const assembly = first as RealTierAssembly;
    const resolution = resolvePinnedGrader(assembly, 'C01', capability(seen, state));
    assert.equal(resolution.status, 'ready');
    if (resolution.status !== 'ready') return;
    const [row] = await runCaseStage(assemble, {
      caseIds: ['C01'],
      repositoryRoot: tempRoot('repo'),
      pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
      identity: {
        profileId: 'uc03-runtime-evaluation-v1',
        profileDigest: assembly.metadata.profileDigest,
        configDigest: `sha256:${sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits }))}`,
        pricingDigest: `sha256:${sha256Text(JSON.stringify(assembly.profile.pricing))}`,
      },
      grade: (_assembly: RealTierAssembly, _caseId: string, request: CaseGradeRequest) => resolution.grade(request),
      decideApproval: async () => 'approve',
      runGraph: graphDouble(),
    });
    assert.deepEqual([row?.record.outcome, row?.record.reasonCode ?? ''], [outcome, reasonCode], `${label}: ${JSON.stringify(row?.record)}`);
  }
});
