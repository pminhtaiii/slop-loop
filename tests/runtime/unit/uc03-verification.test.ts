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
  computeCheckSetDigest,
  CONTRACT_VERSION,
  validateStateTransition,
  type BugTask,
  type TaskState,
  type Baseline,
  type VerificationResult,
  type ReviewResult,
  type CheckDefinition,
  type FixPlan,
  type RepositoryAdmissionContextV02,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  evaluateDeterministicCompletion,
  executeVerificationChecks,
  buildCompletionTransitionContext,
  type CompletionPredicateInput,
  type TrustedReviewRecord,
} from '../../../src/uc03/verification.ts';
import { investigateBaseline } from '../../../src/uc03/investigation.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import {
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestAdmissionTaskStateV02,
} from '../support/uc03/state-fixtures.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
} from '../support/uc03/port-fixtures.ts';

function createGuardedVerificationFixture(options?: {
  readonly alterAdmission?: ((admission: RepositoryAdmissionContextV02) => void) | undefined;
  readonly alterState?: ((state: TaskState) => TaskState) | undefined;
  readonly mutateAfterExecution?: boolean | undefined;
}): {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly journal: MemoryStatePortV02;
  readonly repo: FakeRepositoryPort;
  readonly admission: RepositoryAdmissionContextV02;
  readonly executionGuard: ReturnType<typeof createExecutionGuardV02>;
} {
  const task = createFixtureBugTask();
  const check = task.requiredChecks[0]!;
  const action = {
    actionId: `action-verify-${check.checkId}`,
    kind: 'run_command' as const,
    executable: check.executable,
    argv: [...check.argv],
    workingDirectory: check.workingDirectory ?? 'tests',
    purpose: check.purpose,
  };
  const planDecisionRef = 'dec-approved-plan-001';
  const tempContext = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: check.checkId,
    testPath: 'tests/test_calculator.py',
  });
  const initial = createTestAdmissionTaskStateV02(tempContext);
  const plan = initial.plan!;
  const planBindingDigest = computeCanonicalSha256({
    taskId: initial.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(initial.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    planBindingDigest,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: check.checkId,
    testPath: 'tests/test_calculator.py',
  });
  options?.alterAdmission?.(admission);
  const stateWithAccounting = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      {
        scope: 'task' as const,
        kind: 'timeoutMs' as const,
        limit: 60000,
        consumed: 0,
        reservations: [],
        unit: 'count' as const,
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
  const state = options?.alterState?.(stateWithAccounting) ?? stateWithAccounting;
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });
  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    commandResults: { default: { exitCode: 0, stdout: '1 passed', stderr: '' } },
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: repo } });
  if (options?.mutateAfterExecution) {
    const execute = executionGuard.validateAndExecute.bind(executionGuard);
    executionGuard.validateAndExecute = async (guardAction, guardState, guardContext) => {
      const result = await execute(guardAction, guardState, guardContext);
      journal.getUnderlying().internalSetTask({ ...guardState, nextAction: 'changed after guarded verification' });
      return result;
    };
  }
  return { task, state, journal, repo, admission, executionGuard };
}

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

for (const phase of ['baseline', 'regression', 'compatibility', 'diff'] as const) {
  test(`check phase mismatch: reproduction check with ${phase} phase fails verification`, () => {
    const input = createValidCompletionFixture();
    const [first, second] = getTwoVerificationResults(input);
    const phaseMismatch: CompletionPredicateInput = {
      ...input,
      verificationResults: [
        {
          ...first,
          phase,
        },
        second,
      ],
    };

    const result = evaluateDeterministicCompletion(phaseMismatch);

    assert.equal(result.isComplete, false);
    assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
    assert.ok(
      result.reasons.some((r) => r.includes("phase mismatch for check 'check-pytest-reproduction': expected 'focused'")),
      'reasons must report phase mismatch'
    );
  });
}

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

/* ==================================================================
 * Section 8: Independent Reviewer Validation & Integrity (Defect 3)
 * ================================================================== */

