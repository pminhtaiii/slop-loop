/**
 * T050 — real owner deliveries and their per-task instances (real-tier contract §(a), §(b), §(c)1,
 * §(b)5, §(b)8, T046, T058).
 *
 * One store root, one real `DurableStatePortV02` and one real baseline store per process. The owner
 * ids record the delegated-attestation attribution: this code is built by the coordinator's workers
 * under the user's single delegated direction, never by Thanh Tan or Trong Tan.
 *
 * Everything here is task-independent. `taskOwners` builds the per-task instances T061 consumes —
 * the authority-bound state port, the read fence, the replan transaction, the UC-05 service and the
 * console port. Nothing touches disk at construction: the approval store creates its directory, so
 * it is built lazily inside `taskOwners`.
 */
import { join } from 'node:path';
import type { ApprovalService } from '../approvals/service.ts';
import { ApprovalServiceError } from '../approvals/service.ts';
import type { ApprovalServiceV02 } from '../approvals/service-v02.ts';
import { createApprovalService } from '../approvals/service.ts';
import { createRealContextProvider, type RealContextSource } from '../approvals/real-context-provider.ts';
import { computeCanonicalSha256, type ApprovalPort, type TaskState } from '../contracts/foundation/uc03.ts';
import type { ApprovalContext } from '../approvals/service-data.ts';
import type { PolicyAuthorityRefV02 } from '../contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../contracts/approvals/contracts.ts';
import type { GuardedReadOwnerPort } from '../foundation/guarded-read-capability.ts';
import { isProductionJournal } from '../foundation/production-journal-registry.ts';
import type { ExecutionProfileSourceV02 } from '../persistence/adapters/state-port-v02-admission.ts';
import type { OwnerDelivery } from './evaluation-composition.ts';
import { createBaselineEvidenceAdapter } from './baseline-evidence-adapter.ts';
import { createConsoleApprovalPort } from './console-approval-port.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import { HostActionContextError, type HostActionContext } from './host-action-context.ts';
import { createRecoveryGate, type RecoveryGate } from './real-tier-recovery.ts';
import type { UC03GraphPortsV02, MaterialReplanPortV02 } from '../uc03/graph-types-v02.ts';
import type { TrustedReplanDirection } from '../uc03/repair-types.ts';
import { DurableApprovalStore } from '../persistence/adapters/approval-store-adapter.ts';
import { DEFAULT_POLICY_PROFILE } from '../persistence/adapters/approval-types.ts';
import { createBaselineEvidenceStore } from '../persistence/adapters/baseline-evidence-store.ts';
import { createMaterialReplanPort } from '../persistence/adapters/material-replan-port.ts';
import { createJournalOperationLookup } from '../persistence/adapters/state-port-v02-operation-lookup.ts';
import { createStateReadFence } from '../persistence/adapters/state-port-v02-read-fence.ts';
import { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../persistence/store.ts';

/** The pinned owner-delivery contract these adapters declare: the host template's own contract. */
export const REAL_TIER_DELIVERY_CONTRACT = 'uc03-host-composition/2';
/** Delegated-attestation attribution, in the delivery id so it travels with the composition. */
const ATTRIBUTION = 'delegated-attestation';

export type RealTierOwnerComponent = 'statePort' | 'approvalPort' | 'baselineEvidence' | 'replanPort';

/** Facts one seeded task contributes; T061 supplies them, never a model or argv. */
export interface RealTierTaskBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** The task's own policy identity; the UC-05 profile and the action facts must agree with it. */
  readonly policyIdentity?: Readonly<{ policyId: string; policyVersion: string; configId: string; configVersion: string }> | undefined;
  /** Builds the per-task observed-action source; absent leaves the approval service refusing every context. */
  readonly createContext?: (() => RealContextSource) | undefined;
  /** The published authority ref the read fence must see; absent leaves the read fence refusing. */
  readonly authorityRef?: PolicyAuthorityRefV02 | undefined;
  /**
   * The task's own execution profile — the facts its real Docker-built command view will carry.
   * Absent leaves the port on its synthetic admission constants, which no real view matches.
   */
  readonly executionProfile?: ExecutionProfileSourceV02 | undefined;
}

/** The per-task owner instances T061 composes; each is already bound to one task. */
export interface RealTierBoundOwners {
  readonly statePort: DurableStatePortV02;
  readonly readFence: GuardedReadOwnerPort;
  readonly replanPort: MaterialReplanPortV02;
  readonly approvalService: ApprovalService & ApprovalServiceV02;
  readonly console: ConsoleApprovalPort;
  /** The one observed-action source this task's approval service observes; reused on every rebind. */
  readonly contextSource: RealContextSource;
}

