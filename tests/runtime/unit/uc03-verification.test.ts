/**
 * UC-03 Verified Code Repair - Unit Tests for Verification & Deterministic Completion
 *
 * Owned path: tests/runtime/unit/uc03-verification.test.ts
 * Feature: specs/001-verified-code-repair
 * Task: T014 (deterministic verification and completion predicates)
 *
 * Coverage:
 * - Deterministic completion on valid evidence and matching digests (COMPLETED)
 * - Protected tests digest integrity and tampering prevention
 * - Repository and diff digest drift invalidation (IMPLEMENTED_UNVERIFIED)
 * - Required checks coverage, distinguishing timeout, not-run, error, and fail
 * - Reviewer acceptance, findings, and check set binding
 * - Unmodified states returning INCOMPLETE versus modified states returning IMPLEMENTED_UNVERIFIED
 * - Delivery record construction and contract compliance
 * - Execution helper executeVerificationChecks and state transition builder
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  CONTRACT_VERSION,
  validateStateTransition,
  type BugTask,
  type TaskState,
  type Baseline,
  type VerificationResult,
  type ReviewResult,
  type CheckDefinition,
  type FixPlan,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  evaluateDeterministicCompletion,
  executeVerificationChecks,
  buildCompletionTransitionContext,
  type CompletionPredicateInput,
} from '../../../src/uc03/verification.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
} from '../support/uc03/port-fixtures.ts';

function createValidCompletionFixture(): CompletionPredicateInput {
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

  const checkSetDigest = computeCanonicalSha256(
    task.requiredChecks.map((c) => c.checkId)
  );

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
    changedPaths: ['src/calculator.py'],
    evidenceRefs: [baseline.evidenceId],
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
  };
}

/* ==================================================================
 * Section 1: Deterministic Completion (Happy Path)
 * ================================================================== */

test('completion: evaluates valid evidence and outputs COMPLETED with delivery record', () => {
  const input = createValidCompletionFixture();
  const result = evaluateDeterministicCompletion(input);

  assert.equal(result.isComplete, true);
  assert.equal(result.outcome, 'COMPLETED');
  assert.equal(result.reasons.length, 0);
  assert.ok(result.delivery !== undefined, 'delivery record must be constructed');
  assert.equal(result.delivery?.taskId, input.task.taskId);
  assert.equal(result.delivery?.runId, input.state.runId);
  assert.equal(result.delivery?.outcome, 'COMPLETED');
  assert.equal(result.delivery?.diffDigest, input.currentDiffDigest);
  assert.deepEqual(result.delivery?.changedFiles, ['src/calculator.py']);
  assert.equal(result.delivery?.baselineRef, input.baseline.evidenceId);
  assert.deepEqual(result.delivery?.verificationRefs, [
    'verif-focused-001',
    'verif-regression-001',
  ]);
  assert.equal(result.delivery?.reviewRef, input.reviewResult.reviewId);
  assert.equal(result.delivery?.safeNextAction, 'ready-for-human-review');
});

test('completion: builds valid TrustedTransitionContext completion record', () => {
  const input = createValidCompletionFixture();
  const completionContext = buildCompletionTransitionContext(input);

  assert.equal(completionContext.taskId, input.task.taskId);
  assert.equal(completionContext.runId, input.state.runId);
  assert.equal(
    completionContext.repositoryRevisionDigest,
    input.currentRepoDigest
  );
  assert.equal(completionContext.diffDigest, input.currentDiffDigest);
  assert.equal(completionContext.baselineRef, input.baseline.evidenceId);
  assert.equal(
    completionContext.protectedTestsDigest,
    input.currentProtectedTestsDigest
  );
  assert.equal(
    completionContext.originalProtectedTestsDigest,
    input.originalProtectedTestsDigest
  );
});

/* ==================================================================
 * Section 2: Protected Tests Digest Integrity
 * ================================================================== */

test('protected tests: current digest modified from original prevents completion and stays IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const tampered: CompletionPredicateInput = {
    ...input,
    currentProtectedTestsDigest:
      'sha256:tamperedtestdigest00000000000000000000000000000000000000000000',
  };

  const result = evaluateDeterministicCompletion(tampered);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('protect')),
    'reasons must mention protect'
  );
});

test('protected tests: baseline testProtectionDigest mismatch prevents completion', () => {
  const input = createValidCompletionFixture();
  const tampered: CompletionPredicateInput = {
    ...input,
    baseline: {
      ...input.baseline,
      testProtectionDigest: 'sha256:mismatchedbaselinedigest00000000000000000000000000000000',
    },
  };

  const result = evaluateDeterministicCompletion(tampered);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('protect')),
    'reasons must mention protect'
  );
});

