import type {
  ExecutorIdentityV02,
  PlanApplicabilityV02,
  PolicyAuthorityRefV02,
  ProviderPricingIdentityV02,
  ProviderRoleV02,
} from './ports-v02.ts';
import type { ProviderUsage } from './types.ts';

export type AttemptOutcomeStatusV02 = 'observed' | 'proven-not-dispatched' | 'uncertain';

/** Opaque reference plus integrity digest; raw output/content never appears in journal receipts. */
export interface SafeReferenceV02 {
  readonly reference: string;
  readonly digest: string;
}

export interface AttemptVersionBindingsV02 {
  readonly taskStateSchemaVersion: string;
  readonly controlSchemaVersion: string;
  readonly preClaimTaskStateVersion: number;
  readonly postClaimTaskStateVersion: number;
  readonly postAttemptTaskStateVersion: number;
  readonly preClaimControlVersion: number;
  readonly postClaimControlVersion: number;
  readonly postAttemptControlVersion: number;
  readonly epoch: number;
}

export type ProposedRevisionEffectV02 =
  | { readonly kind: 'advance'; readonly revisionDigest: string }
  | { readonly kind: 'preserve' | 'not-applicable' };

export type ProposedTaskTransitionV02 =
  | { readonly kind: 'transition'; readonly fromNode: string; readonly toNode: string }
  | { readonly kind: 'none' };

export interface ProposedAccountingSettlementV02 {
  readonly disposition: 'settle' | 'hold' | 'release-unused' | 'none';
  readonly reservationRefs: readonly string[];
  readonly observedUsage?: ProviderUsage | undefined;
}

export interface ProposedSettlementEffectsV02 {
  readonly taskTransition: ProposedTaskTransitionV02;
  readonly revision: ProposedRevisionEffectV02;
  readonly invalidatedEvidence: readonly SafeReferenceV02[];
  readonly accounting: ProposedAccountingSettlementV02;
}

interface AttemptOutcomeBaseV02 {
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly attemptId: string;
  readonly executorIdentity: ExecutorIdentityV02;
  readonly admissionDigest: string;
  readonly versions: AttemptVersionBindingsV02;
  readonly resultRef: SafeReferenceV02;
  readonly evidenceRefs: readonly SafeReferenceV02[];
  readonly proposedEffects: ProposedSettlementEffectsV02;
  readonly outcome: AttemptOutcomeStatusV02;
}

interface RepositoryOutcomeBaseV02 extends AttemptOutcomeBaseV02 {
  readonly subjectKind: 'repository-action';
  readonly actionDigest: string;
  readonly policyAuthorityRef: PolicyAuthorityRefV02;
  readonly policyEvaluationReceiptRef: string;
  readonly policyEvaluationReceiptDigest: string;
  readonly freshnessContextDigest: string;
}

type RepositoryOutcomePlanV02 =
  | { readonly planApplicability: 'pre-plan-diagnostic'; readonly diagnosticPurpose: string; readonly taskCriteriaDigest: string; readonly checkSetDigest: string; readonly planBindingDigest?: never | undefined; readonly planDecisionRef?: never | undefined }
  | { readonly planApplicability: 'approved-plan'; readonly planBindingDigest: string; readonly planDecisionRef: string; readonly diagnosticPurpose?: string | undefined; readonly taskCriteriaDigest?: string | undefined; readonly checkSetDigest?: string | undefined };
type ActionDecisionReceiptBindingV02 =
  | { readonly actionDecisionReceiptRef: string; readonly actionDecisionReceiptDigest: string }
  | { readonly actionDecisionReceiptRef?: never | undefined; readonly actionDecisionReceiptDigest?: never | undefined };
type RepositoryOutcomeOperationV02 =
  | { readonly repositoryOperation: 'apply-patch'; readonly outcome: 'observed'; readonly observedResultRevisionDigest: string }
  | { readonly repositoryOperation: 'apply-patch'; readonly outcome: 'uncertain' | 'proven-not-dispatched'; readonly observedResultRevisionDigest?: never | undefined }
  | { readonly repositoryOperation: 'run-command'; readonly outcome: AttemptOutcomeStatusV02; readonly observedResultRevisionDigest?: never | undefined };

export type RepositoryActionOutcomeReceiptV02 = RepositoryOutcomeBaseV02 & RepositoryOutcomePlanV02 & ActionDecisionReceiptBindingV02 & RepositoryOutcomeOperationV02;

interface ProviderOutcomeBaseV02 extends AttemptOutcomeBaseV02 {
  readonly subjectKind: 'provider-request';
  readonly providerRequestId: string;
  readonly requestContentDigest: string;
  readonly role: ProviderRoleV02;
  readonly providerAdmissionReceiptRef: string;
  readonly providerAdmissionReceiptDigest: string;
  readonly requestReservationReceiptRef: string;
  readonly providerIdentity: ProviderPricingIdentityV02;
  readonly budgetRefs: readonly string[];
}

type ProviderOutcomePlanV02 =
  | { readonly planApplicability: 'pre-plan-diagnostic'; readonly diagnosticPurpose: string; readonly taskCriteriaDigest: string; readonly planBindingDigest?: never | undefined; readonly planDecisionRef?: never | undefined }
  | { readonly planApplicability: 'approved-plan'; readonly planBindingDigest: string; readonly planDecisionRef: string; readonly diagnosticPurpose?: string | undefined; readonly taskCriteriaDigest?: string | undefined };