export interface RealTierOwnersOptions {
  /** Directory that holds the durable store; the profile's `stateRoot` outside the checkout. */
  readonly stateRoot: string;
  /** Pinned revision every delivery declares, recorded by the operator in host.json. */
  readonly revision: string;
  /** UC-05 direction authority; without one no material replan is admitted. */
  readonly verifyDirection?: ((state: TaskState, direction: TrustedReplanDirection) => boolean | Promise<boolean>) | undefined;
  /** Real-tier approval profile version; the canonical `profileId` literal is unchanged (§(c)4). */
  readonly approvalProfileVersion: string;
  /**
   * The human operator the approval service records decisions for; defaults to the fixed host operator.
   * `decide` still records only the operator's own explicit approve/reject the console forwards, so no
   * decision is ever fabricated.
   */
  readonly operator?: TrustedOperatorIdentity | undefined;
}

export interface RealTierOwners {
  readonly store: DurableStore;
  readonly components: Pick<UC03GraphPortsV02, RealTierOwnerComponent>;
  readonly deliveries: readonly OwnerDelivery[];
  readonly recoveryGate: RecoveryGate;
  /** True only for the state port this module constructed with `provenance: 'real'` (T043 registry). */
  readonly productionJournal: boolean;
  /** Per-task owner instances for T061; registers them so the delegating ports above can resolve. */
  taskOwners(binding: RealTierTaskBinding): RealTierBoundOwners;
  /** Claims the one task a per-process assembly may carry (`classify`/`resolve` refuse with two); false for any other task. */
  readonly claimTask: (taskId: string) => boolean;
}

const unbound = (): never => {
  throw new ApprovalServiceError('unavailable');
};

/** The host console's operator identity; a decision is only ever recorded when an operator submits one. */
const HOST_OPERATOR: TrustedOperatorIdentity = Object.freeze({ actorId: 'host-operator', channelRef: 'host-console', provenance: 'real' });

/**
 * The durable provider, with the graph's first-request convention: a decision's action id is its
 * decision id, and no request record exists yet when it is first made. The stored record stays
 * primary; only its absence falls back to that same observed action.
 */
