export type StepStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly error?: string | undefined;
  readonly changedFiles?: readonly string[] | undefined;
  readonly verificationRef?: string | undefined;
}

export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed';

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

export interface WorkspaceBaseline {
  readonly commitHash: string;
  readonly branch: string;
  readonly isClean: boolean;
  readonly trackedFilesHash: string;
}

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
  readonly taskId: string;
  readonly runId: string;
  readonly taskType: 'feature' | 'bugfix' | 'refactor';
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly plan: readonly PlanStep[];
  readonly currentStepIndex: number;
  readonly changedFiles: readonly string[];
  readonly status: TaskStatus;
  readonly stateVersion: number;
  readonly lastCheckpointId?: string | undefined;
  readonly budgetLedgers: readonly BudgetLedger[];
  readonly pendingApproval?: ApprovalRequestBinding | undefined;
  readonly workspaceBaseline: WorkspaceBaseline;
  readonly openRisks?: readonly string[] | undefined;
  readonly nextAction?: string | undefined;
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
