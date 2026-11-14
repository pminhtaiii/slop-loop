/**
 * UC-03 workflow evaluation report v1 (`uc03-workflow-evaluation/1`).
 * Owned path: tests/runtime/unit/evaluation-report-v1.test.ts
 *
 * Requirements & Acceptance:
 * - Tagged report: `contractVersion` discriminates workflow from legacy/shared without widening either.
 * - Selected vs suite acceptance: a passing selection never claims catalog acceptance.
 * - Waiting is non-terminal: an expected wait passes the case while the task stays paused.
 * - An unresolved wait stays pending (not-run) and reports exit 3.
 * - Effects and usage are observed/uncertain/unavailable, never inferred.
 * - Real tier needs an internally issued capability receipt bound to this run; forged copies are denied pre-dispatch.
 * - Exploratory scope grades nothing and claims no acceptance.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueRealExecutionAdmission,
  isAdmittedRealExecutionAdmission,
  runEvaluation,
  validateWorkflowEvaluationOptions,
  validateWorkflowEvaluationReport,
  validateWorkflowObservation,
  type EvaluationCaseSpec,
  type WorkflowCaseContext,
  type WorkflowEvaluationOptions,
  type WorkflowObservation,
} from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION } from '../../../eval/uc03/types.ts';

const DIGEST = 'a'.repeat(64);

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
    graderDigest: null,
    initialRepositoryDigest: null,
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

/** Driver observing a fixed workflow per case; records dispatch so refusals can be proven before any effect. */
function driver(byCase: (spec: EvaluationCaseSpec, context: WorkflowCaseContext) => WorkflowObservation): {
  calls: string[];
  executeCase: (spec: EvaluationCaseSpec, context: WorkflowCaseContext) => WorkflowObservation;
} {
  const calls: string[] = [];
  return {
    calls,
    executeCase: (spec, context) => {
      calls.push(spec.caseId);
      return byCase(spec, context);
    },
  };
}

test('workflow report is tag-discriminated from legacy and shared reports', async () => {
  const report = await runEvaluation(options());
  assert.equal(report.contractVersion, WORKFLOW_EVALUATION_VERSION);
  assert.ok('selectionResult' in report && 'suiteAcceptance' in report);
  assert.ok(!('verdict' in report) && !('summary' in report));

  const legacy = await runEvaluation({ mode: 'mock' });
  assert.equal(legacy.contractVersion, '0.1.0');
  assert.ok('verdict' in legacy && 'summary' in legacy);

  await assert.rejects(runEvaluation({ ...options(), mode: 'undecided' }));
});

test('expected wait passes its case while the selected result stays passing and the suite is not claimed', async () => {
  // C02's pinned predicate is INCOMPLETE; an expected waiting-info pause satisfies it without completing the task.
  const fake = driver(spec =>
    spec.caseId === 'C02'
      ? observation({
          workflowOutcome: 'waiting-info',
          expectedWait: 'waiting-info',
          taskId: 'task-2',
          runId: 'run-2',
          effects: 'observed',
          usage: 'uncertain',
          limitations: ['Task remains paused awaiting information.'],
        })
      : observation(),
  );
  const report = await runEvaluation(options({ driver: fake }));
  assert.deepEqual(fake.calls, ['C01', 'C02']);

  const c02 = report.cases.find(item => item.caseId === 'C02');
  assert.equal(c02?.grade, 'pass');
  assert.equal(c02?.gradeReason, 'expected-wait-satisfied');
  assert.equal(c02?.workflowOutcome, 'waiting-info');
  assert.equal(c02?.usage, 'uncertain');
  assert.deepEqual(report.selectionResult, { selected: ['C01', 'C02'], passed: 2, failed: 0, incomplete: 0, pendingWaits: [], outcome: 'pass' });
  assert.equal(report.exitCode, 0);
  // Selected pass is not catalog acceptance: 15 required cases were never run.
  assert.deepEqual(report.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 2, outcome: 'incomplete' });
});

test('an unresolved wait stays pending instead of failing and exits 3', async () => {
  const fake = driver(spec => (spec.caseId === 'C01' ? observation({ workflowOutcome: 'waiting-approval' }) : observation({ workflowOutcome: 'INCOMPLETE', taskId: 'task-2', runId: 'run-2' })));
  const report = await runEvaluation(options({ driver: fake }));

  const c01 = report.cases.find(item => item.caseId === 'C01');
  assert.equal(c01?.grade, 'not-run');
  assert.equal(c01?.gradeReason, 'unresolved-wait');
  assert.deepEqual(report.selectionResult.pendingWaits, ['C01']);
  assert.equal(report.selectionResult.outcome, 'incomplete');
  assert.equal(report.exitCode, 3);
  assert.equal(report.suiteAcceptance.outcome, 'incomplete');
});

