import type { RealExecutionAdmission } from '../shared-types.ts';

export const UC03_CONTRACT_VERSION = '0.1.0';
export const WORKFLOW_EVALUATION_VERSION = 'uc03-workflow-evaluation/1';
export const C17_NOT_RUN_LIMITATION = 'C17 private grading was not run; no isolation evidence is established.';

export const EVALUATION_CASE_IDS = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17'] as const;

export type EvaluationCaseId = (typeof EVALUATION_CASE_IDS)[number];
export type EvaluationOutcome = 'COMPLETED' | 'INCOMPLETE' | 'IMPLEMENTED_UNVERIFIED' | 'FAILED';
export type EvaluationMode = 'mock' | 'real';
export type CaseStatus = 'pass' | 'fail' | 'error' | 'not-run';
export type ActualOutcome = EvaluationOutcome | 'NOT_RUN' | 'REFUSED_BEFORE_DISPATCH' | 'DRIVER_ERROR' | 'DRIVER_RESULT_INVALID';

export interface EvaluationCaseSpec {
  readonly caseId: EvaluationCaseId;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly required: true;
  readonly expectedOutcome: EvaluationOutcome;
  readonly requirements: readonly string[];
  readonly hiddenGraderId?: string | undefined;
}

export interface EvaluationManifest {
  readonly suite: 'uc03';
  readonly version: string;
  readonly description: string;
  readonly cases: readonly EvaluationCaseSpec[];
}

