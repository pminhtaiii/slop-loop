/**
 * Real-tier plan approval context adapter and synthetic post-patch verification context builder.
 *
 * Bridges `createRealContextProvider` with durable `TaskState` plan freshness and bounded lease
 * renewal for `AwaitPlan` decisions. Durable state transitions away from the pending `AwaitPlan`
 * decision resolve to `undefined` so UC-05's `admitContext` raises a non-sticky `invalid` refusal
 * without closing approval admission, while genuine loader or workspace faults still fail closed.
 */
import { ApprovalServiceError } from '../approvals/service.ts';
import type { ApprovalContext } from '../approvals/service-data.ts';
import type { createRealContextProvider, RealContextSource } from '../approvals/real-context-provider.ts';
import { computeCanonicalSha256, type TaskState } from '../contracts/foundation/uc03.ts';
import type { DurableApprovalStore } from '../persistence/adapters/approval-store-adapter.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import { HostActionContextError, type HostActionContext } from './host-action-context.ts';

export type RealContextPolicyIdentity = Readonly<{
  policyId: string;
  policyVersion: string;
  configId?: string;
  configVersion?: string;
}>;

type RealContextProvider = ReturnType<typeof createRealContextProvider>;

const unbound = (): never => {
  throw new ApprovalServiceError('unavailable');
};

function matchesPendingAwaitPlan(state: TaskState, decisionId: string, actionRef: string): boolean {
  return state.node === 'AwaitPlan' && state.activeDecisionId === decisionId && state.plan?.decisionRef === actionRef;
}

/**
 * The durable provider, with the graph's first-request convention: a decision's action id is its
 * decision id, and no request record exists yet when it is first made. The stored record stays
 * primary; only its absence falls back to that same observed action.
 */
export function createRealTierPlanContext(
  provider: RealContextProvider,
  taskId: string,
  statePort: DurableStatePortV02,
  ownerPolicyIdentity?: RealContextPolicyIdentity,
  approvalStore?: Pick<DurableApprovalStore, 'readRequest'>,
  source?: RealContextSource & Partial<Pick<HostActionContext, 'renew'>>,
): RealContextProvider {
  const observedPlan = async (input: unknown): Promise<unknown> => {
    // The provider has admitted this context; persisted plan facts complete its approval freshness.
    const context = input as ApprovalContext;
    if (context.action.kind !== 'approve_fix_plan') return input;
    const state = await statePort.loadTask(taskId);
    if (!state) return unbound();
    const plan = state.plan;
    if (!plan) return undefined;
    // The first plan is requested from AwaitPlan; the post-patch verification approval is requested
    // from Verify (no active decision yet) against the same recorded plan. Both are the plan decision.
    const firstPlan = state.node === 'AwaitPlan' && plan.decisionRef === context.action.actionId;
    const verification = state.node === 'Verify' && state.activeDecisionId === undefined && plan.strategyDigest === context.action.strategyDigest;
    if (!firstPlan && !verification) return undefined;
    return {
      ...context,
      freshness: {
        ...context.freshness,
        currentPlanVersion: plan.planVersion,
        currentStrategyDigest: plan.strategyDigest,
        currentBaselineRef: plan.baselineRef,
        currentEvidenceRefs: plan.evidenceRefs,
        currentCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
        currentCheckSetDigest: plan.checkSetDigest,
      },
    };
  };

  return {
    loadForAction: async (task, actionId) => {
      const raw = await provider.loadForAction(task, actionId).catch(() => undefined);
      return raw === undefined ? observedSyntheticPlan(taskId, actionId, statePort, ownerPolicyIdentity) : observedPlan(raw);
    },
    loadForDecision: async decisionId => {
      // A verification D1 (`dec-verify-…`) has no stored request and was never a registered action.
      if (decisionId.startsWith('dec-verify-')) return observedSyntheticPlan(taskId, decisionId, statePort, ownerPolicyIdentity);
      let loaded: unknown;
      try {
        loaded = await provider.loadForDecision(decisionId);
      } catch (error) {
        if (error instanceof Error && error.message === 'real-context-unknown-decision') {
          loaded = await provider.loadForAction(taskId, decisionId);
        } else if (error instanceof HostActionContextError && error.code === 'EXPIRED_AUTHORITY' && approvalStore && typeof source?.renew === 'function') {
          const response = approvalStore.readRequest(decisionId);
          const storedRequest = response.safe.outcome === 'ok' ? response.value : null;
          const state = await statePort.loadTask(taskId);
          if (!storedRequest || !state) throw error;
          // Moving off the pending AwaitPlan decision is a stale-state mismatch, not a loader fault:
          // returning undefined lets admitContext issue a non-sticky invalid refusal without closing admission.
          if (!matchesPendingAwaitPlan(state, decisionId, storedRequest.actionRef)) return undefined;
          await source.renew(taskId, storedRequest.actionRef);
          const postRenewState = await statePort.loadTask(taskId);
          if (!postRenewState) throw error;
          if (!matchesPendingAwaitPlan(postRenewState, decisionId, storedRequest.actionRef)) return undefined;
          loaded = await provider.loadForDecision(decisionId);
        } else {
          throw error;
        }
      }
      return observedPlan(loaded);
    },
  };
}

/**
 * A plan decision the host never registered as an action (the post-patch verification D1): the
 * durable task already records the exact plan, so the observed action and facts are reconstructed
 * from it — the provider's own freshness fields still come from `observedPlan`.
 */
export async function observedSyntheticPlan(taskId: string, actionId: string, statePort: DurableStatePortV02, ownerPolicyIdentity?: RealContextPolicyIdentity): Promise<unknown> {
  const state = await statePort.loadTask(taskId);
  const plan = state?.plan;
  if (!state || !plan || state.node !== 'Verify' || state.activeDecisionId !== undefined) return unbound();
  const action = {
    actionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  const policyId = ownerPolicyIdentity?.policyId ?? state.taskContext?.configId ?? '';
  const policyVersion = ownerPolicyIdentity?.policyVersion ?? state.taskContext?.configVersion ?? '';
  const configId = ownerPolicyIdentity?.configId ?? state.taskContext?.configId ?? '';
  const configVersion = ownerPolicyIdentity?.configVersion ?? state.taskContext?.configVersion ?? '';
  const built = {
    action,
    facts: {
      taskId: state.taskId,
      workspaceId: state.workspaceId,
      repositoryId: state.repositoryId,
      repositoryRevisionDigest: state.repositoryRevisionDigest,
      policyIdentity: {
        policyId,
        policyVersion,
        configId,
        configVersion,
      },
      registeredActionDigest: computeCanonicalSha256(action),
      continuationRef: actionId,
      role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      patch: null,
      command: null,
      plan: null,
    },
    elements: {
      action: plan.strategy,
      necessity: plan.diagnosis,
      targets: plan.scopedChanges,
      consequences: 'Approval permits verification of the scoped repair',
      verificationStatus: 'Patch applied; verification pending',
    },
    runId: state.runId,
    freshness: {
      currentTaskId: state.taskId,
      currentWorkspaceId: state.workspaceId,
      currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
      currentPolicyId: policyId,
      currentPolicyVersion: policyVersion,
      currentNormalizedActionDigest: computeCanonicalSha256(action),
      currentPlanVersion: plan.planVersion,
      currentStrategyDigest: plan.strategyDigest,
      currentBaselineRef: plan.baselineRef,
      currentEvidenceRefs: plan.evidenceRefs,
      currentCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
      currentCheckSetDigest: plan.checkSetDigest,
    },
  };
  return built;
}
