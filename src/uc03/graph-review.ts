/** Review stage: one node factory hides admission, dispatch, and completion handling. */
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  validateProviderAdmissionV02,
  validateProviderRequest,
  validateReviewAdmission,
  validateReviewResult,
  type TaskState,
  type ReviewResult,
  type ProviderRequest,
} from '../contracts/foundation/uc03.ts';
import { reviewerContextDigest } from '../foundation/reviewer.ts';
import { evaluateDeterministicCompletion } from './verification.ts';
import { loadCompletionPredicateInput, reportForPredicate } from './graph-completion.ts';
import { loadVerifiedPatchAncestry } from './graph-patch-ancestry.ts';
import { currentPlanApprovalIsCurrent } from './post-patch-verification-authority.ts';
import { addMilestone, reviewAdmissionMatchesState, trustedExpectedContext, trustedOwnerStateMatches, validDiffInfo } from './graph-validation.ts';
import { reloadAuthoritativeState, transitionState } from './graph-transitions.ts';
import { buildFinalReport } from './report.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';
import type { ReviewObservationV1 } from '../contracts/review.ts';
import { boundReviewEnabled, prepareBoundReview, persistBoundReview, loadBoundReview } from './verification-review.ts';

type ReviewPorts = Pick<UC03GraphPorts, 'statePort' | 'repositoryPort' | 'reviewerPort' | 'hostAuthority'>;
type ReviewConfig = Pick<
  UC03GraphConfig,
  'reviewerAdmission' | 'trustedExpectedContext' | 'trustedTransitionContext' | 'reviewContext' | 'reviewEvidence' | 'reviewPrompt' | 'reviewerContextResolver' | 'mode'
>;

