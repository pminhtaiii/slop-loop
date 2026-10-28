import { computeCanonicalSha256, computeCheckSetDigest } from '../contracts/foundation/uc03.ts';
import type { TrustedTransitionContext } from '../contracts/foundation/uc03.ts';
import { evaluateDeterministicCompletion } from './verification-completion.ts';
import type { CompletionPredicateInput } from './verification-types.ts';

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
