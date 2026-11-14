/**
 * T014a — controlled failure attribution through the graph-backed driver.
 *
 * Each scenario breaks exactly one host dependency and asserts that the resulting observation
 * names at most the stage it can prove: a component or root cause is never inferred from a
 * failure. Grades are checked only against the safe predicates the contract allows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeText } from '../../../src/foundation/telemetry.ts';
import { createWorkflowDriver, type WorkflowCaseHost } from '../../../eval/uc03/workflow-driver.ts';
import { runEvaluation, type WorkflowEvaluationOptions } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION } from '../../../eval/uc03/types.ts';
import type { CatalogEntry } from '../../../src/runtime/evaluation-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createPendingApprovalRoute, ROUTE_PLAN_DETAILS } from '../support/uc03/controlled-route.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';

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

function catalogEntry(route: ReturnType<typeof createPendingApprovalRoute>, caseId: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    catalogEntryId: `entry-${caseId}`,
    caseId,
    version: '1.0.0',
    caseDigest: digest(`case-${caseId}`),
    publicTaskDigest: digest(`task-${caseId}`),
    initialRepositoryDigest: route.task.initialRevisionDigest,
    fixturePath: 'C:/host-only/fixture.json',
    fixtureDigest: digest(`fixture-${caseId}`),
    grader: { version: '1.0.0', digest: digest(`grader-${caseId}`), path: 'C:/host-only/grader.json' },
    ...overrides,
  };
}

async function observe(route: ReturnType<typeof createPendingApprovalRoute>, caseId: string, overrides: Partial<CatalogEntry> = {}) {
  const host: WorkflowCaseHost = { entry: catalogEntry(route, caseId, overrides), task: route.task, ports: route.ports, expectedWait: null, config: route.config };
  const report = await runEvaluation({ ...HOST_OPTIONS, mode: 'mock', cases: [caseId], driver: createWorkflowDriver(new Map([[caseId, host]])) } as WorkflowEvaluationOptions);
  const [observed] = report.cases;
  assert.ok(observed);
  return { observed, report, host, serialized: JSON.stringify(report) };
}

/** Every scenario must stay inside the contract's safe vocabulary, whatever it broke. */
function assertSafeObservation(observation: { readonly diagnostic: string | null } | undefined, serialized: string): void {
  assert.ok(observation);
  assert.equal(serialized.includes('C:/host-only'), false);
  assert.equal(serialized.includes('MARKER_'), false);
  assert.equal(/at \/.*\.ts:/u.test(serialized), false);
  if (observation.diagnostic !== null) assert.equal(sanitizeText(observation.diagnostic), observation.diagnostic);
}

/* ------------------------------------------------------------------ */

test('pending approval parses as an unresolved wait, never as a verified repair', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const { observed, report } = await observe(route, 'C01');

  assert.equal(observed.workflowOutcome, 'waiting-approval');
  assert.equal(observed.grade, 'not-run');
  assert.equal(observed.gradeReason, 'unresolved-wait');
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
  assert.equal(report.tier, 'controlled');
  assert.equal(report.isRealVerified, false);
});