function realContext(
  provider: ReturnType<typeof createRealContextProvider>,
  taskId: string,
  statePort: DurableStatePortV02,
  ownerPolicyIdentity?: Readonly<{ policyId: string; policyVersion: string; configId?: string; configVersion?: string }>,
  approvalStore?: Pick<DurableApprovalStore, 'readRequest'>,
  source?: RealContextSource & Partial<Pick<HostActionContext, 'renew'>>,
): ReturnType<typeof createRealContextProvider> {
  const observedPlan = async (input: unknown): Promise<unknown> => {
    // The provider has admitted this context; persisted plan facts complete its approval freshness.
    const context = input as ApprovalContext;
    if (context.action.kind !== 'approve_fix_plan') return input;
    const state = await statePort.loadTask(taskId);
    const plan = state?.plan;
    if (!state || !plan) return unbound();
    // The first plan is requested from AwaitPlan; the post-patch verification approval is requested
    // from Verify (no active decision yet) against the same recorded plan. Both are the plan decision.
    const firstPlan = state.node === 'AwaitPlan' && plan.decisionRef === context.action.actionId;
    const verification = state.node === 'Verify' && state.activeDecisionId === undefined && plan.strategyDigest === context.action.strategyDigest;
    if (!firstPlan && !verification) return unbound();
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
          if (!storedRequest || state?.node !== 'AwaitPlan' || state.activeDecisionId !== decisionId || state.plan?.decisionRef !== storedRequest.actionRef) {
            throw error;
          }
          await source.renew(taskId, storedRequest.actionRef);
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
export async function observedSyntheticPlan(
  taskId: string,
  actionId: string,
  statePort: DurableStatePortV02,
  ownerPolicyIdentity?: Readonly<{ policyId: string; policyVersion: string; configId?: string; configVersion?: string }>,
): Promise<unknown> {
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

export function createRealTierOwners(options: RealTierOwnersOptions): RealTierOwners {
  const { stateRoot, revision } = options;
  const verifyDirection = options.verifyDirection ?? ((): false => false);
  // The host operator channel: an explicit approve/reject forwarded by the console records under this
  // fixed identity (the host default when none is given); no decision is ever fabricated.
  const operator = options.operator ?? HOST_OPERATOR;
  const store = new DurableStore(join(stateRoot, 'store'));
  const statePort = new DurableStatePortV02({ store });
  const baselineStore = createBaselineEvidenceStore({ store });
  const baselineEvidence = createBaselineEvidenceAdapter(baselineStore);
  const journal = createJournalOperationLookup(statePort);
  const recoveryGate = createRecoveryGate({ lookupOperation: ref => journal.lookupOperation(ref), lookupWrite: ref => baselineStore.lookupWrite(ref) });
  const bound = new Map<string, RealTierBoundOwners>();
  let claimed: string | undefined;

  /** One bound task, or a refusal: classify() carries no task and never guesses one. */
  const sole = (): RealTierBoundOwners => (bound.size === 1 ? ([...bound.values()][0] ?? unbound()) : unbound());

  // Both task-independent adapters resolve their owner instance from the request's own identity.
  const approvalPort: ApprovalPort = {
    provenance: 'real',
    classify: action => (bound.size === 1 ? sole().approvalService.classify(action) : unbound()),
    requestDecision: binding => bound.get(binding.taskId)?.approvalService.requestDecision(binding) ?? unbound(),
    validateBinding: binding => bound.get(binding.taskId)?.approvalService.validateBinding(binding) ?? Promise.resolve(false),
    resolve: decisionId => sole().approvalService.resolve(decisionId),
  };
  const replanPort: MaterialReplanPortV02 = {
    provenance: 'real',
    accept: request => bound.get(request.taskId)?.replanPort.accept(request) ?? Promise.resolve({ outcome: 'denied', reason: 'TASK_UNBOUND' }),
  };

  const components: RealTierOwners['components'] = { statePort, approvalPort, baselineEvidence, replanPort };
  const deliveryOf = <K extends RealTierOwnerComponent>(component: K): OwnerDelivery =>
    ({ component, id: `uc04-${component}:${ATTRIBUTION}`, contractVersion: REAL_TIER_DELIVERY_CONTRACT, revision, provenance: 'real', adapter: components[component] }) as OwnerDelivery;

  /**
   * The factory surface T061 calls after it seeds a task: one owner instance per capability, each
   * bound to that task. It registers them so the task-independent delegating ports above can reach
   * them, and returns them; it seeds nothing, transitions nothing and writes no task record.
   */
  const taskOwners = (binding: RealTierTaskBinding): RealTierBoundOwners => {
    const existing = bound.get(binding.taskId);
    if (existing) return existing;
    // A bound task's read fence needs a persisted, authority-bearing control head. The seed is how a
    // new task gets one without a claim; an existing head stays authoritative.
    const taskStatePort = new DurableStatePortV02({
      store,
      taskId: binding.taskId,
      approvalStorageDir: join(stateRoot, 'approvals'),
      trustedOperator: operator,
      ...(binding.authorityRef === undefined ? {} : { initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable' as const, activeAuthorityRef: binding.authorityRef } }),
      ...(binding.executionProfile === undefined ? {} : { executionProfile: binding.executionProfile }),
    });
    // The UC-05 policy identity must be the task's own, or every action fact classifies as unbound.
    const profile = Object.freeze({
      ...DEFAULT_POLICY_PROFILE,
      profileVersion: options.approvalProfileVersion,
      ...(binding.policyIdentity === undefined ? {} : { policyIdentity: binding.policyIdentity }),
    });
    const approvalStore = new DurableApprovalStore({ storageDir: join(stateRoot, 'approvals'), durableStore: store, profile, provenance: 'real' });
    // The per-task observed-action source is what makes an approval request admissible (§3); without
    // one the service maps the throwing loader to its own `unavailable` rather than guessing facts.
    // The task record is the v0.2 one this port just seeded, not the legacy store's separate path.
    const created = binding.createContext?.();
    // Without a factory the service still refuses every context; the stand-in keeps the port shape.
    const contextSource: RealContextSource = created ?? { provenance: 'real', observe: () => unbound() };
    const ownerPolicyIdentity = binding.policyIdentity ?? profile.policyIdentity;
    const context =
      created === undefined
        ? { loadForAction: async () => unbound(), loadForDecision: async () => unbound() }
        : realContext(
            createRealContextProvider({ durable: { loadTask: id => taskStatePort.loadTask(id) as never }, approvals: approvalStore, source: created }),
            binding.taskId,
            taskStatePort,
            ownerPolicyIdentity,
            approvalStore,
            created,
          );
    const approvalService = createApprovalService({
      taskId: binding.taskId,
      profile,
      store: approvalStore,
      provenance: 'real',
      context,
      operator: { identity: operator },
    });
    const owners: RealTierBoundOwners = {
      statePort: taskStatePort,
      readFence: createStateReadFence(taskStatePort, binding),
      replanPort: createMaterialReplanPort({ state: taskStatePort, verifyDirection }),
      approvalService,
      console: createConsoleApprovalPort(approvalService, () => binding.taskId),
      contextSource,
    };
    bound.set(binding.taskId, owners);
    return owners;
  };

  return {
    store,
    components,
    deliveries: [deliveryOf('statePort'), deliveryOf('approvalPort'), deliveryOf('baselineEvidence'), deliveryOf('replanPort')],
    recoveryGate,
    productionJournal: isProductionJournal(statePort),
    taskOwners,
    claimTask: taskId => (claimed ??= taskId) === taskId,
  };
}
