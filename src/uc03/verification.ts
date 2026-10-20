/**
 * UC-03 Verified Code Repair - Verification & Deterministic Completion Predicates
 *
 * Owned path: src/uc03/verification.ts
 * Feature: specs/001-verified-code-repair
 * Task: T014 (deterministic verification and completion predicates)
 *
 * Requirements:
 * - FR-005: Require focused and regression checks, compatibility where applicable,
 *   final-diff validation and separate read-only review before completion.
 *   Later changes invalidate stale evidence.
 * - SC-001: 100% of required existing checks pass unchanged and accepted review
 *   of the same final state.
 * - SC-002: Incomplete required verification after applied changes is reported as
 *   IMPLEMENTED_UNVERIFIED; zero unverified or drifted cases claim completion.
 * - SC-004: Every delivered fix links baseline, final checks, review, and diff evidence.
 */

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateVerificationResult,
  validateReviewResult,
  validateDelivery,
  validateVerificationAdmission,
  validateReviewAdmission,
  type BugTask,
  type TaskState,
  type Baseline,
  type VerificationResult,
  type ReviewResult,
  type Delivery,
  type TaskOutcome,
  type RepositoryPort,
  type TrustedTransitionContext,
} from '../contracts/foundation/uc03.ts';
import { extractCheckTestSelectors } from './selectors.ts';

export interface TrustedReviewRecord {
  readonly reviewId: string;
  readonly reviewerRoleConfigId: string;
  readonly iterationReservationRef: string;
  readonly repoDigest: string;
  readonly diffDigest: string;
  readonly checkSetDigest: string;
  readonly status: 'accepted' | 'findings' | 'dismissed';
}

export interface CompletionPredicateInput {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly baseline: Baseline;
  readonly verificationResults: readonly VerificationResult[];
  readonly reviewResult: ReviewResult;
  readonly currentRepoDigest: string;
  readonly currentDiffDigest: string;
  readonly changedFiles: readonly string[];
  readonly originalProtectedTestsDigest: string;
  readonly currentProtectedTestsDigest: string;
  readonly trustedReviewRecord?: TrustedReviewRecord | undefined;
  readonly authorizedDiffDigest?: string | undefined;
  readonly trustedPatchRecord?: { readonly authorizedDiffDigest: string } | undefined;
}

export interface CompletionPredicateResult {
  readonly isComplete: boolean;
  readonly outcome: TaskOutcome;
  readonly delivery?: Delivery | undefined;
  readonly reasons: readonly string[];
}

export interface VerificationExecutionContext {
  readonly runId: string;
  readonly repoDigest: string;
  readonly diffDigest?: string | undefined;
  readonly actionIdPrefix?: string | undefined;
}

/**
 * Evaluates deterministic completion predicates against current repository state,
 * verified test evidence, review status, and test protection digest.
 *
 * Enforces:
 * 1. Protected test integrity: original and current protected test digests must match.
 * 2. Repository and diff digest drift: all verification results and review results must
 *    match current repository revision and current diff digest.
 * 3. Required checks coverage: every required check in task.requiredChecks must have
 *    a passing verification result for current digests, distinguishing timeout, not-run,
 *    and environment failures.
 * 4. Read-only review acceptance: review result must have status 'accepted' and zero
 *    actionable findings (severity error or warning) for current state.
 * 5. Applied change validation: all changedFiles must be canonical non-protected paths,
 *    and changedFiles cannot be empty for completed outcome.
 * 6. Delivery construction: upon deterministic completion, constructs a canonical
 *    Delivery record linking baseline, verification results, review, and diff evidence.
 * 7. Invalidation: unverified or drifted modifications return IMPLEMENTED_UNVERIFIED;
 *    unmodified unverified states return INCOMPLETE.
 */