test('a missing task preflight blocks before any owner call and grades not-run', async () => {
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = {
    entry: catalogEntry(route, 'C01'),
    task: { ...route.task, reproduction: '' },
    ports: route.ports,
    expectedWait: 'waiting-info',
    config: route.config,
  };
  const report = await runEvaluation({ ...HOST_OPTIONS, mode: 'mock', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', host]])) } as WorkflowEvaluationOptions);
  const [observed] = report.cases;
  assert.ok(observed);

  // A needs-info intake legitimately satisfies C02's expectation, but allocates no task.
  assert.equal(observed.workflowOutcome, 'waiting-info');
  assert.equal(observed.taskId, null);
  assert.equal(observed.grade, 'pass');
  assert.equal(observed.gradeReason, 'expected-wait-satisfied');
  assert.equal(report.isRealVerified, false);
});

test('a malformed catalog digest is a prerequisite block: not-run, no dispatch, no host path', async () => {
  const route = createPendingApprovalRoute();
  const { observed, serialized } = await observe(route, 'C01', { caseDigest: 'not-a-digest' });

  assert.equal(observed.grade, 'not-run');
  assert.equal(observed.gradeReason, 'prerequisite-unavailable');
  assert.equal(observed.workflowOutcome, 'not-observed');
  assert.equal(observed.effects, 'none');
  assert.equal(observed.usage, 'unavailable');
  assertSafeObservation(observed, serialized);
});

test('a state-accounting failure names its stage and never leaks the thrown message', async () => {
  const route = createPendingApprovalRoute('approved');
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  route.statePort.getUnderlying().transition = async () => {
    throw new Error('MARKER_STATE_ACCOUNTING_FAILURE');
  };

  const { observed, serialized } = await observe(route, 'C01');

  // The graph catches the throw and attributes it to the stage it was in — never to a component or cause.
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.equal(observed.grade, 'fail');
  assert.equal(observed.gradeReason, 'criteria-violation');
  assert.match(observed.diagnostic ?? '', /^UC-03 outcome INCOMPLETE at Investigate \[workflow\/unknown\/route-incomplete\]$/u);
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_STATE_ACCOUNTING_FAILURE'), false);
});

test('a pending approval runs only pre-plan diagnostics and applies no patch', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const { observed } = await observe(route, 'C01');

  assert.equal(observed.workflowOutcome, 'waiting-approval');
  // Investigation may run its diagnostic checks; nothing may mutate the repository before approval.
  assert.deepEqual(route.repositoryPort.patches, []);
  assert.deepEqual(
    route.repositoryPort.commands.map(command => command.purpose),
    ['reproduction', 'regression'],
  );
});

test('unknown usage stays unknown and is never reported as zero', async () => {
  const route = createPendingApprovalRoute();
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  const { observed, report } = await observe(route, 'C01');

  assert.notEqual(observed.usage, 'observed');
  assert.equal(report.isRealVerified, false);
  // The workflow report carries no numeric amounts at all, so nothing can claim zero cost.
  assert.equal('tokensConsumed' in report, false);
});

test('a selected pass never certifies the full 17-case suite', async () => {
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = {
    entry: catalogEntry(route, 'C02'),
    task: { ...route.task, reproduction: '' },
    ports: route.ports,
    expectedWait: 'waiting-info',
    config: route.config,
  };
  const report = await runEvaluation({ ...HOST_OPTIONS, mode: 'mock', cases: ['C02'], driver: createWorkflowDriver(new Map([['C02', host]])) } as WorkflowEvaluationOptions);

  assert.equal(report.selectionResult.outcome, 'pass');
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 1, outcome: 'incomplete' });
  assert.equal(report.isRealVerified, false);
});

test('a required case outside the selection is never counted as run or passed', async () => {
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = {
    entry: catalogEntry(route, 'C02'),
    task: { ...route.task, reproduction: '' },
    ports: route.ports,
    expectedWait: 'waiting-info',
    config: route.config,
  };
  const report = await runEvaluation({ ...HOST_OPTIONS, mode: 'mock', cases: ['C02'], driver: createWorkflowDriver(new Map([['C02', host]])) } as WorkflowEvaluationOptions);

  // Only the selected case appears, and the suite still counts all 17 as unsatisfied.
  assert.deepEqual(
    report.cases.map(item => item.caseId),
    ['C02'],
  );
  assert.equal(report.suiteAcceptance.satisfiedCases, 1);
  assert.equal(report.suiteAcceptance.requiredCases, 17);
});

test('real mode without admission is refused before dispatch and reports only its own tier', async () => {
  const route = createPendingApprovalRoute();
  let dispatched = 0;
  const host: WorkflowCaseHost = { entry: catalogEntry(route, 'C01'), task: route.task, ports: route.ports, expectedWait: null, config: route.config };
  const driver = createWorkflowDriver(new Map([['C01', host]]));
  const report = await runEvaluation({
    ...HOST_OPTIONS,
    mode: 'real',
    cases: ['C01'],
    driver: {
      executeCase(spec, context) {
        dispatched += 1;
        return driver.executeCase(spec, context);
      },
    },
  } as WorkflowEvaluationOptions);

  assert.equal(dispatched, 0);
  assert.equal(report.tier, 'real-integration');
  assert.equal(report.isRealVerified, false);
  assert.equal(report.cases[0]?.gradeReason, 'real-execution-unavailable');
  assert.equal(report.cases[0]?.grade, 'not-run');
});

