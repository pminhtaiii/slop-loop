import { Annotation } from '@langchain/langgraph';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  validateProviderAdmissionV02,
  validateProviderRequest,
  validateReviewAdmission,
  validateReviewResult,
} from '../contracts/foundation/uc03.ts';
import { evaluateDeterministicCompletion } from './verification.ts';
import { loadCompletionPredicateInput, reportForPredicate } from './graph-completion.ts';
import {
  addMilestone,
  reloadAuthoritativeState,
  reviewAdmissionMatchesState,
  samePaths,
  transitionState,
  trustedExpectedContext,
  trustedOwnerStateMatches,
  validDiffInfo,
  validSettledPatchEvidence,
} from './graph-validation.ts';
import { buildFinalReport } from './report.ts';
import type {
  ApprovalPort,
  Baseline,
  BugTask,
  ClaimReceiptV02,
  FixPlan,
  ModelPort,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  ProviderRequest,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
  RepositoryExecutionReceiptV02,
  RepositoryPort,
  ReviewResult,
  SourceEvidence,
  StatePort,
  StateTransitionOptions,
  TaskOutcome,
  TaskState,
  TelemetryPort,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardV02 } from '../foundation/execution-guard.ts';
import type {
  BaselineEvidenceWriter,
  InvestigationConfigPort,
  TrustedHostExpectedContext,
  TrustedHostPort,
} from './investigation.ts';
import type { RepairPatchProposal, TrustedReplanDirection } from './repair.ts';
import type { FinalReport, Milestone } from './report.ts';

export interface UC03GraphPorts {
  readonly statePort: StatePort;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPort;
  readonly modelPort: ModelPort;
  readonly reviewerPort: UC03ReviewerPort;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly telemetryPort?: TelemetryPort | undefined;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly hostAuthority?: TrustedHostPort | undefined;
  readonly configPort?: InvestigationConfigPort | undefined;
}

/** Route callers must pass the owner-issued provider admission with the exact review request. */
export interface UC03ReviewerPort {
  readonly provenance: 'mock' | 'real';
  review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    admission: ProviderAdmissionContextV02,
    claim: ClaimReceiptV02,
  ): Promise<ReviewResult>;
}

export interface UC03ReviewerAdmission {
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly trustedContext: ProviderAdmissionTrustedContextV02;
}

export interface UC03ReviewerAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
}

export interface UC03PatchAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly patchContent: string;
  readonly targetPaths: readonly string[];
  readonly actionId?: string | undefined;
  readonly failureEvidence?: readonly (VerificationResult | ReviewResult)[] | undefined;
}

export interface UC03RepositoryAdmission {
  readonly context: RepositoryAdmissionContextV02;
  readonly trustedContext: RepositoryAdmissionTrustedContextV02;
}

export type UC03ReviewerAdmissionResolver = (
  request: UC03ReviewerAdmissionRequest,
) => Promise<UC03ReviewerAdmission | undefined> | UC03ReviewerAdmission | undefined;

export type UC03PatchAdmissionResolver = (
  request: UC03PatchAdmissionRequest,
) => Promise<UC03RepositoryAdmission | undefined> | UC03RepositoryAdmission | undefined;

export interface UC03GraphConfig {
  readonly mode?: 'development' | 'production' | undefined;
  readonly trustedExpectedContext?: TrustedHostExpectedContext | undefined;
  readonly trustedDirection?: TrustedReplanDirection | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly admissionContext?: UC03RepositoryAdmission | UC03PatchAdmissionResolver | undefined;
  readonly reviewerAdmission?: UC03ReviewerAdmission | UC03ReviewerAdmissionResolver | undefined;
  readonly patchContent?: string | undefined;
  readonly targetPaths?: readonly string[] | undefined;
  readonly repairPatch?: RepairPatchProposal | undefined;
  readonly revisedPlan?: FixPlan | undefined;
  readonly planDetails?: {
    readonly diagnosis: string;
    readonly strategy: string;
    readonly suspectedCauseLocations: readonly string[];
    readonly scopedChanges: readonly string[];
  } | undefined;
}

export interface UC03WorkflowResult {
  readonly outcome: TaskOutcome | 'pending-approval' | 'needs-info';
  readonly state: TaskState | null;
  readonly finalReport?: FinalReport | undefined;
  readonly reasons: readonly string[];
  readonly milestones: readonly Milestone[];
}