type ProviderOutcomeUsageV02 =
  | { readonly outcome: 'observed'; readonly observedUsage: ProviderUsage }
  | { readonly outcome: 'uncertain' | 'proven-not-dispatched'; readonly observedUsage?: ProviderUsage | undefined };

export type ProviderRequestOutcomeReceiptV02 = ProviderOutcomeBaseV02 & ProviderOutcomePlanV02 & ProviderOutcomeUsageV02;

export type AttemptOutcomeReceiptV02 = RepositoryActionOutcomeReceiptV02 | ProviderRequestOutcomeReceiptV02;

export type ReconciliationKindV02 = 'uncertain-attempt' | 'observed-unsettled';

interface AttemptReconciliationBaseV02 {
  readonly reconciliationId: string;
  readonly reconciliationDigest: string;
  readonly reconciliationKind: ReconciliationKindV02;
  readonly predecessorReceiptId: string;
  readonly predecessorReceiptDigest: string;
  readonly admissionDigest: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly attemptId: string;
  readonly executorIdentity: ExecutorIdentityV02;
  readonly versions: AttemptVersionBindingsV02;
  readonly evidenceRefs: readonly SafeReferenceV02[];
  readonly expectedCurrentTaskStateVersion: number;
  readonly expectedCurrentControlVersion: number;
  readonly expectedCurrentEpoch: number;
  readonly accountingIdentityDigest: string;
}

interface RepositoryReconciliationBaseV02 extends AttemptReconciliationBaseV02 {
  readonly subjectKind: 'repository-action';
  readonly planApplicability: PlanApplicabilityV02;
  readonly actionDigest: string;
  readonly policyAuthorityRef: PolicyAuthorityRefV02;
  readonly policyEvaluationReceiptRef: string;
  readonly policyEvaluationReceiptDigest: string;
  readonly freshnessContextDigest: string;
}

interface ProviderReconciliationBaseV02 extends AttemptReconciliationBaseV02 {
  readonly subjectKind: 'provider-request';
  readonly planApplicability: PlanApplicabilityV02;
  readonly providerRequestId: string;
  readonly requestContentDigest: string;
  readonly role: ProviderRoleV02;
  readonly providerAdmissionReceiptRef: string;
  readonly providerAdmissionReceiptDigest: string;
  readonly requestReservationReceiptRef: string;
  readonly budgetRefs: readonly string[];
  readonly providerIdentity: ProviderPricingIdentityV02;
}

type RepositoryReconciliationPlanFieldsV02 =
  | { readonly planApplicability: 'pre-plan-diagnostic'; readonly diagnosticPurpose: string; readonly taskCriteriaDigest: string; readonly checkSetDigest: string; readonly planBindingDigest?: never | undefined; readonly planDecisionRef?: never | undefined }
  | { readonly planApplicability: 'approved-plan'; readonly planBindingDigest: string; readonly planDecisionRef: string };
type ProviderReconciliationPlanFieldsV02 =
  | { readonly planApplicability: 'pre-plan-diagnostic'; readonly diagnosticPurpose: string; readonly taskCriteriaDigest: string; readonly planBindingDigest?: never | undefined; readonly planDecisionRef?: never | undefined }
  | { readonly planApplicability: 'approved-plan'; readonly planBindingDigest: string; readonly planDecisionRef: string; readonly diagnosticPurpose?: string | undefined; readonly taskCriteriaDigest?: string | undefined };

type ReconciliationOutcomeEvidenceV02 = {
  readonly disposition: 'observed-and-accounted';
  readonly effectEvidenceRef: SafeReferenceV02;
  readonly accountingEvidenceRefs: readonly SafeReferenceV02[];
  readonly observedUsage?: ProviderUsage | undefined;
} | {
  readonly disposition: 'proven-not-dispatched';
  readonly adapterEvidenceRefs: readonly SafeReferenceV02[];
  readonly fencedRecipientIdentity: ExecutorIdentityV02;
  readonly fencingGeneration: number;
  readonly fencingProof: SafeReferenceV02;
};

export type UncertainAttemptReconciliationReceiptV02 =
  | (RepositoryReconciliationBaseV02 & RepositoryReconciliationPlanFieldsV02 & ActionDecisionReceiptBindingV02 & ReconciliationOutcomeEvidenceV02 & { readonly reconciliationKind: 'uncertain-attempt' })
  | (ProviderReconciliationBaseV02 & ProviderReconciliationPlanFieldsV02 & ReconciliationOutcomeEvidenceV02 & { readonly reconciliationKind: 'uncertain-attempt' });

export type ObservedOutcomeReconciliationReceiptV02 =
  | (RepositoryReconciliationBaseV02 & RepositoryReconciliationPlanFieldsV02 & ActionDecisionReceiptBindingV02 & { readonly reconciliationKind: 'observed-unsettled' })
  | (ProviderReconciliationBaseV02 & ProviderReconciliationPlanFieldsV02 & { readonly reconciliationKind: 'observed-unsettled' });

export type AttemptReconciliationReceiptV02 = UncertainAttemptReconciliationReceiptV02 | ObservedOutcomeReconciliationReceiptV02;
