import { validateRepositoryAdmissionV02, type Baseline } from '../contracts/foundation/uc03.ts';
import { failureRefs } from './repair-types.ts';
import { investigateBaseline, prepareFixPlanAndApproval } from './investigation.ts';
import { createRepairActionId, createTrustedRepairContext, executeRepair } from './repair.ts';
import type { UC03GraphConfig, UC03GraphPorts } from './graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from './graph-state.ts';
import { generate, generationRefusal, generates } from './graph-generation.ts';
import { askClarification, clarificationRoundRefusal } from './clarification.ts';

import { addMilestone, currentPlanBindingDigest, resolveExecutionGuard, samePaths, trustedExpectedContext, trustedOwnerStateMatches, validSettledPatchEvidence } from './graph-validation.ts';
import { reloadAuthoritativeState, transitionState } from './graph-transitions.ts';

export { coderContextDigest, generate, generationRefusal, generates } from './graph-generation.ts';
export type { CoderGeneration, CoderPurpose } from './graph-generation.ts';
export { createPatchNode } from './graph-patch.ts';

export function createInvestigateNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Investigate') {
      return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['Investigate requires authoritative task state at the Investigate node'] };
    }
    const planDetails = config?.planDetails;
    const refusal = generationRefusal(config, 'Investigate');
    if (refusal) return { terminalOutcome: 'INCOMPLETE' as const, reasons: [refusal] };
    const trustedContext = trustedExpectedContext(config, state.task, state.state);
    const guard = resolveExecutionGuard(ports, config);
    if ((!planDetails && !generates(config)) || !trustedContext || !guard || !ports.hostAuthority) {
      return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['Investigation requires explicit plan, host snapshot, and v0.2 admission configuration'] };
    }
    if (!(await trustedOwnerStateMatches(trustedContext, state.state))) {
      return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Trusted host configuration does not share the current owner task state'] };
    }

    const baselineResult = await investigateBaseline(state.task, ports.repositoryPort, ports.hostAuthority, {
      ...trustedContext,
      executionGuard: guard,
      statePort: trustedContext.statePort,
    });
    if (baselineResult.status !== 'reproduced' || !baselineResult.baseline) {
      return {
        state: state.state,
        terminalOutcome: 'INCOMPLETE' as const,
        reasons: [`Baseline investigation failed: ${baselineResult.status}${baselineResult.reason ? ` (${baselineResult.reason})` : ''}`],
      };
    }
    const postBaseline = await reloadAuthoritativeState(state.state, ports.statePort, { allowAccountingChange: true });
    if (!postBaseline.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [postBaseline.reason] };

    // A generated plan is bound to the post-baseline owner state, so the admission reserves against
    // the same version the proposal is written into.
    let suppliedPlan = planDetails;
    let ownerState = postBaseline.state;
    if (suppliedPlan === undefined && config !== undefined) {
      const generated = await generate(config, state.task, postBaseline.state, 'propose-plan', []);
      if (!generated.ok)
        return { state: postBaseline.state, terminalOutcome: generated.reason.startsWith('HUMAN_WAIT') ? ('needs-info' as const) : ('INCOMPLETE' as const), reasons: [generated.reason] };
      if (generated.proposal.kind === 'request-info') {
        // The claim committed the coder reservations without bumping stateVersion, as for the plan write.
        const postClaim = await reloadAuthoritativeState(postBaseline.state, ports.statePort, { allowAccountingChange: true });
        if (!postClaim.ok) return { state: postBaseline.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [postClaim.reason] };
        // Rounds are exhausted: refuse here, so the producer's throw never becomes an unconfirmed transition.
        const roundRefusal = clarificationRoundRefusal(postClaim.state, generated.proposal);
        if (roundRefusal !== undefined) return { state: postClaim.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [roundRefusal] };
        const asked = await askClarification({ statePort: ports.statePort, prior: postClaim.state, proposal: generated.proposal });
        // A replayed ask on an already-answered record leaves no open question, so it cannot be a pause.
        // It also cannot return without an outcome: the replay leaves `node` at Investigate, so the edge
        // would route straight back here and re-run this model turn on every lap until the runner's own
        // step limit stops it. `round` is unchanged on a replay, so the section 8 cap does not bound that.
        if (asked.replayed && asked.state.clarification?.answer)
          return {
            state: asked.state,
            terminalOutcome: 'INCOMPLETE' as const,
            reasons: ['The clarification record already answers this ask, so no question is open to pause on'],
          };
        return { state: asked.state, terminalOutcome: 'needs-info' as const, reasons: ['Task paused on a bound coder question'] };
      }
      if (generated.proposal.kind !== 'propose-plan')
        return { state: postBaseline.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [`Expected a plan proposal, received ${generated.proposal.kind}`] };
      // The claim committed the coder reservations without bumping stateVersion; the plan write must
      // carry those ledgers, so reload rather than trusting the pre-claim snapshot.
      const postClaim = await reloadAuthoritativeState(postBaseline.state, ports.statePort, { allowAccountingChange: true });
      if (!postClaim.ok) return { state: postBaseline.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [postClaim.reason] };
      ownerState = postClaim.state;
      suppliedPlan = {
        diagnosis: generated.proposal.diagnosis,
        strategy: generated.proposal.strategy,
        suspectedCauseLocations: generated.proposal.suspectedLocations,
        scopedChanges: generated.proposal.scopedPaths,
      };
    }

    let milestones = addMilestone(
      state.milestones ?? [],
      state.state.taskId,
      state.state.runId,
      'Investigate',
      'investigation_completed',
      'Baseline reproduced and test protection digest computed',
      'success',
    );
    const planResult = await prepareFixPlanAndApproval(
      ownerState,
      baselineResult.baseline,
      {
        repository: ports.repositoryPort,
        state: ports.statePort,
        approval: ports.approvalPort,
        baselineEvidenceWriter: ports.baselineEvidenceWriter,
        model: ports.modelPort,
        host: ports.hostAuthority,
        config: ports.configPort,
      },
      suppliedPlan,
    );
    milestones = addMilestone(milestones, state.state.taskId, state.state.runId, 'Investigate', 'plan_proposed', `Fix plan proposal finished with ${planResult.outcome}`, 'info');
    if (!planResult.state) {
      return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [planResult.reason ?? 'Plan preparation did not persist owner state'], milestones };
    }
    const persisted = await reloadAuthoritativeState(planResult.state, ports.statePort);
    if (!persisted.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason], milestones };
    if (planResult.outcome === 'rejected') {
      if (persisted.state.node === 'AwaitFeedback') return { state: persisted.state, milestones };
      return { state: persisted.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [planResult.reason ?? 'Plan was rejected'], milestones };
    }
    if (planResult.outcome === 'approved') {
      milestones = addMilestone(milestones, state.state.taskId, state.state.runId, 'AwaitPlan', 'plan_approved', 'Fix plan explicitly approved', 'success');
    }

    const baselineRef = planResult.plan?.baselineRef;
    if (!baselineRef) return { state: persisted.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Persisted baseline reference is missing'], milestones };
    const baseline: Baseline = {
      evidenceId: baselineRef,
      repositorySnapshotDigest: baselineResult.baseline.repositorySnapshotDigest,
      checkSetDigest: baselineResult.baseline.checkSetDigest,
      reproductionFailureSignature: baselineResult.baseline.reproductionFailureSignature,
      checkResults: baselineResult.baseline.checkResults,
      testProtectionDigest: baselineResult.baseline.testProtectionDigest,
    };
    return { state: persisted.state, baseline, milestones };
  };
}

