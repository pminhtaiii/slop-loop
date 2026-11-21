/**
 * Durable file-backed UC-03 v0.2 StatePortV02.
 *
 * Writes the reference journal (claims, attempts, outcomes, reconciliations, closures, control head)
 * as JSON under the durable claim directory, one lock per task, atomic writes only. The work lives
 * in the sibling `state-port-v02-*` modules; this class binds them to one store and control seed.
 */
import type {
  AdmissionContextV02,
  AttemptOutcomeReceiptV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureReceiptV02,
  ClaimClosureResultV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  OutcomeRecordResultV02,
  PortProvenance,
  ReconciliationResultV02,
  SettledPatchAncestryRequestV02,
  SettledPatchAncestryV02,
  StatePortV02,
  TaskState,
  VerificationApprovalContextV02,
  VerificationApprovalResolutionV02,
  VerificationAuthoritySnapshotV02,
  RecordVerificationApprovalRequestV02,
  RecordVerificationApprovalResultV02,
} from '../../contracts/foundation/uc03.ts';
import { isVerificationAuthoritySnapshotV02 } from '../../contracts/foundation/uc03.ts';
import type { validateStateTransition } from '../../contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';
import { registerProductionJournal } from '../../foundation/production-journal-registry.ts';
import { loadAdmission, publishAuthority } from './state-port-v02-authority.ts';
import type { StoredAdmissionV02 } from './state-port-v02-authority.ts';
import type { AuthorityPublicationReceiptV02 } from '../../approvals/control-v02.ts';
import type { AuthorityPublicationOptionsV02 } from '../../approvals/control-v02.ts';
import { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, FenceProofV02, RecoveryEvidenceV02, TaskControlModeV02 } from './state-port-v02-types.ts';
import { CONTROL_MODES, DEFAULT_CONTROL } from './state-port-v02-types.ts';
import * as claims from './state-port-v02-claims.ts';
import * as reconcile from './state-port-v02-reconcile.ts';
import type { ExecutionProfileSourceV02 } from './state-port-v02-admission.ts';
import * as control from './state-port-v02-control.ts';
import * as journal from './state-port-v02-journal.ts';
import * as tasks from './state-port-v02-task.ts';
import { DurableVerificationAuthority } from './state-port-v02-verification-authority.ts';

export {
  NEUTRAL_CLAIM_RECEIPT_V02,
  NEUTRAL_ATTEMPT_RECEIPT_V02,
  NEUTRAL_OUTCOME_RECORD_RESULT_V02,
  NEUTRAL_RECONCILIATION_RESULT_V02,
  NEUTRAL_CLAIM_CLOSURE_RESULT_V02,
  CONTROL_MODES,
  DEFAULT_CONTROL,
} from './state-port-v02-types.ts';
export type { ControlRecordV02, TaskControlModeV02 } from './state-port-v02-types.ts';

export interface DurableStatePortV02Options {
  readonly store: DurableStore;
  readonly provenance?: PortProvenance;
  /** The task this port publishes authority and admits continuation for; unbound ports refuse both. */
  readonly taskId?: string;
  /** Seed for a task that has no persisted control head yet (mirrors the reference initialControl*). */
  readonly initialControl?: Partial<Pick<ControlRecordV02, 'controlVersion' | 'epoch' | 'mode' | 'holdRef' | 'activeAuthorityRef'>>;
  readonly trustedTransitions?: Readonly<Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>>;
  /**
   * The owner's own execution profile: a fixed value, or one derived from the trusted task and
   * workspace the port reads. It never comes from the submitted admission's view or action. Absent,
   * the port applies its synthetic admission constants.
   */
  readonly executionProfile?: ExecutionProfileSourceV02;
  /**
   * The approval store directory the real UC-05 service writes: the durable record of plan
   * decisions. Absent, the verification-authority methods fail closed rather than guessing one.
   */
  readonly approvalStorageDir?: string | undefined;
  /**
   * The trusted operator channel whose resolution rows the verification authority accepts. Absent,
   * no persisted resolution is ever treated as a human approval.
   */
  readonly trustedOperator?: TrustedOperatorIdentity | undefined;
}

/** Durable UC-03 v0.2 state port. Missing optional methods fail closed by absence. */
export class DurableStatePortV02 implements StatePortV02 {
  readonly provenance: PortProvenance;
  readonly executionGuardApiVersion = '0.2.0' as const;
  readonly store: DurableStore;
  /** The seed every control read falls back to for this task; shared with port consumers that read heads. */
  readonly controlSeed: ControlRecordV02;
  private readonly statePort: StatePortStore;
  private readonly boundTaskId: string | undefined;
  private readonly taskOptions: tasks.TaskOperationOptions;
  private readonly executionProfile: ExecutionProfileSourceV02 | undefined;
  private readonly verificationAuthority: DurableVerificationAuthority;

