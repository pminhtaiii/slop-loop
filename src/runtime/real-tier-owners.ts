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
import type { ApprovalPort, TaskState } from '../contracts/foundation/uc03.ts';
import type { GuardedReadOwnerPort } from '../foundation/guarded-read-capability.ts';
import { isProductionJournal } from '../foundation/production-journal-registry.ts';
import type { OwnerDelivery } from './evaluation-composition.ts';
import { createBaselineEvidenceAdapter } from './baseline-evidence-adapter.ts';
import { createConsoleApprovalPort } from './console-approval-port.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
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

/** The pinned owner-delivery contract these adapters declare. */
export const REAL_TIER_DELIVERY_CONTRACT = 'uc03-real-tier/1';
/** Delegated-attestation attribution, in the delivery id so it travels with the composition. */
const ATTRIBUTION = 'delegated-attestation';

export type RealTierOwnerComponent = 'statePort' | 'approvalPort' | 'baselineEvidence' | 'replanPort';

/** Facts one seeded task contributes; T061 supplies them, never a model or argv. */
export interface RealTierTaskBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

/** The per-task owner instances T061 composes; each is already bound to one task. */
export interface RealTierBoundOwners {
  readonly statePort: DurableStatePortV02;
  readonly readFence: GuardedReadOwnerPort;
  readonly replanPort: MaterialReplanPortV02;
  readonly approvalService: ApprovalService & ApprovalServiceV02;
  readonly console: ConsoleApprovalPort;
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
}

const unbound = (): never => {
  throw new ApprovalServiceError('unavailable');
};

export function createRealTierOwners(options: RealTierOwnersOptions): RealTierOwners {
  const { stateRoot, revision } = options;
  const verifyDirection = options.verifyDirection ?? ((): false => false);
  const store = new DurableStore(join(stateRoot, 'store'));
  const statePort = new DurableStatePortV02({ store });
  const baselineStore = createBaselineEvidenceStore({ store });
  const baselineEvidence = createBaselineEvidenceAdapter(baselineStore);
  const journal = createJournalOperationLookup(statePort);
  const recoveryGate = createRecoveryGate({ lookupOperation: ref => journal.lookupOperation(ref), lookupWrite: ref => baselineStore.lookupWrite(ref) });
  const profile = Object.freeze({ ...DEFAULT_POLICY_PROFILE, profileVersion: options.approvalProfileVersion });
  const bound = new Map<string, RealTierBoundOwners>();

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
    const taskStatePort = new DurableStatePortV02({ store, taskId: binding.taskId });
    const approvalStore = new DurableApprovalStore({ storageDir: join(stateRoot, 'approvals'), durableStore: store, profile, provenance: 'real' });
    const approvalService = createApprovalService({
      taskId: binding.taskId,
      profile,
      store: approvalStore,
      provenance: 'real',
      // The real context source is a task-bound producer (T061); until it is supplied, the service
      // maps a throwing port to its own `unavailable` rather than classifying unseen facts.
      context: { loadForAction: async () => unbound(), loadForDecision: async () => unbound() },
    });
    const owners: RealTierBoundOwners = {
      statePort: taskStatePort,
      readFence: createStateReadFence(taskStatePort, binding),
      replanPort: createMaterialReplanPort({ state: taskStatePort, verifyDirection }),
      approvalService,
      console: createConsoleApprovalPort(approvalService, () => binding.taskId),
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
  };
}
