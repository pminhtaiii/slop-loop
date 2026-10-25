/**
 * UC-03 v0.2.0 runtime port interfaces and atomic admission contracts.
 * Additive declarations for StatePortV02, RepositoryPortV02, ModelPortV02,
 * ExecutionGuardV02, and supporting attempt/journal types.
 *
 * Source-compatible with existing v0.1 ports.ts.
 */

import type {
  PortIdentity,
  PortProvenance,
} from './ports.ts';
import type {
  ApplyPatchAction,
  CheckDefinition,
  CheckResult,
  EnvelopeOutcome,
  NormalizedAction,
  ProviderRequest,
  ProviderUsage,
  RunCommandAction,
  SourceEvidence,
  TaskState,
  ValidationError,
  AdmittedFile,
} from './types.ts';
import type { RepositoryActionOutcomeReceiptV02, AttemptOutcomeReceiptV02, AttemptReconciliationReceiptV02 } from './attempt-receipts-v02.ts';

export type { PortIdentity, PortProvenance };

export type SubjectKindV02 = 'repository-action' | 'provider-request';
export type PlanApplicabilityV02 = 'pre-plan-diagnostic' | 'approved-plan';
export type ProviderRoleV02 = 'coder' | 'reviewer';

export interface PolicyAuthorityRefV02 {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly issuerKeyRef: string;
  readonly decisionAuthorityGeneration: number;
}

export interface PolicyEvaluationReceiptV02 {
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

/** Independent current-state facts supplied by the trusted admission caller. */
export interface RepositoryAdmissionTrustedContextV02 {
  readonly subjectKind: 'repository-action';
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly runnableNode: string;
  readonly canonicalRevision: string;
  readonly executionProfileId: string;
  readonly planApplicability: PlanApplicabilityV02;
  readonly planBindingDigest?: string | undefined;
  readonly planDecisionRef?: string | undefined;
  readonly policyAuthorityRef: PolicyAuthorityRefV02;
  readonly policyEvaluationReceiptRef: string;
  readonly policyEvaluationReceiptDigest: string;
  readonly actionDecisionReceiptRef?: string | undefined;
  readonly actionDecisionReceiptDigest?: string | undefined;
  readonly freshnessContextDigest: string;
  readonly executionProfile: {
    readonly isolationProfileRef: string;
    readonly exclusionsPolicyVersion: string;
    readonly scratchIdentity: string;
    readonly commandBounds: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly maxCpuSeconds: number;
      readonly maxMemoryBytes: number;
      readonly maxProcessCount: number;
    };
    readonly patchBounds: {
      readonly maxPatchBytes: number;
      readonly maxChangedPaths: number;
    };
  };
  readonly commandViewDigest?: string | undefined;
  readonly allowedDiagnosticChecks: readonly {
    readonly checkId: string;
    readonly testPath: string;
    readonly diagnosticPurpose: string;
    readonly taskCriteriaDigest: string;
    readonly checkSetDigest: string;
    readonly action: RunCommandAction;
  }[];
  readonly allowedDiagnosticTestPaths: readonly string[];
}

export interface ActionDecisionReceiptV02 {
  readonly decisionId: string;
  readonly decisionDigest: string;
  readonly actionDigest: string;
  readonly evaluationReceiptRef: string;
  readonly decisionAuthorityGeneration: number;
  readonly status: 'approved';
  readonly reason?: string | undefined;
}

export interface ProviderPricingIdentityV02 {
  readonly providerId: string;
  readonly modelId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly pricingPolicyId: string;
  readonly pricingPolicyVersion: string;
  readonly issuerKeyRef: string;
  readonly decisionAuthorityGeneration: number;
}

export interface ProviderAdmissionReceiptV02 {
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly providerRequestId: string;
  readonly role: ProviderRoleV02;
  readonly requestContentDigest: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly decisionAuthorityGeneration: number;
}

/** Independent request, role, receipt, and budget facts from the trusted caller. */
export interface ProviderAdmissionTrustedContextV02 {
  readonly subjectKind: 'provider-request';
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly taskId: string;
  readonly runId: string;
  readonly runnableNode: string;
  readonly planApplicability: PlanApplicabilityV02;
  readonly planBindingDigest?: string | undefined;
  readonly planDecisionRef?: string | undefined;
  readonly diagnosticPurpose?: string | undefined;
  readonly taskCriteriaDigest?: string | undefined;
  readonly role: ProviderRoleV02;
  readonly providerRequestId: string;
  readonly requestContentDigest: string;
  readonly providerAdmissionReceiptRef: string;
  readonly providerAdmissionReceiptDigest: string;
  readonly requestReservationReceipt: string;
  readonly budgetRefs: readonly string[];
  readonly providerIdentity: ProviderPricingIdentityV02;
  readonly requestLimits: ProviderRequestLimitsV02;
}

export type AdmissionTrustedContextV02 =
  | RepositoryAdmissionTrustedContextV02
  | ProviderAdmissionTrustedContextV02;

export interface CommandFiniteBoundsV02 {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCpuSeconds?: number | undefined;
  readonly maxMemoryBytes?: number | undefined;
  readonly maxProcessCount?: number | undefined;
  readonly isolationProfileRef: string;
}