export function evaluateDeterministicCompletion(
  input: CompletionPredicateInput
): CompletionPredicateResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      isComplete: false,
      outcome: 'INCOMPLETE',
      reasons: Object.freeze(['Invalid or missing completion predicate input']),
    };
  }

  // Defensive detach of input fields
  let rawTask: BugTask | undefined;
  let rawState: TaskState | undefined;
  let rawBaseline: Baseline | undefined;
  let rawVerifications: readonly VerificationResult[] = [];
  let rawReview: ReviewResult | undefined;
  let currentRepoDigest = '';
  let currentDiffDigest = '';
  let changedFilesList: readonly string[] = [];
  let originalProtectedTestsDigest = '';
  let currentProtectedTestsDigest = '';

  try {
    rawTask = input.task;
    rawState = input.state;
    rawBaseline = input.baseline;
    rawVerifications = Array.isArray(input.verificationResults)
      ? [...input.verificationResults]
      : [];
    rawReview = input.reviewResult;
    currentRepoDigest =
      typeof input.currentRepoDigest === 'string' ? input.currentRepoDigest : '';
    currentDiffDigest =
      typeof input.currentDiffDigest === 'string' ? input.currentDiffDigest : '';
    changedFilesList = Array.isArray(input.changedFiles)
      ? [...input.changedFiles]
      : [];
    originalProtectedTestsDigest =
      typeof input.originalProtectedTestsDigest === 'string'
        ? input.originalProtectedTestsDigest
        : '';
    currentProtectedTestsDigest =
      typeof input.currentProtectedTestsDigest === 'string'
        ? input.currentProtectedTestsDigest
        : '';
  } catch {
    return {
      isComplete: false,
      outcome: 'INCOMPLETE',
      reasons: Object.freeze(['Failed to read completion predicate input properties']),
    };
  }

  // Determine whether repository changes were made or recorded
  const hasChangedFiles = changedFilesList.length > 0;
  const hasStateChangedPaths =
    rawState !== undefined &&
    Array.isArray(rawState.changedPaths) &&
    rawState.changedPaths.length > 0;
  const hasModifications = hasChangedFiles || hasStateChangedPaths;
  const failureOutcome: TaskOutcome = hasModifications
    ? 'IMPLEMENTED_UNVERIFIED'
    : 'INCOMPLETE';

  const reasons: string[] = [];

  // 1. Protected Tests Digest Integrity
  if (!originalProtectedTestsDigest || !currentProtectedTestsDigest) {
    reasons.push(
      'Protected tests digest missing: both original and current digests are required'
    );
  } else if (originalProtectedTestsDigest !== currentProtectedTestsDigest) {
    reasons.push(
      `Protected tests digest modified or tampered: original digest (${originalProtectedTestsDigest}) does not match current digest (${currentProtectedTestsDigest})`
    );
  }

  if (rawBaseline) {
    if (
      typeof rawBaseline.testProtectionDigest !== 'string' ||
      rawBaseline.testProtectionDigest.trim().length === 0
    ) {
      reasons.push(
        'Protected tests baseline testProtectionDigest missing or invalid'
      );
    } else if (
      originalProtectedTestsDigest &&
      rawBaseline.testProtectionDigest !== originalProtectedTestsDigest
    ) {
      reasons.push(
        `Protected tests baseline digest mismatch: expected ${originalProtectedTestsDigest}, got ${rawBaseline.testProtectionDigest}`
      );
    }
  }

  // 2. Digest Presence and Authorization Integrity
  if (!currentRepoDigest || currentRepoDigest.trim().length === 0) {
    reasons.push('currentRepoDigest must be a non-empty string');
  }
  if (!currentDiffDigest || currentDiffDigest.trim().length === 0) {
    reasons.push('currentDiffDigest must be a non-empty string');
  }
  const authorizedDiff =
    input.authorizedDiffDigest ?? input.trustedPatchRecord?.authorizedDiffDigest;
  if (!authorizedDiff || authorizedDiff.trim().length === 0) {
    reasons.push('Independent authorizedDiffDigest is required for completion');
  } else if (currentDiffDigest && authorizedDiff !== currentDiffDigest) {
    reasons.push(
      `Authorized diff digest mismatch: authorized (${authorizedDiff}) does not match current diff digest (${currentDiffDigest})`
    );
  }

  // 3. State Binding and Revision Drift
  if (!rawState) {
    reasons.push('Missing required task state');
  } else {
    if (
      currentRepoDigest &&
      rawState.repositoryRevisionDigest !== currentRepoDigest
    ) {
      reasons.push(
        `Repository revision digest drift: state revision (${rawState.repositoryRevisionDigest}) differs from current repository digest (${currentRepoDigest})`
      );
    }
    if (rawTask && rawState.taskId !== rawTask.taskId) {
      reasons.push(
        `State taskId (${rawState.taskId}) does not match task taskId (${rawTask.taskId})`
      );
    }
    if (
      rawState.taskContext &&
      rawTask &&
      rawState.taskContext.taskId !== rawTask.taskId
    ) {
      reasons.push(
        `State taskContext taskId (${rawState.taskContext.taskId}) does not match task taskId (${rawTask.taskId})`
      );
    }
  }

  // 4. Baseline Binding
  let expectedCheckSetDigest = '';
  if (!rawTask) {
    reasons.push('Missing required bug task');
  } else if (!Array.isArray(rawTask.requiredChecks)) {
    reasons.push('Task requiredChecks must be an array');
  } else {
    expectedCheckSetDigest = computeCheckSetDigest(rawTask.requiredChecks);
  }

  if (!rawBaseline) {
    reasons.push('Missing required baseline evidence');
  } else {
    if (
      typeof rawBaseline.evidenceId !== 'string' ||
      rawBaseline.evidenceId.trim().length === 0
    ) {
      reasons.push('Baseline evidenceId must be a non-empty string');
    }
    if (
      expectedCheckSetDigest &&
      rawBaseline.checkSetDigest !== expectedCheckSetDigest
    ) {
      reasons.push(
        `Baseline checkSetDigest mismatch: expected ${expectedCheckSetDigest}, got ${rawBaseline.checkSetDigest}`
      );
    }
    if (rawState) {
      if (!rawState.plan) {
        reasons.push('Missing required fix plan in task state');
      } else {
        if (
          rawBaseline.evidenceId &&
          rawState.plan.baselineRef !== rawBaseline.evidenceId
        ) {
          reasons.push(
            `Plan baselineRef (${rawState.plan.baselineRef}) does not match baseline evidenceId (${rawBaseline.evidenceId})`
          );
        }
        if (
          expectedCheckSetDigest &&
          rawState.plan.checkSetDigest !== expectedCheckSetDigest
        ) {
          reasons.push(
            `Plan checkSetDigest (${rawState.plan.checkSetDigest}) does not match expected checkSetDigest (${expectedCheckSetDigest})`
          );
        }
      }
      if (rawBaseline.evidenceId) {
        if (
          !Array.isArray(rawState.evidenceRefs) ||
          !rawState.evidenceRefs.includes(rawBaseline.evidenceId)
        ) {
          reasons.push(
            `State evidenceRefs does not include baseline evidenceId (${rawBaseline.evidenceId})`
          );
        }
      }
    }
  }

  // 5. Verification Results Validation and Digest Drift
  if (!Array.isArray(rawVerifications) || rawVerifications.length === 0) {
    reasons.push(
      'verificationResults must be a non-empty array of VerificationResult records'
    );
  } else {
    for (let i = 0; i < rawVerifications.length; i++) {
      const v = rawVerifications[i];
      if (!v) {
        reasons.push(`Verification result at index ${i} is null or undefined`);
        continue;
      }
      const vShape = validateVerificationResult(v, `verificationResults[${i}]`);
      if (!vShape.ok) {
        reasons.push(
          `Verification result schema error: ${vShape.errors.map((e) => e.message).join('; ')}`
        );
        continue;
      }
      if (rawTask && v.taskId !== rawTask.taskId) {
        reasons.push(
          `Verification result ${v.evidenceId} taskId mismatch: expected ${rawTask.taskId}, got ${v.taskId}`
        );
      }
      if (rawState && v.runId !== rawState.runId) {
        reasons.push(
          `Verification result ${v.evidenceId} runId mismatch: expected ${rawState.runId}, got ${v.runId}`
        );
      }
      if (currentRepoDigest && v.repoDigest !== currentRepoDigest) {
        reasons.push(
          `Verification result ${v.evidenceId} repository digest drift: expected ${currentRepoDigest}, got ${v.repoDigest}`
        );
      }
      if (currentDiffDigest) {
        if (v.diffDigest === undefined || v.diffDigest.trim().length === 0) {
          reasons.push(
            `Verification result ${v.evidenceId} missing diff digest for candidate modification: expected ${currentDiffDigest}`
          );
        } else if (v.diffDigest !== currentDiffDigest) {
          reasons.push(
            `Verification result ${v.evidenceId} diff digest drift: expected ${currentDiffDigest}, got ${v.diffDigest}`
          );
        }
      }
    }
  }

  // 6. Required Checks Coverage
  if (rawTask && Array.isArray(rawTask.requiredChecks)) {
    for (const check of rawTask.requiredChecks) {
      const expectedPhase =
        check.purpose === 'reproduction' ? 'focused' : check.purpose;
      const matching = rawVerifications.filter(
        (v) =>
          v &&
          Array.isArray(v.testedIds) &&
          v.testedIds.includes(check.checkId) &&
          (!currentRepoDigest || v.repoDigest === currentRepoDigest) &&
          (!currentDiffDigest || v.diffDigest === currentDiffDigest) &&
          (!rawTask || v.taskId === rawTask.taskId) &&
          (!rawState || v.runId === rawState.runId)
      );

      if (matching.length === 0) {
        reasons.push(
          `Missing verification result for required check '${check.checkId}' (check not run on current state)`
        );
        continue;
      }

      let hasPassingResult = false;
      for (const m of matching) {
        if (m.outcome === 'pass') {
          if (m.phase !== expectedPhase) {
            reasons.push(
              `Verification result phase mismatch for check '${check.checkId}': expected '${expectedPhase}', got '${m.phase}'`
            );
          } else {
            if (rawTask && rawState && currentRepoDigest) {
              const admission = validateVerificationAdmission(m, {
                expectedTaskId: rawTask.taskId,
                expectedRunId: rawState.runId,
                expectedRepoDigest: currentRepoDigest,
                expectedDiffDigest: currentDiffDigest || undefined,
                expectedCheckId: check.checkId,
                requiredPhase: expectedPhase,
              });
              if (!admission.ok) {
                reasons.push(
                  `Verification admission failed for check '${check.checkId}': ${admission.errors.map((e) => e.message).join('; ')}`
                );
              } else {
                hasPassingResult = true;
              }
            } else {
              hasPassingResult = true;
            }
          }
        } else if (m.outcome === 'timeout') {
          reasons.push(
            `Required check '${check.checkId}' timed out (timeout)`
          );
        } else if (m.outcome === 'not-run') {
          reasons.push(`Required check '${check.checkId}' was not run`);
        } else if (m.outcome === 'error') {
          reasons.push(
            `Required check '${check.checkId}' failed with environment error`
          );
        } else if (m.outcome === 'fail') {
          const checkLabel =
            check.purpose === 'regression' ? 'regression check' : 'check';
          reasons.push(`Required ${checkLabel} '${check.checkId}' failed`);
        } else {
          reasons.push(
            `Required check '${check.checkId}' outcome is '${m.outcome}'`
          );
        }
      }

      if (
        !hasPassingResult &&
        !matching.some((m) =>
          ['timeout', 'not-run', 'error', 'fail'].includes(m.outcome)
        )
      ) {
        reasons.push(
          `Required check '${check.checkId}' did not pass verification on current state`
        );
      }
    }
  }

  // 7. Review Result Validation & Acceptance
  if (!rawReview) {
    reasons.push('Missing required review result');
  } else {
    const revShape = validateReviewResult(rawReview);
    if (!revShape.ok) {
      reasons.push(
        `Review result schema error: ${revShape.errors.map((e) => e.message).join('; ')}`
      );
    }
    if (
      !rawReview.reviewerRoleConfigId ||
      rawReview.reviewerRoleConfigId.trim().length === 0
    ) {
      reasons.push(
        'Review result reviewerRoleConfigId is required for completion'
      );
    }
    if (
      !rawReview.iterationReservationRef ||
      rawReview.iterationReservationRef.trim().length === 0
    ) {
      reasons.push(
        'Review result iterationReservationRef is required for completion'
      );
    }
    if (currentRepoDigest && rawReview.repoDigest !== currentRepoDigest) {
      reasons.push(
        `Review result repository digest drift: expected ${currentRepoDigest}, got ${rawReview.repoDigest}`
      );
    }
    if (currentDiffDigest && rawReview.diffDigest !== currentDiffDigest) {
      reasons.push(
        `Review result diff digest drift: expected ${currentDiffDigest}, got ${rawReview.diffDigest}`
      );
    }
    if (
      expectedCheckSetDigest &&
      rawReview.checkSetDigest !== expectedCheckSetDigest
    ) {
      reasons.push(
        `Review result checkSetDigest mismatch: expected ${expectedCheckSetDigest}, got ${rawReview.checkSetDigest}`
      );
    }

    if (rawReview.status === 'findings') {
      const findingList = Array.isArray(rawReview.findings)
        ? rawReview.findings
        : [];
      const msgs =
        findingList.length > 0
          ? findingList.map((f) => `${f.file}:${f.line} ${f.message}`).join('; ')
          : 'unspecified review findings';
      reasons.push(`Review result contains actionable findings: ${msgs}`);
    } else if (rawReview.status !== 'accepted') {
      reasons.push(`Review result status is not accepted: ${rawReview.status}`);
    }

    if (Array.isArray(rawReview.findings)) {
      const actionable = rawReview.findings.filter(
        (f) => f.severity === 'error' || f.severity === 'warning'
      );
      if (actionable.length > 0 && rawReview.status === 'accepted') {
        reasons.push(
          'Review result with status accepted contains actionable findings (error or warning)'
        );
      }
    }

    if (!rawState?.latestReviewRef || rawState.latestReviewRef.trim().length === 0) {
      reasons.push('State latestReviewRef is required for completion');
    } else if (rawReview.reviewId !== rawState.latestReviewRef) {
      reasons.push(
        `Review ID (${rawReview.reviewId}) does not match state latestReviewRef (${rawState.latestReviewRef})`
      );
    }
    if (
      rawState?.reviewRefs &&
      !rawState.reviewRefs.includes(rawReview.reviewId)
    ) {
      reasons.push(
        `Review ID (${rawReview.reviewId}) is not included in state reviewRefs`
      );
    }

    const trustedReview = input.trustedReviewRecord;
    if (!trustedReview) {
      reasons.push('Independent trustedReviewRecord is required for completion');
    } else {
      if (trustedReview.reviewId !== rawReview.reviewId) {
        reasons.push(
          `Trusted review record reviewId mismatch: expected '${trustedReview.reviewId}', got '${rawReview.reviewId}'`
        );
      }
      if (trustedReview.reviewerRoleConfigId !== rawReview.reviewerRoleConfigId) {
        reasons.push(
          `Reviewer role config ID mismatch with independent review record: expected '${trustedReview.reviewerRoleConfigId}', got '${rawReview.reviewerRoleConfigId}'`
        );
      }
      if (trustedReview.iterationReservationRef !== rawReview.iterationReservationRef) {
        reasons.push(
          `Review iteration reservation ref mismatch with independent review record: expected '${trustedReview.iterationReservationRef}', got '${rawReview.iterationReservationRef}'`
        );
      }
      if (currentRepoDigest && trustedReview.repoDigest !== currentRepoDigest) {
        reasons.push(
          `Trusted review record repository digest mismatch: expected '${currentRepoDigest}', got '${trustedReview.repoDigest}'`
        );
      }
      if (currentDiffDigest && trustedReview.diffDigest !== currentDiffDigest) {
        reasons.push(
          `Trusted review record diff digest mismatch: expected '${currentDiffDigest}', got '${trustedReview.diffDigest}'`
        );
      }
      if (trustedReview.status !== 'accepted') {
        reasons.push(
          `Trusted review record status is not accepted: '${trustedReview.status}'`
        );
      }
      if (
        expectedCheckSetDigest &&
        trustedReview.checkSetDigest !== expectedCheckSetDigest
      ) {
        reasons.push(
          `Trusted review record checkSetDigest mismatch: expected '${expectedCheckSetDigest}', got '${trustedReview.checkSetDigest}'`
        );
      }

      if (
        rawState &&
        currentRepoDigest &&
        currentDiffDigest &&
        expectedCheckSetDigest
      ) {
        const reviewAdmission = validateReviewAdmission(rawReview, {
          expectedReviewId: rawState.latestReviewRef,
          expectedRepoDigest: currentRepoDigest,
          expectedDiffDigest: currentDiffDigest,
          expectedCheckSetDigest,
          expectedRoleConfigId: trustedReview.reviewerRoleConfigId,
          expectedIterationReservationRef: trustedReview.iterationReservationRef,
        });
        if (!reviewAdmission.ok) {
          for (const err of reviewAdmission.errors) {
            reasons.push(`Review admission error: ${err.message}`);
          }
        }
      }
    }
  }

  // 8. Changed Files & Path Protection Validation
  if (reasons.length === 0 && changedFilesList.length === 0) {
    reasons.push('changedFiles cannot be empty for COMPLETED outcome');
  }

  const protectedTestFiles = new Set<string>();
  const protectedTestDirs = new Set<string>();
  if (rawTask && Array.isArray(rawTask.requiredChecks)) {
    for (const check of rawTask.requiredChecks) {
      const selectors = extractCheckTestSelectors(check);
      for (const sel of selectors) {
        if (sel.isDirectory) {
          protectedTestDirs.add(sel.filePath.toLowerCase());
        } else {
          protectedTestFiles.add(sel.filePath.toLowerCase());
        }
      }
    }
  }

  const rawBaselineExpected = (rawBaseline as { expectedTestFiles?: unknown })?.expectedTestFiles;
  if (Array.isArray(rawBaselineExpected)) {
    for (const exp of rawBaselineExpected) {
      if (typeof exp === 'string') {
        protectedTestFiles.add(exp.toLowerCase());
      }
    }
  }

  const isProtectedTestFile = (path: string): boolean => {
    const norm = path.toLowerCase();
    if (protectedTestFiles.has(norm)) {
      return true;
    }
    for (const dir of protectedTestDirs) {
      const dirPrefix = dir + '/';
      if (norm === dir || norm.startsWith(dirPrefix)) {
        return true;
      }
    }
    return false;
  };

  for (const file of changedFilesList) {
    if (typeof file !== 'string' || !isCanonicalRelativePath(file)) {
      reasons.push(
        `Changed file '${file}' is not a canonical repository-relative path`
      );
    } else if (isProtectedPath(file) || isProtectedTestFile(file)) {
      reasons.push(
        `Changed file '${file}' attempts to modify a protected path or existing protected test (test protection violation)`
      );
    }
  }

  // 9. Delivery Construction & Outcome Resolution
  if (reasons.length > 0) {
    return {
      isComplete: false,
      outcome: failureOutcome,
      delivery: undefined,
      reasons: Object.freeze(reasons),
    };
  }

  const validTask = rawTask;
  const validState = rawState;
  const validBaseline = rawBaseline;
  const validReview = rawReview;

  if (!validTask || !validState || !validBaseline || !validReview) {
    return {
      isComplete: false,
      outcome: failureOutcome,
      delivery: undefined,
      reasons: Object.freeze(['Internal verification state incomplete']),
    };
  }

  const deliveryCandidate: Delivery = {
    taskId: validTask.taskId,
    runId: validState.runId,
    outcome: 'COMPLETED',
    diffDigest: currentDiffDigest,
    changedFiles: Object.freeze([...changedFilesList]),
    baselineRef: validBaseline.evidenceId,
    verificationRefs: Object.freeze(rawVerifications.map((v) => v.evidenceId)),
    reviewRef: validReview.reviewId,
    limitations: Object.freeze([]),
    safeNextAction: 'ready-for-human-review',
  };

  const deliveryValidation = validateDelivery(deliveryCandidate, {
    expectedTaskId: validTask.taskId,
    expectedRunId: validState.runId,
    expectedDiffDigest: currentDiffDigest,
    expectedBaselineRef: validBaseline.evidenceId,
    expectedReviewRef: validReview.reviewId,
  });
  if (!deliveryValidation.ok) {
    return {
      isComplete: false,
      outcome: failureOutcome,
      delivery: undefined,
      reasons: Object.freeze(
        deliveryValidation.errors.map((e) => e.message)
      ),
    };
  }

  return {
    isComplete: true,
    outcome: 'COMPLETED',
    delivery: Object.freeze(deliveryValidation.value),
    reasons: Object.freeze([]),
  };
}