  constructor(options: DurableStatePortV02Options) {
    this.provenance = options.provenance ?? 'real';
    if (this.provenance !== 'real' && this.provenance !== 'mock') throw new Error('Invalid state port provenance');
    this.store = options.store;
    this.statePort = new StatePortStore(options.store);
    this.boundTaskId = options.taskId;
    this.executionProfile = options.executionProfile;
    const seed = options.initialControl ?? {};
    this.controlSeed = {
      ...DEFAULT_CONTROL,
      ...(seed.controlVersion !== undefined ? { controlVersion: seed.controlVersion } : {}),
      ...(seed.epoch !== undefined ? { epoch: seed.epoch } : {}),
      ...(seed.mode !== undefined ? { mode: seed.mode } : {}),
      ...(seed.holdRef !== undefined ? { holdRef: seed.holdRef } : {}),
      ...(seed.activeAuthorityRef !== undefined ? { activeAuthorityRef: seed.activeAuthorityRef } : {}),
    };
    if (!CONTROL_MODES.includes(this.controlSeed.mode)) throw new Error('Invalid initial control mode');
    this.verificationAuthority = new DurableVerificationAuthority({
      store: this.statePort,
      approvalStorageDir: options.approvalStorageDir,
      operator: options.trustedOperator,
      controlSeed: this.controlSeed,
    });
    this.taskOptions = {
      store: this.statePort,
      trustedTransitions: { ...(options.trustedTransitions ?? {}) },
      ...(options.approvalStorageDir === undefined ? {} : { trustedApproval: (taskId: string) => this.verificationAuthority.trustedPlanApproval(taskId) }),
    };
    // Construction, not the `provenance` string, is what the production brand attests (contract §(b)5).
    if (this.provenance === 'real') registerProductionJournal(this);
  }

  /* ---------------- required StatePort surface ---------------- */

  loadTask(taskId: string): Promise<TaskState | null> {
    return tasks.loadTask(this.taskOptions, taskId);
  }

  transition(state: TaskState, expectedVersion: number): Promise<TaskState> {
    return tasks.transition(this.taskOptions, state, expectedVersion);
  }

  checkpoint(state: TaskState): Promise<void> {
    return tasks.checkpoint(this.taskOptions, state);
  }

  recover(taskId: string): Promise<TaskState> {
    return tasks.recover(this.taskOptions, taskId);
  }

  claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    return claims.claim({ store: this.statePort, initialControl: this.controlSeed, executionProfile: this.executionProfile }, context);
  }

  beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    return claims.beginAttempt(this.statePort, claimId, executor, this.executionProfile);
  }

  recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    return claims.recordOutcome(this.statePort, receipt);
  }

  reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    return reconcile.reconcileObservedOutcome(this.statePort, receipt);
  }

  reconcileUncertain(receipt: AttemptReconciliationReceiptV02, includePatchRevision?: boolean): Promise<ReconciliationResultV02> {
    return reconcile.reconcileUncertain(this.statePort, receipt, includePatchRevision);
  }

  closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    return reconcile.closeUnattemptedClaim(this.statePort, receipt, this.executionProfile);
  }

  /* ---------------- optional: settled patch ancestry ---------------- */

  readClaimState(claimId: string): ReturnType<typeof journal.readClaimState> {
    return journal.readClaimState(this.statePort, claimId);
  }

  readSettledPatchAncestry(request: SettledPatchAncestryRequestV02): Promise<SettledPatchAncestryV02 | null> {
    return journal.readSettledPatchAncestry(this.statePort, request);
  }

  /** The recorded plan decision re-issued only in the caller's exact current authority context. */
  resolvePlanDecisionInContext(decisionId: string, context: VerificationApprovalContextV02): Promise<VerificationApprovalResolutionV02> {
    return this.verificationAuthority.resolvePlanDecisionInContext(decisionId, context);
  }

  /** The owner's one write for the post-patch D1; the current control head is the advisory lock. */
  recordVerificationApproval(request: RecordVerificationApprovalRequestV02): Promise<RecordVerificationApprovalResultV02> {
    return this.verificationAuthority.recordVerificationApproval(request);
  }

  /** The AwaitPlan→Patch trusted approval, derived from the recorded human decision. */
  trustedPlanApproval(taskId: string): ReturnType<DurableVerificationAuthority['trustedPlanApproval']> {
    return this.verificationAuthority.trustedPlanApproval(taskId);
  }

  /**
   * Stage the owner-issued completion facts for the one Review→Deliver transition this task is about
   * to make. The caller supplies them only after the owner `completionContextFor` resolver and the
   * deterministic predicate both passed; the transition validator still re-checks every field against
   * the persisted task, plan and review refs. A later transition without a fresh stage refuses.
   */
  async stageCompletionReceipt(trusted: NonNullable<NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>): Promise<boolean> {
    if (!this.boundTaskId) return false;
    const task = await this.loadTask(this.boundTaskId);
    if (!task) return false;
    this.taskOptions.trustedTransitions[task.stateVersion + 1] = trusted;
    return true;
  }

  /** Whether the recorded plan decision still stands as a human approval at the named authority. */
  planDecisionIsApproved(decisionId: string, context: VerificationApprovalContextV02): Promise<boolean> {
    return this.verificationAuthority.planDecisionIsApproved(decisionId, context);
  }

  /** The recorded decision binding the owner issued when it consumed the decision. */
  readIssuedDecisionBinding(taskId: string, decisionId: string): ReturnType<DurableVerificationAuthority['readIssuedDecisionBinding']> {
    return this.verificationAuthority.readIssuedDecisionBinding(taskId, decisionId);
  }

  /* ---------------- journal snapshot ---------------- */

  getJournalSnapshot(taskId: string): unknown {
    return journal.getJournalSnapshot({ store: this.statePort, initialControl: this.controlSeed }, taskId);
  }

  /**
   * The current control head of one task, synchronously and without historical records: what the
   * pre-transport dispatch authority check reads. Missing, unreadable or malformed is `null` (fail
   * closed); it never widens authority and never depends on an unrelated corrupt outcome file.
   */
  readControlHead(taskId: string): ControlRecordV02 | null {
    return this.statePort.readControlHead(taskId);
  }

  /** Reads owner facts under the task lock, from the same effective head (persisted, else seed) that claims admit against. */
  async readVerificationAuthoritySnapshot(taskId: string): Promise<VerificationAuthoritySnapshotV02 | null> {
    if (taskId !== this.boundTaskId) return null;
    return this.statePort.locked(taskId, async () => {
      const head = await this.statePort.readControl(taskId, this.controlSeed);
      const task = await this.loadTask(taskId);
      const authority = head?.activeAuthorityRef;
      if (!task || task.taskId !== this.boundTaskId || !head || !authority || !task.repositoryRevisionDigest) return null;
      const fields = ['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef', 'decisionAuthorityGeneration'];
      if (
        Object.getPrototypeOf(authority) !== Object.prototype ||
        Object.keys(authority).length !== fields.length ||
        Object.keys(authority).some(field => !fields.includes(field)) ||
        ![authority.policyId, authority.policyVersion, authority.configId, authority.configVersion, authority.issuerKeyRef].every(value => typeof value === 'string' && value.trim().length > 0) ||
        !Number.isSafeInteger(authority.decisionAuthorityGeneration) ||
        authority.decisionAuthorityGeneration <= 0
      )
        return null;
      const snapshot: VerificationAuthoritySnapshotV02 = {
        taskId: task.taskId,
        runId: task.runId,
        stateVersion: task.stateVersion,
        repositoryRevisionDigest: task.repositoryRevisionDigest,
        controlVersion: head.controlVersion,
        epoch: head.epoch,
        decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
        policyIdentity: {
          policyId: authority.policyId,
          policyVersion: authority.policyVersion,
          configId: authority.configId,
          configVersion: authority.configVersion,
          issuerKeyRef: authority.issuerKeyRef,
        },
        controlMode: head.mode,
        holdRef: head.holdRef,
        activeClaimId: head.activeClaimId,
      };
      return isVerificationAuthoritySnapshotV02(snapshot) ? snapshot : null;
    });
  }

  /* ---------------- adapter-specific journal control ---------------- */

  setTaskControl(taskId: string, mode: TaskControlModeV02, eventRef: string): Promise<boolean> {
    return control.setTaskControl(this.statePort, taskId, mode, eventRef);
  }

  fenceClaimRecipient(claimId: string, recipient: ExecutorIdentityV02): Promise<FenceProofV02 | null> {
    return control.fenceClaimRecipient(this.statePort, claimId, recipient);
  }

  fenceAttemptRecipient(claimId: string, recipient: ExecutorIdentityV02): Promise<FenceProofV02 | null> {
    return control.fenceAttemptRecipient(this.statePort, claimId, recipient);
  }

  publishRecoveryEvidence(taskId: string, evidence: RecoveryEvidenceV02): Promise<boolean> {
    return control.publishRecoveryEvidence(this.statePort, taskId, evidence);
  }

  /* ---------------- authority publication and recovery admission (real-tier §(b)5) ---------------- */

  publishAuthority(options: AuthorityPublicationOptionsV02): Promise<AuthorityPublicationReceiptV02> {
    return publishAuthority({ store: this.statePort, taskId: this.boundTaskId, initialControl: this.controlSeed }, options);
  }

  loadAdmission(decisionId: string): Promise<StoredAdmissionV02 | null> {
    return loadAdmission({ store: this.statePort, taskId: this.boundTaskId, initialControl: this.controlSeed }, decisionId);
  }
}
