/** UC-03 workflow dependencies and configuration. */
import type {
  ApprovalPort,
  Baseline,
  BugTask,
  ClaimReceiptV02,
  FixPlan,
  ModelPort,
  ModelPortV02,
  ProviderAdmissionContextV02,
  ProviderAdmissionTrustedContextV02,
  ProviderRequest,
  RepositoryAdmissionContextV02,
  RepositoryAdmissionTrustedContextV02,
  RepositoryPort,
  RepositoryPortV02,
  RepositoryExecutionReceiptV02,
  ReviewResult,
  SourceEvidence,
  StatePort,
  StatePortV02,
  StateTransitionOptions,
  TaskOutcome,
  TaskState,
  TelemetryPort,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import {
  validateBaseline,
  validateProviderRequest,
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  validateReviewResult,
  validateTaskState,
  validateVerificationResult,
} from '../contracts/foundation/uc03.ts';
import { GraphRecursionError } from '@langchain/langgraph';
import type { ExecutionGuardV02 } from '../foundation/execution-guard.ts';
import type { CoderAgent, CoderBudget, UC03CoderAdmission } from './agent.ts';
import type { MaterialReplanPortV02, UC03GraphGenerationV02 } from './graph-types-v02.ts';

export type { UC03CoderAdmission } from './agent.ts';
import type { BaselineEvidenceWriter, InvestigationConfigPort, TrustedHostExpectedContext, TrustedHostPort } from './investigation.ts';
import type { RepairPatchProposal, TrustedReplanDirection } from './repair.ts';
import type { FinalReport, Milestone } from './report.ts';
import type { EvaluationDiagnostic } from '../runtime/evaluation-diagnostics.ts';

export const UC03_GRAPH_RECURSION_LIMIT = 25;

export function graphRecursionLimit(requested?: number): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, UC03_GRAPH_RECURSION_LIMIT)
    : UC03_GRAPH_RECURSION_LIMIT;
}

export function isGraphRecursionError(error: unknown): boolean {
  return error instanceof GraphRecursionError;
}

export interface UC03GraphPorts {
  readonly statePort: StatePort | StatePortV02;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPort | RepositoryPortV02;
  readonly modelPort: ModelPort | ModelPortV02;
  readonly reviewerPort: UC03ReviewerPort;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly telemetryPort?: TelemetryPort | undefined;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly hostAuthority?: TrustedHostPort | undefined;
  readonly configPort?: InvestigationConfigPort | undefined;
  readonly replanPort?: MaterialReplanPortV02 | undefined;
}

/** v0.2 production types; additive, never widens the controlled surface above. */
export * from './graph-types-v02.ts';

/** Route callers must pass the owner-issued provider admission with the exact review request. */
export interface UC03ReviewerPort {
  readonly provenance: 'mock' | 'real';
  review(task: BugTask, diff: string, evidence: readonly SourceEvidence[], request: ProviderRequest, admission: ProviderAdmissionContextV02, claim?: ClaimReceiptV02): Promise<ReviewResult>;
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
  readonly mode?: 'development' | 'production' | 'controlled' | undefined;
  /** Lower the project-owned 25-step ceiling for controlled checks; larger values are clamped. */
  readonly recursionLimit?: number | undefined;
  readonly generation?: UC03GraphGeneration | undefined;
  readonly generationV02?: UC03GraphGenerationV02 | undefined;
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
  readonly diagnostic?: EvaluationDiagnostic | undefined;
  /** Host-only validated evidence; attached non-enumerably so CLI/report serialization omits it. */
  readonly executionEvidence?: UC03ExecutionEvidence | undefined;
}

export interface UC03ExecutionEvidence {
  readonly baseline?: Baseline | undefined;
  readonly verificationResults?: readonly VerificationResult[] | undefined;
  readonly reviewRequest?: ProviderRequest | undefined;
  readonly reviewResult?: ReviewResult | undefined;
  readonly patchAdmission?: UC03RepositoryAdmission | undefined;
  readonly patchReceipt?: RepositoryExecutionReceiptV02 | undefined;
  readonly finalState: TaskState | null;
}

function freezeProjection<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}

/** Keep grader input on the host-held result object, outside JSON reports and spread copies. */
export function attachUC03ExecutionEvidence(
  result: UC03WorkflowResult,
  raw: {
    readonly baseline?: unknown;
    readonly verificationResults?: unknown;
    readonly reviewRequest?: unknown;
    readonly reviewResult?: unknown;
    readonly patchAdmission?: UC03RepositoryAdmission | undefined;
    readonly patchReceipt?: unknown;
    readonly finalState?: unknown;
    readonly state?: unknown;
  },
): UC03WorkflowResult {
  const baseline = raw.baseline === undefined ? undefined : validateBaseline(raw.baseline);
  const verificationResults = Array.isArray(raw.verificationResults) ? raw.verificationResults.map(item => validateVerificationResult(item)) : undefined;
  const reviewRequest = raw.reviewRequest === undefined ? undefined : validateProviderRequest(raw.reviewRequest);
  const reviewResult = raw.reviewResult === undefined ? undefined : validateReviewResult(raw.reviewResult);
  const patchAdmission = raw.patchAdmission
    ? validateRepositoryAdmissionV02(raw.patchAdmission.context, raw.patchAdmission.trustedContext)
    : undefined;
  const patchReceipt = raw.patchReceipt === undefined || !patchAdmission?.ok
    ? undefined
    : validateRepositoryExecutionReceiptV02(raw.patchReceipt, patchAdmission.value);
  const candidateState = raw.finalState === undefined ? raw.state : raw.finalState;
  const finalState = candidateState === undefined || candidateState === null ? undefined : validateTaskState(candidateState);
  const evidence = freezeProjection({
    ...(baseline?.ok ? { baseline: baseline.value } : {}),
    ...(verificationResults?.every(item => item.ok) ? { verificationResults: verificationResults.map(item => item.value) } : {}),
    ...(reviewRequest?.ok ? { reviewRequest: reviewRequest.value } : {}),
    ...(reviewResult?.ok ? { reviewResult: reviewResult.value } : {}),
    ...(patchAdmission?.ok && raw.patchAdmission ? {
      patchAdmission: { context: patchAdmission.value, trustedContext: structuredClone(raw.patchAdmission.trustedContext) },
    } : {}),
    ...(patchReceipt?.ok ? { patchReceipt: patchReceipt.value } : {}),
    finalState: finalState?.ok ? finalState.value : null,
  });
  Object.defineProperty(result, 'executionEvidence', { value: evidence, enumerable: false, writable: false, configurable: false });
  return result;
}
