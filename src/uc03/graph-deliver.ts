/** Deliver and Incomplete terminal nodes; route assembly lives in graph.ts. */
import { addMilestone, trustedExpectedContext, trustedOwnerStateMatches, validDiffInfo } from './graph-validation.ts';
import { buildFinalReport } from './report.ts';
import { evaluateDeterministicCompletion } from './verification.ts';
import { incompleteDelivery, loadCompletionPredicateInput, reportForPredicate } from './graph-completion.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';
import { type UC03GraphConfig, type UC03GraphPorts } from './graph-types.ts';
import { reloadAuthoritativeState } from './graph-transitions.ts';

export function createDeliverNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Deliver' || state.state.outcome !== 'COMPLETED') {
      return incompleteDelivery(state, ['Deliver requires a persisted COMPLETED candidate state']);
    }
    if (!state.baseline || !state.verificationResults?.length || !state.reviewResult || !state.reviewRequest || !state.patchAdmission || !state.patchReceipt) {
      return incompleteDelivery(state, ['Restored Deliver is missing graph checkpoint evidence required for the completion predicate']);
    }
    if (!config) return incompleteDelivery(state, ['Deliver requires the configured trusted host and completion authorities']);
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return incompleteDelivery(state, [current.reason]);
    const trusted = trustedExpectedContext(config, state.task, current.state);
    if (!trusted || !(await trustedOwnerStateMatches(trusted, current.state))) {
      return incompleteDelivery(state, ['Deliver cannot verify the same authoritative task state across route and host ports']);
    }
    const diffInfo = await ports.repositoryPort.inspectDiff(state.task.initialRevisionDigest);
    if (!validDiffInfo(diffInfo)) return incompleteDelivery(state, ['Current repository diff response is invalid']);
    const completionInput = await loadCompletionPredicateInput({
      task: state.task,
      state: current.state,
      baseline: state.baseline,
      verificationResults: state.verificationResults,
      reviewResult: state.reviewResult,
      diffInfo,
      reviewRequest: state.reviewRequest,
      hostAuthority: ports.hostAuthority,
      trustedExpectedContext: config.trustedExpectedContext,
      trustedCompletion: config.trustedTransitionContext?.completion,
      completionContextFor: config.completionContextFor,
      patchAdmission: state.patchAdmission,
      patchReceipt: state.patchReceipt,
      boundReview: config,
    });
    if (!completionInput.ok) return incompleteDelivery(state, completionInput.reasons, diffInfo);
    const beforeReport = await reloadAuthoritativeState(current.state, ports.statePort);
    if (!beforeReport.ok || !(await trustedOwnerStateMatches(trusted, current.state))) {
      return incompleteDelivery(state, [beforeReport.ok ? 'Owner task state changed while completion evidence was loaded' : beforeReport.reason], diffInfo);
    }
    const completion = evaluateDeterministicCompletion(completionInput.input);
    const report = reportForPredicate(state.task, current.state, state.baseline, state.verificationResults, state.reviewResult, diffInfo, completionInput.input, completion, state.milestones ?? []);
    if (report.outcome !== completion.outcome || report.isComplete !== completion.isComplete) {
      const honestReport = buildFinalReport({
        task: state.task,
        state: current.state,
        baseline: state.baseline,
        verificationResults: state.verificationResults,
        reviewResult: state.reviewResult,
        currentRepoDigest: current.state.repositoryRevisionDigest,
        currentDiffDigest: diffInfo.diffDigest,
        changedFiles: diffInfo.changedFiles,
        patchContent: diffInfo.diff,
        originalProtectedTestsDigest: completionInput.input.originalProtectedTestsDigest,
        currentProtectedTestsDigest: completionInput.input.currentProtectedTestsDigest,
        authorizedDiffDigest: completionInput.input.authorizedDiffDigest,
        trustedReviewRecord: completionInput.input.trustedReviewRecord,
        overrideOutcome: current.state.changedPaths.length > 0 ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE',
        failureReasons: ['Completion predicate and final report outcomes diverged'],
        milestones: state.milestones,
      });
      return { state: undefined, finalReport: honestReport, terminalOutcome: honestReport.outcome, reasons: honestReport.failureReasons, milestones: state.milestones };
    }
    return {
      state: completion.isComplete ? current.state : undefined,
      finalReport: report,
      terminalOutcome: report.outcome,
      reasons: report.failureReasons,
      milestones: addMilestone(
        state.milestones ?? [],
        current.state.taskId,
        current.state.runId,
        'Deliver',
        'task_completed',
        completion.isComplete ? 'Task completed with current evidence' : 'Task remains incomplete after current evidence checks',
        completion.isComplete ? 'success' : 'failure',
      ),
    };
  };
}

export function createIncompleteNode(_ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state) {
      const outcome = state.terminalOutcome === 'IMPLEMENTED_UNVERIFIED' ? ('IMPLEMENTED_UNVERIFIED' as const) : ('INCOMPLETE' as const);
      return { terminalOutcome: outcome, reasons: state.reasons ?? [] };
    }
    const outcome =
      state.terminalOutcome === 'INCOMPLETE'
        ? 'INCOMPLETE'
        : state.terminalOutcome === 'IMPLEMENTED_UNVERIFIED' || state.state.outcome === 'IMPLEMENTED_UNVERIFIED' || state.state.changedPaths.length > 0
          ? 'IMPLEMENTED_UNVERIFIED'
          : 'INCOMPLETE';
    const report = buildFinalReport({
      task: state.task,
      state: state.state,
      baseline: state.baseline,
      verificationResults: state.verificationResults,
      reviewResult: state.reviewResult,
      currentRepoDigest: state.state.repositoryRevisionDigest,
      changedFiles: state.state.changedPaths,
      patchContent: config?.patchContent,
      overrideOutcome: outcome,
      failureReasons: state.reasons ?? [],
      milestones: state.milestones,
    });
    const milestones = addMilestone(state.milestones ?? [], state.state.taskId, state.state.runId, 'Incomplete', 'task_failed', 'Task terminated without verified completion', 'failure');
    return { state: state.state, finalReport: report, terminalOutcome: report.outcome, reasons: report.failureReasons, milestones };
  };
}
