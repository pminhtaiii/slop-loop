/**
 * UC-03 Verified Code Repair - Unit Tests for Sanitized Milestone & Final Reporting
 *
 * Owned path: tests/runtime/unit/uc03-report.test.ts
 * Feature: specs/001-verified-code-repair
 * Task: T023 (sanitized milestone and final reporting)
 *
 * Requirements & Acceptance:
 * - C16: Milestones and final report exclude prompts, streams, secrets, and raw reasoning;
 *   per-run and task-level usage/cost retained; bounded redacted diagnostics.
 * - FR-010: Protect credentials, secrets, and harness boundaries from reporting leak.
 * - FR-012: Provide milestone activity and final diff with actual outcome, baseline/check/review
 *   evidence, limitations, and safe next action.
 * - SC-002: Zero unverified or drifted modifications claim COMPLETED status.
 * - SC-004: Every delivered fix links baseline, final checks, review, and diff evidence.
 * - SC-005: Milestone and final reports pass protected-data checks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  CONTRACT_VERSION,
  validateActivityEvent,
  validateDelivery,
  type BugTask,
  type TaskState,
  type Baseline,
  type VerificationResult,
  type ReviewResult,
  type CheckDefinition,
  type FixPlan,
  type BudgetLedger,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  createMilestone,
  milestoneToActivityEvent,
  buildFinalReport,
  formatReportMarkdown,
  formatMilestonesSummary,
  type Milestone,
  type BuildFinalReportInput,
} from '../../../src/uc03/report.ts';
import type { TrustedReviewRecord, CompletionPredicateInput } from '../../../src/uc03/verification.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
} from '../support/uc03/port-fixtures.ts';

function createValidReportingFixture(): CompletionPredicateInput {
  const repoDigest =
    'sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000';
  const diffDigest =
    'sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';
  const protectedDigest = computeCanonicalSha256(
    'protected:tests/test_calculator.py'
  );

  const checkReproduction: CheckDefinition = {
    checkId: 'check-pytest-reproduction',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const checkRegression: CheckDefinition = {
    checkId: 'check-pytest-regression',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'regression',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };

  const task: BugTask = createFixtureBugTask({
    taskId: 'task-uc03-calc-001',
    repositoryId: 'repo-uc03-calc',
    requiredChecks: [checkReproduction, checkRegression],
  });

  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);

  const baseline: Baseline = {
    evidenceId: 'baseline-calc-001',
    repositorySnapshotDigest: task.initialRevisionDigest,
    checkSetDigest,
    reproductionFailureSignature: 'ZeroDivisionError: division by zero',
    checkResults: [
      { checkId: 'check-pytest-reproduction', outcome: 'fail', durationMs: 40 },
      { checkId: 'check-pytest-regression', outcome: 'pass', durationMs: 55 },
    ],
    testProtectionDigest: protectedDigest,
  };

  const planStrategy =
    'Add guard check in Calculator.divide to raise CalculationError on zero denominator';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis:
      'Calculator.divide raises unhandled ZeroDivisionError when denominator is zero',
    suspectedCauseLocations: ['src/calculator.py:12'],
    evidenceRefs: [baseline.evidenceId],
    strategy: planStrategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest,
    baselineRef: baseline.evidenceId,
    strategyDigest: computeCanonicalSha256(planStrategy),
    decisionRef: 'dec-calc-001',
  };

  const ledgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 100000,
      consumed: 12500,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 5.0,
      consumed: 0.25,
      reservations: [],
      unit: 'usd',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'tokens',
      limit: 50000,
      consumed: 12500,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'cost',
      limit: 2.0,
      consumed: 0.25,
      reservations: [],
      unit: 'usd',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'replan',
      limit: 3,
      consumed: 1,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
  ];

  const state: TaskState = {
    ...createFixtureTaskState(),
    schemaVersion: CONTRACT_VERSION,
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: repoDigest,
    requiredCheckIds: task.requiredChecks.map((c) => c.checkId),
    taskContext: task,
    node: 'Review',
    planVersion: 1,
    plan,
    replanCount: 1,
    changedPaths: ['src/calculator.py'],
    evidenceRefs: [baseline.evidenceId],
    budgetLedgers: ledgers,
    activeDecisionId: 'dec-calc-001',
    latestReviewRef: 'review-calc-001',
    reviewRefs: ['review-calc-001'],
  };

  const verificationResults: readonly VerificationResult[] = [
    {
      evidenceId: 'verif-focused-001',
      taskId: task.taskId,
      runId: state.runId,
      actionId: 'action-pytest-focused',
      phase: 'focused',
      repoDigest,
      diffDigest,
      commandIdentity: 'pytest -q tests/test_calculator.py -k test_divide_zero',
      outcome: 'pass',
      testedIds: ['check-pytest-reproduction'],
      diagnosticRefs: [],
    },
    {
      evidenceId: 'verif-regression-001',
      taskId: task.taskId,
      runId: state.runId,
      actionId: 'action-pytest-regression',
      phase: 'regression',
      repoDigest,
      diffDigest,
      commandIdentity: 'pytest -q tests/test_calculator.py',
      outcome: 'pass',
      testedIds: ['check-pytest-regression'],
      diagnosticRefs: [],
    },
  ];

  const reviewResult: ReviewResult = {
    reviewId: 'review-calc-001',
    reviewerRoleConfigId: 'reviewer-config-v1',
    repoDigest,
    diffDigest,
    checkSetDigest,
    status: 'accepted',
    findings: [],
    iterationReservationRef: 'res-rev-001',
  };

  const trustedReviewRecord: TrustedReviewRecord = {
    reviewId: reviewResult.reviewId,
    reviewerRoleConfigId: reviewResult.reviewerRoleConfigId,
    iterationReservationRef: reviewResult.iterationReservationRef,
    repoDigest,
    diffDigest,
    checkSetDigest,
    status: 'accepted',
  };

  return {
    task,
    state,
    baseline,
    verificationResults,
    reviewResult,
    currentRepoDigest: repoDigest,
    currentDiffDigest: diffDigest,
    changedFiles: ['src/calculator.py'],
    originalProtectedTestsDigest: protectedDigest,
    currentProtectedTestsDigest: protectedDigest,
    authorizedDiffDigest: diffDigest,
    trustedReviewRecord,
  };
}

/* ==================================================================
 * Section 1: Milestone Creation and Sanitization (C16)
 * ================================================================== */

