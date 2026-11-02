import { validateRepositoryAdmissionV02, validateRepositoryExecutionReceiptV02, type TaskState } from '../contracts/foundation/uc03.ts';
import { generate, generationRefusal, generates } from './graph-generation.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';
import { addMilestone, currentPlanBindingDigest, patchResult, resolveExecutionGuard, samePaths } from './graph-validation.ts';
import { loadCurrentOwnerState, reloadAuthoritativeState } from './graph-transitions.ts';

export function createPatchNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Patch') return { terminalOutcome: 'INCOMPLETE' as const };
    const refusal = generationRefusal(config, 'Patch');
    if (refusal) return { terminalOutcome: 'INCOMPLETE' as const, reasons: [refusal] };
    const loaded = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!loaded.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [loaded.reason] };
    let current = loaded.state;
    const admissionSource = config?.admissionContext;
    const guard = resolveExecutionGuard(ports, config);
    let patchContent = config?.patchContent;
    let targetPaths = config?.targetPaths;
    if (generates(config) && patchContent === undefined) {
      const generated = await generate(config, state.task, current, 'propose-patch', []);
      if (!generated.ok) return { state: current, terminalOutcome: generated.reason.startsWith('HUMAN_WAIT') ? ('needs-info' as const) : ('INCOMPLETE' as const), reasons: [generated.reason] };
      if (generated.proposal.kind !== 'propose-patch') return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: [`Expected a patch proposal, received ${generated.proposal.kind}`] };
      // Same as the plan path: the coder claim moved the ledgers, not the state version.
      const postClaim = await reloadAuthoritativeState(current, ports.statePort, { allowAccountingChange: true });
      if (!postClaim.ok) return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: [postClaim.reason] };
      current = postClaim.state;
      patchContent = generated.proposal.diff;
      targetPaths = generated.proposal.targetPaths;
    }
    if (!admissionSource || !guard || !patchContent || !targetPaths?.length) {
      return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Patch requires explicit v0.2 admission, guarded workspace, patch bytes, and target paths'] };
    }
    const admission = typeof admissionSource === 'function' ? await admissionSource({ task: state.task, state: current, patchContent, targetPaths }) : admissionSource;
    if (!admission) return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Owner did not issue a patch admission for the current task state'] };
    const beforePatch = await reloadAuthoritativeState(current, ports.statePort, { allowAccountingChange: true });
    if (!beforePatch.ok) return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: [beforePatch.reason] };
    const validated = validateRepositoryAdmissionV02(admission.context, admission.trustedContext);
    const action = validated.ok ? validated.value.action : undefined;
    if (
      !validated.ok ||
      !action ||
      action.kind !== 'apply_patch' ||
      action.patchContent !== patchContent ||
      !samePaths(action.targetPaths, targetPaths) ||
      action.baseRevisionDigest !== current.repositoryRevisionDigest ||
      validated.value.taskId !== current.taskId ||
      validated.value.runId !== current.runId ||
      validated.value.workspaceId !== current.workspaceId ||
      validated.value.repositoryId !== current.repositoryId ||
      validated.value.expectedTaskStateVersion !== current.stateVersion ||
      validated.value.runnableNode !== 'Patch' ||
      validated.value.planApplicability !== 'approved-plan' ||
      validated.value.planDecisionRef !== current.plan?.decisionRef ||
      validated.value.planBindingDigest !== currentPlanBindingDigest(state.task, current)
    ) {
      return { state: current, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Patch admission does not bind the current owner state and exact patch'] };
    }
    const result = await guard.validateAndExecute(action, current, validated.value);
    if (result.outcome !== 'success') {
      const outcome = result.outcome === 'uncertain-effect' ? ('IMPLEMENTED_UNVERIFIED' as const) : ('INCOMPLETE' as const);
      const owner = await loadCurrentOwnerState(state.task, ports.statePort);
      return {
        ...(owner.ok ? { state: owner.state } : {}),
        terminalOutcome: outcome,
        reasons: [`Patch execution refused: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`, ...(!owner.ok ? [owner.reason] : [])],
      };
    }
    const patch = patchResult(result.result);
    if (!patch) {
      return { state: current, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch effect was reported without a valid v0.2 execution receipt'] };
    }
    const execution = validateRepositoryExecutionReceiptV02(patch.executionReceipt, validated.value);
    if (!execution.ok || execution.value.outcome.repositoryOperation !== 'apply-patch' || execution.value.outcome.observedResultRevisionDigest !== patch.newRevisionDigest) {
      return { state: current, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch receipt does not bind the owner-settled revision'] };
    }
    const ownerCandidate: TaskState = {
      ...current,
      stateVersion: execution.value.attempt.postBeginTaskStateVersion + 1,
      node: 'Verify',
      repositoryRevisionDigest: patch.newRevisionDigest,
      activeDecisionId: undefined,
      reviewRefs: [],
      latestReviewRef: undefined,
    };
    const persisted = await reloadAuthoritativeState(ownerCandidate, ports.statePort, { allowAccountingChange: true });
    if (!persisted.ok) return { state: current, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch effect did not produce the owner state bound to its settled receipt'] };
    return {
      state: persisted.state,
      patchAdmission: admission,
      patchReceipt: execution.value,
      milestones: addMilestone(state.milestones ?? [], persisted.state.taskId, persisted.state.runId, 'Patch', 'patch_applied', 'Patch applied and settled by the v0.2 owner protocol', 'success'),
    };
  };
}
