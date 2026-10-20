/** UC-03 contract records and validation context types. */

export const CONTRACT_VERSION = '0.1.0' as const;

export const TASK_OUTCOMES = [
  'COMPLETED',
  'IMPLEMENTED_UNVERIFIED',
  'INCOMPLETE',
  'FAILED',
] as const;

export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const ENVELOPE_OUTCOMES = [
  'success',
  'needs-info',
  'pending-approval',
  'denied',
  'conflict',
  'exhausted',
  'timeout',
  'error',
  'uncertain-effect',
] as const;

export type EnvelopeOutcome = (typeof ENVELOPE_OUTCOMES)[number];

export type PermissionClass =
  | 'ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'FORBIDDEN';

export const TASK_NODES = [
  'Validate',
  'NeedsInfo',
  'Investigate',
  'AwaitPlan',
  'AwaitFeedback',
  'Patch',
  'Verify',
  'Review',
  'Repair',
  'Deliver',
  'Incomplete',
] as const;

export type TaskNode = (typeof TASK_NODES)[number];

export const ALLOWED_NODE_TRANSITIONS: Readonly<Record<TaskNode, readonly TaskNode[]>> = {
  Validate: ['NeedsInfo', 'Investigate'],
  NeedsInfo: ['Validate'],
  Investigate: ['AwaitPlan'],
  AwaitPlan: ['AwaitFeedback', 'Patch'],
  AwaitFeedback: ['Investigate', 'Incomplete'],
  Patch: ['Verify', 'Repair'],
  Verify: ['Review', 'Repair'],
  Review: ['Deliver', 'Repair'],
  Repair: ['Patch', 'Investigate', 'Incomplete'],
  Deliver: [],
  Incomplete: [],
};

export interface TaskEnvelope {
  readonly schemaVersion: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly expectedStateVersion: number;
  readonly repositoryRevisionDigest: string;
  readonly trustedConfigId: string;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export interface ExecutionLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCpuCores: number;
  readonly maxMemoryBytes: number;
  readonly maxPids: number;
}

export interface BudgetLimits {
  readonly maxReplanCount: number;
  readonly maxTokens: number;
  readonly maxCostUsd: number;
  readonly maxRepairAttempts: number;
  readonly maxReviewIterations: number;
}

export type CheckPurpose =
  | 'reproduction'
  | 'focused'
  | 'regression'
  | 'compatibility'
  | 'diff';