test('milestone: creates valid milestone with sanitized summary and metadata', () => {
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Investigate',
    kind: 'investigation_completed',
    summary: 'Investigation reproduced bug with status code 500',
    outcome: 'success',
    evidenceRefs: ['evidence-001'],
  });

  assert.equal(milestone.taskId, 'task-001');
  assert.equal(milestone.runId, 'run-001');
  assert.equal(milestone.node, 'Investigate');
  assert.equal(milestone.kind, 'investigation_completed');
  assert.equal(milestone.summary, 'Investigation reproduced bug with status code 500');
  assert.equal(milestone.outcome, 'success');
  assert.deepEqual(milestone.evidenceRefs, ['evidence-001']);
  assert.ok(milestone.milestoneId.startsWith('ms-'));
  assert.ok(Date.parse(milestone.timestamp) > 0);
});

test('milestone: sanitizes secrets in summary using builtin secret patterns', () => {
  const secretKey = 'sk-123456789012345678901234567890';
  const marker = 'MARKER_SECRET_AUTH_TOKEN_99';
  const rawSummary = `Reproduced with api_key: "${secretKey}" and header ${marker}`;

  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Validate',
    kind: 'task_started',
    summary: rawSummary,
  });

  assert.ok(!milestone.summary.includes(secretKey), 'secret key must be redacted');
  assert.ok(!milestone.summary.includes(marker), 'marker secret must be redacted');
  assert.ok(milestone.summary.includes('[REDACTED]'), 'redacted placeholder must appear');
});