/**
 * Executes required verification checks on a candidate repository revision,
 * creating validated VerificationResult records for each check definition.
 */
export async function executeVerificationChecks(
  task: BugTask,
  repository: RepositoryPort,
  context: VerificationExecutionContext
): Promise<readonly VerificationResult[]> {
  if (!task || !Array.isArray(task.requiredChecks)) {
    throw new Error('INVALID_TASK: BugTask requiredChecks must be an array');
  }
  if (!repository || typeof repository.runTests !== 'function') {
    throw new Error('INVALID_REPOSITORY: RepositoryPort runTests must be a function');
  }
  if (!context || typeof context !== 'object' || !context.runId || !context.repoDigest) {
    throw new Error('INVALID_CONTEXT: VerificationExecutionContext requires runId and repoDigest');
  }

  const results: VerificationResult[] = [];

  for (const check of task.requiredChecks) {
    const phase =
      check.purpose === 'reproduction' ? 'focused' : check.purpose;
    const prefix = context.actionIdPrefix ?? 'action-verify';
    const actionId = `${prefix}-${check.checkId}`;
    const evidenceId = `evidence-verif-${check.checkId}-${computeCanonicalSha256([
      context.runId,
      check.checkId,
      context.repoDigest,
      context.diffDigest ?? '',
    ])}`;

    let outcome: VerificationResult['outcome'] = 'error';

    try {
      const checkResult = await repository.runTests(check);
      if (
        checkResult &&
        typeof checkResult === 'object' &&
        'checkId' in checkResult &&
        checkResult.checkId === check.checkId &&
        'outcome' in checkResult &&
        typeof checkResult.outcome === 'string' &&
        ['pass', 'fail', 'timeout', 'error', 'not-run'].includes(checkResult.outcome)
      ) {
        outcome = checkResult.outcome as VerificationResult['outcome'];
      } else {
        outcome = 'error';
      }
    } catch {
      outcome = 'error';
    }

    const verificationResult: VerificationResult = {
      evidenceId,
      taskId: task.taskId,
      runId: context.runId,
      actionId,
      phase,
      repoDigest: context.repoDigest,
      ...(context.diffDigest !== undefined
        ? { diffDigest: context.diffDigest }
        : {}),
      commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
      outcome,
      testedIds: [check.checkId],
      diagnosticRefs: [],
    };

    const validRes = validateVerificationResult(verificationResult);
    if (!validRes.ok) {
      throw new Error(
        `INVALID_VERIFICATION_RESULT: ${validRes.errors.map((e) => e.message).join('; ')}`
      );
    }

    results.push(validRes.value);
  }

  return Object.freeze(results);
}

