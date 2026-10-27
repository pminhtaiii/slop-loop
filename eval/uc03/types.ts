export const UC03_CONTRACT_VERSION = '0.1.0';
export const C17_NOT_RUN_LIMITATION = 'C17 private grading was not run; no isolation evidence is established.';

export const EVALUATION_CASE_IDS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09',
  'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
] as const;

export type EvaluationCaseId = typeof EVALUATION_CASE_IDS[number];
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