export interface PatchFiniteBoundsV02 {
  readonly maxPatchBytes: number;
  readonly maxChangedPaths: number;
}

export interface ProviderFiniteBoundsV02 {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
  readonly maxReviewerIterations?: number | undefined;
}

export interface ProviderRequestLimitsV02 {
  readonly timeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
  readonly maxReviewerIterations?: number | undefined;
}

export interface CommandViewV02 {
  readonly viewId: string;
  readonly viewDigest: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly canonicalRevision: string;
  readonly admittedFiles: readonly AdmittedFile[];
  readonly exclusionsPolicyVersion: string;
  readonly scratchIdentity: string;
  readonly mountedReadOnly: true;
  readonly isolationProfileRef: string;
}

export interface RepositoryAdmissionBaseContextV02 {
  readonly schemaVersion: '0.2.0';
  readonly subjectKind: 'repository-action';
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly runnableNode: string;
  readonly canonicalRevision: string;
  readonly executionProfileId: string;
  readonly action: NormalizedAction;
  readonly actionDigest: string;
  readonly policyAuthorityRef: PolicyAuthorityRefV02;
  readonly policyEvaluationReceipt: PolicyEvaluationReceiptV02;
  readonly actionDecisionReceipt?: ActionDecisionReceiptV02 | undefined;
  readonly reservationRefs: readonly string[];
  readonly admissionDigest?: string | undefined;

  // Command/Test specific fields
  readonly commandView?: CommandViewV02 | undefined;
  readonly finiteBounds?: CommandFiniteBoundsV02 | PatchFiniteBoundsV02 | undefined;

  // Patch specific fields
  readonly baseRevision?: string | undefined;
  readonly targetPaths?: readonly string[] | undefined;
  readonly patchDigest?: string | undefined;
}

export interface RepositoryPrePlanDiagnosticAdmissionContextV02
  extends RepositoryAdmissionBaseContextV02 {
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
  readonly checkSetDigest: string;
  readonly testPath?: string | undefined;
  readonly checkId?: string | undefined;
  readonly planBindingDigest?: never | undefined;
  readonly planDecisionRef?: never | undefined;
}

export interface RepositoryApprovedPlanAdmissionContextV02
  extends RepositoryAdmissionBaseContextV02 {
  readonly planApplicability: 'approved-plan';
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
  readonly diagnosticPurpose?: string | undefined;
  readonly taskCriteriaDigest?: string | undefined;
  readonly checkSetDigest?: string | undefined;
  readonly testPath?: string | undefined;
  readonly checkId?: string | undefined;
}

export type RepositoryAdmissionContextV02 =
  | RepositoryPrePlanDiagnosticAdmissionContextV02
  | RepositoryApprovedPlanAdmissionContextV02;

export interface ProviderAdmissionBaseContextV02 {
  readonly schemaVersion: '0.2.0';
  readonly subjectKind: 'provider-request';
  readonly taskStateSchemaVersion: string;
  readonly expectedTaskStateVersion: number;
  readonly controlSchemaVersion: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly taskId: string;
  readonly runId: string;
  readonly runnableNode: string;
  readonly providerRequest: ProviderRequest;
  readonly providerRequestId: string;
  readonly role: ProviderRoleV02;
  readonly requestContentDigest: string;
  readonly providerIdentity: ProviderPricingIdentityV02;
  readonly providerAdmissionReceipt: ProviderAdmissionReceiptV02;
  readonly requestReservationReceipt: string;
  readonly budgetRefs: readonly string[];
  readonly finiteBounds: ProviderFiniteBoundsV02;
  readonly admissionDigest?: string | undefined;
}

export interface ProviderPrePlanDiagnosticAdmissionContextV02
  extends ProviderAdmissionBaseContextV02 {
  readonly planApplicability: 'pre-plan-diagnostic';
  readonly diagnosticPurpose: string;
  readonly taskCriteriaDigest: string;
  readonly planBindingDigest?: never | undefined;
  readonly planDecisionRef?: never | undefined;
}

export interface ProviderApprovedPlanAdmissionContextV02
  extends ProviderAdmissionBaseContextV02 {
  readonly planApplicability: 'approved-plan';
  readonly planBindingDigest: string;
  readonly planDecisionRef: string;
  readonly diagnosticPurpose?: string | undefined;
  readonly taskCriteriaDigest?: string | undefined;
}

export type ProviderAdmissionContextV02 =
  | ProviderPrePlanDiagnosticAdmissionContextV02
  | ProviderApprovedPlanAdmissionContextV02;

export type AdmissionContextV02 =
  | RepositoryAdmissionContextV02
  | ProviderAdmissionContextV02;

/* ------------------------------------------------------------------
 * Subsequent Attempt / Journal Types (Declarations for Future Tasks)
 * ------------------------------------------------------------------ */

export interface ExecutorIdentityV02 {
  readonly adapterIdentity: string;
  readonly processIncarnation: string;
  readonly fencingGeneration: number;
  readonly payloadDigest: string;
}

