import { computeCanonicalSha256, computeCheckSetDigest, type TaskState } from '../contracts/foundation/uc03.ts';
import { executeVerificationChecks } from './verification.ts';
import type { UC03GraphConfig, UC03GraphNode, UC03GraphPorts, UC03GraphState } from './graph-types.ts';
import {
  addMilestone,
  reloadAuthoritativeState,
  requiredChecksPassed,
  resolveExecutionGuard,
  transitionState,
  trustedExpectedContext,
  trustedOwnerStateMatches,
  validDiffInfo,
} from './graph-validation.ts';
import { loadVerifiedPatchAncestry, restoreVerificationEvidence } from './graph-patch-ancestry.ts';
import {
  currentPlanApprovalIsCurrent,
  prepareVerificationApproval,
} from './post-patch-verification-authority.ts';

export function createVerifyNode(ports: UC03GraphPorts, config?: UC03GraphConfig): UC03GraphNode {
  return async (state: UC03GraphState) => {
    if (!state.task || !state.state || state.state.node !== 'Verify') return { terminalOutcome: 'INCOMPLETE' as const };
    const task = state.task;
    const current = await reloadAuthoritativeState(state.state, ports.statePort);
    if (!current.ok) return { state: state.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [current.reason] };
    const trusted = trustedExpectedContext(config, task, current.state);
    const guard = resolveExecutionGuard(ports, config);
    const owner = trusted?.statePort;
    if (!trusted || !owner || !guard || !owner.readVerificationAuthoritySnapshot ||
        !owner.recordVerificationApproval || !owner.resolvePlanDecisionInContext || !owner.readSettledPatchAncestry) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification requires the public v0.2 owner authority and ancestry capabilities'] };
    }
    if (!await trustedOwnerStateMatches(trusted, current.state)) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Trusted host and route ports do not share current owner task state'] };
    }
    const ancestry = await loadVerifiedPatchAncestry(task, current.state, owner);
    if (!ancestry) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification requires issuer-validated owner patch ancestry'] };
    if ((state.patchAdmission && computeCanonicalSha256(state.patchAdmission) !== computeCanonicalSha256(ancestry.admission)) ||
        (state.patchReceipt && computeCanonicalSha256(state.patchReceipt) !== computeCanonicalSha256(ancestry.receipt))) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Graph patch evidence differs from the settled owner journal'] };
    }
    let baseline = state.baseline;
    if (!baseline) {
      const restored = await restoreVerificationEvidence(
        task, current.state, owner, ports.baselineEvidenceWriter, trusted.expectedTestFiles,
      );
      if (!restored) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['TaskState-only resume lacks owner-retained baseline or patch evidence'] };
      baseline = restored.baseline;
    }
    const originalPlan = ancestry.originalTaskState.plan;
    if (!originalPlan || baseline.evidenceId !== originalPlan.baselineRef ||
        baseline.repositorySnapshotDigest !== task.initialRevisionDigest ||
        baseline.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) ||
        current.state.plan?.baselineRef !== baseline.evidenceId) {
      return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification baseline does not match owner patch ancestry and current task criteria'] };
    }
    const beforeApproval = await reloadAuthoritativeState(current.state, ports.statePort);
    if (!beforeApproval.ok) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: [beforeApproval.reason] };
    const snapshot = await owner.readVerificationAuthoritySnapshot(current.state.taskId);
    if (!snapshot) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification authority snapshot is unavailable'] };
    const prepared = prepareVerificationApproval(task, beforeApproval.state, snapshot, ancestry.originalDecisionId);
    if (!prepared) return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Fresh verification approval cannot be safely bound to the settled plan'] };

    let verifiedState = beforeApproval.state;
    const currentPointer = verifiedState.plan?.decisionRef === prepared.request.decisionId && verifiedState.activeDecisionId === prepared.request.decisionId;
    if (!currentPointer) {
      if (verifiedState.plan?.decisionRef !== ancestry.originalDecisionId || verifiedState.activeDecisionId !== undefined) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification decision reference is stale or already inconsistent'] };
      }
      let requestResult;
      try { requestResult = await ports.approvalPort.requestDecision(prepared.binding); }
      catch { return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification approval request could not be issued'] }; }
      if (requestResult.decisionId !== prepared.request.decisionId) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Approval issuer returned a different verification decision identity'] };
      }
      let recorded;
      try { recorded = await owner.recordVerificationApproval(prepared.request); }
      catch { return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Owner could not record the verification approval'] }; }
      if (recorded.outcome === 'pending') {
        if (computeCanonicalSha256(recorded.state) !== computeCanonicalSha256(verifiedState) ||
            recorded.controlVersion !== snapshot.controlVersion || recorded.epoch !== snapshot.epoch ||
            recorded.decisionAuthorityGeneration !== snapshot.decisionAuthorityGeneration) {
          return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Pending approval changed owner state or authority counters'] };
        }
        return {
          state: recorded.state,
          baseline,
          patchAdmission: ancestry.admission,
          patchReceipt: ancestry.receipt,
          terminalOutcome: 'pending-approval' as const,
          reasons: ['Fresh post-patch verification approval is pending'],
        };
      }
      if (recorded.outcome === 'rejected') {
        if (computeCanonicalSha256(recorded.state) !== computeCanonicalSha256(verifiedState) ||
            recorded.controlVersion !== snapshot.controlVersion + 1 || recorded.epoch !== snapshot.epoch ||
            recorded.decisionAuthorityGeneration !== snapshot.decisionAuthorityGeneration) {
          return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Rejected approval did not preserve task state and establish one owner hold'] };
        }
        return {
          state: recorded.state,
          baseline,
          patchAdmission: ancestry.admission,
          patchReceipt: ancestry.receipt,
          terminalOutcome: 'INCOMPLETE' as const,
          reasons: ['Fresh post-patch verification approval was rejected and the owner placed the task on hold'],
        };
      }
      if (recorded.outcome !== 'approved' || recorded.decisionId !== prepared.request.decisionId ||
          recorded.controlVersion !== snapshot.controlVersion + 1 || recorded.epoch !== snapshot.epoch ||
          recorded.decisionAuthorityGeneration !== snapshot.decisionAuthorityGeneration ||
          !approvedRebindMatches(verifiedState, recorded.state, prepared.request.decisionId)) {
        return { state: current.state, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Owner verification approval result did not perform the exact one-field authority rebind'] };
      }
      verifiedState = recorded.state;
    }

    const d1 = verifiedState.plan?.decisionRef;
    if (!d1 || verifiedState.activeDecisionId !== d1 ||
        !await currentPlanApprovalIsCurrent(task, verifiedState, owner, d1)) {
      return { state: verifiedState, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Current verification approval is not issuer-approved at the active owner generation'] };
    }
    const diffInfo = await ports.repositoryPort.inspectDiff(task.initialRevisionDigest);
    if (!validDiffInfo(diffInfo)) return { state: verifiedState, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Current repository diff response is invalid'] };
    if (!trusted.admissionContextForCheck) {
      return { state: verifiedState, terminalOutcome: 'INCOMPLETE' as const, reasons: ['Verification requires owner-issued current check admissions'] };
    }
    const results = await executeVerificationChecks(task, ports.repositoryPort, {
      runId: verifiedState.runId,
      repoDigest: verifiedState.repositoryRevisionDigest,
      diffDigest: diffInfo.diffDigest,
      admissionContextForCheck: async (request) => {
        if (!await currentPlanApprovalIsCurrent(task, request.currentState, owner, d1)) return undefined;
        return trusted.admissionContextForCheck?.(request);
      },
      executionGuard: guard,
      statePort: owner,
    });
    const postChecks = await reloadAuthoritativeState(verifiedState, ports.statePort, { allowAccountingChange: true });
    if (!postChecks.ok) return { state: verifiedState, terminalOutcome: 'IMPLEMENTED_UNVERIFIED' as const, reasons: [postChecks.reason] };
    const passing = requiredChecksPassed(task, postChecks.state, diffInfo.diffDigest, results);
    const next: TaskState = {
      ...postChecks.state,
      stateVersion: postChecks.state.stateVersion + 1,
      node: passing ? 'Review' : 'Repair',
      changedPaths: [...new Set([...postChecks.state.changedPaths, ...diffInfo.changedFiles])],
      evidenceRefs: [...new Set([...postChecks.state.evidenceRefs, ...results.flatMap((result) => [result.evidenceId, result.actionId, ...result.diagnosticRefs])])],
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
      baseline,
      patchAdmission: ancestry.admission,
      patchReceipt: ancestry.receipt,
      verificationResults: results,
      ...(passing ? {} : { failureEvidence: results.filter((result) => result.outcome !== 'pass') }),
      milestones,
    };
  };
}

function approvedRebindMatches(before: TaskState, after: TaskState, decisionId: string): boolean {
  const plan = before.plan;
  if (!plan) return false;
  const expected: TaskState = {
    ...before,
    stateVersion: before.stateVersion + 1,
    plan: { ...plan, decisionRef: decisionId },
    activeDecisionId: decisionId,
    approvalDecisionRefs: [...(before.approvalDecisionRefs ?? []), decisionId],
  };
  return computeCanonicalSha256(expected) === computeCanonicalSha256(after);
}