test('protected tests: changedFiles modifying a test file prevents completion', () => {
  const input = createValidCompletionFixture();
  const tampered: CompletionPredicateInput = {
    ...input,
    changedFiles: ['src/calculator.py', 'tests/test_calculator.py'],
  };

  const result = evaluateDeterministicCompletion(tampered);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('protect')),
    'reasons must mention protect'
  );
});

test('protected tests: changedFiles with non-canonical path fails closed', () => {
  const input = createValidCompletionFixture();
  const invalidPath: CompletionPredicateInput = {
    ...input,
    changedFiles: ['../outside.py'],
  };

  const result = evaluateDeterministicCompletion(invalidPath);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('canonical')),
    'reasons must mention canonical'
  );
});

/* ==================================================================
 * Section 3: Repository & Diff Digest Drift
 * ================================================================== */

test('digest drift: currentDiffDigest drift from reviewResult leaves state IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const drifted: CompletionPredicateInput = {
    ...input,
    currentDiffDigest:
      'sha256:drifteddiffdigest00000000000000000000000000000000000000000000000',
  };

  const result = evaluateDeterministicCompletion(drifted);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) => r.toLowerCase().includes('diff') || r.toLowerCase().includes('drift')
    ),
    'reasons must report diff drift'
  );
});

test('digest drift: state repository revision drift leaves state IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const drifted: CompletionPredicateInput = {
    ...input,
    state: {
      ...input.state,
      repositoryRevisionDigest:
        'sha256:driftedstaterevision000000000000000000000000000000000000000000',
    },
  };

  const result = evaluateDeterministicCompletion(drifted);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) =>
        r.toLowerCase().includes('drift') ||
        r.toLowerCase().includes('revision') ||
        r.toLowerCase().includes('digest')
    ),
    'reasons must report state revision drift'
  );
});

function getTwoVerificationResults(
  input: CompletionPredicateInput
): [VerificationResult, VerificationResult] {
  const [first, second] = input.verificationResults;
  if (!first || !second) {
    throw new Error('Expected two verification results in fixture');
  }
  return [first, second];
}

test('digest drift: verificationResult diff digest drift leaves state IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const drifted: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        diffDigest:
          'sha256:driftedverifdiff000000000000000000000000000000000000000000000',
      },
      second,
    ],
  };

  const result = evaluateDeterministicCompletion(drifted);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) => r.toLowerCase().includes('diff') || r.toLowerCase().includes('drift')
    ),
    'reasons must report verification diff drift'
  );
});

test('digest drift: verificationResult repository digest drift leaves state IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const drifted: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      first,
      {
        ...second,
        repoDigest:
          'sha256:driftedverifrepo000000000000000000000000000000000000000000000',
      },
    ],
  };

  const result = evaluateDeterministicCompletion(drifted);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) =>
        r.toLowerCase().includes('drift') ||
        r.toLowerCase().includes('repository')
    ),
    'reasons must report verification repo drift'
  );
});

/* ==================================================================
 * Section 4: Required Checks Coverage & Outcomes
 * ================================================================== */

test('check failure: failed regression check distinguishes regression failure and remains IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const failed: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      first,
      {
        ...second,
        outcome: 'fail',
      },
    ],
  };

  const result = evaluateDeterministicCompletion(failed);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) =>
        r.toLowerCase().includes('fail') ||
        r.toLowerCase().includes('regression')
    ),
    'reasons must report regression failure'
  );
});

test('check timeout: timed-out check distinguishes timeout and remains IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const timedOut: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        outcome: 'timeout',
      },
      second,
    ],
  };

  const result = evaluateDeterministicCompletion(timedOut);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('timeout')),
    'reasons must report timeout'
  );
});

test('check not-run: not-run check distinguishes not-run and remains IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const notRun: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      first,
      {
        ...second,
        outcome: 'not-run',
      },
    ],
  };

  const result = evaluateDeterministicCompletion(notRun);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('not-run') || r.toLowerCase().includes('not run')),
    'reasons must report not run'
  );
});

test('check environment error: error outcome distinguishes environment error and remains IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const errored: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        outcome: 'error',
      },
      second,
    ],
  };

  const result = evaluateDeterministicCompletion(errored);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('error')),
    'reasons must report environment error'
  );
});

test('check missing: required check missing entirely from verification results prevents completion', () => {
  const input = createValidCompletionFixture();
  const [first] = getTwoVerificationResults(input);
  const missingCheck: CompletionPredicateInput = {
    ...input,
    verificationResults: [first], // omitted regression check
  };

  const result = evaluateDeterministicCompletion(missingCheck);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('missing') || r.toLowerCase().includes('not run')),
    'reasons must report missing required check'
  );
});