test('review: missing trustedReviewRecord prevents completion and stays IMPLEMENTED_UNVERIFIED', () => {
  const input = createValidCompletionFixture();
  const withoutTrustedReview: CompletionPredicateInput = {
    ...input,
    trustedReviewRecord: undefined,
  };
  const result = evaluateDeterministicCompletion(withoutTrustedReview);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('Independent trustedReviewRecord is required')),
    `Expected reason for missing trustedReviewRecord, got: ${result.reasons.join('; ')}`
  );
});

test('review: mismatched reviewerRoleConfigId in trustedReviewRecord fails admission', () => {
  const input = createValidCompletionFixture();
  assert.ok(input.trustedReviewRecord);
  const tampered: CompletionPredicateInput = {
    ...input,
    trustedReviewRecord: {
      ...input.trustedReviewRecord,
      reviewerRoleConfigId: 'different-reviewer-role',
    },
  };
  const result = evaluateDeterministicCompletion(tampered);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('Reviewer role config ID mismatch with independent review record')),
    `Expected reason for reviewerRoleConfigId mismatch, got: ${result.reasons.join('; ')}`
  );
});

test('review: missing trusted status or check-set digest prevents completion', async t => {
  for (const field of ['status', 'checkSetDigest'] as const) {
    await t.test(field, () => {
      const input = createValidCompletionFixture();
      assert.ok(input.trustedReviewRecord);
      const incomplete: Record<string, unknown> = { ...input.trustedReviewRecord };
      if (field === 'status') delete incomplete.status;
      else delete incomplete.checkSetDigest;
      const result = evaluateDeterministicCompletion({
        ...input,
        // Simulate an incomplete record crossing the runtime boundary.
        trustedReviewRecord: incomplete as unknown as TrustedReviewRecord,
      });
      assert.equal(result.isComplete, false);
      assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
      assert.ok(result.reasons.some(reason => reason.includes(
        field === 'status' ? 'Trusted review record status is not accepted' : 'Trusted review record checkSetDigest mismatch'
      )), result.reasons.join('; '));
    });
  }
});

test('review: mismatched iterationReservationRef in trustedReviewRecord fails admission', () => {
  const input = createValidCompletionFixture();
  assert.ok(input.trustedReviewRecord);
  const tampered: CompletionPredicateInput = {
    ...input,
    trustedReviewRecord: {
      ...input.trustedReviewRecord,
      iterationReservationRef: 'drifted-reservation-ref',
    },
  };
  const result = evaluateDeterministicCompletion(tampered);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('Review iteration reservation ref mismatch with independent review record')),
    `Expected reason for iterationReservationRef mismatch, got: ${result.reasons.join('; ')}`
  );
});

test('review: missing state.latestReviewRef prevents completion', () => {
  const input = createValidCompletionFixture();
  const withoutLatestReviewRef: CompletionPredicateInput = {
    ...input,
    state: {
      ...input.state,
      latestReviewRef: undefined,
    },
  };
  const result = evaluateDeterministicCompletion(withoutLatestReviewRef);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('State latestReviewRef is required')),
    `Expected reason for missing state.latestReviewRef, got: ${result.reasons.join('; ')}`
  );
});

/* ==================================================================
 * Section 9: Authorized Diff Digest Integrity (Defect 4)
 * ================================================================== */

test('authorizedDiff: missing authorizedDiffDigest prevents completion', () => {
  const input = createValidCompletionFixture();
  const withoutAuthDiff: CompletionPredicateInput = {
    ...input,
    authorizedDiffDigest: undefined,
    trustedPatchRecord: undefined,
  };
  const result = evaluateDeterministicCompletion(withoutAuthDiff);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('Independent authorizedDiffDigest is required')),
    `Expected reason for missing authorizedDiffDigest, got: ${result.reasons.join('; ')}`
  );
});

test('authorizedDiff: authorizedDiffDigest mismatch with currentDiffDigest prevents completion', () => {
  const input = createValidCompletionFixture();
  const mismatchedAuthDiff: CompletionPredicateInput = {
    ...input,
    authorizedDiffDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  };
  const result = evaluateDeterministicCompletion(mismatchedAuthDiff);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('Authorized diff digest mismatch')),
    `Expected reason for authorizedDiffDigest mismatch, got: ${result.reasons.join('; ')}`
  );
});