test('milestone: sanitizes custom secret patterns in summary', () => {
  const customSecret = 'SUPER_INTERNAL_PASSWORD_XYZ';
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Repair',
    kind: 'patch_applied',
    summary: `Applied patch with credential ${customSecret}`,
    customSecretPatterns: [customSecret],
  });

  assert.ok(!milestone.summary.includes(customSecret));
  assert.ok(milestone.summary.includes('[REDACTED]'));
});

test('milestone: strips forbidden raw reasoning, prompts, and streams from details', () => {
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Investigate',
    kind: 'plan_proposed',
    summary: 'Plan proposed for calculator divide fix',
    details: {
      strategyName: 'defensive-guard',
      rawReasoning: 'Internal model reasoning: I think the user wants us to bypass security...',
      thinking: 'Deep chain-of-thought tokens here...',
      prompt: 'System: You are an expert programmer...',
      stream: 'Chunk 1, Chunk 2, raw token stream...',
      safeNote: 'Valid note about diagnosis',
    },
  });

  assert.ok(milestone.details !== undefined);
  assert.equal(milestone.details.strategyName, 'defensive-guard');
  assert.equal(milestone.details.safeNote, 'Valid note about diagnosis');
  assert.equal(milestone.details.rawReasoning, undefined, 'rawReasoning must be stripped');
  assert.equal(milestone.details.thinking, undefined, 'thinking must be stripped');
  assert.equal(milestone.details.prompt, undefined, 'prompt must be stripped');
  assert.equal(milestone.details.stream, undefined, 'stream must be stripped');
});

test('milestone: sanitizes string values in details object', () => {
  const secret = 'sk-proj-999999999999999999999999';
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Repair',
    kind: 'patch_applied',
    summary: 'Patch applied',
    details: {
      diagnostic: `Failed with token ${secret}`,
    },
  });

  assert.ok(milestone.details !== undefined);
  assert.ok(typeof milestone.details.diagnostic === 'string');
  assert.ok(!milestone.details.diagnostic.includes(secret));
  assert.ok(milestone.details.diagnostic.includes('[REDACTED]'));
});

test('milestone: recursively sanitizes array objects and omits protected keys', () => {
  const milestone = createMilestone({
    taskId: 'task-array-detail',
    runId: 'run-array-detail',
    node: 'Report',
    kind: 'task_started',
    summary: 'Started',
    details: {
      items: [{
        prompt: 'PRIVATE PROMPT',
        password: 'MARKER_SECRET_nested',
        keep: 'visible',
        nested: [{ token: 'MARKER_SECRET_token', keep: 'also visible' }],
      }],
    },
  });

  assert.deepEqual(milestone.details, {
    items: [{ keep: 'visible', nested: [{ keep: 'also visible' }] }],
  });
});

test('milestone: rejects cyclic details with a safe error', () => {
  const details: Record<string, unknown> = {};
  details['self'] = details;

  assert.throws(
    () => createMilestone({
      taskId: 'task-cyclic-detail',
      runId: 'run-cyclic-detail',
      node: 'Report',
      kind: 'task_started',
      summary: 'Started',
      details,
    }),
    /Invalid report details/
  );
});

test('milestone: bounds nested UTF-8 details and array items', () => {
  const milestone = createMilestone({
    taskId: 'task-large-detail',
    runId: 'run-large-detail',
    node: 'Report',
    kind: 'task_started',
    summary: 'Started',
    details: {
      items: Array.from({ length: 1000 }, () => ({ text: '🙂'.repeat(1000) })),
    },
  });
  const serialized = JSON.stringify(milestone.details);

  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192);
  const items = milestone.details?.['items'];
  assert.ok(Array.isArray(items));
  assert.ok(items.length <= 128);
  assert.ok(!serialized.includes('\uFFFD'));
});

