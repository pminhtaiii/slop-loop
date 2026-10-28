import type { ApprovalBinding, TaskState } from './types.ts';
import type {
  AttemptReceiptV02,
  AttemptOutcomeReceiptV02,
  ClaimReceiptV02,
  OutcomeRecordResultV02,
  PolicyAuthorityRefV02,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
} from './ports-v02.ts';

export interface VerificationPolicyIdentityV02 {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly issuerKeyRef: string;
}

export interface CompleteApprovalBindingContextV02 {
  readonly currentTaskId: string;
  readonly currentWorkspaceId: string;
  readonly currentRepositoryRevisionDigest: string;
  readonly currentPolicyId: string;
  readonly currentPolicyVersion: string;
  readonly currentNormalizedActionDigest: string;
  readonly currentPlanVersion: number;
  readonly currentStrategyDigest: string;
  readonly currentBaselineRef: string;
  readonly currentEvidenceRefs: readonly string[];
  readonly currentCriteriaDigest: string;
  readonly currentCheckSetDigest: string;
}

export interface VerificationApprovalContextV02 {
  readonly purpose: 'historical-patch' | 'current-verification';
  readonly expectedIssuerKeyRef: string;
  readonly expectedDecisionAuthorityGeneration: number;
  readonly approvalContext: CompleteApprovalBindingContextV02;
}

export type VerificationApprovalResolutionV02 =
  | {
      readonly outcome: 'resolved';
      readonly decisionId: string;
      readonly binding: ApprovalBinding;
      readonly issuerKeyRef: string;
      readonly decisionAuthorityGeneration: number;
      readonly contextDigest: string;
    }
  | {
      readonly outcome: 'unavailable' | 'denied' | 'stale';
      readonly reasonCode: string;
    };

/** Public, issuer-owned lookup for approval records in an explicit authority context. */
export interface ContextualApprovalVerifierV02 {
  resolvePlanDecisionInContext(
    decisionId: string,
    context: VerificationApprovalContextV02,
  ): Promise<VerificationApprovalResolutionV02>;
}

export interface VerificationAuthoritySnapshotV02 {
  readonly taskId: string;
  readonly runId: string;
  readonly stateVersion: number;
  readonly repositoryRevisionDigest: string;
  readonly controlVersion: number;
  readonly epoch: number;
  readonly decisionAuthorityGeneration: number;
  readonly policyIdentity: VerificationPolicyIdentityV02;
  readonly controlMode: string;
  readonly holdRef: string | null;
  readonly activeClaimId: string | null;
}

export interface RecordVerificationApprovalRequestV02 {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly originalDecisionId: string;
  readonly decisionId: string;
  readonly expectedStateVersion: number;
  readonly expectedRepositoryRevisionDigest: string;
  readonly expectedPlanVersion: number;
  readonly expectedPlanMaterialDigest: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly expectedDecisionAuthorityGeneration: number;
  readonly policyIdentity: VerificationPolicyIdentityV02;
  readonly requestIdentity: string;
}

export type RecordVerificationApprovalResultV02 =
  | {
      readonly outcome: 'pending' | 'rejected' | 'approved';
      readonly requestIdentity: string;
      readonly decisionId: string;
      readonly state: TaskState;
      readonly controlVersion: number;
      readonly epoch: number;
      readonly decisionAuthorityGeneration: number;
    }
  | {
      readonly outcome: 'conflict' | 'stale' | 'blocked' | 'unavailable';
      readonly requestIdentity: string;
      readonly reasonCode: string;
    };

export interface SettledPatchAncestryRequestV02 {
  readonly taskId: string;
  readonly runId: string;
  readonly resultingRepositoryRevisionDigest: string;
}

/** Read-only owner journal evidence. It carries no executable capability. */
export interface SettledPatchAncestryV02 {
  readonly admissionContext: RepositoryAdmissionContextV02;
  readonly trustedAdmissionContext: RepositoryAdmissionTrustedContextV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome: AttemptOutcomeReceiptV02;
  readonly settlement: OutcomeRecordResultV02 & { readonly outcome: 'settled' };
  readonly originalTaskState: TaskState;
  readonly originalAuthorityRef: PolicyAuthorityRefV02;
}