export const UC03StateAnnotation = Annotation.Root({
  task: Annotation<BugTask | undefined>({ reducer: (_, n) => n }),
  state: Annotation<TaskState | undefined>({ reducer: (_, n) => n }),
  baseline: Annotation<Baseline | undefined>({ reducer: (_, n) => n }),
  verificationResults: Annotation<readonly VerificationResult[]>({ reducer: (_, n) => n }),
  reviewResult: Annotation<ReviewResult | undefined>({ reducer: (_, n) => n }),
  reviewRequest: Annotation<ProviderRequest | undefined>({ reducer: (_, n) => n }),
  patchAdmission: Annotation<UC03RepositoryAdmission | undefined>({ reducer: (_, n) => n }),
  patchReceipt: Annotation<RepositoryExecutionReceiptV02 | undefined>({ reducer: (_, n) => n }),
  failureEvidence: Annotation<readonly (VerificationResult | ReviewResult)[]>({ reducer: (_, n) => n }),
  finalReport: Annotation<FinalReport | undefined>({ reducer: (_, n) => n }),
  reasons: Annotation<readonly string[]>({ reducer: (c, n) => [...(c ?? []), ...(n ?? [])] }),
  terminalOutcome: Annotation<TaskOutcome | 'pending-approval' | 'needs-info' | undefined>({ reducer: (_, n) => n }),
  milestones: Annotation<readonly Milestone[]>({ reducer: (_, n) => n }),
});

export type UC03GraphState = typeof UC03StateAnnotation.State;
export type UC03GraphNode = (state: UC03GraphState) => Promise<Partial<UC03GraphState>>;

export function validReviewerClaim(
  claim: ClaimReceiptV02 | undefined,
  admission: ProviderAdmissionContextV02,
  state: TaskState,
): claim is ClaimReceiptV02 {
  return !!claim && claim.status === 'claimed' && claim.subjectKind === 'provider-request' &&
    claim.planApplicability === 'approved-plan' && claim.taskId === state.taskId && claim.runId === state.runId &&
    claim.preClaimTaskStateVersion === state.stateVersion &&
    samePaths(claim.reservationRefs, [admission.requestReservationReceipt, ...admission.budgetRefs]);
}