test('effects and usage stay observed, uncertain or unavailable and are never inferred from a failure', async () => {
  const fake = driver(spec =>
    spec.caseId === 'C01'
      ? observation({ workflowOutcome: 'FAILED', effects: 'uncertain', usage: 'unavailable' })
      : observation({ taskId: 'task-2', runId: 'run-2', effects: 'observed', usage: 'observed' }),
  );
  const report = await runEvaluation(options({ driver: fake }));
  const [c01, c02] = report.cases;
  assert.equal(c01?.grade, 'fail');
  assert.equal(c01?.gradeReason, 'criteria-violation');
  assert.equal(c01?.effects, 'uncertain');
  assert.equal(c01?.usage, 'unavailable');
  assert.equal(c02?.effects, 'observed');

  // Unselected cases and a missing driver are explicit not-run facts, never fabricated observations.
  const unselected = await runEvaluation(options({ cases: ['C01'] }));
  assert.deepEqual(unselected.selectionResult.selected, ['C01']);
  assert.equal(unselected.cases[0]?.gradeReason, 'driver-unavailable');
  assert.equal(unselected.cases[0]?.usage, 'unavailable');
  assert.equal(unselected.cases[0]?.effects, 'none');
});

test('real tier is admitted only by an internally issued receipt bound to this run', async () => {
  const binding = { profileDigest: DIGEST, configDigest: DIGEST, pricingDigest: DIGEST, adapterVersions: ['mock-adapter-v1'], caseIds: ['C01'], requestedModel: 'mock-model-v1' };
  const receipt = issueRealExecutionAdmission(binding);
  assert.equal(isAdmittedRealExecutionAdmission(receipt, binding), true);
  assert.equal(isAdmittedRealExecutionAdmission({ ...receipt }, binding), false, 'a spread copy is not the issued object');
  assert.equal(isAdmittedRealExecutionAdmission(receipt, { ...binding, caseIds: ['C02'] }), false, 'a receipt is void for another binding');

  // Forged and copied receipts are denied before dispatch, so the driver is never called.
  for (const forged of [{ admissionId: receipt.admissionId, profileDigest: DIGEST, bindingDigest: receipt.bindingDigest }, { ...receipt }]) {
    const fake = driver(() => observation());
    const refused = await runEvaluation(options({ mode: 'real', cases: ['C01'], realAdmission: forged, driver: fake }));
    assert.deepEqual(fake.calls, []);
    assert.equal(refused.tier, 'real-integration');
    assert.equal(refused.cases[0]?.gradeReason, 'real-execution-unavailable');
    assert.equal(refused.isRealVerified, false);
  }

  // Even a valid receipt does not admit a different run binding.
  const fake = driver(() => observation());
  const wrongRun = await runEvaluation(options({ mode: 'real', cases: ['C02'], realAdmission: receipt, driver: fake }));
  assert.deepEqual(fake.calls, []);
  assert.equal(wrongRun.cases[0]?.gradeReason, 'real-execution-unavailable');

  // The issued receipt bound to this exact run is the only thing that reaches dispatch. Admission alone is
  // not grading evidence: a real-tier case without an independent snapshot grade stays not-run.
  const admitted = driver(() => observation());
  const allowed = await runEvaluation(options({ mode: 'real', cases: ['C01'], realAdmission: receipt, driver: admitted }));
  assert.deepEqual(admitted.calls, ['C01']);
  assert.equal(allowed.cases[0]?.grade, 'not-run');
  assert.equal(allowed.cases[0]?.gradeReason, 'private-grading');
  assert.equal(allowed.isRealVerified, false);
  assert.deepEqual(allowed.suiteAcceptance, { scope: 'catalog', requiredCases: 17, satisfiedCases: 0, outcome: 'incomplete' });
});

test('exploratory scope grades nothing and claims no suite acceptance', async () => {
  const fake = driver(() => observation());
  const report = await runEvaluation(options({ scope: 'exploratory', driver: fake }));
  assert.deepEqual(fake.calls, []);
  assert.ok(report.cases.every(item => item.grade === 'not-run' && item.gradeReason === 'unpinned-criteria'));
  assert.deepEqual(report.suiteAcceptance, { scope: 'exploratory', requiredCases: 0, satisfiedCases: 0, outcome: 'not-applicable' });
  assert.equal(report.exitCode, 1);
});

test('report and observation validation reject inconsistent or widened payloads', async () => {
  const report = await runEvaluation(options({ cases: ['C01'], driver: driver(() => observation()) }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...report, exitCode: 1 }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...report, selectionResult: { ...report.selectionResult, passed: 17 } }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...report, isRealVerified: true }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...report, contractVersion: 'uc03-workflow-evaluation/2' }));
  // Ports, credentials and grader payloads are rejected by exact-key enumeration.
  assert.throws(() => validateWorkflowObservation({ ...observation(), port: 8080 }));
  assert.throws(() => validateWorkflowEvaluationOptions({ ...options(), extra: true }));
  // Exploratory real runs would pin nothing to admit.
  assert.throws(() => validateWorkflowEvaluationOptions({ ...options(), scope: 'exploratory', mode: 'real' }));
});