test('authorizedDiff: buildCompletionTransitionContext uses independent authorizedDiff and trustedReviewRecord', () => {
  const input = createValidCompletionFixture();
  const context = buildCompletionTransitionContext(input);

  assert.equal(context.authorizedDiffDigest, input.authorizedDiffDigest);
  assert.equal(context.reviewerRoleConfigId, input.trustedReviewRecord?.reviewerRoleConfigId);
  assert.equal(context.reviewIterationReservationRef, input.trustedReviewRecord?.iterationReservationRef);
  assert.equal(context.checkSetDigest, computeCheckSetDigest(input.task.requiredChecks));
});

/* ==================================================================
 * Section 10: Test Result Identity Validation (Defect 6)
 * ================================================================== */

test('executeVerificationChecks: runner returning mismatched checkId records error outcome', async () => {
  const input = createValidCompletionFixture();
  const spoofedRepo = new FakeRepositoryPort({
    initialRevision: input.currentRepoDigest,
    testResults: {
      default: {
        checkId: 'check-some-other-spoofed-id',
        outcome: 'pass',
      },
    },
  });

  const results = await executeVerificationChecks(input.task, spoofedRepo, {
    runId: 'run-verify-1',
    repoDigest: input.currentRepoDigest,
    diffDigest: input.currentDiffDigest,
  });

  assert.equal(results.length, input.task.requiredChecks.length);
  for (const r of results) {
    assert.equal(r.outcome, 'error', `Check ${r.testedIds[0]} should have failed closed with error due to mismatched checkId`);
  }
});

/* ==================================================================
 * Section 11: Pytest Node ID & Directory Test Protection (Defect 8)
 * ================================================================== */

test('protected tests: pytest node ID selector (tests/foo.py::test_bar) protects the underlying test file', () => {
  const checkWithNodeId: CheckDefinition = {
    checkId: 'check-pytest-node-id',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py::test_add_positive'],
    purpose: 'regression',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const taskWithNodeId = createFixtureBugTask({
    taskId: 'task-uc03-calc-node-id',
    repositoryId: 'repo-uc03-calc',
    requiredChecks: [checkWithNodeId],
  });
  const input = createValidCompletionFixture();
  const inputWithNodeIdCheck: CompletionPredicateInput = {
    ...input,
    task: taskWithNodeId,
    // Attempting to modify tests/test_calculator.py must be caught even though check had ::test_add_positive!
    changedFiles: ['tests/test_calculator.py'],
  };
  const result = evaluateDeterministicCompletion(inputWithNodeIdCheck);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('test protection violation')),
    `Expected test protection violation for modifying test file when check specified node ID, got: ${result.reasons.join('; ')}`
  );
});

test('protected tests: pytest invocation and option values determine which paths are protected', () => {
  const cases = [
    { executable: 'python3', argv: ['-m', 'pytest', '-k', 'src/filter.py', '--cov-report', 'src/report.py', 'tests/extra.py'], protectedPath: 'tests/extra.py' },
    { executable: 'pytest', argv: ['--deselect', 'tests/extra.py::test_other'], protectedPath: 'tests/extra.py' },
    { executable: 'pytest', argv: ['--deselect=tests/extra.py::test_other'], protectedPath: 'tests/extra.py' },
    { executable: 'python3', argv: ['src/compatibility.py'], protectedPath: undefined },
  ];
  for (const check of cases) {
    const input = createValidCompletionFixture();
    const template = input.task.requiredChecks[0];
    assert.ok(template);
    for (const changedFile of ['tests/extra.py', 'src/filter.py', 'src/report.py', 'src/compatibility.py']) {
      const result = evaluateDeterministicCompletion({
        ...input,
        task: {
          ...input.task,
          requiredChecks: [{ ...template, executable: check.executable, argv: check.argv }],
        },
        changedFiles: [changedFile],
      });
      assert.equal(
        result.reasons.some(reason => reason.includes('test protection violation')),
        changedFile === check.protectedPath,
        `${check.executable} ${check.argv.join(' ')}: ${changedFile}`
      );
    }
  }
});