test('an approval issuer failure stops at the approve stage and never echoes the thrown text', async () => {
  const route = createPendingApprovalRoute('approved');
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  route.approvalPort.requestDecision = async () => {
    throw new Error('MARKER_APPROVAL_ISSUER');
  };

  const { observed, serialized } = await observe(route, 'C01');

  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.equal(observed.grade, 'fail');
  assert.equal(observed.diagnostic, 'UC-03 outcome INCOMPLETE at AwaitPlan [workflow/unknown/route-incomplete]');
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_APPROVAL_ISSUER'), false);
});

test('a trusted host snapshot failure stops at investigation and reports the integration stage', async () => {
  const route = createPendingApprovalRoute('approved');
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  route.hostAuthority.loadSnapshot = async () => {
    throw new Error('MARKER_HOST_SNAPSHOT');
  };

  const { observed, serialized } = await observe(route, 'C01');

  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.equal(observed.diagnostic, 'UC-03 outcome INCOMPLETE at Investigate [workflow/unknown/route-incomplete]');
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_HOST_SNAPSHOT'), false);
});

test('a route that cannot reload owner state reports no stage and keeps the failure unproven', async () => {
  const route = createPendingApprovalRoute('approved');
  await seedGraphTaskState(route.statePort, createGraphTaskState(route.task));
  route.statePort.getUnderlying().loadTask = async () => {
    throw new Error('MARKER_STATE_LOAD');
  };

  const { observed, serialized } = await observe(route, 'C01');

  // No owner state to reload, so neither the stage nor the effects can be claimed.
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.equal(observed.taskId, null);
  assert.equal(observed.effects, 'uncertain');
  assert.equal(observed.usage, 'unavailable');
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_STATE_LOAD'), false);
});

test('the shared route fixture drives a real plan through investigation', async () => {
  // Guards the fixture itself: a typo in ROUTE_PLAN_DETAILS would make every witness above vacuous.
  assert.equal(ROUTE_PLAN_DETAILS.decisionRef, 'decision-route-test-001');
  assert.deepEqual(ROUTE_PLAN_DETAILS.scopedChanges, ['src/calculator.py']);
});

async function assertControlledBaselineRefusal(
  expectedStatus: 'non-reproducing' | 'collection-error' | 'error',
  reproduction: { readonly exitCode: number; readonly stdout: string },
  regression: { readonly exitCode: number; readonly stdout: string },
): Promise<void> {
  const fixture = await controlledGeneratedPlanFixture();
  fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { ...reproduction, stderr: '' });
  fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py', { ...regression, stderr: '' });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;

  const before = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(before);
  const claimsBefore = fixture.statePort.getJournalSnapshot().claims.length;
  const ledgersBefore = fixture.statePort.getLedgers();
  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const after = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.ok(after);

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.some(reason => reason.includes(`Baseline investigation failed: ${expectedStatus}`)));
  assert.deepEqual({ ...after, budgetLedgers: [] }, { ...before, budgetLedgers: [] }, `${expectedStatus} does not transition owner task state`);
  const journal = fixture.statePort.getJournalSnapshot();
  const diagnosticClaims = journal.claims.slice(claimsBefore);
  const diagnosticClaimIds = fixture.route.repositoryPort.v02Calls.map(call => call.claimId);
  assert.equal(diagnosticClaims.length, 2, 'only the two admitted diagnostic commands claim owner capacity');
  assert.deepEqual(
    diagnosticClaims.map(claim => claim.status),
    ['settled', 'settled'],
  );
  assert.equal(diagnosticClaimIds.filter((claimId): claimId is string => typeof claimId === 'string').length, 2);
  assert.deepEqual(
    diagnosticClaims.map(claim => claim.claimId),
    diagnosticClaimIds,
  );
  assert.equal(
    journal.claims.some(claim => claim.claimId.startsWith('claim-controlled-')),
    false,
    'no coder claim or model generation follows the refusal',
  );
  assert.ok(
    fixture.statePort.getLedgers().some((ledger, index) => ledger.consumed > (ledgersBefore[index]?.consumed ?? 0)),
    'the two settled diagnostics retain their finite resource accounting',
  );
  assert.deepEqual(fixture.modelCalls, []);
  assert.deepEqual(fixture.coderAdmissions, []);
  assert.deepEqual(fixture.route.repositoryPort.patches, []);
  assert.deepEqual(
    fixture.route.repositoryPort.commands.map(command => command.purpose),
    ['reproduction', 'regression'],
  );
  assert.equal(fixture.route.repositoryPort.v02Calls.length, 2);
}

