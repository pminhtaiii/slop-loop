import type { PolicyIdentity } from '../v01/types.ts';
import type { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../versions.ts';

export interface PolicyEvaluationReceipt {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly actionDigest: string;
  readonly freshnessContextDigest: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly decisionAuthorityGeneration: number;
  readonly result: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN';
}
export type PolicyEvaluationReceiptV02 = PolicyEvaluationReceipt;

export interface ActionDecisionReceipt {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly decisionId: string;
  readonly decisionDigest: string;
  readonly actionDigest: string;
  readonly evaluationReceiptRef: string;
  readonly decisionAuthorityGeneration: number;
  readonly status: 'approved';
  readonly reason?: string;
}
export type ActionDecisionReceiptV02 = ActionDecisionReceipt;

export type ProviderRole = 'coder' | 'reviewer';
export type ProviderRoleV02 = ProviderRole;

interface ProviderAdmissionReceiptBase {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly providerRequestId: string;
  readonly role: ProviderRole;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly requestContentDigest: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly decisionAuthorityGeneration: number;
}
export type ProviderAdmissionReceipt =
  | (ProviderAdmissionReceiptBase & {
    readonly planApplicability: 'pre-plan-diagnostic';
    readonly diagnosticPurpose: string;
    readonly taskCriteriaDigest: string;
    readonly planBindingDigest?: never;
    readonly planDecisionRef?: never;
  })
  | (ProviderAdmissionReceiptBase & {
    readonly planApplicability: 'approved-plan';
    readonly planBindingDigest: string;
    readonly planDecisionRef: string;
    readonly diagnosticPurpose?: never;
    readonly taskCriteriaDigest?: never;
  });
export type ProviderAdmissionReceiptV02 = ProviderAdmissionReceipt;

export interface ExecutorIdentityV02Receipt {
  readonly adapterIdentity: string;
  readonly processIncarnation: string;
  readonly fencingGeneration: number;
  readonly payloadDigest: string;
}

export interface ClaimClosureReceipt {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly runId: string;
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly reason: string;
  readonly pauseOrDenialEvent: {
    readonly eventKind: 'pause' | 'denial';
    readonly eventRef: string;
    readonly eventDigest: string;
  };
  readonly fencedExecutorIdentity: ExecutorIdentityV02Receipt;
  readonly noAttemptProof: {
    readonly journalRef: string;
    readonly journalDigest: string;
    readonly claimPhase: 'claimed';
  };
  readonly reservationDispositions: readonly {
    readonly reservationRef: string;
    readonly disposition: 'released';
  }[];
}
export type ClaimClosureReceiptV02 = ClaimClosureReceipt;

export type DispatchClaimPhaseV02 =
  | 'claimed'
  | 'attempting'
  | 'dispatched'
  | 'outcome-recorded'
  | 'settled'
  | 'uncertain'
  | 'observed-unsettled';

interface DispatchClaimV02Identity {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly runId: string;
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly policyIdentity: PolicyIdentity;
  readonly decisionRefs: readonly string[];
  readonly reservationRefs: readonly string[];
}

type DispatchClaimV02Lifecycle =
  | { readonly phase: 'claimed'; readonly resultRef: null; readonly attemptId?: never }
  | { readonly phase: 'attempting'; readonly resultRef: null; readonly attemptId: string }
  | { readonly phase: 'dispatched'; readonly resultRef: string | null; readonly attemptId: string }
  | { readonly phase: 'outcome-recorded' | 'settled' | 'uncertain' | 'observed-unsettled'; readonly resultRef: string; readonly attemptId: string };

type RepositoryActionClaimV02 =
  | {
    readonly subjectKind: 'repository-action';
    readonly planApplicability: 'pre-plan-diagnostic';
    readonly actionId: string;
    readonly actionDigest: string;
    readonly repositoryStateDigest: string;
    readonly diagnosticPurpose: string;
    readonly taskCriteriaDigest: string;
    readonly planBindingDigest?: never;
    readonly planDecisionRef?: never;
    readonly providerRequestId?: never;
    readonly requestContentDigest?: never;
    readonly role?: never;
  }
  | {
    readonly subjectKind: 'repository-action';
    readonly planApplicability: 'approved-plan';
    readonly actionId: string;
    readonly actionDigest: string;
    readonly repositoryStateDigest: string;
    readonly planBindingDigest: string;
    readonly planDecisionRef: string;
    readonly diagnosticPurpose?: never;
    readonly taskCriteriaDigest?: never;
    readonly providerRequestId?: never;
    readonly requestContentDigest?: never;
    readonly role?: never;
  };

type ProviderRequestClaimV02 =
  | {
    readonly subjectKind: 'provider-request';
    readonly planApplicability: 'pre-plan-diagnostic';
    readonly providerRequestId: string;
    readonly requestContentDigest: string;
    readonly role: ProviderRole;
    readonly diagnosticPurpose: string;
    readonly taskCriteriaDigest: string;
    readonly actionId?: never;
    readonly actionDigest?: never;
    readonly repositoryStateDigest?: never;
    readonly planBindingDigest?: never;
    readonly planDecisionRef?: never;
  }
  | {
    readonly subjectKind: 'provider-request';
    readonly planApplicability: 'approved-plan';
    readonly providerRequestId: string;
    readonly requestContentDigest: string;
    readonly role: ProviderRole;
    readonly planBindingDigest: string;
    readonly planDecisionRef: string;
    readonly diagnosticPurpose?: never;
    readonly taskCriteriaDigest?: never;
    readonly actionId?: never;
    readonly actionDigest?: never;
    readonly repositoryStateDigest?: never;
  };

export type DispatchClaimV02 = DispatchClaimV02Identity & DispatchClaimV02Lifecycle & (RepositoryActionClaimV02 | ProviderRequestClaimV02);