test('check phase mismatch: reproduction check with wrong phase fails verification', () => {
  const input = createValidCompletionFixture();
  const [first, second] = getTwoVerificationResults(input);
  const phaseMismatch: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        phase: 'regression', // reproduction check must have focused or baseline phase
      },
      second,
    ],
  };

  const result = evaluateDeterministicCompletion(phaseMismatch);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('phase')),
    'reasons must report phase mismatch'
  );
});

/* ==================================================================
 * Section 5: Reviewer Acceptance & Findings
 * ================================================================== */

test('review: review status findings with error severity prevents completion', () => {
  const input = createValidCompletionFixture();
  const reviewFindings: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      status: 'findings',
      findings: [
        {
          file: 'src/calculator.py',
          line: 15,
          side: 'new',
          severity: 'error',
          message: 'Unhandled zero division boundary case',
        },
      ],
    },
  };

  const result = evaluateDeterministicCompletion(reviewFindings);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) =>
        r.toLowerCase().includes('review') ||
        r.toLowerCase().includes('finding')
    ),
    'reasons must report review findings'
  );
});

test('review: review status invalid prevents completion', () => {
  const input = createValidCompletionFixture();
  const reviewInvalid: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      status: 'invalid',
    },
  };

  const result = evaluateDeterministicCompletion(reviewInvalid);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('review')),
    'reasons must report review not accepted'
  );
});

test('review: review status accepted with lingering actionable findings prevents completion', () => {
  const input = createValidCompletionFixture();
  const inconsistentReview: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      status: 'accepted',
      findings: [
        {
          file: 'src/calculator.py',
          line: 10,
          side: 'new',
          severity: 'warning',
          message: 'Inconsistent docstring',
        },
      ],
    },
  };

  const result = evaluateDeterministicCompletion(inconsistentReview);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some(
      (r) =>
        r.toLowerCase().includes('review') ||
        r.toLowerCase().includes('finding')
    ),
    'reasons must report actionable findings in accepted review'
  );
});

test('review: review checkSetDigest mismatch prevents completion', () => {
  const input = createValidCompletionFixture();
  const checkSetMismatch: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      checkSetDigest: 'sha256:mismatchedchecksetdigest00000000000000000000000000000000',
    },
  };

  const result = evaluateDeterministicCompletion(checkSetMismatch);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('checksetdigest')),
    'reasons must report checkSetDigest mismatch'
  );
});

test('review: reviewId mismatch with state latestReviewRef prevents completion', () => {
  const input = createValidCompletionFixture();
  const idMismatch: CompletionPredicateInput = {
    ...input,
    state: {
      ...input.state,
      latestReviewRef: 'review-different-id',
    },
  };

  const result = evaluateDeterministicCompletion(idMismatch);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('review id')),
    'reasons must report review ID mismatch'
  );
});

/* ==================================================================
 * Section 6: Baseline Alignment & Incomplete States
 * ================================================================== */

test('baseline: baseline checkSetDigest mismatch prevents completion', () => {
  const input = createValidCompletionFixture();
  const baselineMismatch: CompletionPredicateInput = {
    ...input,
    baseline: {
      ...input.baseline,
      checkSetDigest: 'sha256:mismatchedbaselinecheckset00000000000000000000000000000000',
    },
  };

  const result = evaluateDeterministicCompletion(baselineMismatch);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('checksetdigest')),
    'reasons must report baseline checkSetDigest mismatch'
  );
});

test('unmodified state: empty changedFiles and empty state changedPaths yields INCOMPLETE outcome', () => {
  const input = createValidCompletionFixture();
  const unmodified: CompletionPredicateInput = {
    ...input,
    changedFiles: [],
    state: {
      ...input.state,
      changedPaths: [],
    },
  };

  const result = evaluateDeterministicCompletion(unmodified);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'INCOMPLETE', 'unmodified incomplete state must be INCOMPLETE');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('changedfiles')),
    'reasons must report empty changedFiles'
  );
});

/* ==================================================================
 * Section 7: Robustness & Defensive Fail-Closed Guards
 * ================================================================== */

test('robustness: null input fails closed with INCOMPLETE', () => {
  const result = evaluateDeterministicCompletion(null as unknown as CompletionPredicateInput);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.length > 0);
});

test('robustness: undefined input fails closed with INCOMPLETE', () => {
  const result = evaluateDeterministicCompletion(undefined as unknown as CompletionPredicateInput);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.length > 0);
});

