import {
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  type Baseline,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import {
  investigateBaseline,
  prepareFixPlanAndApproval,
} from './investigation.ts';
import { executeVerificationChecks } from './verification.ts';
import { createRepairActionId, createTrustedRepairContext, executeRepair } from './repair.ts';
import type { UC03GraphConfig, UC03GraphNode, UC03GraphPorts, UC03GraphState } from './graph-types.ts';

import {
  addMilestone, currentPlanBindingDigest, loadCurrentOwnerState, patchResult,
  reloadAuthoritativeState, requiredChecksPassed, resolveExecutionGuard,
  samePaths, transitionState, trustedExpectedContext, trustedOwnerStateMatches,
  validDiffInfo, validSettledPatchEvidence,
} from './graph-validation.ts';

export function createInvestigateNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state || state.state.node !== 'Investigate') {
        return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['Investigate requires authoritative task state at the Investigate node'] };
      }
      const planDetails = config?.planDetails;
      const trustedContext = trustedExpectedContext(config, state.task, state.state);
      const guard = resolveExecutionGuard(ports, config);
      if (!planDetails || !trustedContext || !guard || !ports.hostAuthority) {
        return { terminalOutcome: 'INCOMPLETE' as const, reasons: ['Investigation requires explicit plan, host snapshot, and v0.2 admission configuration'] };
      }
      if (!await trustedOwnerStateMatches(trustedContext, state.state)) {
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

      let milestones = addMilestone(
        state.milestones ?? [], state.state.taskId, state.state.runId, 'Investigate', 'investigation_completed',
        'Baseline reproduced and test protection digest computed', 'success',
      );
      const planResult = await prepareFixPlanAndApproval(
        postBaseline.state,
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
        planDetails,
      );
      milestones = addMilestone(
        milestones, state.state.taskId, state.state.runId, 'Investigate', 'plan_proposed',
        `Fix plan proposal finished with ${planResult.outcome}`, 'info',
      );
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

export function createPatchNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state || state.state.node !== 'Patch') return { terminalOutcome: 'INCOMPLETE' as const };
      const current = await reloadAuthoritativeState(state.state, ports.statePort);
      if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
      const admissionSource = config?.admissionContext;
      const guard = resolveExecutionGuard(ports, config);
      if (!admissionSource || !guard || !config?.patchContent || !config.targetPaths?.length) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Patch requires explicit v0.2 admission, guarded workspace, patch bytes, and target paths'] };
      }
      const admission = typeof admissionSource === 'function'
        ? await admissionSource({ task: state.task, state: current.state, patchContent: config.patchContent, targetPaths: config.targetPaths })
        : admissionSource;
      if (!admission) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Owner did not issue a patch admission for the current task state'] };
      const beforePatch = await reloadAuthoritativeState(current.state, ports.statePort);
      if (!beforePatch.ok) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [beforePatch.reason] };
      const validated = validateRepositoryAdmissionV02(admission.context, admission.trustedContext);
      const action = validated.ok ? validated.value.action : undefined;
      if (
        !validated.ok ||
        !action || action.kind !== 'apply_patch' ||
        action.patchContent !== config.patchContent ||
        !samePaths(action.targetPaths, config.targetPaths) ||
        action.baseRevisionDigest !== current.state.repositoryRevisionDigest ||
        validated.value.taskId !== current.state.taskId ||
        validated.value.runId !== current.state.runId ||
        validated.value.workspaceId !== current.state.workspaceId ||
        validated.value.repositoryId !== current.state.repositoryId ||
        validated.value.expectedTaskStateVersion !== current.state.stateVersion ||
        validated.value.runnableNode !== 'Patch' ||
        validated.value.planApplicability !== 'approved-plan' ||
        validated.value.planDecisionRef !== current.state.plan?.decisionRef ||
        validated.value.planBindingDigest !== currentPlanBindingDigest(state.task, current.state)
      ) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Patch admission does not bind the current owner state and exact patch'] };
      }
      const result = await guard.validateAndExecute(action, current.state, validated.value);
      if (result.outcome !== 'success') {
        const outcome = result.outcome === 'uncertain-effect' ? 'IMPLEMENTED_UNVERIFIED' as const : 'INCOMPLETE' as const;
        const owner = await loadCurrentOwnerState(state.task, ports.statePort);
        return {
          ...(owner.ok ? { state: owner.state } : {}),
          terminalOutcome: outcome,
          reasons: [
            `Patch execution refused: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
            ...(!owner.ok ? [owner.reason] : []),
          ],
        };
      }
      const patch = patchResult(result.result);
      if (!patch) {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch effect was reported without a valid v0.2 execution receipt'] };
      }
      const execution = validateRepositoryExecutionReceiptV02(patch.executionReceipt, validated.value);
      if (!execution.ok || execution.value.outcome.repositoryOperation !== 'apply-patch' ||
          execution.value.outcome.observedResultRevisionDigest !== patch.newRevisionDigest) {
        return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch receipt does not bind the owner-settled revision'] };
      }
      const ownerCandidate: TaskState = {
        ...current.state,
        stateVersion: execution.value.attempt.postBeginTaskStateVersion + 1,
        node: 'Verify',
        repositoryRevisionDigest: patch.newRevisionDigest,
        activeDecisionId: undefined,
        reviewRefs: [],
        latestReviewRef: undefined,
      };
      const persisted = await reloadAuthoritativeState(ownerCandidate, ports.statePort, { allowAccountingChange: true });
      if (!persisted.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Patch effect did not produce the owner state bound to its settled receipt'] };
      return {
        state: persisted.state,
        patchAdmission: admission,
        patchReceipt: execution.value,
        milestones: addMilestone(state.milestones ?? [], persisted.state.taskId, persisted.state.runId, 'Patch', 'patch_applied', 'Patch applied and settled by the v0.2 owner protocol', 'success'),
      };
    };
}

export function createVerifyNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
      if (!state.task || !state.state || state.state.node !== 'Verify') return { terminalOutcome: 'INCOMPLETE' as const };
      const current = await reloadAuthoritativeState(state.state, ports.statePort);
      if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
      if (!validSettledPatchEvidence(state, state.task, current.state)) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification requires the current persisted patch admission and settlement receipt'] };
      }
      const trusted = trustedExpectedContext(config, state.task, current.state);
      const guard = resolveExecutionGuard(ports, config);
      if (!trusted || !guard) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification requires current v0.2 host admission'] };
      if (!await trustedOwnerStateMatches(trusted, current.state)) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Trusted host and route ports do not share current owner task state'] };
      const diffInfo = await ports.repositoryPort.inspectDiff(state.task.initialRevisionDigest);
      if (!validDiffInfo(diffInfo)) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Current repository diff response is invalid'] };
      const results = await executeVerificationChecks(state.task, ports.repositoryPort, {
        runId: current.state.runId,
        repoDigest: current.state.repositoryRevisionDigest,
        diffDigest: diffInfo.diffDigest,
        ...(trusted.admissionContextForCheck ? { admissionContextForCheck: trusted.admissionContextForCheck } : {}),
        executionGuard: guard,
        statePort: trusted.statePort,
      });
      const postChecks = await reloadAuthoritativeState(current.state, ports.statePort, { allowAccountingChange: true });
      if (!postChecks.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [postChecks.reason] };
      const passing = requiredChecksPassed(state.task, postChecks.state, diffInfo.diffDigest, results);
      const nextNode = passing ? 'Review' : 'Repair';
      const next: TaskState = {
        ...postChecks.state,
        stateVersion: postChecks.state.stateVersion + 1,
        node: nextNode,
        changedPaths: [...new Set([...postChecks.state.changedPaths, ...diffInfo.changedFiles])],
        evidenceRefs: [...new Set([
          ...postChecks.state.evidenceRefs,
          ...results.flatMap((result) => [result.evidenceId, result.actionId, ...result.diagnosticRefs]),
        ])],
        nextAction: passing ? 'request-review' : 'repair-failing-checks',
      };
      const persisted = await transitionState(ports.statePort, next, postChecks.state.stateVersion);
      const milestones = addMilestone(
        state.milestones ?? [], persisted.taskId, persisted.runId, 'Verify', 'verification_completed',
        passing ? 'All verification checks passed' : 'Required verification did not pass', passing ? 'success' : 'failure',
        results.map((result) => result.evidenceId),
      );
      return {
        state: persisted,
        verificationResults: results,
        ...(passing ? {} : { failureEvidence: results.filter((result) => result.outcome !== 'pass') }),
        milestones,
      };
    };
}

export function createRepairNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  const run: UC03GraphNode = async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Repair') return { terminalOutcome: 'INCOMPLETE' as const };
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    const repairPatch = config?.repairPatch;
    if (!config || !repairPatch) {
      const outcome: 'IMPLEMENTED_UNVERIFIED' | 'INCOMPLETE' = current.state.changedPaths.length ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE';
      const next = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete' as const, outcome, nextAction: 'halt-no-repair-proposal' };
      const persisted = await transitionState(ports.statePort, next, current.state.stateVersion);
      return { state: persisted, terminalOutcome: outcome, reasons: ['No repair patch proposal provided'] };
    }
    const expected = trustedExpectedContext(config, state.task, current.state);
    const guard = resolveExecutionGuard(ports, config), source = config.admissionContext;
    if (!expected?.statePort || !guard || !source) {
      const outcome: 'IMPLEMENTED_UNVERIFIED' | 'INCOMPLETE' = current.state.changedPaths.length ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE';
      const next = { ...current.state, stateVersion: current.state.stateVersion + 1, node: 'Incomplete' as const, outcome, nextAction: 'halt-missing-repair-admission' };
      const persisted = await transitionState(ports.statePort, next, current.state.stateVersion);
      return { state: persisted, terminalOutcome: outcome, reasons: ['Repair requires current v0.2 admission and finite owner configuration'] };
    }
    const failures = state.failureEvidence ?? [], actionId = createRepairActionId(current.state, failures);
    if (!actionId) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair requires current actionable failure evidence'] };
    const admission = typeof source === 'function'
      ? await source({ task: state.task, state: current.state, patchContent: repairPatch.diff, targetPaths: repairPatch.affectedPaths, actionId, failureEvidence: failures })
      : source;
    if (!admission) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Owner did not issue a repair admission for the current task state'] };
    const validated = validateRepositoryAdmissionV02(admission.context, admission.trustedContext);
    if (!validated.ok || validated.value.runnableNode !== 'Repair' || validated.value.planApplicability !== 'approved-plan' ||
        validated.value.action.kind !== 'apply_patch' || validated.value.action.actionId !== actionId ||
        validated.value.action.patchContent !== repairPatch.diff || !samePaths(validated.value.action.targetPaths, repairPatch.affectedPaths) ||
        validated.value.canonicalRevision !== current.state.repositoryRevisionDigest || validated.value.expectedTaskStateVersion !== current.state.stateVersion ||
        validated.value.planDecisionRef !== current.state.plan?.decisionRef || validated.value.planBindingDigest !== currentPlanBindingDigest(state.task, current.state)) {
      return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair admission does not bind the current owner state and exact repair patch'] };
    }
    const before = await reloadAuthoritativeState(current.state, ports.statePort);
    if (!before.ok) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [before.reason] };
    const trustedRepairContext = createTrustedRepairContext(current.state, failures, validated.value);
    if (!trustedRepairContext) return { state: current.state, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair evidence cannot be bound to the current owner state'] };
    const result = await executeRepair(
      { taskId: current.state.taskId, failureEvidence: failures, repairPatch, actionId, admissionContext: validated.value },
      { statePort: expected.statePort, repositoryPort: ports.repositoryPort, executionGuard: guard, approvalPort: ports.approvalPort, admissionContext: validated.value, trustedRepairContext, trustedTransitionContext: config.trustedTransitionContext },
    );
    if (!result.state) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: result.reasons };
    const persisted = await reloadAuthoritativeState(result.state, ports.statePort);
    if (!persisted.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [persisted.reason] };
    if (result.outcome !== 'REPAIR_PREPARED' || !result.executionReceipt) {
      return { state: persisted.state, patchAdmission: undefined, patchReceipt: undefined, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: result.reasons.length ? result.reasons : ['Repair owner settlement receipt is missing'] };
    }
    const nextEvidence: UC03GraphState = { ...state, state: persisted.state, patchAdmission: admission, patchReceipt: result.executionReceipt };
    if (!validSettledPatchEvidence(nextEvidence, state.task, persisted.state)) {
      return { state: persisted.state, patchAdmission: undefined, patchReceipt: undefined, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: ['Repair owner settlement receipt does not bind the latest revision'] };
    }
    return { state: persisted.state, patchAdmission: admission, patchReceipt: result.executionReceipt };
  };
  return async (state) => ({ patchAdmission: undefined, patchReceipt: undefined, ...await run(state) });
}
