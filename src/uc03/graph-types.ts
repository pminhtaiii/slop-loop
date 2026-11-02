/** UC-03 workflow dependencies and configuration. */
import type {
  ApprovalPort,
  BugTask,
  ClaimReceiptV02,
  FixPlan,
  ModelPort,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  ProviderRequest,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
  RepositoryPort,
  ReviewResult,
  SourceEvidence,
  StatePort,
  StateTransitionOptions,
  TaskOutcome,
  TaskState,
  TelemetryPort,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardV02 } from '../foundation/execution-guard.ts';
import type { CoderAgent, CoderBudget } from './agent.ts';
import type { BaselineEvidenceWriter, InvestigationConfigPort, TrustedHostExpectedContext, TrustedHostPort } from './investigation.ts';
import type { RepairPatchProposal, TrustedReplanDirection } from './repair.ts';
import type { FinalReport, Milestone } from './report.ts';

export interface UC03GraphPorts {
  readonly statePort: StatePort;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPort;
  readonly modelPort: ModelPort;
  readonly reviewerPort: UC03ReviewerPort;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly telemetryPort?: TelemetryPort | undefined;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly hostAuthority?: TrustedHostPort | undefined;
  readonly configPort?: InvestigationConfigPort | undefined;
}

/** Route callers must pass the owner-issued provider admission with the exact review request. */
export interface UC03ReviewerPort {
  readonly provenance: 'mock' | 'real';
  review(task: BugTask, diff: string, evidence: readonly SourceEvidence[], request: ProviderRequest, admission: ProviderAdmissionContextV02, claim: ClaimReceiptV02): Promise<ReviewResult>;
}

export interface UC03ReviewerAdmission {
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly trustedContext: ProviderAdmissionTrustedContextV02;
}

export interface UC03ReviewerAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
}

export interface UC03PatchAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly patchContent: string;
  readonly targetPaths: readonly string[];
  readonly actionId?: string | undefined;
  readonly failureEvidence?: readonly (VerificationResult | ReviewResult)[] | undefined;
}

export interface UC03RepositoryAdmission {
  readonly context: RepositoryAdmissionContextV02;
  readonly trustedContext: RepositoryAdmissionTrustedContextV02;
}

export interface UC03CoderAdmission {
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly trustedContext: ProviderAdmissionTrustedContextV02;
}

export interface UC03CoderAdmissionRequest {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly purpose: 'propose-plan' | 'propose-patch' | 'propose-repair' | 'propose-replan';
  readonly evidence: readonly SourceEvidence[];
}

export type UC03CoderAdmissionResolver = (request: UC03CoderAdmissionRequest) => Promise<UC03CoderAdmission | undefined> | UC03CoderAdmission | undefined;

export type UC03ReviewerAdmissionResolver = (request: UC03ReviewerAdmissionRequest) => Promise<UC03ReviewerAdmission | undefined> | UC03ReviewerAdmission | undefined;

export type UC03PatchAdmissionResolver = (request: UC03PatchAdmissionRequest) => Promise<UC03RepositoryAdmission | undefined> | UC03RepositoryAdmission | undefined;

/**
 * Opt-in model generation for the real profile. Deliberately not a port: `CoderAgent` is host
 * wiring, and each call needs an owner-issued coder admission (`coderAdmission`).
 */
export interface UC03GraphGeneration {
  readonly agent: CoderAgent;
  readonly budget?: CoderBudget | undefined;
}

export interface UC03GraphConfig {
  readonly mode?: 'development' | 'production' | undefined;
  readonly generation?: UC03GraphGeneration | undefined;
  readonly trustedExpectedContext?: TrustedHostExpectedContext | undefined;
  readonly trustedDirection?: TrustedReplanDirection | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly admissionContext?: UC03RepositoryAdmission | UC03PatchAdmissionResolver | undefined;
  readonly reviewerAdmission?: UC03ReviewerAdmission | UC03ReviewerAdmissionResolver | undefined;
  readonly coderAdmission?: UC03CoderAdmission | UC03CoderAdmissionResolver | undefined;
  readonly patchContent?: string | undefined;
  readonly targetPaths?: readonly string[] | undefined;
  readonly repairPatch?: RepairPatchProposal | undefined;
  readonly revisedPlan?: FixPlan | undefined;
  readonly planDetails?:
    | {
        readonly diagnosis: string;
        readonly strategy: string;
        readonly suspectedCauseLocations: readonly string[];
        readonly scopedChanges: readonly string[];
      }
    | undefined;
}

export interface UC03WorkflowResult {
  readonly outcome: TaskOutcome | 'pending-approval' | 'needs-info';
  readonly state: TaskState | null;
  readonly finalReport?: FinalReport | undefined;
  readonly reasons: readonly string[];
  readonly milestones: readonly Milestone[];
}