test('robustness: throwing getters in input fail closed safely', () => {
  const input = createValidCompletionFixture();
  const hostile = {
    ...input,
    get verificationResults() {
      throw new Error('Hostile getter trap');
    },
  };

  const result = evaluateDeterministicCompletion(hostile as unknown as CompletionPredicateInput);

  assert.equal(result.isComplete, false);
  assert.ok(result.reasons.length > 0);
});

test('robustness: caller array mutation after evaluate invocation does not affect delivery or reasons', () => {
  const input = createValidCompletionFixture();
  const mutableChangedFiles = ['src/calculator.py'];
  const testInput: CompletionPredicateInput = {
    ...input,
    changedFiles: mutableChangedFiles,
  };

  const result = evaluateDeterministicCompletion(testInput);
  assert.equal(result.isComplete, true);

  // Mutate caller array
  mutableChangedFiles.push('src/malicious.py');

  // Result delivery changedFiles must remain unchanged
  assert.deepEqual(result.delivery?.changedFiles, ['src/calculator.py']);
});

/* ==================================================================
 * Section 8: Execution Helper executeVerificationChecks
 * ================================================================== */

test('executeVerificationChecks: runs checks on FakeRepositoryPort and produces validated results', async () => {
  const input = createValidCompletionFixture();
  const repo = new FakeRepositoryPort({
    initialRevision: input.currentRepoDigest,
  });

  repo.setTestResult('check-pytest-reproduction', {
    checkId: 'check-pytest-reproduction',
    outcome: 'pass',
    outputExcerpt: '1 passed in 0.04s',
    durationMs: 40,
  });
  repo.setTestResult('check-pytest-regression', {
    checkId: 'check-pytest-regression',
    outcome: 'pass',
    outputExcerpt: '5 passed in 0.05s',
    durationMs: 55,
  });

  const results = await executeVerificationChecks(input.task, repo, {
    runId: input.state.runId,
    repoDigest: input.currentRepoDigest,
    diffDigest: input.currentDiffDigest,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.outcome, 'pass');
  assert.equal(results[0]?.phase, 'focused');
  assert.equal(results[1]?.outcome, 'pass');
  assert.equal(results[1]?.phase, 'regression');

  // Verify that the generated results pass evaluateDeterministicCompletion
  const fullInput: CompletionPredicateInput = {
    ...input,
    verificationResults: results,
  };
  const evalResult = evaluateDeterministicCompletion(fullInput);
  assert.equal(evalResult.isComplete, true);
  assert.equal(evalResult.outcome, 'COMPLETED');
});

test('buildCompletionTransitionContext: throws when called on incomplete input', () => {
  const input = createValidCompletionFixture();
  const incompleteInput: CompletionPredicateInput = {
    ...input,
    currentProtectedTestsDigest: 'sha256:tampered0000000000000000000000000000000000000000000000000000',
  };

  assert.throws(() => {
    buildCompletionTransitionContext(incompleteInput);
  }, /CANNOT_BUILD_COMPLETION_CONTEXT/);
});

test('integration: buildCompletionTransitionContext produces trusted completion record admitted by validateStateTransition', () => {
  const input = createValidCompletionFixture();
  const completionContext = buildCompletionTransitionContext(input);

  const nextState: TaskState = {
    ...input.state,
    stateVersion: input.state.stateVersion + 1,
    node: 'Deliver',
    outcome: 'COMPLETED',
  };

  const transitionRes = validateStateTransition(input.state, nextState, {
    trusted: { completion: completionContext },
  });

  assert.equal(
    transitionRes.ok,
    true,
    `validateStateTransition must succeed: ${transitionRes.ok ? '' : transitionRes.errors.map((e) => e.message).join('; ')}`
  );
});

test('verification: verificationResult taskId mismatch prevents completion and stays IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const first = input.verificationResults[0];
  assert.ok(first);
  const mismatched: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        taskId: 'different-task-id',
      },
      ...input.verificationResults.slice(1),
    ],
  };

  const result = evaluateDeterministicCompletion(mismatched);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.includes('taskId')));
});

test('verification: verificationResult runId mismatch prevents completion and stays IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const first = input.verificationResults[0];
  assert.ok(first);
  const mismatched: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        runId: 'different-run-id',
      },
      ...input.verificationResults.slice(1),
    ],
  };

  const result = evaluateDeterministicCompletion(mismatched);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.includes('runId')));
});

