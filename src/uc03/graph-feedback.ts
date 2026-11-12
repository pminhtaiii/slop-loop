/** Human feedback stage; direction validation remains private to the node. */
import { computeCanonicalSha256, computeCheckSetDigest, validateFixPlan, type FixPlan, type TaskState } from '../contracts/foundation/uc03.ts';
import { evaluatePlanMateriality, executeReplan } from './repair.ts';
import { addMilestone } from './graph-validation.ts';
import { generate, generationRefusal, generates } from './graph-nodes.ts';
import { reloadAuthoritativeState, transitionState } from './graph-transitions.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';

/**
 * Bind a generated proposal to the current owner state the way `validPlanForTask` demands:
 * the route computes the digest and copies the bound fields, so the model never supplies them.
 */
function generatedPlan(
  state: TaskState,
  proposal: { diagnosis: string; strategy: string; suspectedLocations: readonly string[]; scopedPaths: readonly string[]; evidenceRefs: readonly string[] },
): FixPlan | undefined {
  const task = state.taskContext;
  const prior = state.plan;
  if (!task?.requiredChecks.length || !prior) return undefined;
  return {
    planVersion: state.planVersion,
    diagnosis: proposal.diagnosis,
    suspectedCauseLocations: proposal.suspectedLocations,
    evidenceRefs: proposal.evidenceRefs,
    strategy: proposal.strategy,
    scopedChanges: proposal.scopedPaths,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: prior.baselineRef,
    strategyDigest: computeCanonicalSha256(proposal.strategy),
  };
}

function directionMatchesState(direction: NonNullable<UC03GraphConfig['trustedDirection']>, state: TaskState): boolean {
  return (
    direction.taskId === state.taskId &&
    direction.workspaceId === state.workspaceId &&
    direction.repositoryRevisionDigest === state.repositoryRevisionDigest &&
    direction.stateVersion === state.stateVersion &&
    direction.planVersion === state.planVersion &&
    !!state.plan?.decisionRef &&
    state.activeDecisionId === state.plan.decisionRef &&
    direction.rejectedDecisionId === state.activeDecisionId &&
    direction.strategyDigest === state.plan?.strategyDigest
  );
}

export function createAwaitFeedbackNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'AwaitFeedback') return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['AwaitFeedback requires authoritative paused state'] };
    const loaded = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!loaded.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [loaded.reason] };
    let current = loaded;
    const direction = config?.trustedDirection;
    if (!direction) return { state: current.state, terminalOutcome: 'needs-info' as const };
    if (!directionMatchesState(direction, current.state))
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Trusted feedback direction is stale or does not bind the current owner state'] };
    if (direction.directive === 'terminate') {
      const next: TaskState = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete', outcome: 'INCOMPLETE', nextAction: 'human-directed-termination' };
      return { state: await transitionState(ports.statePort, next, current.state.stateVersion), terminalOutcome: 'INCOMPLETE' as const };
    }
    // Only the revise branch needs a generated plan; the human wait and terminate directions must
    // keep working under production generation, so the refusal sits below them.
    const refusal = generationRefusal(config, 'AwaitFeedback');
    if (refusal) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [refusal] };
    const candidate = config?.revisedPlan;
    let plan = candidate;
    if (plan === undefined && direction.directive === 'revise' && current.state.plan && generates(config)) {
      const generated = await generate(config, state.task, current.state, 'propose-replan', []);
      if (!generated.ok)
        return {
          state: current.state,
          terminalOutcome: generated.reason.startsWith('HUMAN_WAIT') ? ('needs-info' as const) : ('INCOMPLETE' as const),
          reasons: [generated.reason],
        };
      if (generated.proposal.kind !== 'propose-plan')
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [`Expected a revised plan proposal, received ${generated.proposal.kind}`] };
      // The coder claim moved the ledgers, not the state version; the replan write must carry them.
      const postClaim = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      if (!postClaim.ok) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [postClaim.reason] };
      current = postClaim;
      plan = generatedPlan(current.state, generated.proposal);
      if (!plan) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Owner task has no required checks to bind a revised plan to'] };
    }
    if (direction.directive !== 'revise' || !current.state.plan || !plan) {
      return { state: current.state, terminalOutcome: 'needs-info' as const, reasons: ['Human revise direction and explicit candidate plan are required'] };
    }
    if (!validateFixPlan(plan).ok || !evaluatePlanMateriality(current.state.plan, plan).changedFields.length) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Revised plan must be valid and change a bound plan field'] };
    }
    const proposalId = `replan-${computeCanonicalSha256([current.state.taskId, current.state.runId, current.state.stateVersion, plan]).slice(7)}`;
    const replanned = await executeReplan(
      { taskId: current.state.taskId, proposalId, candidatePlan: plan },
      { statePort: ports.statePort, replanPort: ports.replanPort, approvalPort: ports.approvalPort, trustedDirection: direction, trustedTransitionContext: config?.trustedTransitionContext },
    );
    if (!replanned.state || !['REPLAN_PREPARED', 'CLARIFICATION_ACCEPTED'].includes(replanned.outcome)) {
      const latest = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      return {
        state: latest.ok ? latest.state : current.state,
        terminalOutcome: replanned.outcome === 'AWAIT_FEEDBACK' ? ('needs-info' as const) : ('INCOMPLETE' as const),
        reasons: replanned.reasons,
      };
    }
    const persisted = await reloadAuthoritativeState(replanned.state, ports.statePort);
    if (!persisted.ok) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason] };
    const milestones = replanned.isMaterial
      ? addMilestone(state.milestones ?? [], state.state.taskId, state.state.runId, 'AwaitFeedback', 'replan_triggered', 'Material replan initiated', 'info')
      : state.milestones;
    return { state: persisted.state, milestones };
  };
}
