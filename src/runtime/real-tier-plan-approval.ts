/** Register a persisted first plan with the host's measured context before UC-05 presents it. */
import { computeActionDigest, computeCanonicalSha256, type ApprovalPort } from '../contracts/foundation/uc03.ts';
import type { PolicyFacts } from '../approvals/policy.ts';
import type { RealTierBoundOwners } from './real-tier-owners.ts';
import type { HostActionContext } from './host-action-context.ts';

export function realTierPlanApproval(owners: RealTierBoundOwners): ApprovalPort {
  const service = owners.approvalService;
  return {
    provenance: 'real',
    classify: action => service.classify(action),
    validateBinding: binding => service.validateBinding(binding),
    resolve: id => service.resolve(id),
    requestDecision: async binding => {
      const state = await owners.statePort.loadTask(binding.taskId);
      const owner = await owners.statePort.readVerificationAuthoritySnapshot(binding.taskId);
      const plan = state?.plan;
      // The post-patch verification approval (node Verify, activeDecisionId still the original plan)
      // is requested and recorded by the durable owner itself; no host registration is involved, so
      // it goes straight to the service, which keeps its own stale/binding refusals.
      if (state?.node === 'Verify' && owner && state.activeDecisionId === undefined) {
        const pending = { ...binding };
        delete pending.reason;
        return service.requestDecision(pending);
      }
      if (
        !state ||
        !owner ||
        owner.controlMode !== 'runnable' ||
        owner.activeClaimId ||
        owner.holdRef ||
        state.node !== 'AwaitPlan' ||
        !plan ||
        plan.planVersion !== 1 ||
        plan.decisionRef !== binding.decisionId ||
        state.activeDecisionId !== binding.decisionId ||
        plan.strategyDigest !== binding.strategyDigest ||
        state.workspaceId !== binding.workspaceId ||
        state.repositoryRevisionDigest !== binding.repositoryRevisionDigest ||
        computeCanonicalSha256(plan.evidenceRefs) !== computeCanonicalSha256(binding.evidenceRefs)
      )
        throw new Error('PLAN_REGISTRATION_REFUSED');
      const source = owners.contextSource as Partial<HostActionContext>;
      if (typeof source.register !== 'function') throw new Error('PLAN_REGISTRY_REQUIRED');
      const action = {
        actionId: binding.decisionId,
        kind: 'approve_fix_plan' as const,
        planVersion: plan.planVersion,
        strategyDigest: plan.strategyDigest,
        diagnosisEvidenceRefs: plan.evidenceRefs,
        checkSetDigest: plan.checkSetDigest,
      };
      const { policyId, policyVersion, configId, configVersion } = owner.policyIdentity;
      const facts: PolicyFacts = {
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        policyIdentity: { policyId, policyVersion, configId, configVersion },
        registeredActionDigest: computeActionDigest(action),
        continuationRef: binding.decisionId,
        role: 'coder',
        // Presenting a plan executes no command or patch. The registry independently measures revision.
        safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
        patch: null,
        command: null,
        plan: null,
      };
      await source.register({
        action,
        facts,
        elements: {
          action: plan.strategy,
          necessity: plan.diagnosis,
          targets: plan.scopedChanges,
          consequences: 'Approval permits the scoped repair plan',
          verificationStatus: 'Baseline reproduced; repair verification pending',
        },
      });

      const pending = { ...binding };
      delete pending.reason;
      return service.requestDecision(pending);
    },
  };
}
