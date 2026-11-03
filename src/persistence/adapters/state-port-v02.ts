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
} from '../../contracts/foundation/uc03.ts';
import type { validateStateTransition } from '../../contracts/foundation/uc03.ts';
import type { DurableStore } from '../store.ts';
import { StatePortStore } from './state-port-v02-storage.ts';
import type { ControlRecordV02, FenceProofV02, RecoveryEvidenceV02, TaskControlModeV02 } from './state-port-v02-types.ts';
import { CONTROL_MODES, DEFAULT_CONTROL } from './state-port-v02-types.ts';
import * as claims from './state-port-v02-claims.ts';
import * as reconcile from './state-port-v02-reconcile.ts';
import * as control from './state-port-v02-control.ts';
import * as journal from './state-port-v02-journal.ts';
import * as tasks from './state-port-v02-task.ts';

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
  /** Seed for a task that has no persisted control head yet (mirrors the reference initialControl*). */
  readonly initialControl?: Partial<Pick<ControlRecordV02, 'controlVersion' | 'epoch' | 'mode' | 'holdRef' | 'activeAuthorityRef'>>;
  readonly trustedTransitions?: Readonly<Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>>;
}

/** Durable UC-03 v0.2 state port. Missing optional methods fail closed by absence. */
export class DurableStatePortV02 implements StatePortV02 {
  readonly provenance: PortProvenance;
  readonly executionGuardApiVersion = '0.2.0' as const;
  readonly store: DurableStore;
  private readonly statePort: StatePortStore;
  private readonly initialControl: ControlRecordV02;
  private readonly taskOptions: tasks.TaskOperationOptions;

  constructor(options: DurableStatePortV02Options) {
    this.provenance = options.provenance ?? 'real';
    if (this.provenance !== 'real' && this.provenance !== 'mock') throw new Error('Invalid state port provenance');
    this.store = options.store;
    this.statePort = new StatePortStore(options.store);
    this.taskOptions = { store: this.statePort, trustedTransitions: options.trustedTransitions ?? {} };
    const seed = options.initialControl ?? {};
    this.initialControl = {
      ...DEFAULT_CONTROL,
      ...(seed.controlVersion !== undefined ? { controlVersion: seed.controlVersion } : {}),
      ...(seed.epoch !== undefined ? { epoch: seed.epoch } : {}),
      ...(seed.mode !== undefined ? { mode: seed.mode } : {}),
      ...(seed.holdRef !== undefined ? { holdRef: seed.holdRef } : {}),
      ...(seed.activeAuthorityRef !== undefined ? { activeAuthorityRef: seed.activeAuthorityRef } : {}),
    };
    if (!CONTROL_MODES.includes(this.initialControl.mode)) throw new Error('Invalid initial control mode');
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
    return claims.claim({ store: this.statePort, initialControl: this.initialControl }, context);
  }

  beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    return claims.beginAttempt(this.statePort, claimId, executor);
  }

  recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    return claims.recordOutcome(this.statePort, receipt);
  }

  reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    return reconcile.reconcileObservedOutcome(this.statePort, receipt);
  }

  reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    return reconcile.reconcileUncertain(this.statePort, receipt);
  }

  closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    return reconcile.closeUnattemptedClaim(this.statePort, receipt);
  }

  /* ---------------- optional: settled patch ancestry ---------------- */

  readClaimState(claimId: string): ReturnType<typeof journal.readClaimState> {
    return journal.readClaimState(this.statePort, claimId);
  }

  readSettledPatchAncestry(request: SettledPatchAncestryRequestV02): Promise<SettledPatchAncestryV02 | null> {
    return journal.readSettledPatchAncestry(this.statePort, request);
  }

  /* ---------------- journal snapshot ---------------- */

  getJournalSnapshot(taskId: string): unknown {
    return journal.getJournalSnapshot({ store: this.statePort, initialControl: this.initialControl }, taskId);
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
}