export interface CheckDefinition {
  readonly checkId: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly purpose: CheckPurpose;
  readonly workingDirectory?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface BugTask {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly initialRevisionDigest: string;
  readonly goal: string;
  readonly observedBehavior: string;
  readonly expectedBehavior: string;
  readonly reproduction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly requiredChecks: readonly CheckDefinition[];
  readonly limits: ExecutionLimits;
  readonly budgetLimits: BudgetLimits;
  readonly configId: string;
  readonly configVersion: string;
}

export interface RunCommandAction {
  readonly actionId: string;
  readonly kind: 'run_command';
  readonly executable: string;
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly purpose?: string | undefined;
}

export interface ApplyPatchAction {
  readonly actionId: string;
  readonly kind: 'apply_patch';
  readonly patchContent: string;
  readonly targetPaths: readonly string[];
  readonly baseRevisionDigest: string;
}

export interface ApproveFixPlanAction {
  readonly actionId: string;
  readonly kind: 'approve_fix_plan';
  readonly planVersion: number;
  readonly strategyDigest: string;
  readonly diagnosisEvidenceRefs: readonly string[];
  readonly checkSetDigest: string;
}

export type NormalizedAction =
  | RunCommandAction
  | ApplyPatchAction
  | ApproveFixPlanAction;

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'stale';

export interface ApprovalBinding {
  readonly decisionId: string;
  readonly actionKind: 'action' | 'fix_plan';
  readonly normalizedActionDigest: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryRevisionDigest: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly planVersion?: number | undefined;
  readonly strategyDigest?: string | undefined;
  readonly baselineRef?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly criteriaDigest?: string | undefined;
  readonly checkSetDigest?: string | undefined;
  readonly status: ApprovalStatus;
  readonly reason?: string | undefined;
}

export interface ApprovalBindingContext {
  readonly currentTaskId?: string | undefined;
  readonly currentWorkspaceId?: string | undefined;
  readonly currentRepositoryRevisionDigest?: string | undefined;
  readonly currentPolicyId?: string | undefined;
  readonly currentPolicyVersion?: string | undefined;
  readonly currentNormalizedActionDigest?: string | undefined;
  readonly currentPlanVersion?: number | undefined;
  readonly currentStrategyDigest?: string | undefined;
  readonly currentBaselineRef?: string | undefined;
  readonly currentEvidenceRefs?: readonly string[] | undefined;
  readonly currentCriteriaDigest?: string | undefined;
  readonly currentCheckSetDigest?: string | undefined;
}

export interface CommandViewValidationContext {
  readonly currentCanonicalRevisionDigest?: string | undefined;
  readonly currentExclusionsPolicyVersion?: string | undefined;
  readonly expectedViewDigest?: string | undefined;
  readonly trustedFileDigests?: Readonly<Record<string, string>> | undefined;
}

export interface AdmittedFile {
  readonly path: string;
  readonly digest: string;
}

export interface CommandView {
  readonly viewId: string;
  readonly viewDigest: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly canonicalRevisionDigest: string;
  readonly admittedFiles: readonly AdmittedFile[];
  readonly exclusionsPolicyVersion: string;
  readonly scratchIdentity: string;
  readonly mountedReadOnly: true;
}

export interface TaskWorkspace {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly containerImageDigest: string;
  readonly repoVolumeId: string;
  readonly scratchVolumeId: string;
  readonly expectedRepoState: string;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly billableTokens?: number | undefined;
}

export interface ProviderRequest {
  readonly providerRequestId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly role: 'coder' | 'reviewer';
  readonly purpose: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly configId: string;
  readonly pricingPolicyId: string;
  readonly contextDigest: string;
  readonly timeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
  readonly reservationRef: string;
  readonly dispatchState: 'reserved' | 'dispatched' | 'settled' | 'uncertain';
  readonly observedUsage?: ProviderUsage | undefined;
  readonly uncertainReason?: string | undefined;
}

export interface ReservationBundleItem {
  readonly ledgerIdentity: string;
  readonly scope: 'task' | 'run';
  readonly kind: string;
  readonly configurationId: string;
  readonly version: number;
  readonly requestId: string;
  readonly amount: number;
}

export interface ReservationBundle {
  readonly bundleId: string;
  readonly transactionRef: string;
  readonly taskId: string;
  readonly runId: string;
  readonly reservations: readonly ReservationBundleItem[];
}

export interface ProviderRequestValidationContext {
  readonly expectedTaskId?: string | undefined;
  readonly expectedRunId?: string | undefined;
  readonly expectedRole?: 'coder' | 'reviewer' | undefined;
  readonly expectedPurpose?: string | undefined;
  readonly expectedProviderId?: string | undefined;
  readonly expectedModelId?: string | undefined;
  readonly expectedConfigId?: string | undefined;
  readonly expectedPricingPolicyId?: string | undefined;
  readonly expectedContextDigest?: string | undefined;
  readonly expectedProviderRequestId?: string | undefined;
}

/** Host-only StatePort snapshot. Never populate from a model or client projection. */
export interface DispatchAdmissionContext {
  readonly expectedRequest: ProviderRequest;
  readonly storedRequests: readonly ProviderRequest[];
  readonly taskAccountingStatus: 'healthy' | 'unknown';
  readonly transactionRef: string;
  /** Authoritative ledger IDs, in the same order as ledgers. */
  readonly ledgerIdentities: readonly string[];
  readonly requireRunReviewIteration: boolean;
  readonly reservationIds: Readonly<Record<string, string>>;
  readonly ledgers: readonly BudgetLedger[];
  readonly reservationBundle: ReservationBundle;
  readonly isTelemetryEstimate?: boolean | undefined;
}

export class BudgetExhaustionError extends Error {
  readonly code = 'BUDGET_EXHAUSTED' as const;
  readonly details: { scope?: string; kind?: string; limit?: number; requested?: number } | undefined;
  constructor(
    message: string,
    details?: { scope?: string; kind?: string; limit?: number; requested?: number }
  ) {
    super(message);
    this.name = 'BudgetExhaustionError';
    this.details = details;
  }
}

export class BudgetConflictError extends Error {
  readonly code = 'BUDGET_CONFLICT' as const;
  readonly details: { scope?: string; kind?: string; version?: number } | undefined;
  constructor(
    message: string,
    details?: { scope?: string; kind?: string; version?: number }
  ) {
    super(message);
    this.name = 'BudgetConflictError';
    this.details = details;
  }
}

export interface Run {
  readonly runId: string;
  readonly taskId: string;
  readonly startTime: string;
  readonly endTime?: string | undefined;
  readonly totalUsage?: ProviderUsage | undefined;
  readonly outcome?: TaskOutcome | undefined;
}

export type PlanStepStatus = 'todo' | 'doing' | 'done' | 'failed';
export const PLAN_STEP_STATUSES: readonly PlanStepStatus[] = ['todo', 'doing', 'done', 'failed'];

export interface PlanStep {
  readonly stepId: string;
  readonly description: string;
  readonly status: PlanStepStatus;
  readonly actionRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface FixPlan {
  readonly planVersion: number;
  readonly diagnosis: string;
  readonly suspectedCauseLocations: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly strategy: string;
  readonly scopedChanges: readonly string[];
  readonly checkSetDigest: string;
  readonly baselineRef: string;
  readonly strategyDigest: string;
  readonly decisionRef?: string | undefined;
}

export interface BudgetReservation {
  readonly reservationId: string;
  readonly keyedId: string;
  readonly amount: number;
}

export interface BudgetLedger {
  readonly scope: 'task' | 'run';
  readonly kind: string;
  readonly limit: number;
  readonly consumed: number;
  readonly reservations: readonly BudgetReservation[];
  readonly unit: string;
  readonly configurationId: string;
  readonly version: number;
}

export interface TaskState {
  readonly schemaVersion: string;
  readonly stateVersion: number;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryRevisionDigest: string;
  readonly goal: string;
  readonly observedBehavior?: string | undefined;
  readonly expectedBehavior?: string | undefined;
  readonly reproduction?: string | undefined;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly requiredCheckIds?: readonly string[] | undefined;
  readonly taskContext?: BugTask | undefined;
  readonly node: TaskNode;
  readonly planVersion: number;
  readonly replanCount: number;
  readonly plan?: FixPlan | undefined;
  readonly steps?: readonly PlanStep[] | undefined;
  readonly changedPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly approvalDecisionRefs?: readonly string[] | undefined;
  readonly activeDecisionId?: string | undefined;
  readonly reviewRefs?: readonly string[] | undefined;
  readonly latestReviewRef?: string | undefined;
  readonly budgetLedgers?: readonly BudgetLedger[] | undefined;
  readonly checkpointConfigId?: string | undefined;
  readonly checkpointVersion?: number | undefined;
  readonly risks: readonly string[];
  readonly nextAction: string;
  readonly outcome?: TaskOutcome | undefined;
}

export type TaskCheckpoint = TaskState;

/** Host-owned evidence boundary, never populated from model proposals. */
export interface TrustedTransitionContext {
  readonly approval?: { readonly binding: unknown; readonly freshness: ApprovalBindingContext };
  readonly completion?: {
    readonly taskId: string; readonly runId: string; readonly repositoryRevisionDigest: string;
    readonly diffDigest: string; readonly checkSetDigest: string; readonly baselineRef: string;
    readonly criteriaDigest: string; readonly authorizedDiffDigest: string;
    readonly protectedTestsDigest: string; readonly originalProtectedTestsDigest: string;
    readonly reviewerRoleConfigId?: string;
    readonly reviewIterationReservationRef?: string;
    readonly checks: readonly (
      | { readonly checkId: string; readonly outcome: 'pass'; readonly repositoryRevisionDigest: string; readonly diffDigest: string }
      | VerificationResult
    )[];
    readonly review:
      | { readonly reviewId: string;
          readonly status: 'accepted';
          readonly repositoryRevisionDigest: string;
          readonly diffDigest: string;
          readonly checkSetDigest: string;
          readonly roleConfigId: string }
      | ReviewResult;
  };
  readonly replanReservation?: { readonly proposalId: string;
    readonly taskId: string;
    readonly configurationId: string;
    readonly priorCount: number;
    readonly nextCount: number;
    readonly reservationId: string };
}

export interface StateTransitionOptions {
  readonly allowSameNode?: boolean | undefined;
  /** Only the host may supply these records, after validating external evidence. */
  readonly trusted?: TrustedTransitionContext | undefined;
}

export interface CheckResult {
  readonly checkId: string;
  readonly outcome: 'pass' | 'fail' | 'timeout' | 'error' | 'not-run';
  readonly outputExcerpt?: string | undefined;
  readonly durationMs?: number | undefined;
}

export interface Baseline {
  readonly evidenceId: string;
  readonly repositorySnapshotDigest: string;
  readonly checkSetDigest: string;
  readonly reproductionFailureSignature: string;
  readonly checkResults: readonly CheckResult[];
  readonly testProtectionDigest: string;
}

export interface VerificationResult {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly phase: 'baseline' | 'focused' | 'regression' | 'compatibility' | 'diff';
  readonly repoDigest: string;
  readonly diffDigest?: string | undefined;
  readonly commandIdentity: string;
  readonly outcome: 'pass' | 'fail' | 'timeout' | 'error' | 'not-run';
  readonly testedIds: readonly string[];
  readonly diagnosticRefs: readonly string[];
}

export interface SourceEvidence {
  readonly path: string;
  readonly revisionDigest: string;
  readonly boundedExcerpt: string;
  readonly resultCount: number;
  readonly truncated: boolean;
}

export type ReviewSide = 'old' | 'new';
export type ReviewSeverity = 'error' | 'warning' | 'info';

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly side: ReviewSide;
  readonly severity: ReviewSeverity;
  readonly message: string;
  readonly evidenceRef?: string | undefined;
}

export interface ReviewResult {
  readonly reviewId: string;
  readonly reviewerRoleConfigId: string;
  readonly repoDigest: string;
  readonly diffDigest: string;
  readonly checkSetDigest: string;
  readonly status: 'accepted' | 'findings' | 'invalid';
  readonly findings: readonly ReviewFinding[];
  readonly iterationReservationRef: string;
}

export interface ActivityEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly node: string;
  readonly actionType: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly evidenceRefs: readonly string[];
}