test('protected tests: test directory selector (tests/unit) protects files under that directory', () => {
  const checkWithDir: CheckDefinition = {
    checkId: 'check-pytest-dir',
    executable: 'pytest',
    argv: ['-q', 'tests/unit'],
    purpose: 'regression',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const taskWithDir = createFixtureBugTask({
    taskId: 'task-uc03-calc-dir',
    repositoryId: 'repo-uc03-calc',
    requiredChecks: [checkWithDir],
  });
  const input = createValidCompletionFixture();
  const inputWithDirCheck: CompletionPredicateInput = {
    ...input,
    task: taskWithDir,
    // Attempting to modify a file inside tests/unit must be caught as test protection violation!
    changedFiles: ['tests/unit/test_feature.py'],
  };
  const result = evaluateDeterministicCompletion(inputWithDirCheck);

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.includes('test protection violation')),
    `Expected test protection violation for modifying file inside test directory, got: ${result.reasons.join('; ')}`
  );
});

/* ==================================================================
 * Section 12: End-to-End Investigation & Verification Integration
 * ================================================================== */

test('integration: investigateBaseline output flows directly into evaluateDeterministicCompletion and validateStateTransition without digest overrides', async () => {
  const repoDigest = 'sha256:111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000';
  const diffDigest = 'sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999';

  const checkRepro: CheckDefinition = {
    checkId: 'check-pytest-repro',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_div'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const checkRegress: CheckDefinition = {
    checkId: 'check-pytest-regress',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'regression',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };

  const task = createFixtureBugTask({
    taskId: 'task-flow-001',
    repositoryId: 'repo-flow',
    requiredChecks: [checkRepro, checkRegress],
  });

  const testFile = { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' };
  const host = {
    async loadSnapshot(req: {
      taskId: string;
      workspaceId: string;
      repositoryId: string;
      expectedRevisionDigest: string;
      expectedCheckSetDigest: string;
      expectedTestFiles: readonly string[];
    }) {
      return {
        taskId: req.taskId,
        workspaceId: req.workspaceId,
        repositoryId: req.repositoryId,
        currentRevision: req.expectedRevisionDigest,
        checkSetDigest: req.expectedCheckSetDigest,
        expectedTestFiles: req.expectedTestFiles,
        testFiles: [testFile],
      };
    },
  };

  const initialRepo = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    testResults: {
      'check-pytest-repro': { checkId: 'check-pytest-repro', outcome: 'fail', outputExcerpt: 'ZeroDivisionError' },
      'check-pytest-regress': { checkId: 'check-pytest-regress', outcome: 'pass', outputExcerpt: '1 passed' },
    },
  });

  const expectedCheckSetDigest = computeCheckSetDigest(task.requiredChecks);
  const expectedContext = {
    taskId: task.taskId,
    workspaceId: 'workspace-flow-001',
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: expectedCheckSetDigest,
    expectedTestFiles: ['tests/test_calculator.py'],
  };

  // 1. Run investigateBaseline
  const baselineResult = await investigateBaseline(task, initialRepo, host, expectedContext);
  assert.equal(baselineResult.status, 'reproduced');
  if (baselineResult.status !== 'reproduced' || !baselineResult.baseline) {
    throw new Error('Expected baseline to be reproduced with candidate');
  }
  const candidate = baselineResult.baseline;

  // 2. Verified checkSetDigest matches computeCheckSetDigest exactly
  assert.equal(candidate.checkSetDigest, expectedCheckSetDigest);

  const baseline: Baseline = {
    evidenceId: 'baseline-flow-001',
    repositorySnapshotDigest: candidate.repositorySnapshotDigest,
    checkSetDigest: candidate.checkSetDigest,
    reproductionFailureSignature: candidate.reproductionFailureSignature,
    checkResults: candidate.checkResults,
    testProtectionDigest: candidate.testProtectionDigest,
  };

  const planStrategy = 'Add check in divide';
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Division by zero',
    suspectedCauseLocations: ['src/calculator.py:10'],
    evidenceRefs: [baseline.evidenceId],
    strategy: planStrategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: baseline.checkSetDigest,
    baselineRef: baseline.evidenceId,
    strategyDigest: computeCanonicalSha256(planStrategy),
    decisionRef: 'dec-flow-001',
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
    activeDecisionId: 'dec-flow-001',
    latestReviewRef: 'review-flow-001',
    reviewRefs: ['review-flow-001'],
  };

  const patchedRepo = new FakeRepositoryPort({
    initialRevision: repoDigest,
    testResults: {
      'check-pytest-repro': { checkId: 'check-pytest-repro', outcome: 'pass' },
      'check-pytest-regress': { checkId: 'check-pytest-regress', outcome: 'pass' },
    },
  });

  const verificationResults = await executeVerificationChecks(task, patchedRepo, {
    runId: state.runId,
    repoDigest,
    diffDigest,
  });

  const reviewResult: ReviewResult = {
    reviewId: 'review-flow-001',
    reviewerRoleConfigId: 'role-reviewer-v1',
    repoDigest,
    diffDigest,
    checkSetDigest: candidate.checkSetDigest,
    status: 'accepted',
    findings: [],
    iterationReservationRef: 'res-flow-001',
  };

  const trustedReviewRecord: TrustedReviewRecord = {
    reviewId: reviewResult.reviewId,
    reviewerRoleConfigId: reviewResult.reviewerRoleConfigId,
    iterationReservationRef: reviewResult.iterationReservationRef,
    repoDigest,
    diffDigest,
    checkSetDigest: candidate.checkSetDigest,
    status: 'accepted',
  };

  const completionInput: CompletionPredicateInput = {
    task,
    state,
    baseline,
    verificationResults,
    reviewResult,
    currentRepoDigest: repoDigest,
    currentDiffDigest: diffDigest,
    changedFiles: ['src/calculator.py'],
    originalProtectedTestsDigest: candidate.testProtectionDigest,
    currentProtectedTestsDigest: candidate.testProtectionDigest,
    authorizedDiffDigest: diffDigest,
    trustedReviewRecord,
  };

  // 3. Evaluate deterministic completion with zero manual digest adjustments
  const completionResult = evaluateDeterministicCompletion(completionInput);
  assert.equal(completionResult.isComplete, true);
  assert.equal(completionResult.outcome, 'COMPLETED');
  assert.equal(completionResult.reasons.length, 0);

  // 4. Build trusted completion context
  const completionContext = buildCompletionTransitionContext(completionInput);
  assert.equal(completionContext.checkSetDigest, candidate.checkSetDigest);
  assert.equal(completionContext.authorizedDiffDigest, diffDigest);

  // 5. Test state transition to Deliver node
  const deliverState: TaskState = {
    ...state,
    stateVersion: state.stateVersion + 1,
    node: 'Deliver',
    outcome: 'COMPLETED',
    nextAction: 'ready-for-human-review',
  };

  const transitionRes = validateStateTransition(state, deliverState, {
    trusted: {
      completion: completionContext,
    },
  });
  assert.equal(transitionRes.ok, true, `validateStateTransition should succeed: ${transitionRes.ok ? '' : transitionRes.errors.map(e => e.message).join('; ')}`);
});

