import {
  validateReviewAdmission,
  validateReviewResult,
} from '../contracts/foundation/uc03.ts';
import type {
  ReviewResult,
  TaskState,
} from '../contracts/foundation/uc03.ts';
import type { CompletionPredicateInput } from './verification-types.ts';

export function completionReviewReasons(context: {
  readonly input: CompletionPredicateInput;
  readonly rawState: TaskState | undefined;
  readonly rawReview: ReviewResult | undefined;
  readonly currentRepoDigest: string;
  readonly currentDiffDigest: string;
  readonly expectedCheckSetDigest: string;
}): string[] {
  const {
    input,
    rawState,
    rawReview,
    currentRepoDigest,
    currentDiffDigest,
    expectedCheckSetDigest,
  } = context;
  const reasons: string[] = [];
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

  return reasons;
}
