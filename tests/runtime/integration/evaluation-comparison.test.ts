/**
 * T014b — two-attempt comparison over graph-backed reports.
 *
 * Two attempts are compatible only when they share the case, repository and grader identity. Each
 * attempt gets a fresh task, so nothing is carried between them; a differing factor is named, and a
 * single pair never yields a quality claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { runEvaluation, type WorkflowEvaluationOptions } from '../../../eval/uc03/runner.ts';
import { compareWorkflowEvaluations } from '../../../eval/uc03/compare.ts';
import { WORKFLOW_EVALUATION_VERSION } from '../../../eval/uc03/types.ts';
import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createPendingApprovalRoute } from '../support/uc03/controlled-route.ts';

const digest = (seed: string): string => sha256Text(seed);

const HOST_OPTIONS = {
  contractVersion: WORKFLOW_EVALUATION_VERSION,
  profileDigest: digest('profile'),
  configDigest: digest('config'),
  pricingDigest: digest('pricing'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'mock-model-v1',
  timestamp: '2026-11-04T00:00:00.000Z',
} as const;

/** Shared case/repository/grader identity: the only thing two comparable attempts may not vary. */
const CASE_IDENTITY = {
  caseDigest: digest('case-C01'),
  publicTaskDigest: digest('task-C01'),
  fixtureDigest: digest('fixture-C01'),
  grader: { version: '1.0.0', digest: digest('grader-C01'), path: 'C:/host-only/grader.json' },
} as const;

function entry(overrides: Partial<CatalogEntry> = {}, initialRepositoryDigest?: string): CatalogEntry {
  return {
    catalogEntryId: 'entry-C01',
    caseId: 'C01',
    version: '1.0.0',
    initialRepositoryDigest: initialRepositoryDigest ?? digest('repo-unset'),
    fixturePath: 'C:/host-only/fixture.json',
    ...CASE_IDENTITY,
    ...overrides,
  };
}

/** One attempt: a fresh task and fresh ports, sharing only the host-pinned identity. */
async function attempt(overrides: { readonly caseEntry?: Partial<CatalogEntry>; readonly profileDigest?: string } = {}) {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const host: WorkflowCaseHost = {
    entry: entry(overrides.caseEntry, route.task.initialRevisionDigest),
    task: route.task,
    ports: route.ports,
    expectedWait: null,
    config: route.config,
  };
  const report = await runEvaluation({
    ...HOST_OPTIONS,
    ...(overrides.profileDigest === undefined ? {} : { profileDigest: overrides.profileDigest }),
    mode: 'mock',
    cases: ['C01'],
    driver: createWorkflowDriver(new Map([['C01', host]])),
  } as WorkflowEvaluationOptions);
  return { report, route };
}

/* ------------------------------------------------------------------ */

test('two compatible attempts share case/repository/grader identity and compare without a failed guard', async () => {
  const first = await attempt();
  const second = await attempt();

  // Fresh ports and a fresh state journal per attempt; only the pinned case identity is reused.
  assert.notEqual(first.route.statePort, second.route.statePort);
  first.route.repositoryPort.setTestResult('check-pytest-regression', { checkId: 'check-pytest-regression', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 100 });
  assert.deepEqual(
    first.report.cases.map(item => [item.caseId, item.graderDigest, item.expectedOutcome]),
    second.report.cases.map(item => [item.caseId, item.graderDigest, item.expectedOutcome]),
  );

  const comparison = compareWorkflowEvaluations(first.report, second.report);
  assert.deepEqual(comparison.failedGuards, []);
  assert.equal(comparison.compatible, true);
  assert.deepEqual(comparison.changedFactors, []);
  // One pair supports no quality claim, and a single selected case never certifies the suite.
  assert.ok(comparison.limitations.some(line => line.includes('no causal or statistical quality claim')));
  assert.equal(comparison.baselineAcceptance.outcome, 'incomplete');
  assert.equal(comparison.candidateAcceptance.outcome, 'incomplete');
});

test('a differing grader or initial repository refuses the comparison', async () => {
  const baseline = await attempt();
  const otherRepo = await attempt({ caseEntry: { initialRepositoryDigest: digest('different-repo') } });
  const otherGrader = await attempt({ caseEntry: { grader: { version: '1.0.0', digest: digest('different-grader'), path: 'C:/host-only/grader.json' } } });

  // Both attempts run the same task against the same host-pinned identity, so only the changed pinned fact fails.
  const repoComparison = compareWorkflowEvaluations(baseline.report, otherRepo.report);
  assert.deepEqual(repoComparison.failedGuards, ['initialRepositoryDigest']);
  assert.equal(repoComparison.compatible, false);

  const graderComparison = compareWorkflowEvaluations(baseline.report, otherGrader.report);
  assert.deepEqual(graderComparison.failedGuards, ['graderDigest']);
  assert.equal(graderComparison.compatible, false);
});

test('both attempts keep unknown usage unknown across the comparison', async () => {
  const baseline = await attempt();
  const candidate = await attempt();
  const comparison = compareWorkflowEvaluations(baseline.report, candidate.report);

  // A pending route never observes provider usage, so the pair has no token or cost delta.
  assert.equal(comparison.tokensDelta, null);
  assert.equal(comparison.costDeltaUsd, null);
  assert.ok(comparison.limitations.some(line => line.includes('deltas are null, never zero')));
});

test('an unresolved wait is carried into the comparison, never graded as a repair', async () => {
  const baseline = await attempt();
  const candidate = await attempt();

  for (const { report } of [baseline, candidate]) {
    const [observed] = report.cases;
    assert.ok(observed);
    assert.equal(observed.grade, 'not-run');
    assert.equal(observed.gradeReason, 'unresolved-wait');
    assert.equal(report.tier, 'controlled');
    assert.equal(report.isRealVerified, false);
  }

  const comparison = compareWorkflowEvaluations(baseline.report, candidate.report);
  assert.deepEqual(comparison.pendingWaits, { baseline: ['C01'], candidate: ['C01'] });
  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.equal(comparison.summary.stableCount, 1);
});

test('a differing profile is a named changed factor, and a real attempt is refused before it can be compared', async () => {
  const baseline = await attempt();
  const otherProfile = await attempt({ profileDigest: digest('other-profile') });
  const changed = compareWorkflowEvaluations(baseline.report, otherProfile.report);

  assert.equal(changed.compatible, true);
  assert.deepEqual(changed.changedFactors, ['profileDigest']);
  assert.equal(changed.configurationConfounded, false);

  // Real mode without G-REAL admission runs nothing, so it can never be read as a second verified attempt.
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = { entry: entry({}, route.task.initialRevisionDigest), task: route.task, ports: route.ports, expectedWait: null, config: route.config };
  const real = await runEvaluation({
    ...HOST_OPTIONS,
    mode: 'real',
    cases: ['C01'],
    driver: createWorkflowDriver(new Map([['C01', host]])),
  } as WorkflowEvaluationOptions);
  assert.equal(real.isRealVerified, false);
  assert.equal(real.cases[0]?.gradeReason, 'real-execution-unavailable');

  const refused = compareWorkflowEvaluations(baseline.report, real);
  // The refused run observed no identity, so mode fails while the identity guards stay unproven.
  assert.equal(refused.compatible, false);
  assert.deepEqual(refused.failedGuards, ['mode']);
  assert.deepEqual(refused.unverifiedGuards, ['graderDigest', 'initialRepositoryDigest', 'repositoryId']);
});