test('regression: changing check argv or executable invalidates stale baseline and prevents completion', () => {
  const input = createValidCompletionFixture();
  const firstCheck = input.task.requiredChecks[0];
  if (!firstCheck) throw new Error('Missing check in test fixture');
  const modifiedCheck: CheckDefinition = {
    ...firstCheck,
    argv: ['-q', '-v', 'tests/test_calculator.py'],
  };
  const changedTask: BugTask = {
    ...input.task,
    requiredChecks: [modifiedCheck, ...input.task.requiredChecks.slice(1)],
  };
  const result = evaluateDeterministicCompletion({
    ...input,
    task: changedTask,
  });

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes('checksetdigest')),
    'Must fail due to checkSetDigest mismatch between stale baseline and changed checks'
  );
});

test('regression: trustedReviewRecord checkSetDigest mismatch prevents completion', () => {
  const input = createValidCompletionFixture();
  if (!input.trustedReviewRecord) throw new Error('Missing trustedReviewRecord in fixture');
  const badReviewRecord: TrustedReviewRecord = {
    ...input.trustedReviewRecord,
    checkSetDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const result = evaluateDeterministicCompletion({
    ...input,
    trustedReviewRecord: badReviewRecord,
  });

  assert.equal(result.isComplete, false);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
});

// =========================================================================
// SECTION: v0.2 Atomic Admission & Guarded Verification Runs (T062 Behavioral RED)
// =========================================================================

test('v0.2 verification admission: guarded command carries approved plan binding and decisionRef', async () => {
  const task = createFixtureBugTask();
  const verifyCheck = task.requiredChecks[0]!;
  const action = {
    actionId: 'action-verify-' + verifyCheck.checkId,
    kind: 'run_command' as const,
    executable: verifyCheck.executable,
    argv: [...verifyCheck.argv],
    workingDirectory: verifyCheck.workingDirectory ?? 'tests',
    purpose: verifyCheck.purpose,
  };
  const planDecisionRef = 'dec-approved-plan-001';
  const tempContext = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });
  delete (tempContext as any).taskCriteriaDigest;
  delete (tempContext as any).checkSetDigest;
  const initial = createTestAdmissionTaskStateV02(tempContext);
  const state = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      {
        scope: 'task' as const,
        kind: 'timeoutMs' as const,
        limit: 60000,
        consumed: 0,
        reservations: [],
        unit: 'count' as const,
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
  const plan = state.plan!;
  const planBindingDigest = computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });

  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    planBindingDigest,
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });
  delete (admission as any).taskCriteriaDigest;
  delete (admission as any).checkSetDigest;

  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    commandResults: {
      default: {
        exitCode: 0,
        stdout: '1 passed',
        stderr: '',
      },
    },
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: repo } });

  const execContext = {
    runId: state.runId,
    repoDigest: state.repositoryRevisionDigest,
    admissionContext: admission,
    executionGuard,
    statePort: journal,
  };

  const results = await executeVerificationChecks(task, repo, execContext);

  assert.equal(repo.tests.length, 0, 'The v0.2 consumer must not call RepositoryPortV02.runTests directly');
  assert.equal(repo.commands.length, 1, `The approved check must reach the guard-owned command receiver once: ${JSON.stringify(results)}`);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.outcome, 'pass');
  assert.deepEqual(results[0]?.diagnosticRefs, ['execution-guard:success']);

  // Target v0.2 acceptance: Verification command must carry the approved-plan binding and decisionRef,
  // recording its observed outcome receipt in the StatePortV02 journal.
  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.claims.length, 1, 'The receiver must create exactly one journal claim');
  assert.equal(snapshot.attempts.length, 1, 'The receiver must begin exactly one attempt');
  assert.equal(snapshot.outcomes.length, 1, 'The receiver must settle exactly one outcome');
  assert.equal(snapshot.outcomes[0]?.outcome, 'observed', 'Outcome receipt must record observed check outcome');
  assert.equal(repo.v02Calls.length, 1, 'Receiver must record one admitted v0.2 call');
  const v02Call = repo.v02Calls[0];
  assert.equal(v02Call?.context.planApplicability, 'approved-plan', 'Context must carry approved-plan applicability');
  assert.equal(v02Call?.context.planDecisionRef, planDecisionRef, 'Context must bind the approved plan decisionRef');
  assert.equal(v02Call?.claim?.planApplicability, 'approved-plan', 'Claim must carry approved-plan applicability');
});

