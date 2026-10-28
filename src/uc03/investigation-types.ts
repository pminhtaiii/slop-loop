import type {
  ApprovalBinding,
  ApprovalPort,
  Baseline,
  BugTask,
  CheckDefinition,
  ExecutionGuardV02,
  FixPlan,
  ModelPort,
  RepositoryAdmissionContextV02,
  RepositoryPort,
  StatePort,
  StatePortV02,
  TaskState,
} from '../contracts/foundation/uc03.ts';

export interface TrustedTestFileSnapshot {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface TrustedHostSnapshotRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedRevisionDigest: string;
  readonly expectedCriteriaDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedTestFiles: readonly string[];
}

/**
 * Host composition supplies facts it measured or derived from canonical
 * repository state, trusted check configuration, and the complete test
 * inventory. The consumer trusts this input boundary; T013 does not implement
 * or prove production measurement.
 */
export interface TrustedHostExpectedContext {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly revisionDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly expectedTestFiles: readonly string[];
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
  /** Resolves current owner-issued policy and journal authority for the exact check action. */
  readonly admissionContextForCheck?: (request: {
    readonly check: CheckDefinition;
    readonly action: RepositoryAdmissionContextV02['action'];
    readonly currentState: TaskState;
  }) => Promise<RepositoryAdmissionContextV02 | undefined> | RepositoryAdmissionContextV02 | undefined;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly statePort?: StatePortV02 | undefined;
}

/** Snapshot claims from the producer; each binding is checked against injected admission facts. */
export interface TrustedHostSnapshot {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly currentRevision: string;
  readonly checkSetDigest: string;
  readonly testFiles: readonly TrustedTestFileSnapshot[];
  readonly expectedTestFiles: readonly string[];
}

export interface TrustedHostPort {
  /** Returns producer claims; it cannot set admission facts or provide durable baseline/CAS guarantees. */
  loadSnapshot(
    request: TrustedHostSnapshotRequest
  ): Promise<TrustedHostSnapshot> | TrustedHostSnapshot;
}

export type TrustedInvestigationHostAuthority = TrustedHostPort;

export type BaselineStatus =
  | 'reproduced'
  | 'non-reproducing'
  | 'collection-error'
  | 'error';

export interface BaselineEvidenceCandidate extends Omit<Baseline, 'evidenceId'> {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly criteriaDigest: string;
  readonly requiredChecks: BugTask['requiredChecks'];
  readonly expectedPassingCheckIds: readonly string[];
  readonly reproductionCheckId: string;
  readonly expectedTestFiles: readonly string[];
}

export interface BaselineEvidenceWriteRequest {
  readonly content: BaselineEvidenceCandidate;
  readonly contentDigest: string;
}

export interface BaselineEvidenceAcknowledgement {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly contentDigest: string;
  readonly repositorySnapshotDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly testProtectionDigest: string;
  readonly reproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
  readonly expectedTestFiles: readonly string[];
  readonly requiredCheckIds: readonly string[];
}

/** Local UC-04 consumer contract; the host adapter owns durable storage and evidence identity. */
export interface BaselineEvidenceWriter {
  persistBaselineEvidence(
    request: BaselineEvidenceWriteRequest
  ): Promise<BaselineEvidenceAcknowledgement>;
  /** Optional owner lookup used to restore TaskState-only graph continuations. */
  loadBaselineEvidence?(
    taskId: string,
    workspaceId: string,
    repositoryId: string,
    evidenceId: string,
  ): Promise<{ readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement } | null>;
}

export interface BaselineInvestigationResult {
  readonly status: BaselineStatus;
  readonly baseline?: BaselineEvidenceCandidate | undefined;
  readonly reproductionSignature?: string | undefined;
  readonly reason?: string | undefined;
}

export type PlanApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface PlanPreparationResult {
  readonly outcome: PlanApprovalStatus;
  readonly plan?: FixPlan | undefined;
  readonly binding?: ApprovalBinding | undefined;
  readonly state?: TaskState | undefined;
  readonly reason?: string | undefined;
}

export interface InvestigationConfigPort {
  readonly provenance?: string | undefined;
  loadConfig?(
    taskId: string
  ):
    | Promise<{ readonly configId?: string; readonly configVersion?: string } | null>
    | { readonly configId?: string; readonly configVersion?: string }
    | null;
}

export interface InvestigationPorts {
  readonly repository: RepositoryPort;
  readonly state: StatePort;
  readonly approval: ApprovalPort;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly model?: ModelPort | undefined;
  readonly host?: TrustedHostPort | undefined;
  readonly config?: InvestigationConfigPort | undefined;
}
