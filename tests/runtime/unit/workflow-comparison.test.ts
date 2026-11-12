/**
 * UC-03 workflow comparison (`compareWorkflowEvaluations`).
 * Owned path: tests/runtime/unit/workflow-comparison.test.ts
 *
 * Reports are built through the real `runEvaluation` workflow path so validator agreement is proven.
 * Guards for `suite`, `contractVersion` and `manifestDigest` cannot differ between two accepted
 * reports: the workflow validator pins all three. Those cases assert the validator refusal instead.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareEvaluations, compareWorkflowEvaluations } from '../../../eval/uc03/compare.ts';
import { runEvaluation, type EvaluationCaseSpec, type WorkflowCaseContext, type WorkflowEvaluationOptions, type WorkflowObservation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION } from '../../../eval/uc03/types.ts';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function options(overrides: Partial<WorkflowEvaluationOptions> = {}): WorkflowEvaluationOptions {
  return {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    cases: ['C01', 'C02'],
    profileDigest: DIGEST,
    configDigest: DIGEST,
    pricingDigest: DIGEST,
    adapterVersions: ['mock-adapter-v1'],
    requestedModel: 'mock-model-v1',
    timestamp: '2026-11-02T00:00:00.000Z',
    ...overrides,
  };
}

function observation(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: 'mock-model-v1',
    graderDigest: DIGEST,
    initialRepositoryDigest: DIGEST,
    workflowOutcome: 'COMPLETED',
    expectedWait: null,
    blocked: null,
    effects: 'none',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  };
}

function driver(overrides: Partial<WorkflowObservation> = {}): { executeCase: (spec: EvaluationCaseSpec, context: WorkflowCaseContext) => WorkflowObservation } {
  return { executeCase: () => observation(overrides) };
}

const run = (overrides: Partial<WorkflowEvaluationOptions> = {}) => runEvaluation(options(overrides));
const comparisonCliExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const comparisonCli = fileURLToPath(new URL(`../../../eval/uc03/compare.${comparisonCliExtension}`, import.meta.url));
const runComparisonCli = (args: readonly string[]) => spawnSync(process.execPath, [
  '--experimental-strip-types', comparisonCli, ...args,
], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });

test('the comparison CLI dispatches tagged workflow reports and writes workflow comparison JSON', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({ configDigest: OTHER, driver: driver() });
  const directory = mkdtempSync(join(tmpdir(), 'uc03-workflow-compare-cli-'));
  const baselinePath = join(directory, 'baseline.json');
  const candidatePath = join(directory, 'candidate.json');
  const outputPath = join(directory, 'comparison.json');
  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(candidatePath, JSON.stringify(candidate));

  try {
    const result = runComparisonCli(['--baseline', baselinePath, '--candidate', candidatePath, '--output', outputPath]);

    assert.equal(result.status, 1, result.stderr);
    const comparison = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    assert.equal(comparison.contractVersion, WORKFLOW_EVALUATION_VERSION);
    assert.equal(comparison.compatible, true);
    assert.deepEqual(comparison.failedGuards, []);
    assert.deepEqual(comparison.changedFactors, ['configDigest']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the comparison CLI strict option rejects a guarded config change', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({ configDigest: OTHER, driver: driver() });
  const directory = mkdtempSync(join(tmpdir(), 'uc03-workflow-compare-strict-'));
  const baselinePath = join(directory, 'baseline.json');
  const candidatePath = join(directory, 'candidate.json');
  const outputPath = join(directory, 'comparison.json');
  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(candidatePath, JSON.stringify(candidate));

  try {
    const result = runComparisonCli(['--baseline', baselinePath, '--candidate', candidatePath, '--output', outputPath, '--strict-same-config']);
    const comparison = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(comparison.failedGuards, ['strictSameConfig']);
    assert.equal(comparison.compatible, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the comparison CLI reports incompatible tagged reports with their failed guard', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({ driver: driver({ repositoryId: 'repo-2', initialRepositoryDigest: OTHER }) });
  const directory = mkdtempSync(join(tmpdir(), 'uc03-workflow-compare-incompatible-'));
  const baselinePath = join(directory, 'baseline.json');
  const candidatePath = join(directory, 'candidate.json');
  const outputPath = join(directory, 'comparison.json');
  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(candidatePath, JSON.stringify(candidate));

  try {
    const result = runComparisonCli(['--baseline', baselinePath, '--candidate', candidatePath, '--output', outputPath]);
    const comparison = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(comparison.failedGuards, ['initialRepositoryDigest', 'repositoryId']);
    assert.equal(comparison.compatible, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the comparison CLI safely refuses mixed and malformed workflow inputs', async () => {
  const workflow = await run({ driver: driver() });
  const legacy = await runEvaluation({ mode: 'mock' });
  const directory = mkdtempSync(join(tmpdir(), 'uc03-workflow-compare-invalid-'));
  const workflowPath = join(directory, 'workflow.json');
  const legacyPath = join(directory, 'legacy.json');
  const malformedPath = join(directory, 'malformed.json');
  const outputPath = join(directory, 'comparison.json');
  writeFileSync(workflowPath, JSON.stringify(workflow));
  writeFileSync(legacyPath, JSON.stringify(legacy));
  writeFileSync(malformedPath, JSON.stringify({ suite: 'uc03', contractVersion: WORKFLOW_EVALUATION_VERSION }));

  try {
    const mixed = runComparisonCli(['--baseline', workflowPath, '--candidate', legacyPath, '--output', outputPath]);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /comparison refused: invalid or incomparable report inputs/u);
    assert.equal(existsSync(outputPath), false);

    const malformed = runComparisonCli(['--baseline', malformedPath, '--candidate', malformedPath, '--output', outputPath]);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /comparison refused: invalid or incomparable report inputs/u);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the comparison CLI preserves legacy report output and summary', async () => {
  const baseline = await runEvaluation({ mode: 'mock' });
  const candidate = await runEvaluation({ mode: 'mock' });
  const directory = mkdtempSync(join(tmpdir(), 'uc03-legacy-compare-cli-'));
  const baselinePath = join(directory, 'baseline.json');
  const candidatePath = join(directory, 'candidate.json');
  const outputPath = join(directory, 'comparison.json');
  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(candidatePath, JSON.stringify(candidate));

  try {
    const result = runComparisonCli(['--baseline', baselinePath, '--candidate', candidatePath, '--output', outputPath]);
    const comparison = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^UC-03 Comparison: Verdict = /u);
    assert.equal('baselineDigest' in comparison, true);
    assert.equal('baselineConfigDigest' in comparison, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('identical reports certify a compatible pair with no changed factors', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({ driver: driver() });
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  assert.equal(comparison.contractVersion, WORKFLOW_EVALUATION_VERSION);
  assert.equal(comparison.compatible, true);
  assert.deepEqual(comparison.failedGuards, []);
  assert.deepEqual(comparison.unverifiedGuards, []);
  // Comparable, but a two-case selection never certifies the 17-case suite, so no pass verdict is claimed.
  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.equal(comparison.exitCode, 1);
  assert.deepEqual(comparison.summary, { totalCommon: 2, totalAdded: 0, totalRemoved: 0, stableCount: 2, improvementsCount: 0, regressionsCount: 0, unknownUsageCases: 0, observedUsageCases: 4 });
  assert.deepEqual(
    comparison.limitations.filter(line => line.includes('unverified') || line.includes('statistical') || line.includes('selected-case pass')),
    [
      'Two attempts are observations; this comparison supports no causal or statistical quality claim.',
      'A selected-case pass does not make the full suite pass; suite acceptance is mirrored from each report and never inferred.',
    ],
  );
});

test('a differing per-case expected outcome fails its guard', async () => {
  const baseline = await run({ driver: driver() });
  // C01's pinned expectation is a wait, so a hand-built report with a terminal expectation is still validator-legal.
  const drifted = { ...baseline, cases: baseline.cases.map(item => ({ ...item, expectedOutcome: item.expectedOutcome === 'COMPLETED' ? 'INCOMPLETE' : 'COMPLETED' })) };
  const comparison = compareWorkflowEvaluations(baseline, drifted);

  assert.deepEqual(comparison.failedGuards, ['expectedOutcome']);
  assert.equal(comparison.compatible, false);
  assert.ok(comparison.limitations.some(line => line.includes('expectedOutcome')));
});

test('a single changed config factor is named without a confounding label', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({ configDigest: OTHER, driver: driver() });
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  assert.deepEqual(comparison.changedFactors, ['configDigest']);
  assert.equal(comparison.configurationConfounded, false);
  assert.deepEqual(comparison.failedGuards, []);
  assert.equal(comparison.baselineConfigDigest, DIGEST);
  assert.equal(comparison.candidateConfigDigest, OTHER);
});

test('multiple changed factors are reported and labelled configuration-confounded', async () => {
  const baseline = await run({ driver: driver() });
  const candidate = await run({
    profileDigest: OTHER,
    pricingDigest: OTHER,
    adapterVersions: ['mock-adapter-v2'],
    requestedModel: 'mock-model-v2',
    driver: driver({ returnedModel: 'mock-model-v2' }),
  });
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  assert.deepEqual(comparison.changedFactors, ['adapterVersions', 'pricingDigest', 'profileDigest', 'requestedModel', 'returnedModel']);
  assert.equal(comparison.configurationConfounded, true);
  assert.ok(comparison.limitations.some(line => line.includes('configuration-confounded')));
});

test('strict same-config mode rejects any changed factor as a failed guard', async () => {
  const baseline = await run({ driver: driver() });
  const different = await run({ configDigest: OTHER, driver: driver() });
  const strict = compareWorkflowEvaluations(baseline, different, { strictSameConfig: true });
  assert.deepEqual(strict.failedGuards, ['strictSameConfig']);
  assert.equal(strict.compatible, false);

  const same = compareWorkflowEvaluations(baseline, await run({ driver: driver() }), { strictSameConfig: true });
  assert.deepEqual(same.failedGuards, []);
  assert.deepEqual(same.changedFactors, []);
});

test('repository and grader identity guards fail and are named', async () => {
  const baseline = await run({ driver: driver({ graderDigest: DIGEST }) });
  const candidate = await run({ driver: driver({ repositoryId: 'repo-2', graderDigest: OTHER, initialRepositoryDigest: OTHER }) });
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  assert.deepEqual(comparison.failedGuards, ['graderDigest', 'initialRepositoryDigest', 'repositoryId']);
  assert.deepEqual(comparison.unverifiedGuards, []);
  assert.equal(comparison.compatible, false);
  assert.ok(comparison.limitations.some(line => line.includes('Comparison refused') && line.includes('graderDigest') && line.includes('repositoryId')));
});

test('identity facts observed on neither side are unverified and refuse the pair', async () => {
  const blind = { repositoryId: null, graderDigest: null, initialRepositoryDigest: null } as const;
  const baseline = await run({ driver: driver(blind) });
  const candidate = await run({ driver: driver(blind) });
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  // null identity is not agreement: every identity guard stays unproven, so no verdict is claimed.
  assert.equal(comparison.compatible, false);
  assert.deepEqual(comparison.failedGuards, []);
  assert.deepEqual(comparison.unverifiedGuards, ['graderDigest', 'initialRepositoryDigest', 'repositoryId']);
  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.ok(comparison.limitations.some(line => line.includes('Guards not provable') && line.includes('graderDigest') && line.includes('repositoryId')));
});

test('selected case order and cardinality are guarded', async () => {
  const baseline = await run({ cases: ['C01', 'C02'], driver: driver() });
  // The runner emits cases in manifest order, so the reordered case is hand-built: the validator
  // accepts any case order as long as selectionResult follows it.
  const reordered = { ...baseline, selectionResult: { ...baseline.selectionResult, selected: [...baseline.selectionResult.selected].reverse() }, cases: [...baseline.cases].reverse() };
  assert.deepEqual(compareWorkflowEvaluations(baseline, reordered).failedGuards, ['selected']);

  const narrowed = await run({ cases: ['C01'], driver: driver() });
  assert.deepEqual(compareWorkflowEvaluations(baseline, narrowed).failedGuards, ['caseCardinality', 'selected']);
  assert.deepEqual(compareWorkflowEvaluations(narrowed, baseline).failedGuards, ['caseCardinality', 'selected']);
});

test('execution mode, contract version and manifest identity cannot differ in comparable reports', async () => {
  const baseline = await run({ driver: driver() });
  // A refused real run observes nothing, so its identity facts are unproven, not equal: mode fails, identity stays unverified.
  const real = await run({ mode: 'real', driver: driver() });
  const compared = compareWorkflowEvaluations(baseline, real);
  assert.deepEqual(compared.failedGuards, ['mode']);
  assert.deepEqual(compared.unverifiedGuards, ['graderDigest', 'initialRepositoryDigest', 'repositoryId']);
  assert.equal(compared.compatible, false);

  // Suite, contractVersion and manifestDigest are pinned by the workflow validator, so no accepted pair can differ on them.
  assert.throws(() => compareWorkflowEvaluations(baseline, { ...baseline, suite: 'uc01' }));
  assert.throws(() => compareWorkflowEvaluations(baseline, { ...baseline, contractVersion: 'uc03-workflow-evaluation/2' }));
  assert.throws(() => compareWorkflowEvaluations(baseline, { ...baseline, manifestDigest: `sha256:${OTHER}` }));
  assert.throws(() => compareWorkflowEvaluations(baseline, { ...baseline, cases: [] }));
});

test('grade transitions count improvements and regressions across common selected cases', async () => {
  const baseline = await run({ cases: ['C01', 'C03'], driver: driver({ workflowOutcome: 'FAILED' }) });
  const improved = await run({ cases: ['C01', 'C03'], driver: driver() });
  const improvement = compareWorkflowEvaluations(baseline, improved);
  assert.deepEqual(
    improvement.cases.map(item => [item.caseId, item.transition]),
    [
      ['C01', 'improved'],
      ['C03', 'improved'],
    ],
  );
  assert.equal(improvement.summary.improvementsCount, 2);
  assert.equal(improvement.summary.totalCommon, 2);

  const regression = compareWorkflowEvaluations(improved, baseline);
  assert.equal(regression.summary.regressionsCount, 2);
  assert.equal(regression.summary.stableCount, 0);
  // A two-case selection never certifies the 17-case suite, so improvement stays INCOMPLETE; a regression is named regardless.
  assert.equal(improvement.verdict, 'INCOMPLETE');
  assert.equal(regression.verdict, 'REGRESSED');
});

test('unknown usage stays unknown and waits/non-selection retain coverage', async () => {
  // C01 pauses unresolved (not-run), C02 reaches its pinned INCOMPLETE outcome: selection passes, the suite does not.
  const byCase = (usage: WorkflowObservation['usage']) => ({
    executeCase: (spec: EvaluationCaseSpec) => (spec.caseId === 'C01' ? observation({ workflowOutcome: 'waiting-approval', usage }) : observation({ workflowOutcome: 'INCOMPLETE' })),
  });
  const baseline = await run({ cases: ['C01', 'C02'], driver: byCase('uncertain') });
  const candidate = await run({ cases: ['C01', 'C02', 'C03'], driver: byCase('unavailable') });
  // Different selections make the pair incompatible, but retained coverage is still reported.
  const comparison = compareWorkflowEvaluations(baseline, candidate);

  assert.equal(comparison.tokensDelta, null);
  assert.equal(comparison.costDeltaUsd, null);
  assert.equal(comparison.summary.unknownUsageCases, 2);
  assert.equal(comparison.summary.observedUsageCases, 3);
  assert.deepEqual(comparison.pendingWaits, { baseline: ['C01'], candidate: ['C01'] });
  assert.deepEqual(comparison.selectedCases, ['C01', 'C02', 'C03']);
  assert.deepEqual(comparison.notSelectedCases, {
    baseline: ['C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17'],
    candidate: ['C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17'],
  });
  // A selected pass never presents complete suite acceptance (C01 never observed an outcome, so the selection fails).
  assert.equal(comparison.baselineAcceptance.outcome, 'incomplete');
  assert.equal(comparison.candidateAcceptance.outcome, 'fail');
  assert.ok(comparison.limitations.some(line => line.includes('complete suite acceptance')));
  assert.ok(comparison.limitations.some(line => line.includes('deltas are null, never zero')));
});

test('legacy comparison keeps its own reports and refuses workflow ones', async () => {
  const legacy = await runEvaluation({ mode: 'mock' });
  const legacyAgain = await runEvaluation({ mode: 'mock' });
  assert.equal(compareEvaluations(legacy, legacyAgain).verdict, 'INCOMPLETE');
  assert.throws(() => compareWorkflowEvaluations(legacy, legacyAgain));
  // The legacy comparator also refuses tagged workflow reports rather than misreading them.
  const tagged = await run({ driver: driver() });
  assert.throws(() => compareEvaluations(tagged, tagged));
});