test('v0.2 verification admission: zero repository command effects when task has open claim', async () => {
  const task = createFixtureBugTask();
  const verifyCheck = task.requiredChecks[0]!;
  const action = {
    actionId: 'action-verify-' + verifyCheck.checkId,
    kind: 'run_command' as const,
    executable: verifyCheck.executable,
    argv: [...verifyCheck.argv],
    workingDirectory: verifyCheck.workingDirectory ?? 'tests',
    purpose: verifyCheck.purpose,
  };
  const planDecisionRef = 'dec-approved-plan-001';
  const tempContext = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });
  const initial = createTestAdmissionTaskStateV02(tempContext);
  const plan = initial.plan!;
  const planBindingDigest = computeCanonicalSha256({
    taskId: initial.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(initial.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });

  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    planBindingDigest,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });

  const state = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      {
        scope: 'task' as const,
        kind: 'timeoutMs' as const,
        limit: 60000,
        consumed: 0,
        reservations: [],
        unit: 'count' as const,
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };

  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  // Open an unresolved claim on the task
  const openClaim = await journal.claim(admission);
  assert.ok(openClaim.claimId, 'Open claim must have valid claimId');
  assert.equal(journal.getJournalSnapshot().activeClaimId, openClaim.claimId);

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: verifyCheck.checkId,
        outcome: 'pass',
        durationMs: 25,
      },
    },
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: repo } });

  const execContext = {
    runId: state.runId,
    repoDigest: state.repositoryRevisionDigest,
    admissionContext: admission,
    executionGuard,
    statePort: journal,
  };

  await executeVerificationChecks(task, repo, execContext);

  // Target v0.2 acceptance: An open claim blocks any new runTests effect and yields zero repository test effects.
  assert.equal(
    repo.tests.length,
    0,
    'Open claim must block the verification command and yield zero repository test effects'
  );
  assert.equal(repo.commands.length, 0, 'Open claims must not reach the command receiver');
  assert.equal(journal.getJournalSnapshot().claims.length, 1, 'No second claim may be created for an open claim');
  assert.equal(journal.getJournalSnapshot().attempts.length, 0, 'Open claims must not begin an attempt');
  assert.equal(journal.getJournalSnapshot().outcomes.length, 0, 'Open claims must not record an outcome');
});