export function createReviewNode(ports: ReviewPorts, config?: ReviewConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Review') return { terminalOutcome: 'INCOMPLETE' as const };
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    const admissionSource = config?.reviewerAdmission;
    if (boundReviewEnabled(config) && (!config?.reviewContext || !config.reviewEvidence)) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['EVIDENCE_UNACKNOWLEDGED: bound review requires its observation owner'] };
    }
    if (!state.baseline || !state.verificationResults?.length || !admissionSource) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Review requires persisted baseline/check evidence and owner-issued provider admission'] };
    }
    const trusted = trustedExpectedContext(config, state.task, current.state);
    const owner = trusted?.statePort;
    const decisionId = current.state.plan?.decisionRef;
    const ancestry = owner ? await loadVerifiedPatchAncestry(state.task, current.state, owner) : undefined;
    if (
      !owner ||
      !ancestry ||
      !decisionId ||
      (state.patchAdmission && computeCanonicalSha256(state.patchAdmission) !== computeCanonicalSha256(ancestry.admission)) ||
      (state.patchReceipt && computeCanonicalSha256(state.patchReceipt) !== computeCanonicalSha256(ancestry.receipt)) ||
      !(await currentPlanApprovalIsCurrent(state.task, current.state, owner, decisionId))
    ) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Review requires current issuer-approved D1 and owner-validated D0 patch ancestry'] };
    }
    const diffInfo = await ports.repositoryPort.inspectDiff(state.task.initialRevisionDigest);
    if (!validDiffInfo(diffInfo)) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Current repository diff response is invalid'] };
    if (!trusted) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer requires the current owner StatePortV02 boundary'] };
    if (!(await trustedOwnerStateMatches(trusted, current.state)))
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Trusted reviewer and route ports do not share current owner task state'] };
    let reviewed: { result: ReviewResult; ownerState: TaskState; request: Pick<ProviderRequest, 'reservationRef'> };
    let observation: ReviewObservationV1 | 'fresh' | undefined;
    if (config && boundReviewEnabled(config)) {
      try {
        observation = await loadBoundReview(config, state.task, current.state, diffInfo, state.verificationResults, true);
      } catch {
        observation = undefined;
      }
      if (!observation) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['EVIDENCE_UNACKNOWLEDGED: owner review history is unavailable'] };
    }
    if (observation && observation !== 'fresh') {
      if (!observation.result || (observation.status !== 'accepted' && observation.status !== 'findings'))
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['EVIDENCE_UNACKNOWLEDGED: recovered review is unavailable'] };
      reviewed = { result: observation.result, ownerState: current.state, request: { reservationRef: observation.result.iterationReservationRef } };
    } else {
      let prepared;
      try {
        prepared = config && boundReviewEnabled(config) ? await prepareBoundReview(config, ports.reviewerPort, { task: state.task, state: current.state, diff: diffInfo }) : undefined;
      } catch {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['AUTHORITY_UNAVAILABLE: bound review preparation failed'] };
      }
      if (boundReviewEnabled(config) && !prepared)
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['REQUIRED_EVIDENCE_MISSING: bound review input unavailable'] };
      const evidence = prepared?.evidence ?? [];
      const reviewAdmission =
        typeof admissionSource === 'function' ? await admissionSource({ task: state.task, state: current.state, diff: diffInfo, reviewContext: prepared?.context, evidence }) : admissionSource;
      if (!reviewAdmission) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Owner did not issue a reviewer admission for the current diff'] };
      // Mint and dispatch use the same selected evidence projection.
      const contextDigest = reviewerContextDigest(
        state.task,
        diffInfo.diff,
        evidence,
        current.state.repositoryRevisionDigest,
        {
          runId: current.state.runId,
          expectedTaskStateVersion: current.state.stateVersion,
        },
        prepared?.context,
      );
      if (contextDigest === null) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Current repository diff is not a unified diff'] };
      const requestValidation = validateProviderRequest(reviewAdmission.request, {
        expectedTaskId: current.state.taskId,
        expectedRunId: current.state.runId,
        expectedRole: 'reviewer',
        expectedPurpose: 'final-review',
        expectedContextDigest: contextDigest,
        expectedProviderRequestId: reviewAdmission.context.providerRequestId,
      });
      const admissionValidation = validateProviderAdmissionV02(reviewAdmission.context, reviewAdmission.trustedContext);
      if (
        !requestValidation.ok ||
        !admissionValidation.ok ||
        reviewAdmission.context.providerRequestId !== reviewAdmission.request.providerRequestId ||
        reviewAdmission.context.role !== 'reviewer' ||
        reviewAdmission.context.runnableNode !== 'Review' ||
        reviewAdmission.context.expectedTaskStateVersion !== current.state.stateVersion ||
        reviewAdmission.context.taskId !== current.state.taskId ||
        reviewAdmission.context.runId !== current.state.runId ||
        computeCanonicalSha256(reviewAdmission.context.providerRequest) !== computeCanonicalSha256(reviewAdmission.request) ||
        reviewAdmission.context.requestContentDigest !== computeRequestContentDigest(reviewAdmission.request) ||
        reviewAdmission.request.reservationRef !== reviewAdmission.context.requestReservationReceipt ||
        !reviewAdmissionMatchesState(reviewAdmission.context, current.state, state.task)
      ) {
        return {
          state: current.state,
          terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const,
          reasons: ['Reviewer request or persisted admission does not bind the current task, run, state, and reservation'],
        };
      }
      const beforeReview = await reloadAuthoritativeState(current.state, ports.statePort);
      if (!beforeReview.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [beforeReview.reason] };
      const result = await ports.reviewerPort.review(state.task, diffInfo.diff, evidence, reviewAdmission.request, reviewAdmission.context, undefined);
      const afterReview = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      if (!afterReview.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [afterReview.reason] };
      const ownerState = afterReview.state;
      if (prepared && config) {
        let observation;
        try {
          observation = await persistBoundReview(config, state.task, ownerState, prepared, reviewAdmission.context, result);
        } catch {
          observation = undefined;
        }
        if (!observation || result.status === 'invalid')
          return { state: ownerState, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['EVIDENCE_UNACKNOWLEDGED: review observation unavailable or invalid'] };
      }
      reviewed = { result, ownerState, request: reviewAdmission.request };
    }
    const { result, ownerState, request: reviewRequest } = reviewed;
    const reviewValidation = validateReviewResult(result);
    const reviewAdmissionValidation = validateReviewAdmission(result, {
      expectedTaskId: current.state.taskId,
      expectedRepoDigest: current.state.repositoryRevisionDigest,
      expectedDiffDigest: diffInfo.diffDigest,
      expectedCheckSetDigest: computeCheckSetDigest(state.task.requiredChecks),
      expectedRoleConfigId: state.task.configId,
      expectedIterationReservationRef: reviewRequest.reservationRef,
    });
    if (!reviewValidation.ok || !reviewAdmissionValidation.ok || result.iterationReservationRef !== reviewRequest.reservationRef) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer result does not match the admitted current diff and persisted reservation'] };
    }
    const reviewRefs = [...new Set([...(current.state.reviewRefs ?? []), result.reviewId])];
    const milestones = addMilestone(
      state.milestones ?? [],
      current.state.taskId,
      current.state.runId,
      'Review',
      'review_completed',
      result.status === 'accepted' ? 'Reviewer accepted patch' : 'Reviewer reported findings',
      result.status === 'accepted' ? 'success' : 'failure',
      [result.reviewId],
    );
    if (result.status !== 'accepted') {
      const failureRefs = [result.reviewId, result.iterationReservationRef, ...result.findings.map(finding => finding.evidenceRef ?? result.reviewId)];
      const repairState: TaskState = {
        // The review dispatch settled its own usage into the ledgers, so the pre-dispatch snapshot
        // is no longer authoritative accounting.
        ...ownerState,
        stateVersion: ownerState.stateVersion + 1,
        node: 'Repair',
        latestReviewRef: result.reviewId,
        reviewRefs,
        evidenceRefs: [...new Set([...ownerState.evidenceRefs, ...failureRefs])],
        nextAction: 'repair-review-findings',
      };
      const persisted = await transitionState(ports.statePort, repairState, ownerState.stateVersion);
      return { state: persisted, reviewResult: result, reviewRequest, failureEvidence: [result], milestones };
    }

    const deliverCandidate: TaskState = {
      ...ownerState,
      stateVersion: ownerState.stateVersion + 1,
      node: 'Deliver',
      activeDecisionId: undefined,
      latestReviewRef: result.reviewId,
      reviewRefs,
      outcome: 'COMPLETED',
      nextAction: 'deliver-final-report',
    };
    const completionInput = await loadCompletionPredicateInput({
      task: state.task,
      state: deliverCandidate,
      baseline: state.baseline,
      verificationResults: state.verificationResults,
      reviewResult: result,
      diffInfo,
      reviewRequest,
      hostAuthority: ports.hostAuthority,
      trustedExpectedContext: config?.trustedExpectedContext,
      trustedCompletion: config?.trustedTransitionContext?.completion,
      patchAdmission: state.patchAdmission,
      patchReceipt: state.patchReceipt,
      boundReview: config,
    });
    if (!completionInput.ok) {
      if (boundReviewEnabled(config))
        return { state: ownerState, reviewResult: result, reviewRequest, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: completionInput.reasons, milestones };
      const incompleteState: TaskState = {
        ...ownerState,
        stateVersion: ownerState.stateVersion + 1,
        node: 'Repair',
        latestReviewRef: result.reviewId,
        reviewRefs,
        // Repair is non-terminal, so the outcome lives on the report only.
        nextAction: 'halt-missing-completion-evidence',
      };
      const persisted = await transitionState(ports.statePort, incompleteState, ownerState.stateVersion);
      const report = buildFinalReport({
        task: state.task,
        state: persisted,
        baseline: state.baseline,
        verificationResults: state.verificationResults,
        reviewResult: result,
        currentRepoDigest: persisted.repositoryRevisionDigest,
        currentDiffDigest: diffInfo.diffDigest,
        changedFiles: diffInfo.changedFiles,
        patchContent: diffInfo.diff,
        overrideOutcome: 'IMPLEMENTED_UNVERIFIED',
        failureReasons: completionInput.reasons,
        milestones,
      });
      return { state: persisted, reviewResult: result, reviewRequest, finalReport: report, terminalOutcome: report.outcome, reasons: completionInput.reasons, milestones };
    }

    const completion = evaluateDeterministicCompletion(completionInput.input);
    if (!completion.isComplete) {
      if (boundReviewEnabled(config)) return { state: ownerState, reviewResult: result, reviewRequest, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: completion.reasons, milestones };
      const incompleteState: TaskState = {
        ...ownerState,
        stateVersion: ownerState.stateVersion + 1,
        node: 'Repair',
        latestReviewRef: result.reviewId,
        reviewRefs,
        nextAction: 'halt-incomplete-completion-predicate',
      };
      const persisted = await transitionState(ports.statePort, incompleteState, ownerState.stateVersion);
      const report = reportForPredicate(state.task, persisted, state.baseline, state.verificationResults, result, diffInfo, completionInput.input, completion, milestones);
      return { state: persisted, reviewResult: result, reviewRequest, finalReport: report, terminalOutcome: report.outcome, reasons: completion.reasons, milestones };
    }

    const persisted = await transitionState(ports.statePort, deliverCandidate, ownerState.stateVersion);
    return { state: persisted, reviewResult: result, reviewRequest, milestones };
  };
}
