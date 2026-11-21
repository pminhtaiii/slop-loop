/**
 * The owner completion context for the real tier's accepted-review delivery.
 *
 * The completion predicate needs facts the graph holds (the settled verification results and the
 * reviewer's accepted verdict) plus facts only the owner can supply: the current control head and its
 * policy identity, the recorded plan decision, the durable baseline record, the retained repository
 * diff, the host-measured protected-test snapshot, and the durable reviewer claim that reserved the
 * review iteration. This resolver re-reads every owner fact and returns `undefined` — never a
 * partial record — when any of them disagrees with the current route.
 *
 * The caller passes the Delivery candidate; the persisted owner state is still `Review` at that
 * moment, so owner facts are read from it and the candidate is only checked for agreement.
 *
 * Refusals: no current owner authority, a plan decision that is no longer the recorded human
 * approval, a missing or mismatched owner baseline, a protected-tests digest that differs from that
 * baseline, a check that did not pass on the current revision and diff, a re-measured diff that
 * differs from the request's, a review that is not accepted at the current revision, or no durable
 * settled reviewer claim for the review's reservation.
 */
import { computeCanonicalSha256, computeCheckSetDigest } from '../contracts/foundation/uc03.ts';
import type { BugTask, ReviewResult, TaskState, VerificationResult } from '../contracts/foundation/uc03.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../uc03/graph-types.ts';
import { requiredChecksPassed } from '../uc03/graph-validation.ts';
import { currentPlanApprovalIsCurrent } from '../uc03/post-patch-verification-authority.ts';
import { currentAuthority } from './real-tier-admissions.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';

export interface CompletionDiffSource {
  inspectDiff(baseRevisionDigest: string): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }>;
}

/** The review id the canonical reviewer mints: `review-<providerRequestId>`, whose durable claim is `claim-<providerRequestId>`. */
const REVIEWED_CLAIM = /^review-(.+)$/u;

export function realTierCompletionContext(
  assembly: RealTierAssembly,
  task: BugTask,
  port: DurableStatePortV02,
  repository: CompletionDiffSource,
): (request: UC03CompletionContextRequest) => Promise<UC03TrustedCompletion | undefined> {
  return request => resolveCompletionContext(assembly, task, port, repository, request);
}

async function resolveCompletionContext(
  assembly: RealTierAssembly,
  task: BugTask,
  port: DurableStatePortV02,
  repository: CompletionDiffSource,
  { state: candidate, reviewResult, verificationResults, reviewRequest, diffInfo, protectedTestsDigest, originalProtectedTestsDigest }: UC03CompletionContextRequest,
): Promise<UC03TrustedCompletion | undefined> {
  const state = await port.loadTask(task.taskId);
  if (!state || state.taskId !== task.taskId) return undefined;
  // Two legitimate callers: the Review node before its delivery transition (owner still `Review`),
  // and the Deliver node re-checking after it (owner already `Deliver`). Anything else is another route.
  const preDelivery = state.node === 'Review' && candidate.stateVersion === state.stateVersion + 1;
  const postDelivery = state.node === 'Deliver' && candidate.stateVersion === state.stateVersion;
  if (!preDelivery && !postDelivery) return undefined;
  const plan = state.plan;
  const decisionRef = plan?.decisionRef;
  const baselineRef = plan?.baselineRef;
  if (!plan || !decisionRef || !baselineRef) return undefined;
  if (candidate.taskId !== state.taskId || candidate.runId !== state.runId || candidate.repositoryRevisionDigest !== state.repositoryRevisionDigest || candidate.node !== 'Deliver') return undefined;
  const owner = await currentAuthority(port, state);
  if (!owner) return undefined;
  if (!(await currentPlanApprovalIsCurrent(task, state, port, decisionRef))) return undefined;

  // The owner's own baseline record, not the request's claim, supplies the original protected-tests digest.
  let baselineRecord;
  try {
    baselineRecord = await assembly.components.baselineEvidence.loadBaselineEvidence(task.taskId, state.workspaceId, task.repositoryId, baselineRef);
  } catch {
    return undefined;
  }
  if (!baselineRecord || baselineRecord.acknowledgement.evidenceId !== baselineRef) return undefined;

  const authorized = await repository.inspectDiff(task.initialRevisionDigest);
  const authorizedDiffDigest = authorized.diffDigest;
  if (computeCanonicalSha256(authorized.diff) !== authorizedDiffDigest || authorizedDiffDigest !== diffInfo.diffDigest) return undefined;

  // The current protected-test snapshot must be the one this route measured and equal to the baseline's.
  const originalProtected = baselineRecord.acknowledgement.testProtectionDigest;
  if (protectedTestsDigest !== originalProtected || originalProtectedTestsDigest !== originalProtected) return undefined;

  const checks: readonly VerificationResult[] = verificationResults;
  if (!requiredChecksPassed(task, state, authorizedDiffDigest, checks)) return undefined;

  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  // The owner reviews nothing itself: the review arrives as the graph's verdict, and the owner's own
  // facts are the durable settled reviewer claim and the candidate's declared review refs, which the
  // delivery transition then re-checks against the persisted record.
  const review = acceptedReview(candidate, reviewResult, reviewRequest.reservationRef, authorizedDiffDigest, checkSetDigest);
  if (!review) return undefined;
  // The reservation must be a durable, settled reviewer claim, not just a string the graph carried.
  const providerRequestId = REVIEWED_CLAIM.exec(review.reviewId)?.[1];
  if (!providerRequestId) return undefined;
  const claim = await port.readClaimState(`claim-${providerRequestId}`);
  if (
    !claim ||
    claim.status !== 'settled' ||
    claim.taskId !== state.taskId ||
    !claim.attempt ||
    claim.attempt.taskId !== state.taskId ||
    !claim.claim.reservationRefs.includes(review.iterationReservationRef)
  )
    return undefined;

  return {
    taskId: state.taskId,
    runId: state.runId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    diffDigest: authorizedDiffDigest,
    checkSetDigest,
    baselineRef,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    authorizedDiffDigest,
    protectedTestsDigest: originalProtected,
    originalProtectedTestsDigest: originalProtected,
    reviewerRoleConfigId: owner.policyIdentity.configId,
    reviewIterationReservationRef: review.iterationReservationRef,
    checks,
    review,
  };
}

/** The reviewer's verdict, only as the current revision's accepted review recorded by the owner state. */
function acceptedReview(state: TaskState, reviewResult: ReviewResult | undefined, reservationRef: string, diffDigest: string, checkSetDigest: string): ReviewResult | undefined {
  if (
    !reviewResult ||
    reviewResult.status !== 'accepted' ||
    reviewResult.reviewId !== state.latestReviewRef ||
    !state.reviewRefs?.includes(reviewResult.reviewId) ||
    reviewResult.iterationReservationRef !== reservationRef ||
    reviewResult.repoDigest !== state.repositoryRevisionDigest ||
    reviewResult.diffDigest !== diffDigest ||
    reviewResult.checkSetDigest !== checkSetDigest
  )
    return undefined;
  return reviewResult;
}
