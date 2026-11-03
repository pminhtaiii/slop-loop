/**
 * Shared vocabulary for the durable UC-03 v0.2 state port: the neutral receipts, the control head,
 * the journal records as they are stored, and the reservation specification.
 */
import type {
  AdmissionContextV02,
  AdmissionTrustedContextV02,
  AttemptReceiptV02,
  ClaimClosureResultV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  OutcomeRecordResultV02,
  PolicyAuthorityRefV02,
  ProviderUsage,
  ReconciliationResultV02,
  SafeReferenceV02,
  TaskState,
} from '../../contracts/foundation/uc03.ts';

export const NEUTRAL_CLAIM_RECEIPT_V02: ClaimReceiptV02 = Object.freeze({
  claimId: '',
  claimDigest: '',
  taskId: '',
  runId: '',
  subjectKind: 'repository-action',
  planApplicability: 'pre-plan-diagnostic',
  preClaimTaskStateVersion: 0,
  preClaimControlVersion: 0,
  postClaimControlVersion: 0,
  epoch: 0,
  status: 'claimed',
  reservationRefs: Object.freeze([]) as readonly string[],
});
export const NEUTRAL_ATTEMPT_RECEIPT_V02: AttemptReceiptV02 = Object.freeze({
  attemptId: '',
  claimId: '',
  taskId: '',
  executorIdentity: Object.freeze({ adapterIdentity: '', processIncarnation: '', fencingGeneration: 0, payloadDigest: '' }),
  preAttemptTaskStateVersion: 0,
  postBeginTaskStateVersion: 0,
  preAttemptControlVersion: 0,
  postBeginControlVersion: 0,
  epoch: 0,
  status: 'attempting',
});
export const NEUTRAL_OUTCOME_RECORD_RESULT_V02: OutcomeRecordResultV02 = Object.freeze({ outcome: 'uncertain', receiptId: '' });
export const NEUTRAL_RECONCILIATION_RESULT_V02: ReconciliationResultV02 = Object.freeze({ outcome: 'blocked', receiptId: '' });
export const NEUTRAL_CLAIM_CLOSURE_RESULT_V02: ClaimClosureResultV02 = Object.freeze({ closed: false, receiptId: '' });

export type TaskControlModeV02 = 'runnable' | 'paused' | 'rejected' | 'ended' | 'recovery';

export interface ControlRecordV02 {
  readonly controlVersion: number;
  readonly epoch: number;
  readonly mode: TaskControlModeV02;
  readonly holdRef: string | null;
  readonly holdEventDigest: string | null;
  readonly activeAuthorityRef: PolicyAuthorityRefV02 | null;
  readonly activeClaimId: string | null;
}

export interface StoredClaimV02 {
  readonly receipt: ClaimReceiptV02;
  readonly context: AdmissionContextV02;
  readonly taskSnapshot: TaskState;
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly trustedAdmissionContext: AdmissionTrustedContextV02;
  readonly status: 'claimed' | 'attempting' | 'settled' | 'uncertain' | 'observed-unsettled' | 'closed';
  readonly attemptId?: string | undefined;
  readonly settlementResult?: (OutcomeRecordResultV02 & { readonly outcome: 'settled' }) | undefined;
}

export interface StoredAttemptV02 {
  readonly receipt: AttemptReceiptV02;
  readonly claimId: string;
  readonly status: 'attempting' | 'settled' | 'uncertain' | 'observed-unsettled';
  readonly outcomeReceiptId?: string | undefined;
}

export interface FenceProofV02 {
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly recipientIdentity: ExecutorIdentityV02;
  readonly fencedExecutorIdentity: ExecutorIdentityV02;
  readonly fencingGeneration: number;
  readonly proofRef: SafeReferenceV02;
  readonly adapterEvidenceRefs: readonly SafeReferenceV02[];
  readonly holdRef: string;
  readonly controlVersion: number;
  readonly epoch: number;
}

export interface RecoveryEvidenceV02 {
  readonly predecessorReceiptId: string;
  readonly effectEvidenceRef: SafeReferenceV02;
  readonly accountingEvidenceRefs: readonly SafeReferenceV02[];
  readonly observedUsage?: ProviderUsage | undefined;
  readonly observedRevisionDigest?: string | undefined;
  readonly invalidatedEvidence?: readonly SafeReferenceV02[] | undefined;
}

export interface ReservationSpecV02 {
  readonly scope: 'task' | 'run';
  readonly kind: string;
  readonly amount: number;
  readonly reservationId: string;
  readonly keyedId: string;
}

export const SHA256 = /^sha256:[0-9a-f]{64}$/u;
export const CONTROL_MODES: readonly TaskControlModeV02[] = ['runnable', 'paused', 'rejected', 'ended', 'recovery'];
export const DEFAULT_CONTROL: ControlRecordV02 = Object.freeze({
  controlVersion: 0,
  epoch: 0,
  mode: 'runnable',
  holdRef: null,
  holdEventDigest: null,
  activeAuthorityRef: null,
  activeClaimId: null,
});