test('milestone: bounds summary byte length cleanly to maxSummaryBytes', () => {
  const longSummary = 'A'.repeat(2000);
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Verification',
    kind: 'verification_completed',
    summary: longSummary,
    maxSummaryBytes: 128,
  });

  assert.ok(Buffer.byteLength(milestone.summary, 'utf8') <= 128);
  assert.ok(milestone.summary.includes('... [TRUNCATED]'));
});

test('milestone: honors one-byte summary limits', () => {
  const milestone = createMilestone({
    taskId: 'task-tiny-summary',
    runId: 'run-tiny-summary',
    node: 'Report',
    kind: 'task_started',
    summary: '🙂'.repeat(10),
    maxSummaryBytes: 1,
  });

  assert.ok(Buffer.byteLength(milestone.summary, 'utf8') <= 1);
});

test('milestone: rejects non-finite summary limits', () => {
  assert.throws(() => createMilestone({
    taskId: 'task-infinite-summary',
    runId: 'run-infinite-summary',
    node: 'Report',
    kind: 'task_started',
    summary: 'summary',
    maxSummaryBytes: Number.POSITIVE_INFINITY,
  }), /Invalid report limit: maxSummaryBytes/);
});

test('milestoneToActivityEvent: converts Milestone to contract ActivityEvent', () => {
  const milestone = createMilestone({
    taskId: 'task-001',
    runId: 'run-001',
    node: 'Verification',
    kind: 'verification_completed',
    summary: 'Verification complete',
    outcome: 'success',
    evidenceRefs: ['verif-001'],
  });

  const event = milestoneToActivityEvent(milestone, 150);
  const validation = validateActivityEvent(event);

  assert.equal(validation.ok, true, 'ActivityEvent must pass contract validation');
  assert.equal(event.taskId, 'task-001');
  assert.equal(event.runId, 'run-001');
  assert.equal(event.node, 'Verification');
  assert.equal(event.outcome, 'success');
  assert.equal(event.durationMs, 150);
  assert.deepEqual(event.evidenceRefs, ['verif-001']);
});

/* ==================================================================
 * Section 2: Deterministic Honest Final Reporting (T004 States)
 * ================================================================== */

test('report: generates COMPLETED final report with valid delivery on verified state', () => {
  const fixture = createValidReportingFixture();
  const reportInput: BuildFinalReportInput = {
    ...fixture,
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -12,2 +12,4 @@\n+    if b == 0:\n+        raise CalculationError("division by zero")\n',
    milestones: [
      createMilestone({
        taskId: fixture.task.taskId,
        runId: fixture.state.runId,
        node: 'Investigate',
        kind: 'investigation_completed',
        summary: 'Baseline reproduced zero division error',
      }),
      createMilestone({
        taskId: fixture.task.taskId,
        runId: fixture.state.runId,
        node: 'Verification',
        kind: 'verification_completed',
        summary: 'Focused and regression checks passed',
      }),
    ],
  };

  const report = buildFinalReport(reportInput);

  assert.equal(report.isComplete, true);
  assert.equal(report.outcome, 'COMPLETED');
  assert.equal(report.taskId, fixture.task.taskId);
  assert.equal(report.runId, fixture.state.runId);
  assert.equal(report.repositoryId, fixture.task.repositoryId);
  assert.equal(report.diff.diffDigest, fixture.currentDiffDigest);
  assert.deepEqual(report.diff.changedFiles, ['src/calculator.py']);
  assert.ok(report.diff.patch !== undefined);
  assert.equal(report.evidence.baselineRef, fixture.baseline.evidenceId);
  assert.deepEqual(report.evidence.verificationRefs, ['verif-focused-001', 'verif-regression-001']);
  assert.equal(report.evidence.reviewRef, fixture.reviewResult.reviewId);
  assert.equal(report.failureReasons.length, 0);
  assert.equal(report.safeNextAction, 'ready-for-human-review');

  // Verify delivery record compliance
  assert.ok(report.delivery !== undefined);
  const deliveryValidation = validateDelivery(report.delivery);
  assert.equal(deliveryValidation.ok, true);

  // Verify usage retention
  assert.equal(report.usage.tokensConsumed, 12500);
  assert.equal(report.usage.costUsd, 0.25);
  assert.equal(report.usage.replanCount, 1);
  assert.equal(report.milestones.length, 2);
});