test('v0.2 verification admission: zero repository command effects when task is paused', async () => {
  const task = createFixtureBugTask();
  const verifyCheck = task.requiredChecks[0]!;
  const action = {
    actionId: 'action-verify-' + verifyCheck.checkId,
    kind: 'run_command' as const,
    executable: verifyCheck.executable,
    argv: [...verifyCheck.argv],
    workingDirectory: verifyCheck.workingDirectory ?? 'tests',
    purpose: verifyCheck.purpose,
  };
  const planDecisionRef = 'dec-approved-plan-001';
  const tempContext = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });
  const state = createTestAdmissionTaskStateV02(tempContext);
  const plan = state.plan!;
  const planBindingDigest = computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });

  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    planBindingDigest,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });

  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialMode: 'paused',
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: verifyCheck.checkId,
        outcome: 'pass',
        durationMs: 25,
      },
    },
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: repo } });

  const execContext = {
    runId: state.runId,
    repoDigest: state.repositoryRevisionDigest,
    admissionContext: admission,
    executionGuard,
    statePort: journal,
  };

  await executeVerificationChecks(task, repo, execContext);

  // Target v0.2 acceptance: Paused task must block the verification command and yield zero repository test effects.
  assert.equal(
    repo.tests.length,
    0,
    'Paused task must block the verification command and yield zero repository test effects'
  );
  assert.equal(repo.commands.length, 0, 'Paused tasks must not reach the command receiver');
  assert.equal(journal.getJournalSnapshot().claims.length, 0, 'Paused tasks must not create a claim');
});