export function createReviewNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state || state.state.node !== 'Review') return { terminalOutcome: 'INCOMPLETE' as const };
      const current = await reloadAuthoritativeState(state.state, ports.statePort);
      if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
      const admissionSource = config?.reviewerAdmission;
      if (!state.baseline || !state.verificationResults?.length || !admissionSource ||
          !validSettledPatchEvidence(state, state.task, current.state)) {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Review requires persisted baseline/check evidence and owner-issued provider admission'] };
      }
      const diffInfo = await ports.repositoryPort.inspectDiff(state.task.initialRevisionDigest);
      if (!validDiffInfo(diffInfo)) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Current repository diff response is invalid'] };
      const trusted = trustedExpectedContext(config, state.task, current.state);
      if (!trusted) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer requires the current owner StatePortV02 boundary'] };
      if (!trusted.statePort) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer requires the current owner StatePortV02 boundary'] };
      if (!await trustedOwnerStateMatches(trusted, current.state)) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Trusted reviewer and route ports do not share current owner task state'] };
      const reviewAdmission = typeof admissionSource === 'function'
        ? await admissionSource({ task: state.task, state: current.state, diff: diffInfo })
        : admissionSource;
      if (!reviewAdmission) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Owner did not issue a reviewer admission for the current diff'] };
      const requestValidation = validateProviderRequest(reviewAdmission.request, {
        expectedTaskId: current.state.taskId,
        expectedRunId: current.state.runId,
        expectedRole: 'reviewer',
        expectedPurpose: 'final-review',
        expectedContextDigest: computeCanonicalSha256(diffInfo.diff),
        expectedProviderRequestId: reviewAdmission.context.providerRequestId,
      });
      const admissionValidation = validateProviderAdmissionV02(reviewAdmission.context, reviewAdmission.trustedContext);
      if (
        !requestValidation.ok || !admissionValidation.ok ||
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
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer request or persisted admission does not bind the current task, run, state, and reservation'] };
      }
      const beforeReview = await reloadAuthoritativeState(current.state, ports.statePort);
      if (!beforeReview.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [beforeReview.reason] };
      const claim = await trusted.statePort.claim(reviewAdmission.context);
      if (!validReviewerClaim(claim, reviewAdmission.context, current.state)) {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Owner budget protocol refused the reviewer allowance before dispatch'] };
      }
      const beforeDispatch = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      if (!beforeDispatch.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [beforeDispatch.reason] };
      const result = await ports.reviewerPort.review(
        state.task,
        diffInfo.diff,
        [],
        reviewAdmission.request,
        reviewAdmission.context,
        claim,
      );
      const afterReview = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      if (!afterReview.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [afterReview.reason] };
      const ownerState = afterReview.state;
      const reviewValidation = validateReviewResult(result);
      const reviewAdmissionValidation = validateReviewAdmission(result, {
        expectedTaskId: current.state.taskId,
        expectedRepoDigest: current.state.repositoryRevisionDigest,
        expectedDiffDigest: diffInfo.diffDigest,
        expectedCheckSetDigest: computeCheckSetDigest(state.task.requiredChecks),
        expectedRoleConfigId: reviewAdmission.context.providerIdentity.configId,
        expectedIterationReservationRef: reviewAdmission.request.reservationRef,
      });
      if (!reviewValidation.ok || !reviewAdmissionValidation.ok || result.iterationReservationRef !== reviewAdmission.request.reservationRef) {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Reviewer result does not match the admitted current diff and persisted reservation'] };
      }
      const reviewRefs = [...new Set([...(current.state.reviewRefs ?? []), result.reviewId])];
      const milestones = addMilestone(
        state.milestones ?? [], current.state.taskId, current.state.runId, 'Review', 'review_completed',
        result.status === 'accepted' ? 'Reviewer accepted patch' : 'Reviewer reported findings',
        result.status === 'accepted' ? 'success' : 'failure', [result.reviewId],
      );
      if (result.status !== 'accepted') {
        const failureRefs = [
          result.reviewId,
          result.iterationReservationRef,
          ...result.findings.map((finding) => finding.evidenceRef ?? result.reviewId),
        ];
        const repairState: TaskState = {
          ...current.state,
          stateVersion: current.state.stateVersion + 1,
          node: 'Repair',
          latestReviewRef: result.reviewId,
          reviewRefs,
          evidenceRefs: [...new Set([...current.state.evidenceRefs, ...failureRefs])],
          nextAction: 'repair-review-findings',
        };
        const persisted = await transitionState(ports.statePort, repairState, ownerState.stateVersion);
        return { state: persisted, reviewResult: result, reviewRequest: reviewAdmission.request, failureEvidence: [result], milestones };
      }

      const deliverCandidate: TaskState = {
        ...ownerState,
        stateVersion: ownerState.stateVersion + 1,
        node: 'Deliver',
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
        reviewRequest: reviewAdmission.request,
        hostAuthority: ports.hostAuthority,
        trustedExpectedContext: config?.trustedExpectedContext,
        trustedCompletion: config?.trustedTransitionContext?.completion,
        patchAdmission: state.patchAdmission,
        patchReceipt: state.patchReceipt,
      });
      if (!completionInput.ok) {
        const incompleteState: TaskState = {
          ...ownerState,
          stateVersion: ownerState.stateVersion + 1,
          node: 'Repair',
          latestReviewRef: result.reviewId,
          reviewRefs,
          outcome: 'IMPLEMENTED_UNVERIFIED',
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
        return { state: persisted, reviewResult: result, reviewRequest: reviewAdmission.request, finalReport: report, terminalOutcome: report.outcome, reasons: completionInput.reasons, milestones };
      }

      const completion = evaluateDeterministicCompletion(completionInput.input);
      if (!completion.isComplete) {
        const incompleteState: TaskState = {
          ...ownerState,
          stateVersion: ownerState.stateVersion + 1,
          node: 'Repair',
          latestReviewRef: result.reviewId,
          reviewRefs,
          outcome: completion.outcome,
          nextAction: 'halt-incomplete-completion-predicate',
        };
        const persisted = await transitionState(ports.statePort, incompleteState, ownerState.stateVersion);
        const report = reportForPredicate(state.task, persisted, state.baseline, state.verificationResults, result, diffInfo, completionInput.input, completion, milestones);
        return { state: persisted, reviewResult: result, reviewRequest: reviewAdmission.request, finalReport: report, terminalOutcome: report.outcome, reasons: completion.reasons, milestones };
      }

      const persisted = await transitionState(ports.statePort, deliverCandidate, ownerState.stateVersion);
      return { state: persisted, reviewResult: result, reviewRequest: reviewAdmission.request, milestones };
    };
}

