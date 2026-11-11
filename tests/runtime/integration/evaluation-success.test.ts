/**
 * First-case proof surface: the operator CLI over the real workflow runner and a real graph-backed driver.
 *
 * C02 (expected wait satisfied) and C01 (unresolved wait) are separate CLI invocations on purpose:
 * combined they only ever show `incomplete`. Suite acceptance still counts all 17 required cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createPendingApprovalRoute } from '../support/uc03/controlled-route.ts';

const digest = (seed: string): string => sha256Text(seed);

/* ------------------------------------------------------------------
 * Host binding and driver
 * ------------------------------------------------------------------ */

function catalogEntryFor(caseId: string, task: { initialRevisionDigest: string }, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    catalogEntryId: `entry-${caseId}`,
    caseId,
    version: '1.0.0',
    caseDigest: digest(`case-${caseId}`),
    publicTaskDigest: digest(`task-${caseId}`),
    initialRepositoryDigest: task.initialRevisionDigest,
    fixturePath: 'C:/host-only/fixture.json',
    fixtureDigest: digest(`fixture-${caseId}`),
    grader: { version: '1.0.0', digest: digest(`grader-${caseId}`), path: 'C:/host-only/grader.json' },
    ...overrides,
  };
}

const HOST_OPTIONS = {
  profileDigest: digest('profile'),
  configDigest: digest('config'),
  pricingDigest: digest('pricing'),
  adapterVersions: ['uc03-adapter-1'],
  requestedModel: 'deepseek-v4.1',
} as const;

interface CliOutput {
  readonly exitCode: number;
  readonly selectionResult: { readonly outcome: string; readonly passed: number; readonly failed: number; readonly incomplete: number; readonly pendingWaits: readonly string[] };
  readonly suiteAcceptance: { readonly scope: string; readonly requiredCases: number; readonly satisfiedCases: number; readonly outcome: string };
  readonly cases: readonly { readonly caseId: string; readonly grade: string; readonly gradeReason: string; readonly taskId: string | null; readonly workflowOutcome: string }[];
  readonly limitations: readonly string[];
  readonly mode: string;
  readonly tier: string;
  readonly isRealVerified: boolean;
}

function parseOutput(output: string): CliOutput {
  const json = output.slice(0, output.indexOf('\nUC-03 Workflow Evaluation'));
  return JSON.parse(json) as CliOutput;
}

test('C02 expected wait: exit 0 and a selected pass while the suite stays incomplete over 17 required cases', async () => {
  const route = createPendingApprovalRoute();
  const needsInfoTask = { ...route.task, reproduction: '' };
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C02', route.task), task: needsInfoTask, ports: route.ports, expectedWait: 'waiting-info', config: route.config };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C02'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C02', host]])) });
  const report = parseOutput(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(report.mode, 'mock');
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
  assert.equal(report.selectionResult.outcome, 'pass');
  assert.equal(report.selectionResult.passed, 1);
  // The decisive pair: the case passed, the catalog did not.
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 1, outcome: 'incomplete' });
  const [observed] = report.cases;
  assert.ok(observed);
  assert.equal(observed.caseId, 'C02');
  assert.equal(observed.grade, 'pass');
  assert.equal(observed.gradeReason, 'expected-wait-satisfied');
  assert.equal(observed.workflowOutcome, 'waiting-info');
  // Pause proof: a needs-info intake allocates no task.
  assert.equal(observed.taskId, null);
  assert.match(result.output, /UC-03 Workflow Evaluation \[MOCK\]: Selected = pass, Suite = incomplete, ExitCode = 0/);
  assert.equal(result.output.includes('C:/host-only'), false);
});

test('C01 unresolved wait: exit 3 with the case pending in the catalog suite', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C01', route.task), task: route.task, ports: route.ports, expectedWait: null, config: route.config };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C01', host]])) });
  const report = parseOutput(result.output);

  assert.equal(result.exitCode, 3);
  assert.equal(report.selectionResult.outcome, 'incomplete');
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
  assert.equal(report.cases[0]?.grade, 'not-run');
  assert.equal(report.cases[0]?.gradeReason, 'unresolved-wait');
  assert.equal(report.cases[0]?.workflowOutcome, 'waiting-approval');
  assert.equal(report.suiteAcceptance.outcome, 'incomplete');
  assert.equal(report.suiteAcceptance.satisfiedCases, 0);
  assert.match(result.output, /ExitCode = 3/);
});

/** A blocked precondition was never dispatched, so it is ungraded (not-run), never a pass. */
test('blocked driver entry never grades as a pass and never leaks a host path', async () => {
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = {
    entry: catalogEntryFor('C01', route.task, { caseDigest: 'not-a-digest' }),
    task: route.task,
    ports: route.ports,
    expectedWait: null,
    config: route.config,
  };

  const result = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C01', host]])) });

  assert.equal(result.output.includes('C:/host-only'), false);
  assert.equal(result.output.includes('EVALUATION_REFUSED'), false);
  assert.equal(result.exitCode, 4);
  const report = parseOutput(result.output);
  assert.equal(report.cases[0]?.grade, 'not-run');
  assert.equal(report.cases[0]?.gradeReason, 'prerequisite-unavailable');
  assert.equal(report.selectionResult.outcome, 'incomplete');
});

test('host binding digests reach the report unchanged; no real-tier claim is made', async () => {
  const route = createPendingApprovalRoute();
  const needsInfoTask = { ...route.task, reproduction: '' };
  const host: WorkflowCaseHost = { entry: catalogEntryFor('C02', route.task), task: needsInfoTask, ports: route.ports, expectedWait: 'waiting-info', config: route.config };

  const result = await runEvaluateCli(['--cases', 'C02'], { ...HOST_OPTIONS, driver: createWorkflowDriver(new Map([['C02', host]])) });
  const report = parseOutput(result.output) as CliOutput & { readonly configDigest: string };

  assert.equal(result.exitCode, 0);
  assert.equal(report.mode, 'mock');
  assert.equal(report.configDigest, HOST_OPTIONS.configDigest);
  assert.equal(report.isRealVerified, false);
});