export interface CaseTiming {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

export interface CaseUsage {
  readonly tokensConsumed: number;
  readonly costUsd: number;
  readonly replanCount?: number | undefined;
  readonly repairAttempts?: number | undefined;
  readonly reviewIterations?: number | undefined;
}

export interface CaseDigests {
  readonly manifestDigest: string;
  readonly configDigest?: string | undefined;
  readonly repositoryDigest?: string | undefined;
  readonly diffDigest?: string | undefined;
  readonly evidenceDigest?: string | undefined;
}

export interface CaseResult {
  readonly caseId: EvaluationCaseId;
  readonly useCase: 'UC-03';
  readonly contractVersion: string;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly mode: EvaluationMode;
  readonly status: CaseStatus;
  readonly expectedOutcome: EvaluationOutcome;
  readonly actualOutcome: ActualOutcome;
  readonly timing: CaseTiming;
  readonly usage: CaseUsage;
  readonly digests: CaseDigests;
  readonly denialReason?: string | undefined;
  readonly sideEffectObserved: boolean | null;
  readonly limitations: readonly string[];
}

export interface EvaluationSummary {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly errorCases: number;
  readonly notRunCases: number;
  readonly requiredFailuresOrNotRun: number;
  readonly successRate: number;
  readonly expectedDenialRate: number;
  readonly replanCountsTotal: number;
  readonly repairIterationsTotal: number;
  readonly reviewIterationsTotal: number;
  readonly totalDurationMs: number;
  readonly totalTokensConsumed: number;
  readonly totalCostUsd: number;
}

export interface EvaluationReport {
  readonly suite: 'uc03';
  readonly contractVersion: string;
  readonly mode: EvaluationMode;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly timestamp: string;
  readonly isRealVerified: false;
  readonly verdict: 'PASS' | 'FAIL' | 'REFUSED';
  readonly exitCode: 0 | 1;
  readonly summary: EvaluationSummary;
  readonly cases: readonly CaseResult[];
  readonly limitations: readonly string[];
}

export interface EvaluationGradingBounds {
  readonly timeoutMs: number;
  readonly maxCpuMs: number;
  readonly maxOutputBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxProcesses: number;
}

export interface EvaluationSnapshotIdentity {
  readonly snapshotId: string;
  readonly digest: string;
}

export interface EvaluationGradingProfile {
  readonly profileId: string;
  readonly digest: string;
  readonly bounds: EvaluationGradingBounds;
}

export interface EvaluationGradingAdmissionRequest {
  readonly finalSnapshot: EvaluationSnapshotIdentity;
  readonly profile: EvaluationGradingProfile;
  readonly executorId: string;
}

export interface EvaluationGradingAdmission extends EvaluationGradingAdmissionRequest {
  readonly kind: 'injected-mock-isolation-admission';
  readonly admissionId: string;
}

export interface EvaluationGraderExecutionRequest extends EvaluationGradingAdmissionRequest {
  readonly admission: EvaluationGradingAdmission;
  readonly executor: EvaluationGraderExecutor;
  readonly graderPayload: unknown;
}

export interface EvaluationGraderExecutor {
  readonly executorId: string;
  execute(request: EvaluationGraderExecutionRequest): unknown | Promise<unknown>;
}

export interface EvaluationIsolationAuthority {
  admit(request: EvaluationGradingAdmissionRequest): unknown | Promise<unknown>;
}

export interface MockPrivateGradingBoundary {
  readonly finalSnapshot: EvaluationSnapshotIdentity;
  readonly profile: EvaluationGradingProfile;
  readonly graderPayload: unknown;
  readonly isolationAuthority: EvaluationIsolationAuthority;
  readonly executor: EvaluationGraderExecutor;
}

export interface SafeEvaluationGradingResult {
  readonly finalSnapshot: EvaluationSnapshotIdentity;
  readonly profile: EvaluationGradingProfile;
  readonly executorId: string;
  readonly status: 'pass' | 'fail';
  readonly actualOutcome: EvaluationOutcome;
  readonly durationMs: number;
  readonly outputBytes: number;
}

export interface EvaluationDriverContext extends EvaluationCaseContext {
  readonly suite: 'uc03';
}

export interface RunEvaluationOptions {
  readonly contractVersion?: undefined;
  readonly suite?: string | undefined;
  readonly mode: EvaluationMode;
  readonly manifestPath?: string | undefined;
  readonly configPath?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly cases?: readonly string[] | undefined;
  readonly driver?: EvaluationDriver | undefined;
  readonly mockPrivateGrading?: unknown;
  readonly customSecretPatterns?: readonly string[] | undefined;
}

export interface EvaluationDriver {
  executeCase(spec: EvaluationCaseSpec, context: EvaluationDriverContext): unknown | Promise<unknown>;
}

export interface EvaluationCaseContext {
  readonly spec: EvaluationCaseSpec;
  readonly mode: EvaluationMode;
  readonly manifestDigest: string;
  readonly configDigest: string;
}

/** Nonterminal workflow observations; a paused product task can satisfy a case predicate without a repair. */
export type WorkflowLifecycle = 'waiting-approval' | 'waiting-info' | 'not-observed' | EvaluationOutcome;
export type WorkflowEffects = 'none' | 'observed' | 'uncertain';
export type WorkflowUsage = 'observed' | 'uncertain' | 'unavailable';
export type WorkflowTier = 'controlled' | 'real-integration';
export type WorkflowGrade = 'pass' | 'fail' | 'not-run';
export type WorkflowWait = 'waiting-approval' | 'waiting-info';
export type WorkflowBlock = 'prerequisite-unavailable' | 'busy' | 'reconciliation-required';
export type WorkflowReason =
  | 'criteria-satisfied'
  | 'expected-wait-satisfied'
  | 'criteria-violation'
  | 'unresolved-wait'
  | 'unpinned-criteria'
  | 'real-execution-unavailable'
  | 'driver-unavailable'
  | 'invalid-observation'
  | 'not-selected'
  | 'private-grading'
  | WorkflowBlock;

export interface WorkflowCaseContext {
  readonly spec: EvaluationCaseSpec;
  readonly mode: EvaluationMode;
  readonly tier: WorkflowTier;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly profileDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
}

/** Host-held observation for one case. Absent facts are explicit nulls; effects and usage are never inferred from a failure. */
export interface WorkflowObservation {
  readonly repositoryId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly returnedModel: string | null;
  readonly graderDigest: string | null;
  readonly workflowOutcome: WorkflowLifecycle;
  readonly expectedWait: WorkflowWait | null;
  readonly blocked: WorkflowBlock | null;
  readonly effects: WorkflowEffects;
  readonly usage: WorkflowUsage;
  readonly diagnostic: string | null;
  readonly artifacts: readonly string[];
  readonly limitations: readonly string[];
}

/** Run-level binding copied onto every case; never taken from a driver observation. */
export interface WorkflowBinding {
  readonly tier: WorkflowTier;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
}

/** Host-held workflow observation. Ports, credentials and grader payloads never cross this boundary. */
export interface WorkflowDriver {
  executeCase(spec: EvaluationCaseSpec, context: WorkflowCaseContext): unknown | Promise<unknown>;
}

export interface WorkflowCaseResult {
  readonly caseId: EvaluationCaseId;
  readonly repositoryId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly graderDigest: string | null;
  readonly workflowOutcome: WorkflowLifecycle;
  readonly tier: WorkflowTier;
  readonly grade: WorkflowGrade;
  readonly gradeReason: WorkflowReason;
  readonly effects: WorkflowEffects;
  readonly usage: WorkflowUsage;
  readonly diagnostic: string | null;
  readonly artifacts: readonly string[];
  readonly limitations: readonly string[];
}

export interface WorkflowSelectionResult {
  readonly selected: readonly EvaluationCaseId[];
  readonly passed: number;
  readonly failed: number;
  readonly incomplete: number;
  readonly pendingWaits: readonly EvaluationCaseId[];
  readonly outcome: 'pass' | 'fail' | 'incomplete';
}

export interface WorkflowSuiteAcceptance {
  readonly scope: 'catalog' | 'exploratory';
  readonly requiredCases: number;
  readonly satisfiedCases: number;
  readonly outcome: 'pass' | 'fail' | 'incomplete' | 'not-applicable';
}

export interface WorkflowEvaluationReport {
  readonly suite: 'uc03';
  readonly contractVersion: typeof WORKFLOW_EVALUATION_VERSION;
  readonly mode: EvaluationMode;
  readonly tier: WorkflowTier;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly timestamp: string;
  readonly isRealVerified: false;
  readonly selectionResult: WorkflowSelectionResult;
  readonly suiteAcceptance: WorkflowSuiteAcceptance;
  readonly exitCode: 0 | 1 | 2 | 3 | 4;
  readonly cases: readonly WorkflowCaseResult[];
  readonly limitations: readonly string[];
}

export interface WorkflowEvaluationOptions {
  readonly contractVersion: typeof WORKFLOW_EVALUATION_VERSION;
  readonly suite?: 'uc03' | undefined;
  readonly mode: EvaluationMode;
  readonly scope?: 'catalog' | 'exploratory' | undefined;
  readonly cases?: readonly string[] | undefined;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
  /** Only an internally issued capability admits the real tier; a caller-supplied value is denied before dispatch. */
  readonly realAdmission?: RealExecutionAdmission | undefined;
  readonly driver?: WorkflowDriver | undefined;
  readonly timestamp?: string | undefined;
}
