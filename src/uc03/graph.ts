/** UC-03 mock-capable route orchestration. Real execution remains gated. */

import { END, START, StateGraph } from '@langchain/langgraph';
import {
  isAdmittedForProduction,
  type BugTask,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import { createInvestigateNode, createPatchNode, createRepairNode } from './graph-nodes.ts';
import { createVerifyNode } from './graph-verify.ts';
import { restoreVerificationEvidence } from './graph-patch-ancestry.ts';
import { addMilestone, decisionMatchesState, validateGraphInput, validDiffInfo, trustedExpectedContext, trustedOwnerStateMatches } from './graph-validation.ts';
import { createAwaitFeedbackNode } from './graph-feedback.ts';
import { reloadAuthoritativeState, transitionState } from './graph-transitions.ts';
import { incompleteDelivery, loadCompletionPredicateInput, reportForPredicate } from './graph-completion.ts';
import { evaluateDeterministicCompletion } from './verification.ts';
import { buildFinalReport, type Milestone } from './report.ts';
import { UC03StateAnnotation, type UC03GraphNode, type UC03GraphState } from './graph-state.ts';
import { type UC03GraphConfig, type UC03GraphPorts, type UC03WorkflowResult } from './graph-types.ts';
import { createReviewNode } from './graph-review.ts';
import { handlePlanRejection } from './repair.ts';

export { UC03StateAnnotation };
export type { UC03GraphConfig, UC03GraphPorts, UC03GraphState, UC03WorkflowResult };

const WORKFLOW_NODES = [
  'Investigate', 'AwaitPlan', 'AwaitFeedback', 'Patch', 'Verify', 'Review', 'Repair', 'Deliver', 'Incomplete',
] as const;

function createWorkflowApp(ports: UC03GraphPorts, config?: UC03GraphConfig) {
  const nodes = {
    startTask: async (state: TaskState) => {
      const current = await reloadAuthoritativeState(state, ports.statePort);
      if (!current.ok) throw new Error(current.reason);
      return transitionState(ports.statePort, {
        ...current.state,
        stateVersion: current.state.stateVersion + 1,
        node: 'Investigate',
        nextAction: 'investigate-baseline',
      }, current.state.stateVersion);
    },
    taskStarted: (state: TaskState, milestones: readonly Milestone[]) => addMilestone(
      milestones, state.taskId, state.runId, 'Validate', 'task_started', `Task ${state.taskId} validated and started`,
    ),
    Investigate: createInvestigateNode(ports, config),
    AwaitPlan: createAwaitPlanNode(ports),
    AwaitFeedback: createAwaitFeedbackNode(ports, config),
    Patch: createPatchNode(ports, config),
    Verify: createVerifyNode(ports, config),
    Review: createReviewNode(ports, config),
    Repair: createRepairNode(ports, config),
    Deliver: createDeliverNode(ports, config),
    Incomplete: createIncompleteNode(ports, config),
  };
  const workflow = new StateGraph(UC03StateAnnotation)
    .addNode('Validate', async (state: UC03GraphState) => {
      if (!state.task) return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['Missing required task'] };
      const validation = await validateGraphInput(state.task, state.state, ports.statePort);
      if (!validation.ok) {
        return { state: undefined, terminalOutcome: validation.outcome, reasons: validation.reasons };
      }

      let authoritative = validation.state;
      const starting = authoritative.node === 'Validate';
      if (authoritative.node === 'Validate') {
        authoritative = await nodes.startTask(authoritative);
      }
      if (authoritative.node === 'NeedsInfo') {
        return { state: authoritative, terminalOutcome: 'needs-info' as const, reasons: ['Task is paused for required information'] };
      }
      if (authoritative.node === 'Verify' && (!state.baseline || !state.patchAdmission || !state.patchReceipt)) {
        const trusted = trustedExpectedContext(config, state.task, authoritative);
        const restored = trusted?.statePort
          ? await restoreVerificationEvidence(state.task, authoritative, trusted.statePort, ports.baselineEvidenceWriter, trusted.expectedTestFiles)
          : undefined;
        if (!restored) {
          return { state: authoritative, terminalOutcome: 'INCOMPLETE' as const, reasons: ['TaskState-only verification resume lacks owner-retained baseline and settled patch evidence'] };
        }
        return {
          state: authoritative,
          baseline: restored.baseline,
          patchAdmission: restored.admission,
          patchReceipt: restored.receipt,
          milestones: starting ? nodes.taskStarted(authoritative, state.milestones ?? []) : state.milestones,
        };
      }
      const milestones = starting ? nodes.taskStarted(authoritative, state.milestones ?? []) : state.milestones;
      return { state: authoritative, milestones };
    })
    .addNode('Investigate', nodes.Investigate)
    .addNode('AwaitPlan', nodes.AwaitPlan)
    .addNode('AwaitFeedback', nodes.AwaitFeedback)
    .addNode('Patch', nodes.Patch)
    .addNode('Verify', nodes.Verify)
    .addNode('Review', nodes.Review)
    .addNode('Repair', nodes.Repair)
    .addNode('Deliver', nodes.Deliver)
    .addNode('Incomplete', nodes.Incomplete);

  workflow.addEdge(START, 'Validate');
  workflow.addConditionalEdges('Validate', (state: UC03GraphState) => {
    if (state.terminalOutcome) return END;
    return routeFromPersistedNode(state.state?.node);
  });
  workflow.addConditionalEdges('Investigate', (state: UC03GraphState) => {
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('AwaitPlan', (state: UC03GraphState) => {
    if (state.terminalOutcome === 'pending-approval') return END;
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('AwaitFeedback', (state: UC03GraphState) => {
    if (state.terminalOutcome === 'needs-info') return END;
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('Patch', (state: UC03GraphState) => {
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('Verify', (state: UC03GraphState) => {
    if (state.terminalOutcome === 'pending-approval') return END;
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('Review', (state: UC03GraphState) => {
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addConditionalEdges('Repair', (state: UC03GraphState) => {
    if (state.terminalOutcome) return 'Incomplete';
    return routeFromPersistedNode(state.state?.node, 'Incomplete');
  });
  workflow.addEdge('Deliver', END);
  workflow.addEdge('Incomplete', END);
  return workflow.compile();
}

function routeFromPersistedNode(node: TaskState['node'] | undefined, fallback = 'Incomplete'): string {
  return node && (WORKFLOW_NODES as readonly string[]).includes(node) ? node : fallback;
}

export type UC03WorkflowApp = ReturnType<typeof createWorkflowApp>;

export function buildUC03Graph(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03WorkflowApp {
  return createWorkflowApp(ports, config);
}

export function createAwaitPlanNode(ports: UC03GraphPorts): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'AwaitPlan' || !state.state.activeDecisionId || !state.state.plan) {
      return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['AwaitPlan lacks the persisted decision or plan binding'] };
    }
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    const decisionId = current.state.activeDecisionId;
    if (!decisionId) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Current owner state no longer has an active decision'] };
    const resolved = await ports.approvalPort.resolve(decisionId);
    if (!decisionMatchesState(resolved, current.state)) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Resolved plan decision is stale or does not match current owner state'] };
    if (resolved.status === 'pending') return { state: current.state, terminalOutcome: 'pending-approval' as const };
    if (resolved.status === 'rejected') {
      const rejection = await handlePlanRejection(
        { taskId: current.state.taskId, decisionId: resolved.decisionId, rejectionReason: resolved.reason ?? 'Human rejected plan' },
        { statePort: ports.statePort, approvalPort: ports.approvalPort },
      );
      const persisted = await reloadAuthoritativeState(rejection.state, ports.statePort);
      if (!persisted.ok) return { terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason] };
      return {
        state: persisted.state,
        milestones: addMilestone(state.milestones ?? [], state.state.taskId, state.state.runId, 'AwaitPlan', 'plan_rejected', 'Fix plan rejected by human', 'pending'),
      };
    }
    if (!await ports.approvalPort.validateBinding(resolved)) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Plan approval is not current owner authority'] };
    }
    const next: TaskState = {
      ...current.state,
      stateVersion: current.state.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
    };
    const persisted = await transitionState(ports.statePort, next, current.state.stateVersion);
    return {
      state: persisted,
      milestones: addMilestone(state.milestones ?? [], persisted.taskId, persisted.runId, 'AwaitPlan', 'plan_approved', 'Fix plan explicitly approved', 'success'),
    };
  };
}

export async function runUC03Graph(
  task: BugTask,
  ports: UC03GraphPorts,
  config?: UC03GraphConfig,
  initialState?: TaskState,
): Promise<UC03WorkflowResult> {
  if (config?.mode === 'production' && !isAdmittedForProduction([
    ports.statePort, ports.approvalPort, ports.repositoryPort, ports.modelPort, ports.reviewerPort,
    ...(ports.executionGuard ? [ports.executionGuard] : []),
  ])) {
    return {
      outcome: 'INCOMPLETE', state: null,
      reasons: ['PRODUCTION_ADMISSION_REFUSED: All effectful ports must declare real provenance and satisfy production admission'],
      milestones: [],
    };
  }

  const app = buildUC03Graph(ports, config);
  try {
    const output = await app.invoke({ task, state: initialState, reasons: [], milestones: [] });
    const reportOutcome = output.finalReport?.outcome;
    const outcome = reportOutcome ?? output.terminalOutcome ?? output.state?.outcome ?? 'INCOMPLETE';
    return {
      outcome,
      state: output.state ?? null,
      finalReport: output.finalReport,
      reasons: output.finalReport?.failureReasons ?? output.reasons ?? [],
      milestones: output.milestones ?? [],
    };
  } catch {
    let current: TaskState | null = null;
    try { current = await ports.statePort.loadTask(task.taskId); } catch { /* No authoritative state is available. */ }
    const outcome = current?.changedPaths.length ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE';
    return {
      outcome,
      state: current?.outcome === 'COMPLETED' ? null : current,
      reasons: ['UC-03 route stopped after an unconfirmed owner transition'],
      milestones: [],
    };
  }
}

export function createDeliverNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state || state.state.node !== 'Deliver' || state.state.outcome !== 'COMPLETED') {
        return incompleteDelivery(state, ['Deliver requires a persisted COMPLETED candidate state']);
      }
      if (!state.baseline || !state.verificationResults?.length || !state.reviewResult || !state.reviewRequest ||
          !state.patchAdmission || !state.patchReceipt) {
        return incompleteDelivery(state, ['Restored Deliver is missing graph checkpoint evidence required for the completion predicate']);
      }
      if (!config) return incompleteDelivery(state, ['Deliver requires the configured trusted host and completion authorities']);
      const current = await reloadAuthoritativeState(state.state, ports.statePort);
      if (!current.ok) return incompleteDelivery(state, [current.reason]);
      const trusted = trustedExpectedContext(config, state.task, current.state);
      if (!trusted || !await trustedOwnerStateMatches(trusted, current.state)) {
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
        patchAdmission: state.patchAdmission,
        patchReceipt: state.patchReceipt,
      });
      if (!completionInput.ok) return incompleteDelivery(state, completionInput.reasons, diffInfo);
      const beforeReport = await reloadAuthoritativeState(current.state, ports.statePort);
      if (!beforeReport.ok || !await trustedOwnerStateMatches(trusted, current.state)) {
        return incompleteDelivery(state, [beforeReport.ok ? 'Owner task state changed while completion evidence was loaded' : beforeReport.reason], diffInfo);
      }
      const completion = evaluateDeterministicCompletion(completionInput.input);
      const report = reportForPredicate(state.task, current.state, state.baseline, state.verificationResults, state.reviewResult, diffInfo, completionInput.input, completion, state.milestones ?? []);
      if (report.outcome !== completion.outcome || report.isComplete !== completion.isComplete) {
        const honestReport = buildFinalReport({
          task: state.task, state: current.state, baseline: state.baseline,
          verificationResults: state.verificationResults, reviewResult: state.reviewResult,
          currentRepoDigest: current.state.repositoryRevisionDigest,
          currentDiffDigest: diffInfo.diffDigest, changedFiles: diffInfo.changedFiles, patchContent: diffInfo.diff,
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
        milestones: addMilestone(state.milestones ?? [], current.state.taskId, current.state.runId, 'Deliver', 'task_completed', completion.isComplete ? 'Task completed with current evidence' : 'Task remains incomplete after current evidence checks', completion.isComplete ? 'success' : 'failure'),
      };
    };
}

export function createIncompleteNode(_ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state) {
        const outcome = state.terminalOutcome === 'IMPLEMENTED_UNVERIFIED' ? 'IMPLEMENTED_UNVERIFIED' as const : 'INCOMPLETE' as const;
        return { terminalOutcome: outcome, reasons: state.reasons ?? [] };
      }
      const outcome = state.terminalOutcome === 'INCOMPLETE' ? 'INCOMPLETE' : state.terminalOutcome === 'IMPLEMENTED_UNVERIFIED' || state.state.outcome === 'IMPLEMENTED_UNVERIFIED' || state.state.changedPaths.length > 0
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