test('report: check failure results in IMPLEMENTED_UNVERIFIED and no delivery record', () => {
  const fixture = createValidReportingFixture();
  const failedVerification: VerificationResult = {
    evidenceId: 'verif-focused-failed',
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    actionId: 'action-pytest-focused',
    phase: 'focused',
    repoDigest: fixture.currentRepoDigest,
    diffDigest: fixture.currentDiffDigest,
    commandIdentity: 'pytest -q tests/test_calculator.py -k test_divide_zero',
    outcome: 'fail',
    testedIds: ['check-pytest-reproduction'],
    diagnosticRefs: ['diag-fail-001'],
  };

  const regCheck = fixture.verificationResults[1];
  assert.ok(regCheck !== undefined);
  const report = buildFinalReport({
    ...fixture,
    verificationResults: [failedVerification, regCheck],
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.length > 0);
  assert.ok(report.failureReasons.some((r) => r.includes('failed')));
  assert.notEqual(report.safeNextAction, 'ready-for-human-review');
});

test('report: review findings result in IMPLEMENTED_UNVERIFIED and no delivery record', () => {
  const fixture = createValidReportingFixture();
  const findingsReview: ReviewResult = {
    ...fixture.reviewResult,
    status: 'findings',
    findings: [
      {
        side: 'new',
        file: 'src/calculator.py',
        line: 14,
        severity: 'error',
        message: 'CalculationError is not defined or imported',
      },
    ],
  };

  assert.ok(fixture.trustedReviewRecord !== undefined);
  const report = buildFinalReport({
    ...fixture,
    reviewResult: findingsReview,
    trustedReviewRecord: {
      ...fixture.trustedReviewRecord,
      status: 'findings',
    },
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.some((r) => r.includes('CalculationError is not defined')));
});

test('report: digest drift results in IMPLEMENTED_UNVERIFIED and no delivery record', () => {
  const fixture = createValidReportingFixture();
  const driftedRepoDigest = 'sha256:9999999999999999999999999999999999999999999999999999999999999999';

  const report = buildFinalReport({
    ...fixture,
    currentRepoDigest: driftedRepoDigest,
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.some((r) => r.includes('drift')));
});

test('report: protected test modification results in IMPLEMENTED_UNVERIFIED and test protection violation', () => {
  const fixture = createValidReportingFixture();
  const tamperedProtectedDigest = computeCanonicalSha256('tampered-protected-tests');

  const report = buildFinalReport({
    ...fixture,
    currentProtectedTestsDigest: tamperedProtectedDigest,
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.some((r) => r.includes('Protected tests')));
});

test('report: incomplete without modifications yields INCOMPLETE outcome', () => {
  const fixture = createValidReportingFixture();
  const unmodifiedState: TaskState = {
    ...fixture.state,
    changedPaths: [],
    plan: undefined,
  };

  const report = buildFinalReport({
    task: fixture.task,
    state: unmodifiedState,
    baseline: fixture.baseline,
    changedFiles: [],
    currentRepoDigest: fixture.task.initialRevisionDigest,
    currentDiffDigest: '',
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'INCOMPLETE');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.length > 0);
});

test('report: refusal of false completion claims when verification failed', () => {
  const fixture = createValidReportingFixture();
  const failedVerification: VerificationResult = {
    evidenceId: 'verif-focused-failed',
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    actionId: 'action-pytest-focused',
    phase: 'focused',
    repoDigest: fixture.currentRepoDigest,
    diffDigest: fixture.currentDiffDigest,
    commandIdentity: 'pytest -q tests/test_calculator.py -k test_divide_zero',
    outcome: 'fail',
    testedIds: ['check-pytest-reproduction'],
    diagnosticRefs: ['diag-fail-001'],
  };

  const regCheck = fixture.verificationResults[1];
  assert.ok(regCheck !== undefined);
  // Attempt to pass overrideOutcome: 'COMPLETED' despite failure
  const report = buildFinalReport({
    ...fixture,
    verificationResults: [failedVerification, regCheck],
    overrideOutcome: 'COMPLETED',
  });

  assert.notEqual(report.outcome, 'COMPLETED', 'buildFinalReport must refuse false COMPLETED outcome');
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.isComplete, false);
  assert.equal(report.delivery, undefined);
});

/* ==================================================================
 * Section 3: Bounded Secret Safety Across Success and Errors (C16)
 * ================================================================== */

test('report: sanitizes secrets in failure reasons and limitations', () => {
  const fixture = createValidReportingFixture();
  const secretToken = 'sk-123456789012345678901234567890';
  const customSecret = 'SUPER_SECRET_CONN_STR_123';

  const report = buildFinalReport({
    ...fixture,
    failureReasons: [`Connection failed with secret token: ${secretToken}`],
    limitations: [`External server auth header ${customSecret} unavailable`],
    customSecretPatterns: [customSecret],
    overrideOutcome: 'FAILED',
  });

  for (const reason of report.failureReasons) {
    assert.ok(!reason.includes(secretToken));
    assert.ok(reason.includes('[REDACTED]'));
  }
  for (const lim of report.limitations) {
    assert.ok(!lim.includes(customSecret));
    assert.ok(lim.includes('[REDACTED]'));
  }
});

test('report: sanitizes copied milestone summaries in JSON and Markdown', () => {
  const fixture = createValidReportingFixture();
  const source = createMilestone({
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    node: 'Verification',
    kind: 'verification_completed',
    summary: 'safe summary',
  });
  const report = buildFinalReport({
    ...fixture,
    milestones: [{ ...source, summary: 'Verification included MARKER_SECRET_milestone' }],
  });
  const serialized = JSON.stringify(report);
  const markdown = formatReportMarkdown(report);

  assert.ok(!serialized.includes('MARKER_SECRET_milestone'));
  assert.ok(!markdown.includes('MARKER_SECRET_milestone'));
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(markdown.includes('[REDACTED]'));
});

test('report: rejects protected stable metadata without echoing the value', () => {
  const fixture = createValidReportingFixture();
  let caught: unknown;
  try {
    buildFinalReport({
      ...fixture,
      changedFiles: ['src/MARKER_SECRET_filename.py'],
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.match(caught.message, /Protected report metadata rejected/);
  assert.ok(!caught.message.includes('MARKER_SECRET_filename.py'));
});

test('report: rejects protected milestone evidence references without echoing them', () => {
  const fixture = createValidReportingFixture();
  const milestone = createMilestone({
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    node: 'Verification',
    kind: 'verification_completed',
    summary: 'Checks completed',
  });
  let caught: unknown;
  try {
    buildFinalReport({
      ...fixture,
      milestones: [{ ...milestone, evidenceRefs: ['MARKER_SECRET_evidence_ref'] }],
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.match(caught.message, /Protected report metadata rejected/);
  assert.ok(!caught.message.includes('MARKER_SECRET_evidence_ref'));
});

test('report: rejects oversized limitations and milestone collections', () => {
  const fixture = createValidReportingFixture();
  const milestone = createMilestone({
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    node: 'Report',
    kind: 'task_started',
    summary: 'Started',
  });

  assert.throws(() => buildFinalReport({
    ...fixture,
    limitations: Array.from({ length: 65 }, () => 'bounded limitation'),
  }), /Protected report metadata rejected: limitations/);
  assert.throws(() => buildFinalReport({
    ...fixture,
    milestones: Array.from({ length: 65 }, () => milestone),
  }), /Protected report metadata rejected: milestones/);
});

test('report: rejects serialized output above the aggregate byte bound', () => {
  const fixture = createValidReportingFixture();
  const milestone: Milestone = {
    milestoneId: 'ms-large-output',
    taskId: fixture.task.taskId,
    runId: fixture.state.runId,
    timestamp: '2026-10-22T00:00:00.000Z',
    node: 'Report',
    kind: 'task_started',
    summary: 'Started',
    outcome: 'info',
    evidenceRefs: Array.from({ length: 64 }, (_, index) => `ref-${String(index).padStart(2, '0')}-${'x'.repeat(505)}`),
    details: {},
  };

  assert.throws(() => buildFinalReport({
    ...fixture,
    milestones: Array.from({ length: 64 }, () => milestone),
  }), /Final report exceeds safe output bounds/);
});

test('report: sanitizes secrets embedded in patch content', () => {
  const fixture = createValidReportingFixture();
  const embeddedSecret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
  const rawPatch = `--- a/src/config.py\n+++ b/src/config.py\n@@ -1,2 +1,3 @@\n+API_KEY = "${embeddedSecret}"\n`;

  const report = buildFinalReport({
    ...fixture,
    patchContent: rawPatch,
  });

  assert.ok(report.diff.patch !== undefined);
  assert.ok(!report.diff.patch.includes(embeddedSecret), 'Patch must not leak embedded secrets');
  assert.ok(report.diff.patch.includes('[REDACTED]'));
});

test('report: bounds large patch content to maxDiffBytes cleanly without corruption', () => {
  const fixture = createValidReportingFixture();
  const hugePatch = '--- a/src/big.py\n+++ b/src/big.py\n' + '+ line of code content\n'.repeat(500);

  const report = buildFinalReport({
    ...fixture,
    patchContent: hugePatch,
    maxDiffBytes: 256,
  });

  assert.ok(report.diff.patch !== undefined);
  assert.ok(Buffer.byteLength(report.diff.patch, 'utf8') <= 256);
  assert.equal(report.diff.truncated, true);
  assert.ok(report.diff.patch.includes('... [TRUNCATED]'));
});

test('report: honors one-byte patch limits', () => {
  const report = buildFinalReport({
    ...createValidReportingFixture(),
    patchContent: '🙂'.repeat(10),
    maxDiffBytes: 1,
  });

  assert.ok(Buffer.byteLength(report.diff.patch ?? '', 'utf8') <= 1);
  assert.equal(report.diff.truncated, true);
});

test('report: rejects non-finite patch limits', () => {
  assert.throws(() => buildFinalReport({
    ...createValidReportingFixture(),
    patchContent: 'patch',
    maxDiffBytes: Number.POSITIVE_INFINITY,
  }), /Invalid report limit: maxDiffBytes/);
});

test('report: flags changed protected paths as failure', () => {
  const fixture = createValidReportingFixture();

  const report = buildFinalReport({
    ...fixture,
    changedFiles: ['.env', 'src/calculator.py'],
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.some((r) => r.includes('protected path')));
});

test('report: treats malformed verification results as incomplete evidence', () => {
  const fixture = createValidReportingFixture();
  const report = buildFinalReport({
    ...fixture,
    verificationResults: [null] as unknown as readonly VerificationResult[],
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(report.delivery, undefined);
  assert.ok(report.failureReasons.some((reason) => reason.includes('Malformed verification evidence')));
});

test('report: combines persisted changes when the supplied inventory is empty', () => {
  const fixture = createValidReportingFixture();
  const report = buildFinalReport({
    task: fixture.task,
    state: { ...fixture.state, changedPaths: ['src/fix.py'] },
    changedFiles: [],
  });

  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.deepEqual(report.diff.changedFiles, ['src/fix.py']);
  assert.ok(report.failureReasons.some((reason) => reason.includes('inventory')));
});

test('report: rejects inconsistent changed-file inventories from completion', () => {
  const fixture = createValidReportingFixture();
  const report = buildFinalReport({
    ...fixture,
    state: { ...fixture.state, changedPaths: ['src/state.py'] },
    changedFiles: ['src/input.py'],
  });

  assert.equal(report.isComplete, false);
  assert.equal(report.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.deepEqual([...report.diff.changedFiles].sort(), ['src/input.py', 'src/state.py']);
  assert.ok(report.failureReasons.some((reason) => reason.includes('inventory')));
});

/* ==================================================================
 * Section 4: Resource Usage and Accounting Retention (C16)
 * ================================================================== */

test('report: aggregates and retains budget accounting per-run and task-level', () => {
  const fixture = createValidReportingFixture();
  const report = buildFinalReport(fixture);

  assert.equal(report.usage.tokensConsumed, 12500);
  assert.equal(report.usage.costUsd, 0.25);
  assert.equal(report.usage.replanCount, 1);
  assert.equal(report.usage.perLedger.length, 5);

  const taskTokens = report.usage.perLedger.find((l) => l.scope === 'task' && l.kind === 'tokens');
  assert.ok(taskTokens !== undefined);
  assert.equal(taskTokens?.consumed, 12500);
  assert.equal(taskTokens?.limit, 100000);
});

/* ==================================================================
 * Section 5: Markdown Report & Milestone Summary Formatting
 * ================================================================== */

test('formatReportMarkdown: formats complete report without secrets or raw reasoning', () => {
  const fixture = createValidReportingFixture();
  const secretKey = 'sk-123456789012345678901234567890';
  const report = buildFinalReport({
    ...fixture,
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -12,2 +12,4 @@\n+    if b == 0:\n+        raise CalculationError("division by zero")\n',
    limitations: [`Tested on local mock environment with key ${secretKey}`],
    milestones: [
      createMilestone({
        taskId: fixture.task.taskId,
        runId: fixture.state.runId,
        node: 'Investigate',
        kind: 'investigation_completed',
        summary: 'Investigation reproduced bug',
      }),
    ],
  });

  const markdown = formatReportMarkdown(report);

  assert.ok(markdown.includes('# UC-03 Code Repair Report'));
  assert.ok(markdown.includes(report.taskId));
  assert.ok(markdown.includes('COMPLETED'));
  assert.ok(markdown.includes('src/calculator.py'));
  assert.ok(markdown.includes('ready-for-human-review'));
  assert.ok(!markdown.includes(secretKey), 'Markdown must not contain secrets');
  assert.ok(!markdown.includes('rawReasoning'), 'Markdown must not mention rawReasoning');
  assert.ok(!markdown.includes('thinking'), 'Markdown must not mention internal thinking');
});

test('formatMilestonesSummary: formats chronological milestone list cleanly', () => {
  const milestones: Milestone[] = [
    createMilestone({
      taskId: 'task-001',
      runId: 'run-001',
      node: 'Validate',
      kind: 'task_started',
      summary: 'Task started and validated',
      outcome: 'info',
    }),
    createMilestone({
      taskId: 'task-001',
      runId: 'run-001',
      node: 'Investigate',
      kind: 'investigation_completed',
      summary: 'Baseline reproduction passed',
      outcome: 'success',
    }),
  ];

  const summary = formatMilestonesSummary(milestones);
  assert.ok(summary.includes('task_started'));
  assert.ok(summary.includes('investigation_completed'));
  assert.ok(summary.includes('Baseline reproduction passed'));
});
