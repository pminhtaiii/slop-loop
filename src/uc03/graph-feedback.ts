/** Human feedback stage; direction validation remains private to the node. */
import { computeCanonicalSha256, validateFixPlan, type TaskState } from '../contracts/foundation/uc03.ts';
import { evaluatePlanMateriality, executeReplan } from './repair.ts';
import { addMilestone } from './graph-validation.ts';
import { reloadAuthoritativeState, transitionState } from './graph-transitions.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';

function directionMatchesState(
  direction: NonNullable<UC03GraphConfig['trustedDirection']>,
  state: TaskState,
): boolean {
  return direction.taskId === state.taskId && direction.workspaceId === state.workspaceId &&
    direction.repositoryRevisionDigest === state.repositoryRevisionDigest && direction.stateVersion === state.stateVersion &&
    direction.planVersion === state.planVersion && direction.rejectedDecisionId === state.plan?.decisionRef &&
    direction.strategyDigest === state.plan?.strategyDigest;
}

export function createAwaitFeedbackNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'AwaitFeedback') return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['AwaitFeedback requires authoritative paused state'] };
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    const direction = config?.trustedDirection;
    if (!direction) return { state: current.state, terminalOutcome: 'needs-info' as const };
    if (!directionMatchesState(direction, current.state)) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Trusted feedback direction is stale or does not bind the current owner state'] };
    if (direction.directive === 'terminate') {
      const next: TaskState = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'human-directed-termination' };
      return { state: await transitionState(ports.statePort, next, current.state.stateVersion), terminalOutcome: 'INCOMPLETE' as const };
    }
    const candidate = config?.revisedPlan;
    if (direction.directive !== 'revise' || !current.state.plan || !candidate) {
      return { state: current.state, terminalOutcome: 'needs-info' as const, reasons: ['Human revise direction and explicit candidate plan are required'] };
    }
    if (!validateFixPlan(candidate).ok || !evaluatePlanMateriality(current.state.plan, candidate).changedFields.length) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Revised plan must be valid and change a bound plan field'] };
    }
    const proposalId = `replan-${computeCanonicalSha256([current.state.taskId, current.state.runId, current.state.stateVersion, candidate]).slice(7)}`;
    const replanned = await executeReplan(
      { taskId: current.state.taskId, proposalId, candidatePlan: candidate },
      { statePort: ports.statePort, approvalPort: ports.approvalPort, trustedDirection: direction, trustedTransitionContext: config?.trustedTransitionContext },
    );
    if (!replanned.state || !['REPLAN_PREPARED', 'CLARIFICATION_ACCEPTED'].includes(replanned.outcome)) {
      const latest = await reloadAuthoritativeState(current.state, ports.statePort);
      return { state: latest.ok ? latest.state : current.state, terminalOutcome: replanned.outcome === 'AWAIT_FEEDBACK' ? 'needs-info' as const : 'INCOMPLETE' as const, reasons: replanned.reasons };
    }
    const persisted = await reloadAuthoritativeState(replanned.state, ports.statePort);
    if (!persisted.ok) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason] };
    const milestones = replanned.isMaterial
      ? addMilestone(state.milestones ?? [], state.state.taskId, state.state.runId, 'AwaitFeedback', 'replan_triggered', 'Material replan initiated', 'info')
      : state.milestones;
    return { state: persisted.state, milestones };
  };
}

