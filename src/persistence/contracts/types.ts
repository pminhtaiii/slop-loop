/**
 * UC-04 Recovery & Multi-step Feature Extension Contracts and Validators.
 * Schema version: uc04-recovery/0.1-draft
 */

export const UC04_SCHEMA_VERSION = 'uc04-recovery/0.1-draft' as const;

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly predecessorIds?: readonly string[] | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly error?: string | undefined;
  readonly changedFiles?: readonly string[] | undefined;
}

export interface WorkspaceBaseline {
  readonly commitHash: string;
  readonly branch: string;
  readonly isClean: boolean;
  readonly trackedFilesHash: string;
}

export interface BudgetReservationItem {
  readonly reservationId: string;
  readonly keyedId: string;
  readonly amount: number;
}

export interface BudgetLedger {
  readonly scope: 'task' | 'run';
  readonly kind: 'tokens' | 'token' | 'cost' | 'repair' | 'reviewer';
  readonly limit: number;
  readonly consumed: number;
  readonly reservations: readonly BudgetReservationItem[];
  readonly configurationId: string;
  readonly version: number;
}

export interface ReservationBundleItem {
  readonly ledgerIdentity: string;
  readonly scope: 'task' | 'run';
  readonly kind: 'tokens' | 'token' | 'cost' | 'repair' | 'reviewer';
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

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly billableTokens?: number | undefined;
  readonly costUsd: number;
}

export interface DeliberatePauseRecord {
  readonly schemaVersion: typeof UC04_SCHEMA_VERSION;
  readonly taskId: string;
  readonly active: boolean;
  readonly pauseKey: string;
  readonly operatorRef: string;
  readonly acceptedAt: string;
  readonly revision: number;
  readonly epoch: number;
  readonly resumeKey: string | null;
  readonly outstandingAttemptRefs: readonly string[];
}

export interface DispatchClaimRecord {
  readonly claimId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly actionId: string;
  readonly epoch: number;
  readonly stateVersion: number;
  readonly phase: 'claimed' | 'dispatched' | 'observed' | 'uncertain' | 'reconciled';
  readonly reservationRefs: readonly string[];
  readonly createdAt: string;
  readonly settledAt?: string | undefined;
  readonly outcomeEvidence?: unknown | undefined;
}

export interface CompactSummary {
  readonly taskId: string;
  readonly sourceStateVersion: number;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly currentState: string;
  readonly openRisks: readonly string[];
  readonly nextAction: string;
}

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed';

export interface ApprovalRequestBinding {
  readonly requestId: string;
  readonly actionType: string;
  readonly targetFiles: readonly string[];
  readonly normalizedActionDigest: string;
  readonly repoCommit: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface TaskState {
  readonly schemaVersion: typeof UC04_SCHEMA_VERSION;
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly taskType: 'feature' | 'bugfix' | 'refactor';
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly plan: readonly PlanStep[];
  readonly currentStepIndex: number;
  readonly status: TaskStatus;
  readonly stateVersion: number;
  readonly lastCheckpointId?: string | undefined;
  readonly budgetLedgers: readonly BudgetLedger[];
  readonly workspaceBaseline: WorkspaceBaseline;
  readonly changedFiles: readonly string[];
  readonly openRisks: readonly string[];
  readonly nextAction: string;
  readonly pendingApproval?: ApprovalRequestBinding | undefined;
}

export interface CheckpointRecord {
  readonly checkpointId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly stateVersion: number;
  readonly timestamp: string;
  readonly state: TaskState;
  readonly checksum: string;
}

/* Operation result discriminant types */
export type OperationDiscriminator =
  | 'ok'
  | 'held'
  | 'invalid'
  | 'denied'
  | 'conflict'
  | 'exhausted'
  | 'unavailable'
  | 'uncertain';

export interface BaseOperationResult {
  readonly status: OperationDiscriminator;
  readonly safeReason?: string | undefined;
  readonly nextAction?: string | undefined;
}

export interface RegisterTaskInput {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly taskType: 'feature' | 'bugfix' | 'refactor';
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly plan: readonly PlanStep[];
  readonly budgetLedgers: readonly BudgetLedger[];
  readonly workspaceBaseline: WorkspaceBaseline;
}

export interface ClaimDispatchInput {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly actionId: string;
  readonly expectedEpoch: number;
  readonly expectedStateVersion: number;
  readonly requiredEvidenceRefs: readonly string[];
  readonly reservationRefs: readonly string[];
  readonly repoDigest: string;
  readonly policyVersion: string;
}

export interface PauseTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly pauseKey: string;
  readonly operatorRef: string;
  readonly reason?: string | undefined;
}

export interface ResumeTaskInput {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly resumeKey: string;
  readonly operatorRef: string;
}

export interface RecordAndSettleInput {
  readonly taskId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly requestId: string;
  readonly observedOutcome: 'success' | 'failure' | 'uncertain';
  readonly observedUsage: ProviderUsage;
  readonly evidenceRefs: readonly string[];
  readonly changedFiles?: readonly string[] | undefined;
  readonly nextAction?: string | undefined;
}

export interface RecoverTaskInput {
  readonly taskId: string;
  readonly newRunId: string;
  readonly repoEvidence: WorkspaceBaseline;
  readonly trustedOutcomeEvidence?: readonly unknown[] | undefined;
}
