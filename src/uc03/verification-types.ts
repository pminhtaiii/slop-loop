import type {
  Baseline,
  BugTask,
  Delivery,
  ExecutionGuardV02,
  RepositoryAdmissionContextV02,
  ReviewResult,
  StatePortV02,
  TaskOutcome,
  TaskState,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';

export interface TrustedReviewRecord {
  readonly reviewId: string;
  readonly reviewerRoleConfigId: string;
  readonly iterationReservationRef: string;
  readonly repoDigest: string;
  readonly diffDigest: string;
  readonly checkSetDigest: string;
  readonly status: 'accepted' | 'findings' | 'dismissed';
}

export interface CompletionPredicateInput {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly baseline: Baseline;
  readonly verificationResults: readonly VerificationResult[];
  readonly reviewResult: ReviewResult;
  readonly currentRepoDigest: string;
  readonly currentDiffDigest: string;
  readonly changedFiles: readonly string[];
  readonly originalProtectedTestsDigest: string;
  readonly currentProtectedTestsDigest: string;
  readonly trustedReviewRecord?: TrustedReviewRecord | undefined;
  readonly authorizedDiffDigest?: string | undefined;
  readonly trustedPatchRecord?: { readonly authorizedDiffDigest: string } | undefined;
}

export interface CompletionPredicateResult {
  readonly isComplete: boolean;
  readonly outcome: TaskOutcome;
  readonly delivery?: Delivery | undefined;
  readonly reasons: readonly string[];
}

export interface VerificationExecutionContext {
  readonly runId: string;
  readonly repoDigest: string;
  readonly diffDigest?: string | undefined;
  readonly actionIdPrefix?: string | undefined;
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly statePort?: StatePortV02 | undefined;
}