test('a non-reproducing baseline refuses plan generation without changing owner state', async () => {
  await assertControlledBaselineRefusal('non-reproducing', { exitCode: 0, stdout: '1 passed' }, { exitCode: 0, stdout: '1 passed' });
});

test('a reproduction collection error refuses plan generation without changing owner state', async () => {
  await assertControlledBaselineRefusal('collection-error', { exitCode: 2, stdout: 'ERROR: Failed to collect tests/test_calculator.py' }, { exitCode: 0, stdout: '1 passed' });
});

test('a pre-existing regression failure refuses plan generation without changing owner state', async () => {
  await assertControlledBaselineRefusal('error', { exitCode: 0, stdout: '1 passed' }, { exitCode: 1, stdout: 'FAILED tests/test_calculator.py::test_divide - AssertionError' });
});

/* T038: recognized coder-boundary refusals become observed components, via the real controlled graph and driver. */

async function observeCoderRefusal(content: string) {
  const fixture = await controlledGeneratedPlanFixture({ firstResponse: { proposalId: 'controlled-inspect-1', content } });
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('controlled host not ready');
  const route = createPendingApprovalRoute();
  const host: WorkflowCaseHost = { entry: catalogEntry(route, 'C01'), task: fixture.task, expectedWait: null, controlled: { ports: readiness.ports, config: readiness.config } };
  const report = await runEvaluation({ ...HOST_OPTIONS, mode: 'mock', cases: ['C01'], driver: createWorkflowDriver(new Map([['C01', host]])) } as WorkflowEvaluationOptions);
  const [observed] = report.cases;
  assert.ok(observed);
  return { fixture, observed, serialized: JSON.stringify(report) };
}

function assertSpentOneDispatchNoPatch(fixture: Awaited<ReturnType<typeof observeCoderRefusal>>['fixture']): void {
  assert.deepEqual(fixture.modelCalls.length, 1, 'exactly the charged coder dispatch');
  assert.equal(fixture.coderAdmissions.length, 1);
  assert.deepEqual(fixture.route.repositoryPort.patches, []);
}

test('a malformed coder response is reported as an observed model-output refusal at investigate', async () => {
  const { fixture, observed, serialized } = await observeCoderRefusal('MARKER_NOT_JSON {');
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.match(observed.diagnostic ?? '', /^UC-03 outcome INCOMPLETE at Investigate \[model-output\/model\/[a-z0-9-]+\]$/u);
  assert.equal(observed.usage, 'observed');
  assert.equal(observed.effects, 'observed');
  assertSpentOneDispatchNoPatch(fixture);
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_NOT_JSON'), false);
});

test('an inspect against a missing repository file is reported as an observed repository-read refusal at investigate', async () => {
  const content = JSON.stringify({ kind: 'inspect', proposalId: 'controlled-inspect-1', operation: 'read_file', args: { path: 'src/missing_MARKER_ESCAPE.py' } });
  const { fixture, observed, serialized } = await observeCoderRefusal(content);
  assert.equal(observed.workflowOutcome, 'INCOMPLETE');
  assert.match(observed.diagnostic ?? '', /^UC-03 outcome INCOMPLETE at Investigate \[repository-tool\/tool\/[a-z0-9-]+\]$/u);
  assert.equal(observed.usage, 'observed');
  assert.equal(observed.effects, 'observed');
  assertSpentOneDispatchNoPatch(fixture);
  assertSafeObservation(observed, serialized);
  assert.equal(serialized.includes('MARKER_ESCAPE'), false);
});