export type ClaimStatusV02 =
  | 'claimed'
  | 'attempting'
  | 'dispatched'
  | 'outcome-recorded'
  | 'settled'
  | 'uncertain'
  | 'observed-unsettled';

export interface ClaimReceiptV02 {
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly runId: string;
  readonly subjectKind: SubjectKindV02;
  readonly planApplicability: PlanApplicabilityV02;
  readonly preClaimTaskStateVersion: number;
  readonly preClaimControlVersion: number;
  readonly postClaimControlVersion: number;
  readonly epoch: number;
  readonly status: 'claimed';
  readonly reservationRefs: readonly string[];
}

export interface AttemptReceiptV02 {
  readonly attemptId: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly executorIdentity: ExecutorIdentityV02;
  readonly preAttemptTaskStateVersion: number;
  readonly postBeginTaskStateVersion: number;
  readonly preAttemptControlVersion: number;
  readonly postBeginControlVersion: number;
  readonly epoch: number;
  readonly status: 'attempting';
}

export interface ClaimClosureReceiptV02 {
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly claimId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly fencedExecutorIdentity: ExecutorIdentityV02;
  readonly unconsumedReservations: readonly string[];
}

export type {
  AttemptOutcomeStatusV02,
  SafeReferenceV02,
  AttemptVersionBindingsV02,
  ProposedRevisionEffectV02,
  ProposedTaskTransitionV02,
  ProposedAccountingSettlementV02,
  ProposedSettlementEffectsV02,
  RepositoryActionOutcomeReceiptV02,
  ProviderRequestOutcomeReceiptV02,
  AttemptOutcomeReceiptV02,
  ReconciliationKindV02,
  UncertainAttemptReconciliationReceiptV02,
  ObservedOutcomeReconciliationReceiptV02,
  AttemptReconciliationReceiptV02,
} from './attempt-receipts-v02.ts';

export interface OutcomeRecordResultV02 {
  readonly outcome: 'settled' | 'recorded-unsettled' | 'already-recorded' | 'uncertain';
  readonly receiptId: string;
}

export interface ReconciliationResultV02 {
  readonly outcome: 'settled' | 'blocked' | 'conflict';
  readonly receiptId: string;
}

export interface ClaimClosureResultV02 {
  readonly closed: boolean;
  readonly receiptId: string;
}

/* ------------------------------------------------------------------
 * v0.2 Port Interfaces
 * ------------------------------------------------------------------ */

export interface StatePortV02 extends PortIdentity {
  loadTask(taskId: string): Promise<TaskState | null>;
  transition(state: TaskState, expectedVersion: number): Promise<TaskState>;
  claim(context: AdmissionContextV02): Promise<ClaimReceiptV02>;
  beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02>;
  recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02>;
  reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02>;
  reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02>;
  closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02>;
  checkpoint(state: TaskState): Promise<void>;
  recover(taskId: string): Promise<TaskState>;
}

/** Exact receiver handoff, issued only after an observed outcome is settled. */
export interface RepositoryExecutionReceiptV02 {
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome: RepositoryActionOutcomeReceiptV02;
  readonly settlement: OutcomeRecordResultV02 & { readonly outcome: 'settled' };
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Approved canonical result alias.
export type RepositoryPatchResultV02 = {
  readonly applied: boolean;
  readonly newRevisionDigest: string;
  readonly executionReceipt: RepositoryExecutionReceiptV02;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Approved canonical result alias.
export type RepositoryCommandResultV02 = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly executionReceipt: RepositoryExecutionReceiptV02;
};

export interface RepositoryPortV02 extends PortIdentity {
  listDir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<SourceEvidence>;
  searchCode(query: string): Promise<readonly SourceEvidence[]>;
  applyPatch(
    patch: ApplyPatchAction,
    context: RepositoryAdmissionContextV02
  ): Promise<RepositoryPatchResultV02>;
  runCommand(
    action: RunCommandAction,
    context: RepositoryAdmissionContextV02
  ): Promise<RepositoryCommandResultV02>;
  runTests(
    check: CheckDefinition,
    context: RepositoryAdmissionContextV02
  ): Promise<CheckResult>;
  inspectDiff(
    baseRevisionDigest: string
  ): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }>;
}

export interface ModelPortV02 extends PortIdentity {
  propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context: ProviderAdmissionContextV02
  ): Promise<{
    readonly outcome: 'observed' | 'uncertain' | 'denied' | 'invalid';
    readonly result?: unknown;
    readonly observedUsage?: ProviderUsage | undefined;
    readonly reason?: string | undefined;
    readonly errors?: readonly ValidationError[] | undefined;
  }>;
}

export interface ExecutionGuardResultV02 {
  readonly outcome: EnvelopeOutcome;
  readonly result?: unknown;
  readonly reason?: string | undefined;
  readonly attemptId?: string | undefined;
}

export interface ExecutionGuardV02 extends PortIdentity {
  validateAndExecute(
    action: NormalizedAction,
    state: TaskState,
    context: RepositoryAdmissionContextV02
  ): Promise<ExecutionGuardResultV02>;
}