test('verification: verificationResult missing diffDigest for candidate modification prevents completion', () => {
  const input = createValidCompletionFixture();
  const first = input.verificationResults[0];
  assert.ok(first);
  const noDiff: CompletionPredicateInput = {
    ...input,
    verificationResults: [
      {
        ...first,
        diffDigest: undefined,
      },
      ...input.verificationResults.slice(1),
    ],
  };

  const result = evaluateDeterministicCompletion(noDiff);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('diff')));
});

test('review: missing reviewerRoleConfigId prevents completion', () => {
  const input = createValidCompletionFixture();
  const noRoleConfig: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      reviewerRoleConfigId: '',
    },
  };

  const result = evaluateDeterministicCompletion(noRoleConfig);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.includes('reviewerRoleConfigId')));
});

test('review: missing iterationReservationRef prevents completion', () => {
  const input = createValidCompletionFixture();
  const noResRef: CompletionPredicateInput = {
    ...input,
    reviewResult: {
      ...input.reviewResult,
      iterationReservationRef: '',
    },
  };

  const result = evaluateDeterministicCompletion(noResRef);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.includes('iterationReservationRef')));
});

test('baseline: missing baseline testProtectionDigest prevents completion', () => {
  const input = createValidCompletionFixture();
  const baselineWithoutProtection = { ...input.baseline } as Record<
    string,
    unknown
  >;
  delete baselineWithoutProtection['testProtectionDigest'];
  const noProtection: CompletionPredicateInput = {
    ...input,
    baseline: baselineWithoutProtection as unknown as Baseline,
  };

  const result = evaluateDeterministicCompletion(noProtection);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('protect')));
});

test('state: missing plan in task state prevents completion', () => {
  const input = createValidCompletionFixture();
  const noPlan: CompletionPredicateInput = {
    ...input,
    state: {
      ...input.state,
      plan: undefined,
    },
  };

  const result = evaluateDeterministicCompletion(noPlan);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('plan')));
});

test('state: plan checkSetDigest mismatch prevents completion', () => {
  const input = createValidCompletionFixture();
  assert.ok(input.state.plan);
  const badCheckSet: CompletionPredicateInput = {
    ...input,
    state: {
      ...input.state,
      plan: {
        ...input.state.plan,
        checkSetDigest: 'sha256:differentcheckset000000000000000000000000000000000000000000000000',
      },
    },
  };

  const result = evaluateDeterministicCompletion(badCheckSet);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('checksetdigest')));
});

test('protected tests: flag syntax test argument (--test-file=tests/test_calculator.py) is detected and protected', () => {
  const input = createValidCompletionFixture();
  const flagCheckTask: BugTask = {
    ...input.task,
    requiredChecks: [
      {
        checkId: 'check-pytest-custom',
        executable: 'pytest',
        argv: ['-q', '--test-file=tests/test_calculator.py'],
        purpose: 'regression',
        timeoutMs: 30000,
        maxOutputBytes: 1048576,
      },
    ],
  };

  const tamperedChangedFiles: CompletionPredicateInput = {
    ...input,
    task: flagCheckTask,
    changedFiles: ['tests/test_calculator.py'],
  };

  const result = evaluateDeterministicCompletion(tamperedChangedFiles);
  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes('protect')));
});

test('executeVerificationChecks: safely records error outcome when runTests throws', async () => {
  const input = createValidCompletionFixture();
  const repo = new FakeRepositoryPort({
    initialRevision: input.currentRepoDigest,
  });

  repo.runTests = async () => {
    throw new Error('Container crashed or test process aborted');
  };

  const results = await executeVerificationChecks(input.task, repo, {
    runId: input.state.runId,
    repoDigest: input.currentRepoDigest,
    diffDigest: input.currentDiffDigest,
  });

  assert.equal(results.length, input.task.requiredChecks.length);
  for (const r of results) {
    assert.equal(r.outcome, 'error');
  }
});

test('executeVerificationChecks: throws on invalid inputs', async () => {
  const input = createValidCompletionFixture();
  const repo = new FakeRepositoryPort({
    initialRevision: input.currentRepoDigest,
  });

  await assert.rejects(
    async () => {
      await executeVerificationChecks(null as unknown as BugTask, repo, {
        runId: 'run-1',
        repoDigest: 'repo-1',
      });
    },
    /INVALID_TASK/
  );

  await assert.rejects(
    async () => {
      await executeVerificationChecks(input.task, null as unknown as FakeRepositoryPort, {
        runId: 'run-1',
        repoDigest: 'repo-1',
      });
    },
    /INVALID_REPOSITORY/
  );

  await assert.rejects(
    async () => {
      await executeVerificationChecks(
        input.task,
        repo,
        null as unknown as { runId: string; repoDigest: string }
      );
    },
    /INVALID_CONTEXT/
  );
});