/**
 * Builds the trusted completion context required for StatePort transition to Deliver.
 */
export function buildCompletionTransitionContext(
  input: CompletionPredicateInput
): NonNullable<NonNullable<TrustedTransitionContext>['completion']> {
  const evalResult = evaluateDeterministicCompletion(input);
  if (!evalResult.isComplete || !evalResult.delivery) {
    throw new Error(
      `CANNOT_BUILD_COMPLETION_CONTEXT: Deterministic completion predicates not satisfied: ${evalResult.reasons.join('; ')}`
    );
  }

  const expectedCheckSetDigest = computeCheckSetDigest(input.task.requiredChecks);
  const criteriaDigest = computeCanonicalSha256(
    input.task.acceptanceCriteria
  );

  const authorizedDiff =
    input.authorizedDiffDigest ?? input.trustedPatchRecord?.authorizedDiffDigest;
  if (!authorizedDiff) {
    throw new Error(
      'CANNOT_BUILD_COMPLETION_CONTEXT: Missing independent authorizedDiffDigest'
    );
  }
  if (!input.trustedReviewRecord) {
    throw new Error(
      'CANNOT_BUILD_COMPLETION_CONTEXT: Missing independent trustedReviewRecord'
    );
  }

  return {
    taskId: input.task.taskId,
    runId: input.state.runId,
    repositoryRevisionDigest: input.currentRepoDigest,
    diffDigest: input.currentDiffDigest,
    checkSetDigest: expectedCheckSetDigest,
    baselineRef: input.baseline.evidenceId,
    criteriaDigest,
    authorizedDiffDigest: authorizedDiff,
    protectedTestsDigest: input.currentProtectedTestsDigest,
    originalProtectedTestsDigest: input.originalProtectedTestsDigest,
    reviewerRoleConfigId: input.trustedReviewRecord.reviewerRoleConfigId,
    reviewIterationReservationRef: input.trustedReviewRecord.iterationReservationRef,
    checks: input.verificationResults,
    review: input.reviewResult,
  };
}