test('v0.2 verification admission: zero repository command effects on missing or malformed admission context', async () => {
  const task = createFixtureBugTask();
  const verifyCheck = task.requiredChecks[0]!;
  const action = {
    actionId: 'action-verify-' + verifyCheck.checkId,
    kind: 'run_command' as const,
    executable: verifyCheck.executable,
    argv: [...verifyCheck.argv],
    workingDirectory: verifyCheck.workingDirectory ?? 'tests',
    purpose: verifyCheck.purpose,
  };
  const planDecisionRef = 'dec-approved-plan-001';
  const tempContext = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });
  const state = createTestAdmissionTaskStateV02(tempContext);
  const plan = state.plan!;
  const planBindingDigest = computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });

  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-verify-001'],
    runnableNode: 'Verify',
    planApplicability: 'approved-plan',
    planDecisionRef,
    planBindingDigest,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: verifyCheck.checkId,
    testPath: 'tests/test_calculator.py',
  });

  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: verifyCheck.checkId,
        outcome: 'pass',
        durationMs: 25,
      },
    },
  });
  const executionGuard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: repo } });

  const execContext = {
    runId: state.runId,
    repoDigest: state.repositoryRevisionDigest,
    executionGuard,
    statePort: journal,
  };

  const results = await executeVerificationChecks(task, repo, execContext);

  // Target v0.2 acceptance: Missing or malformed admission context must deny the verification command and yield zero repository test effects.
  assert.equal(
    repo.tests.length,
    0,
    'Missing or malformed admission context must deny the verification command and yield zero repository test effects'
  );
  assert.equal(
    repo.v02Calls.length,
    0,
    'Missing or malformed admission context must not make v0.2 calls'
  );
  assert.equal(repo.commands.length, 0, 'Missing admission context must not reach the command receiver');
  assert.equal(journal.getJournalSnapshot().claims.length, 0, 'Missing admission context must not create a claim');
  assert.ok(
    results.length > 0 && results.every((r) => r.outcome === 'error'),
    'Denied verification checks must record error outcomes'
  );
});

test('v0.2 verification admission: missing or stale view, stale state, and stale approved plan fail closed before repository effects', async (t) => {
  const cases: Array<{
    readonly name: string;
    readonly alterAdmission?: (admission: RepositoryAdmissionContextV02) => void;
    readonly alterState?: (state: TaskState) => TaskState;
  }> = [
    {
      name: 'missing command view',
      alterAdmission: (admission) => { delete (admission as unknown as Record<string, unknown>).commandView; },
    },
    {
      name: 'stale command view revision',
      alterAdmission: (admission) => {
        const context = admission as unknown as Record<string, unknown>;
        context.commandView = {
          ...(context.commandView as Record<string, unknown>),
          canonicalRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        };
      },
    },
    {
      name: 'stale task state version',
      alterState: (state) => ({ ...state, stateVersion: state.stateVersion + 1 }),
    },
    {
      name: 'stale approved plan decision',
      alterState: (state) => ({ ...state, activeDecisionId: 'dec-stale-plan-002' }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = createGuardedVerificationFixture(scenario);
      const results = await executeVerificationChecks(fixture.task, fixture.repo, {
        runId: fixture.state.runId,
        repoDigest: fixture.state.repositoryRevisionDigest,
        admissionContext: fixture.admission,
        executionGuard: fixture.executionGuard,
        statePort: fixture.journal,
      });
      const snapshot = fixture.journal.getJournalSnapshot();
      assert.ok(results.length > 0 && results.every((result) => result.outcome === 'error'));
      assert.equal(fixture.repo.tests.length, 0);
      assert.equal(fixture.repo.commands.length, 0);
      assert.equal(fixture.repo.v02Calls.length, 0);
      assert.equal(snapshot.claims.length, 0);
      assert.equal(snapshot.attempts.length, 0);
      assert.equal(snapshot.outcomes.length, 0);
    });
  }
});

test('v0.2 verification admission: authoritative task mutation after guarded execution invalidates verification evidence', async () => {
  const fixture = createGuardedVerificationFixture({ mutateAfterExecution: true });
  const results = await executeVerificationChecks(fixture.task, fixture.repo, {
    runId: fixture.state.runId,
    repoDigest: fixture.state.repositoryRevisionDigest,
    admissionContext: fixture.admission,
    executionGuard: fixture.executionGuard,
    statePort: fixture.journal,
  });

  assert.equal(fixture.repo.commands.length, 1, 'The approved command executes through the receiver once');
  assert.equal(fixture.repo.tests.length, 0, 'The v0.2 caller must not use runTests');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.outcome, 'error');
  assert.ok(results[0]?.diagnosticRefs.includes('execution-guard:success'));
  assert.ok(results[0]?.diagnosticRefs.includes('authoritative-state-drift'));
  assert.equal(fixture.journal.getJournalSnapshot().outcomes.length, 1, 'The receiver settles the effect before state drift invalidates its evidence');
});
