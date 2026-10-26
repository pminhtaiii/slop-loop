import {
  computeCheckSetDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateDelivery,
  validateVerificationAdmission,
  validateVerificationResult,
} from '../contracts/foundation/uc03.ts';
import { extractCheckTestSelectors } from './selectors.ts';
import { completionReviewReasons } from './verification-review.ts';
import type {
  BugTask,
  Baseline,
  Delivery,
  ReviewResult,
  TaskOutcome,
  TaskState,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type {
  CompletionPredicateInput,
  CompletionPredicateResult,
} from './verification-types.ts';

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

  reasons.push(...completionReviewReasons({
    input,
    rawState,
    rawReview,
    currentRepoDigest,
    currentDiffDigest,
    expectedCheckSetDigest,
  }));

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