export interface Delivery {
  readonly taskId: string;
  readonly runId: string;
  readonly outcome: TaskOutcome;
  readonly diffDigest: string;
  readonly changedFiles: readonly string[];
  readonly baselineRef: string;
  readonly verificationRefs: readonly string[];
  readonly reviewRef: string;
  readonly limitations: readonly string[];
  readonly safeNextAction: string;
}

export type CheckOutcome = 'pass' | 'fail' | 'timeout' | 'error' | 'not-run';
export type VerificationPhase = 'baseline' | 'focused' | 'regression' | 'compatibility' | 'diff';

export interface SourceEvidenceLimits {
  readonly maxExcerptBytes?: number | undefined;
  readonly maxResultCount?: number | undefined;
  readonly allowedPaths?: readonly string[] | undefined;
}

export interface BaselineAdmissionContext {
  readonly expectedEvidenceId?: string | undefined;
  readonly expectedRepositorySnapshotDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedTestProtectionDigest: string;
  readonly expectedReproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
}

export interface VerificationAdmissionContext {
  readonly expectedTaskId: string;
  readonly expectedRunId: string;
  readonly expectedRepoDigest: string;
  readonly expectedDiffDigest?: string | undefined;
  readonly expectedCheckId?: string | undefined;
  readonly requiredPhase?: VerificationPhase | undefined;
}

export type TrustedDiffLines = Readonly<
  Record<
    string,
    {
      readonly oldLines?: readonly number[] | undefined;
      readonly newLines?: readonly number[] | undefined;
    }
  >
>;

export interface ReviewAdmissionContext {
  readonly expectedReviewId?: string | undefined;
  readonly expectedTaskId?: string | undefined;
  readonly expectedRepoDigest: string;
  readonly expectedDiffDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedRoleConfigId: string;
  readonly expectedIterationReservationRef?: string | undefined;
  readonly trustedDiffLines?: TrustedDiffLines | undefined;
}

export interface TaskWorkspaceValidationContext {
  readonly expectedTaskId?: string | undefined;
  readonly expectedWorkspaceId?: string | undefined;
}

export interface DeliveryValidationContext {
  readonly expectedTaskId?: string | undefined;
  readonly expectedRunId?: string | undefined;
  readonly expectedDiffDigest?: string | undefined;
  readonly expectedBaselineRef?: string | undefined;
  readonly expectedReviewRef?: string | undefined;
}