export function createRepairNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  const run: UC03GraphNode = async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Repair') return { terminalOutcome: 'INCOMPLETE' as const };
    const refusal = generationRefusal(config, 'Repair');
    if (refusal) return { terminalOutcome: 'INCOMPLETE' as const, reasons: [refusal] };
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    let repairPatch = config?.repairPatch;
    const failures = state.failureEvidence ?? [];
    if (config && repairPatch === undefined && generates(config)) {
      const generated = await generate(config, state.task, current.state, 'propose-repair', []);
      if (!generated.ok) return { state: current.state, terminalOutcome: generated.reason.startsWith('HUMAN_WAIT') ? ('needs-info' as const) : ('INCOMPLETE' as const), reasons: [generated.reason] };
      if (generated.proposal.kind !== 'propose-patch')
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [`Expected a repair proposal, received ${generated.proposal.kind}`] };
      const refs = failureRefs(failures);
      repairPatch = { diff: generated.proposal.diff, affectedPaths: generated.proposal.targetPaths, evidenceRefs: refs.evidence, diagnosticRefs: refs.diagnostics };
    }
    if (!config || !repairPatch) {
      const outcome: 'IMPLEMENTED_UNVERIFIED' | 'INCOMPLETE' = current.state.changedPaths.length ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE';
      const next = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete' as const, outcome, nextAction: 'halt-no-repair-proposal' };
      const persisted = await transitionState(ports.statePort, next, current.state.stateVersion);
      return { state: persisted, terminalOutcome: outcome, reasons: ['No repair patch proposal provided'] };
    }
    const expected = trustedExpectedContext(config, state.task, current.state);
    const guard = resolveExecutionGuard(ports, config),
      source = config.admissionContext;
    if (!expected?.statePort || !guard || !source) {
      const outcome: 'IMPLEMENTED_UNVERIFIED' | 'INCOMPLETE' = current.state.changedPaths.length ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE';
      const next = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete' as const, outcome, nextAction: 'halt-missing-repair-admission' };
      const persisted = await transitionState(ports.statePort, next, current.state.stateVersion);
      return { state: persisted, terminalOutcome: outcome, reasons: ['Repair requires current v0.2 admission and finite owner configuration'] };
    }
    const actionId = createRepairActionId(current.state, failures);
    if (!actionId) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair requires current actionable failure evidence'] };
    const admission =
      typeof source === 'function'
        ? await source({ task: state.task, state: current.state, patchContent: repairPatch.diff, targetPaths: repairPatch.affectedPaths, actionId, failureEvidence: failures })
        : source;
    if (!admission) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Owner did not issue a repair admission for the current task state'] };
    const validated = validateRepositoryAdmissionV02(admission.context, admission.trustedContext);
    if (
      !validated.ok ||
      validated.value.runnableNode !== 'Repair' ||
      validated.value.planApplicability !== 'approved-plan' ||
      validated.value.action.kind !== 'apply_patch' ||
      validated.value.action.actionId !== actionId ||
      validated.value.action.patchContent !== repairPatch.diff ||
      !samePaths(validated.value.action.targetPaths, repairPatch.affectedPaths) ||
      validated.value.canonicalRevision !== current.state.repositoryRevisionDigest ||
      validated.value.expectedTaskStateVersion !== current.state.stateVersion ||
      validated.value.planDecisionRef !== current.state.plan?.decisionRef ||
      validated.value.planBindingDigest !== currentPlanBindingDigest(state.task, current.state)
    ) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair admission does not bind the current owner state and exact repair patch'] };
    }
    const before = await reloadAuthoritativeState(current.state, ports.statePort);
    if (!before.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [before.reason] };
    const trustedRepairContext = createTrustedRepairContext(current.state, failures, validated.value);
    if (!trustedRepairContext) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair evidence cannot be bound to the current owner state'] };
    const result = await executeRepair(
      { taskId: current.state.taskId, failureEvidence: failures, repairPatch, actionId, admissionContext: validated.value },
      {
        statePort: expected.statePort,
        repositoryPort: ports.repositoryPort,
        executionGuard: guard,
        approvalPort: ports.approvalPort,
        admissionContext: validated.value,
        trustedRepairContext,
        trustedTransitionContext: config.trustedTransitionContext,
      },
    );
    if (!result.state) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: result.reasons };
    const persisted = await reloadAuthoritativeState(result.state, ports.statePort);
    if (!persisted.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason] };
    if (result.outcome !== 'REPAIR_PREPARED' || !result.executionReceipt) {
      return {
        state: persisted.state,
        patchAdmission: undefined,
        patchReceipt: undefined,
        terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const,
        reasons: result.reasons.length ? result.reasons : ['Repair owner settlement receipt is missing'],
      };
    }
    const nextEvidence: UC03GraphState = { ...state, state: persisted.state, patchAdmission: admission, patchReceipt: result.executionReceipt };
    if (!validSettledPatchEvidence(nextEvidence, state.task, persisted.state)) {
      return {
        state: persisted.state,
        patchAdmission: undefined,
        patchReceipt: undefined,
        terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const,
        reasons: ['Repair owner settlement receipt does not bind the latest revision'],
      };
    }
    return { state: persisted.state, patchAdmission: admission, patchReceipt: result.executionReceipt };
  };
  return async state => ({ patchAdmission: undefined, patchReceipt: undefined, ...(await run(state)) });
}
