import { createHash } from 'node:crypto';
/**
 * UC-03 Verified Code Repair - Canonical v0.1 Contracts and Runtime Validators
 *
 * Owned path: src/contracts/uc03.ts
 * Feature: specs/001-verified-code-repair
 */

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
  constructor(
    message: string,
    readonly details?: { scope?: string; kind?: string; limit?: number; requested?: number }
  ) {
    super(message);
    this.name = 'BudgetExhaustionError';
  }
}

export class BudgetConflictError extends Error {
  readonly code = 'BUDGET_CONFLICT' as const;
  constructor(
    message: string,
    readonly details?: { scope?: string; kind?: string; version?: number }
  ) {
    super(message);
    this.name = 'BudgetConflictError';
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


export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
    }
  }
  return `{${entries.join(',')}}`;
}

export function computeCanonicalSha256(val: unknown): string {
  const json = canonicalJsonStringify(val);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function computeActionDigest(action: NormalizedAction): string {
  return computeCanonicalSha256(action);
}

export function computeCommandViewDigest(view: Omit<CommandView, 'viewDigest'> | CommandView): string {
  const rest = { ...(view as Record<string, unknown>) };
  delete rest['viewDigest'];
  return computeCanonicalSha256(rest);
}

export function isCanonicalRelativePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (filePath.includes('\0')) return false;
  if (filePath.includes('\\')) return false;
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) return false;
  if (filePath.startsWith('./') || filePath === '.') return false;
  if (filePath.startsWith('../') || filePath === '..') return false;
  if (filePath.endsWith('/')) return false;
  if (filePath.endsWith('/..') || filePath.endsWith('/.')) return false;
  if (filePath.includes('//') || filePath.includes('/./') || filePath.includes('/../')) return false;
  return true;
}

export function normalizeLexicalPath(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.includes('\0')) return null;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;

  const segments = normalized.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

/* ------------------------------------------------------------------
 * Port Signatures
 * ------------------------------------------------------------------ */

export interface ModelProposal {
  readonly proposalId: string;
  readonly content: string;
  readonly actions?: readonly NormalizedAction[] | undefined;
}

export interface ModelResult {
  readonly proposal: ModelProposal;
  readonly observedUsage: ProviderUsage;
}

export type ModelPortOutcome = 'observed' | 'uncertain' | 'denied' | 'invalid';

export interface ModelPortObserved {
  readonly outcome: 'observed';
  readonly result: ModelResult;
}

export interface ModelPortUncertain {
  readonly outcome: 'uncertain';
  readonly reason: string;
  readonly observedUsage?: ProviderUsage | undefined;
}

export interface ModelPortDenied {
  readonly outcome: 'denied';
  readonly reason: string;
}

export interface ModelPortInvalid {
  readonly outcome: 'invalid';
  readonly errors: readonly ValidationError[];
  readonly observedUsage?: ProviderUsage | undefined;
}

export type ModelPortResult =
  | ModelPortObserved
  | ModelPortUncertain
  | ModelPortDenied
  | ModelPortInvalid;

export interface ModelPort {
  propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ModelPortResult>;
}

export interface RepositoryPort {
  listDir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<SourceEvidence>;
  searchCode(query: string): Promise<readonly SourceEvidence[]>;
  applyPatch(patch: ApplyPatchAction): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>;
  runCommand(action: RunCommandAction): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  runTests(check: CheckDefinition): Promise<CheckResult>;
  inspectDiff(baseRevisionDigest: string): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }>;
}

export interface ExecutionGuard {
  validateAndExecute(
    action: NormalizedAction,
    state: TaskState
  ): Promise<{ readonly outcome: EnvelopeOutcome; readonly result?: unknown }>;
}

export interface StatePort {
  loadTask(taskId: string): Promise<TaskState | null>;
  transition(state: TaskState, expectedVersion: number): Promise<TaskState>;
  reserve(scope: 'task' | 'run', kind: string, amount: number, actionId: string): Promise<string>;
  reserveMany(
    reservations: readonly {
      readonly scope: 'task' | 'run';
      readonly kind: string;
      readonly amount: number;
    }[],
    requestId: string,
    transactionRef?: string
  ): Promise<ReservationBundle>;
  settle(actionId: string, observed: ProviderUsage): Promise<void>;
  reconcileUncertain(
    requestId: string,
    reconciliation: {
      readonly observedUsage?: ProviderUsage | undefined;
      readonly reason: string;
    }
  ): Promise<void>;
  checkpoint(state: TaskState): Promise<void>;
  recover(taskId: string): Promise<TaskState>;
}

export interface ApprovalPort {
  classify(action: NormalizedAction): Promise<PermissionClass>;
  requestDecision(binding: ApprovalBinding): Promise<ApprovalBinding>;
  validateBinding(binding: ApprovalBinding): Promise<boolean>;
  resolve(decisionId: string): Promise<ApprovalBinding>;
}

export interface ReviewerPort {
  review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ReviewResult>;
}

export interface TelemetryPort {
  emitActivity(event: ActivityEvent): Promise<void>;
  recordUsage(taskId: string, runId: string, usage: ProviderUsage): Promise<void>;
}

/* ------------------------------------------------------------------
 * Validation Helpers
 * ------------------------------------------------------------------ */

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  errors: ValidationError[]
): void {
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      errors.push({
        path: path ? `${path}.${key}` : key,
        message: `Unknown property: ${key}`,
        code: 'UNKNOWN_PROPERTY',
      });
    }
  }
}

function validateNonEmptyString(
  val: unknown,
  path: string,
  errors: ValidationError[]
): string | undefined {
  if (typeof val !== 'string') {
    errors.push({
      path,
      message: `${path} must be a string`,
      code: 'INVALID_TYPE',
    });
    return undefined;
  }
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    errors.push({
      path,
      message: `${path} must be a non-empty string`,
      code: 'EMPTY_STRING',
    });
    return undefined;
  }
  return trimmed;
}

function validatePositiveInteger(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isSafeInteger(val) || val <= 0) {
    errors.push({
      path,
      message: `${path} must be a finite positive integer`,
      code: 'INVALID_POSITIVE_INTEGER',
    });
    return undefined;
  }
  return val;
}

function validatePositiveNumber(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    errors.push({
      path,
      message: `${path} must be a finite positive number`,
      code: 'INVALID_POSITIVE_NUMBER',
    });
    return undefined;
  }
  return val;
}

function validateNonNegativeInteger(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isSafeInteger(val) || val < 0) {
    errors.push({
      path,
      message: `${path} must be a finite non-negative integer`,
      code: 'INVALID_NON_NEGATIVE_INTEGER',
    });
    return undefined;
  }
  return val;
}

function validateNonNegativeNumber(
  val: unknown,
  path: string,
  errors: ValidationError[]
): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    errors.push({
      path,
      message: `${path} must be a finite non-negative number`,
      code: 'INVALID_NON_NEGATIVE_NUMBER',
    });
    return undefined;
  }
  return val;
}


export function isProtectedPath(filePath: string): boolean {
  const lex = normalizeLexicalPath(filePath);
  const target = (lex ?? filePath.replace(/\\/g, '/')).toLowerCase();
  const segments = target.split('/');
  const baseName = segments[segments.length - 1] ?? target;

  // .env files
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return true;
  }
  // SSH keys & private keys / certificates
  if (
    baseName === 'id_rsa' ||
    baseName === 'id_ed25519' ||
    baseName === 'id_dsa' ||
    baseName === 'id_ecdsa' ||
    baseName.endsWith('.pem') ||
    baseName.endsWith('.key') ||
    baseName.endsWith('.pkcs12') ||
    baseName.endsWith('.pfx')
  ) {
    return true;
  }
  // Credentials & secret configurations
  if (
    baseName === 'credentials.json' ||
    baseName === 'secrets.json' ||
    baseName.startsWith('password') ||
    baseName.startsWith('token')
  ) {
    return true;
  }
  // Git metadata
  if (segments.includes('.git') || target.startsWith('.git/') || target === '.git') {
    return true;
  }
  // Agent files (.agents, .codex, AGENTS.md, CLAUDE.md)
  if (segments.includes('.agents') || target.startsWith('.agents/') || target === '.agents') {
    return true;
  }
  if (segments.includes('.codex') || target.startsWith('.codex/') || target === '.codex') {
    return true;
  }
  if (baseName === 'agents.md' || baseName === 'claude.md') {
    return true;
  }
  // Hidden evaluation / grading
  if (
    target.startsWith('eval/uc03/private/') ||
    target.includes('private/grading') ||
    target.includes('/private/') ||
    target.startsWith('private/')
  ) {
    return true;
  }
  return false;
}


const EXECUTION_LIMITS_ALLOWED_KEYS = [
  'timeoutMs',
  'maxOutputBytes',
  'maxCpuCores',
  'maxMemoryBytes',
  'maxPids',
] as const;

const BUDGET_LIMITS_ALLOWED_KEYS = [
  'maxReplanCount',
  'maxTokens',
  'maxCostUsd',
  'maxRepairAttempts',
  'maxReviewIterations',
] as const;

const CHECK_DEFINITION_ALLOWED_KEYS = [
  'checkId',
  'executable',
  'argv',
  'purpose',
  'workingDirectory',
  'timeoutMs',
  'maxOutputBytes',
] as const;

const BUG_TASK_ALLOWED_KEYS = [
  'taskId',
  'repositoryId',
  'initialRevisionDigest',
  'goal',
  'observedBehavior',
  'expectedBehavior',
  'reproduction',
  'acceptanceCriteria',
  'constraints',
  'requiredChecks',
  'limits',
  'budgetLimits',
  'configId',
  'configVersion',
] as const;

const RUN_COMMAND_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'executable',
  'argv',
  'workingDirectory',
  'purpose',
] as const;

const APPLY_PATCH_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'patchContent',
  'targetPaths',
  'baseRevisionDigest',
] as const;

const APPROVE_FIX_PLAN_ACTION_ALLOWED_KEYS = [
  'actionId',
  'kind',
  'planVersion',
  'strategyDigest',
  'diagnosisEvidenceRefs',
  'checkSetDigest',
] as const;

const APPROVAL_BINDING_ACTION_ALLOWED_KEYS = [
  'decisionId',
  'actionKind',
  'normalizedActionDigest',
  'taskId',
  'workspaceId',
  'repositoryRevisionDigest',
  'policyId',
  'policyVersion',
  'status',
  'reason',
] as const;

const APPROVAL_BINDING_FIX_PLAN_ALLOWED_KEYS = [
  'decisionId',
  'actionKind',
  'normalizedActionDigest',
  'taskId',
  'workspaceId',
  'repositoryRevisionDigest',
  'policyId',
  'policyVersion',
  'planVersion',
  'strategyDigest',
  'baselineRef',
  'evidenceRefs',
  'criteriaDigest',
  'checkSetDigest',
  'status',
  'reason',
] as const;

const COMMAND_VIEW_ALLOWED_KEYS = [
  'viewId',
  'viewDigest',
  'taskId',
  'workspaceId',
  'canonicalRevisionDigest',
  'admittedFiles',
  'exclusionsPolicyVersion',
  'scratchIdentity',
  'mountedReadOnly',
] as const;

const ADMITTED_FILE_ALLOWED_KEYS = ['path', 'digest'] as const;

/* ------------------------------------------------------------------
 * Validators
 * ------------------------------------------------------------------ */

export function validateExecutionLimits(input: unknown): ValidationResult<ExecutionLimits> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'limits', message: 'limits must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, EXECUTION_LIMITS_ALLOWED_KEYS, 'limits', errors);

  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'limits.timeoutMs', errors);
  const maxOutputBytes = validatePositiveInteger(input['maxOutputBytes'], 'limits.maxOutputBytes', errors);
  const maxCpuCores = validatePositiveNumber(input['maxCpuCores'], 'limits.maxCpuCores', errors);
  const maxMemoryBytes = validatePositiveInteger(input['maxMemoryBytes'], 'limits.maxMemoryBytes', errors);
  const maxPids = validatePositiveInteger(input['maxPids'], 'limits.maxPids', errors);

  if (
    errors.length > 0 ||
    timeoutMs === undefined ||
    maxOutputBytes === undefined ||
    maxCpuCores === undefined ||
    maxMemoryBytes === undefined ||
    maxPids === undefined
  ) {
    return { ok: false, errors };
  }

  const result: ExecutionLimits = {
    timeoutMs,
    maxOutputBytes,
    maxCpuCores,
    maxMemoryBytes,
    maxPids,
  };

  return { ok: true, value: result };
}

export function validateBudgetLimits(input: unknown): ValidationResult<BudgetLimits> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'budgetLimits', message: 'budgetLimits must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUDGET_LIMITS_ALLOWED_KEYS, 'budgetLimits', errors);

  const replan = validateNonNegativeInteger(input['maxReplanCount'], 'budgetLimits.maxReplanCount', errors);
  if (replan !== undefined && replan > 3) {
    errors.push({
      path: 'budgetLimits.maxReplanCount',
      message: 'maxReplanCount cannot exceed 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  const maxTokens = validateNonNegativeInteger(input['maxTokens'], 'budgetLimits.maxTokens', errors);
  const maxCostUsd = validateNonNegativeNumber(input['maxCostUsd'], 'budgetLimits.maxCostUsd', errors);
  const maxRepairAttempts = validateNonNegativeInteger(input['maxRepairAttempts'], 'budgetLimits.maxRepairAttempts', errors);
  const maxReviewIterations = validateNonNegativeInteger(input['maxReviewIterations'], 'budgetLimits.maxReviewIterations', errors);

  if (
    errors.length > 0 ||
    replan === undefined ||
    replan > 3 ||
    maxTokens === undefined ||
    maxCostUsd === undefined ||
    maxRepairAttempts === undefined ||
    maxReviewIterations === undefined
  ) {
    return { ok: false, errors };
  }

  const result: BudgetLimits = {
    maxReplanCount: replan,
    maxTokens,
    maxCostUsd,
    maxRepairAttempts,
    maxReviewIterations,
  };

  return { ok: true, value: result };
}

export function validateCheckDefinition(
  input: unknown,
  path: string,
  errors: ValidationError[]
): CheckDefinition | undefined {
  if (!isPlainObject(input)) {
    errors.push({
      path,
      message: `${path} must be an object`,
      code: 'INVALID_TYPE',
    });
    return undefined;
  }

  const initialErrorsCount = errors.length;
  rejectUnknownKeys(input, CHECK_DEFINITION_ALLOWED_KEYS, path, errors);

  const checkId = validateNonEmptyString(input['checkId'], `${path}.checkId`, errors);
  const executable = validateNonEmptyString(input['executable'], `${path}.executable`, errors);

  let argvValid = false;
  if (!Array.isArray(input['argv'])) {
    errors.push({
      path: `${path}.argv`,
      message: `${path}.argv must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    let allStrings = true;
    for (let i = 0; i < input['argv'].length; i++) {
      if (typeof input['argv'][i] !== 'string') {
        allStrings = false;
        errors.push({
          path: `${path}.argv[${i}]`,
          message: `${path}.argv[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
    if (allStrings) argvValid = true;
  }

  const validPurposes: readonly CheckPurpose[] = [
    'reproduction',
    'focused',
    'regression',
    'compatibility',
    'diff',
  ];
  const purpose = input['purpose'] as CheckPurpose;
  if (!validPurposes.includes(purpose)) {
    errors.push({
      path: `${path}.purpose`,
      message: `${path}.purpose must be one of: ${validPurposes.join(', ')}`,
      code: 'INVALID_PURPOSE',
    });
  }

  let workingDirectory: string | undefined;
  if (input['workingDirectory'] !== undefined) {
    workingDirectory = validateNonEmptyString(input['workingDirectory'], `${path}.workingDirectory`, errors);
  }

  let timeoutMs: number | undefined;
  if (input['timeoutMs'] !== undefined) {
    timeoutMs = validatePositiveInteger(input['timeoutMs'], `${path}.timeoutMs`, errors);
  }

  let maxOutputBytes: number | undefined;
  if (input['maxOutputBytes'] !== undefined) {
    maxOutputBytes = validatePositiveInteger(input['maxOutputBytes'], `${path}.maxOutputBytes`, errors);
  }

  if (
    errors.length > initialErrorsCount ||
    !checkId ||
    !executable ||
    !argvValid ||
    !validPurposes.includes(purpose)
  ) {
    return undefined;
  }

  return {
    checkId,
    executable,
    argv: input['argv'] as readonly string[],
    purpose,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  };
}

export function validateBugTask(input: unknown): ValidationResult<BugTask> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'bugTask', message: 'BugTask must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUG_TASK_ALLOWED_KEYS, 'bugTask', errors);

  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const repositoryId = validateNonEmptyString(input['repositoryId'], 'repositoryId', errors);
  const initialRevisionDigest = validateNonEmptyString(input['initialRevisionDigest'], 'initialRevisionDigest', errors);
  const goal = validateNonEmptyString(input['goal'], 'goal', errors);
  const observedBehavior = validateNonEmptyString(input['observedBehavior'], 'observedBehavior', errors);
  const expectedBehavior = validateNonEmptyString(input['expectedBehavior'], 'expectedBehavior', errors);
  const reproduction = validateNonEmptyString(input['reproduction'], 'reproduction', errors);
  const configId = validateNonEmptyString(input['configId'], 'configId', errors);
  const configVersion = validateNonEmptyString(input['configVersion'], 'configVersion', errors);

  if (!Array.isArray(input['acceptanceCriteria'])) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must be an array of non-empty strings',
      code: 'INVALID_TYPE',
    });
  } else if (input['acceptanceCriteria'].length === 0) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must contain at least one criteria string',
      code: 'EMPTY_CRITERIA',
    });
  } else {
    for (let i = 0; i < input['acceptanceCriteria'].length; i++) {
      validateNonEmptyString(input['acceptanceCriteria'][i], `acceptanceCriteria[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['constraints'])) {
    errors.push({
      path: 'constraints',
      message: 'constraints must be an array of strings',
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['constraints'].length; i++) {
      if (typeof input['constraints'][i] !== 'string') {
        errors.push({
          path: `constraints[${i}]`,
          message: `constraints[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  const requiredChecks: CheckDefinition[] = [];
  if (!Array.isArray(input['requiredChecks'])) {
    errors.push({
      path: 'requiredChecks',
      message: 'requiredChecks must be an array of check definitions',
      code: 'INVALID_TYPE',
    });
  } else if (input['requiredChecks'].length === 0) {
    errors.push({
      path: 'requiredChecks',
      message: 'requiredChecks must contain at least one check definition',
      code: 'EMPTY_REQUIRED_CHECKS',
    });
  } else {
    for (let i = 0; i < input['requiredChecks'].length; i++) {
      const parsedCheck = validateCheckDefinition(input['requiredChecks'][i], `requiredChecks[${i}]`, errors);
      if (parsedCheck) {
        requiredChecks.push(parsedCheck);
      }
    }
  }

  const limitsRes = validateExecutionLimits(input['limits']);
  if (!limitsRes.ok) {
    errors.push(...limitsRes.errors);
  }

  const budgetLimitsRes = validateBudgetLimits(input['budgetLimits']);
  if (!budgetLimitsRes.ok) {
    errors.push(...budgetLimitsRes.errors);
  }

  if (
    errors.length > 0 ||
    !taskId ||
    !repositoryId ||
    !initialRevisionDigest ||
    !goal ||
    !observedBehavior ||
    !expectedBehavior ||
    !reproduction ||
    !configId ||
    !configVersion ||
    !Array.isArray(input['acceptanceCriteria']) ||
    input['acceptanceCriteria'].length === 0 ||
    !Array.isArray(input['constraints']) ||
    !Array.isArray(input['requiredChecks']) ||
    input['requiredChecks'].length === 0 ||
    !limitsRes.ok ||
    !budgetLimitsRes.ok
  ) {
    return { ok: false, errors };
  }

  const bugTask: BugTask = {
    taskId,
    repositoryId,
    initialRevisionDigest,
    goal,
    observedBehavior,
    expectedBehavior,
    reproduction,
    acceptanceCriteria: input['acceptanceCriteria'] as readonly string[],
    constraints: input['constraints'] as readonly string[],
    requiredChecks,
    limits: limitsRes.value,
    budgetLimits: budgetLimitsRes.value,
    configId,
    configVersion,
  };

  return { ok: true, value: bugTask };
}

export function validateNormalizedAction(input: unknown): ValidationResult<NormalizedAction> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'action', message: 'Action must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  const actionId = validateNonEmptyString(input['actionId'], 'actionId', errors);
  const kind = validateNonEmptyString(input['kind'], 'kind', errors);

  if (!actionId || !kind) {
    return { ok: false, errors };
  }

  if (kind === 'run_command') {
    rejectUnknownKeys(input, RUN_COMMAND_ACTION_ALLOWED_KEYS, '', errors);

    const executable = validateNonEmptyString(input['executable'], 'executable', errors);
    if (executable) {
      if (/[\s;&|><`$\r\n]/.test(executable)) {
        errors.push({
          path: 'executable',
          message: 'executable contains forbidden shell characters or whitespace',
          code: 'FORBIDDEN_SHELL_CHARACTERS',
        });
      }
    }

    if (!Array.isArray(input['argv'])) {
      errors.push({
        path: 'argv',
        message: 'argv must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      for (let i = 0; i < input['argv'].length; i++) {
        if (typeof input['argv'][i] !== 'string') {
          errors.push({
            path: `argv[${i}]`,
            message: `argv[${i}] must be a string`,
            code: 'INVALID_TYPE',
          });
        }
      }
    }

    const workingDirectory = validateNonEmptyString(input['workingDirectory'], 'workingDirectory', errors);
    let purpose: string | undefined;
    if (input['purpose'] !== undefined) {
      purpose = validateNonEmptyString(input['purpose'], 'purpose', errors);
    }

    if (errors.length > 0 || !executable || !Array.isArray(input['argv']) || !workingDirectory) {
      return { ok: false, errors };
    }

    const action: RunCommandAction = {
      actionId,
      kind: 'run_command',
      executable,
      argv: input['argv'] as readonly string[],
      workingDirectory,
      ...(purpose !== undefined ? { purpose } : {}),
    };
    return { ok: true, value: action };
  }

  if (kind === 'apply_patch') {
    rejectUnknownKeys(input, APPLY_PATCH_ACTION_ALLOWED_KEYS, '', errors);

    const rawPatch = input['patchContent'];
    let patchContent: string | undefined;
    if (typeof rawPatch !== 'string') {
      errors.push({
        path: 'patchContent',
        message: 'patchContent must be a string',
        code: 'INVALID_TYPE',
      });
    } else if (rawPatch.trim().length === 0) {
      errors.push({
        path: 'patchContent',
        message: 'patchContent must be a non-empty string',
        code: 'EMPTY_STRING',
      });
    } else {
      patchContent = rawPatch;
    }

    const baseRevisionDigest = validateNonEmptyString(input['baseRevisionDigest'], 'baseRevisionDigest', errors);

    if (!Array.isArray(input['targetPaths'])) {
      errors.push({
        path: 'targetPaths',
        message: 'targetPaths must be an array of relative paths',
        code: 'INVALID_TYPE',
      });
    } else if (input['targetPaths'].length === 0) {
      errors.push({
        path: 'targetPaths',
        message: 'targetPaths must contain at least one path',
        code: 'EMPTY_TARGET_PATHS',
      });
    } else {
      for (let i = 0; i < input['targetPaths'].length; i++) {
        const p = validateNonEmptyString(input['targetPaths'][i], `targetPaths[${i}]`, errors);
        if (p) {
          if (!isCanonicalRelativePath(p)) {
            errors.push({
              path: `targetPaths[${i}]`,
              message: `targetPaths[${i}] must be a canonical relative path: ${p}`,
              code: 'WORKSPACE_ESCAPE',
            });
          }
          if (isProtectedPath(p)) {
            errors.push({
              path: `targetPaths[${i}]`,
              message: `targetPaths[${i}] targets protected path: ${p}`,
              code: 'PROTECTED_PATH_FORBIDDEN',
            });
          }
        }
      }
    }

    if (
      errors.length > 0 ||
      !patchContent ||
      !baseRevisionDigest ||
      !Array.isArray(input['targetPaths']) ||
      input['targetPaths'].length === 0
    ) {
      return { ok: false, errors };
    }

    const action: ApplyPatchAction = {
      actionId,
      kind: 'apply_patch',
      patchContent,
      targetPaths: input['targetPaths'] as readonly string[],
      baseRevisionDigest,
    };
    return { ok: true, value: action };
  }

  if (kind === 'approve_fix_plan') {
    rejectUnknownKeys(input, APPROVE_FIX_PLAN_ACTION_ALLOWED_KEYS, '', errors);

    const planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
    const strategyDigest = validateNonEmptyString(input['strategyDigest'], 'strategyDigest', errors);
    const checkSetDigest = validateNonEmptyString(input['checkSetDigest'], 'checkSetDigest', errors);

    if (!Array.isArray(input['diagnosisEvidenceRefs'])) {
      errors.push({
        path: 'diagnosisEvidenceRefs',
        message: 'diagnosisEvidenceRefs must be an array of evidence references',
        code: 'INVALID_TYPE',
      });
    } else if (input['diagnosisEvidenceRefs'].length === 0) {
      errors.push({
        path: 'diagnosisEvidenceRefs',
        message: 'diagnosisEvidenceRefs must contain at least one evidence reference',
        code: 'EMPTY_EVIDENCE_REFS',
      });
    } else {
      for (let i = 0; i < input['diagnosisEvidenceRefs'].length; i++) {
        validateNonEmptyString(input['diagnosisEvidenceRefs'][i], `diagnosisEvidenceRefs[${i}]`, errors);
      }
    }

    if (
      errors.length > 0 ||
      planVersion === undefined ||
      !strategyDigest ||
      !checkSetDigest ||
      !Array.isArray(input['diagnosisEvidenceRefs']) ||
      input['diagnosisEvidenceRefs'].length === 0
    ) {
      return { ok: false, errors };
    }

    const action: ApproveFixPlanAction = {
      actionId,
      kind: 'approve_fix_plan',
      planVersion,
      strategyDigest,
      diagnosisEvidenceRefs: input['diagnosisEvidenceRefs'] as readonly string[],
      checkSetDigest,
    };
    return { ok: true, value: action };
  }

  return {
    ok: false,
    errors: [
      {
        path: 'kind',
        message: `Unknown action kind: ${kind}`,
        code: 'INVALID_ACTION_KIND',
      },
    ],
  };
}

/** Admission requires host-owned current identities; parsing alone grants no permission. */
export function validateApprovalBinding(input: unknown, context?: ApprovalBindingContext): ValidationResult<ApprovalBinding> {
  const parsed = parseApprovalBinding(input);
  if (!parsed.ok) return parsed;
  const binding = parsed.value;
  if (binding.status !== 'approved') return parsed;
  const required: (keyof ApprovalBindingContext)[] = ['currentTaskId', 'currentWorkspaceId', 'currentRepositoryRevisionDigest', 'currentPolicyId', 'currentPolicyVersion', 'currentNormalizedActionDigest'];
  if (binding.actionKind === 'fix_plan') required.push('currentPlanVersion', 'currentStrategyDigest', 'currentBaselineRef', 'currentEvidenceRefs', 'currentCriteriaDigest', 'currentCheckSetDigest');
  const errors: ValidationError[] = [];
  for (const field of required) {
    const value = context?.[field];
    if (value === undefined ||
      (typeof value === 'string' && !value.trim()) ||
      (field === 'currentPlanVersion' && (!Number.isSafeInteger(value) ||
      Number(value) < 1)) ||
      (field === 'currentEvidenceRefs' && (!Array.isArray(value) ||
      value.length === 0 ||
      value.some(v => typeof v !== 'string' ||
      !v.trim())))) {
      errors.push({ path: `context.${field}`, code: 'MISSING_FRESHNESS_CONTEXT', message: 'Complete trusted freshness context is required' });
    }
  }
  const checked = parseApprovalBinding(input, context);
  if (!checked.ok) errors.push(...checked.errors);
  return errors.length ? { ok: false, errors } : checked;
}

export function parseApprovalBinding(
  input: unknown,
  context?: ApprovalBindingContext
): ValidationResult<ApprovalBinding> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'approvalBinding', message: 'approvalBinding must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  const actionKind = input['actionKind'];
  if (actionKind !== 'action' && actionKind !== 'fix_plan') {
    errors.push({
      path: 'actionKind',
      message: 'actionKind must be either "action" or "fix_plan"',
      code: 'INVALID_ACTION_KIND',
    });
    return { ok: false, errors };
  }

  if (actionKind === 'fix_plan') {
    rejectUnknownKeys(input, APPROVAL_BINDING_FIX_PLAN_ALLOWED_KEYS, '', errors);
  } else {
    rejectUnknownKeys(input, APPROVAL_BINDING_ACTION_ALLOWED_KEYS, '', errors);
  }

  const decisionId = validateNonEmptyString(input['decisionId'], 'decisionId', errors);
  const normalizedActionDigest = validateNonEmptyString(input['normalizedActionDigest'], 'normalizedActionDigest', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const repositoryRevisionDigest = validateNonEmptyString(input['repositoryRevisionDigest'], 'repositoryRevisionDigest', errors);
  const policyId = validateNonEmptyString(input['policyId'], 'policyId', errors);
  const policyVersion = validateNonEmptyString(input['policyVersion'], 'policyVersion', errors);

  const validStatuses: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'stale'];
  const status = input['status'] as ApprovalStatus;
  if (!validStatuses.includes(status)) {
    errors.push({
      path: 'status',
      message: `status must be one of: ${validStatuses.join(', ')}`,
      code: 'INVALID_STATUS',
    });
  }

  let planVersion: number | undefined;
  let strategyDigest: string | undefined;
  let baselineRef: string | undefined;
  let evidenceRefs: readonly string[] | undefined;
  let criteriaDigest: string | undefined;
  let checkSetDigest: string | undefined;

  if (actionKind === 'fix_plan') {
    if (input['planVersion'] === undefined) {
      errors.push({
        path: 'planVersion',
        message: 'planVersion is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
    }

    if (input['strategyDigest'] === undefined) {
      errors.push({
        path: 'strategyDigest',
        message: 'strategyDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      strategyDigest = validateNonEmptyString(input['strategyDigest'], 'strategyDigest', errors);
    }

    if (input['baselineRef'] === undefined) {
      errors.push({
        path: 'baselineRef',
        message: 'baselineRef is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      baselineRef = validateNonEmptyString(input['baselineRef'], 'baselineRef', errors);
    }

    if (input['criteriaDigest'] === undefined) {
      errors.push({
        path: 'criteriaDigest',
        message: 'criteriaDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      criteriaDigest = validateNonEmptyString(input['criteriaDigest'], 'criteriaDigest', errors);
    }

    if (input['checkSetDigest'] === undefined) {
      errors.push({
        path: 'checkSetDigest',
        message: 'checkSetDigest is required for fix_plan approval bindings',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      checkSetDigest = validateNonEmptyString(input['checkSetDigest'], 'checkSetDigest', errors);
    }

    if (!Array.isArray(input['evidenceRefs'])) {
      errors.push({
        path: 'evidenceRefs',
        message: 'evidenceRefs must be an array of evidence references',
        code: 'MISSING_PLAN_FIELD',
      });
    } else if (input['evidenceRefs'].length === 0) {
      errors.push({
        path: 'evidenceRefs',
        message: 'evidenceRefs must not be empty',
        code: 'MISSING_PLAN_FIELD',
      });
    } else {
      const refs: string[] = [];
      for (let i = 0; i < input['evidenceRefs'].length; i++) {
        const r = validateNonEmptyString(input['evidenceRefs'][i], `evidenceRefs[${i}]`, errors);
        if (r) refs.push(r);
      }
      evidenceRefs = refs;
    }
  }

  let reason: string | undefined;
  if (input['reason'] !== undefined) {
    reason = validateNonEmptyString(input['reason'], 'reason', errors);
  }

  if (context) {
    if (context.currentTaskId !== undefined && context.currentTaskId !== taskId) {
      errors.push({ path: 'taskId', message: 'Binding taskId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentWorkspaceId !== undefined && context.currentWorkspaceId !== workspaceId) {
      errors.push({ path: 'workspaceId', message: 'Binding workspaceId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentRepositoryRevisionDigest !== undefined && context.currentRepositoryRevisionDigest !== repositoryRevisionDigest) {
      errors.push({ path: 'repositoryRevisionDigest', message: 'Binding repositoryRevisionDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentPolicyId !== undefined && context.currentPolicyId !== policyId) {
      errors.push({ path: 'policyId', message: 'Binding policyId does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentPolicyVersion !== undefined && context.currentPolicyVersion !== policyVersion) {
      errors.push({ path: 'policyVersion', message: 'Binding policyVersion does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (context.currentNormalizedActionDigest !== undefined && context.currentNormalizedActionDigest !== normalizedActionDigest) {
      errors.push({ path: 'normalizedActionDigest', message: 'Binding normalizedActionDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
    }
    if (actionKind === 'fix_plan') {
      if (context.currentPlanVersion !== undefined && context.currentPlanVersion !== planVersion) {
        errors.push({ path: 'planVersion', message: 'Binding planVersion does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentStrategyDigest !== undefined && context.currentStrategyDigest !== strategyDigest) {
        errors.push({ path: 'strategyDigest', message: 'Binding strategyDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentBaselineRef !== undefined && context.currentBaselineRef !== baselineRef) {
        errors.push({ path: 'baselineRef', message: 'Binding baselineRef does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentCriteriaDigest !== undefined && context.currentCriteriaDigest !== criteriaDigest) {
        errors.push({ path: 'criteriaDigest', message: 'Binding criteriaDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentCheckSetDigest !== undefined && context.currentCheckSetDigest !== checkSetDigest) {
        errors.push({ path: 'checkSetDigest', message: 'Binding checkSetDigest does not match current context', code: 'STALE_APPROVAL_BINDING' });
      }
      if (context.currentEvidenceRefs !== undefined) {
        const match =
          Array.isArray(evidenceRefs) &&
          context.currentEvidenceRefs.length === evidenceRefs.length &&
          context.currentEvidenceRefs.every((r, idx) => r === evidenceRefs?.[idx]);
        if (!match) {
          errors.push({ path: 'evidenceRefs', message: 'Binding evidenceRefs do not match current context', code: 'STALE_APPROVAL_BINDING' });
        }
      }
    }
  }

  if (
    errors.length > 0 ||
    !decisionId ||
    !normalizedActionDigest ||
    !taskId ||
    !workspaceId ||
    !repositoryRevisionDigest ||
    !policyId ||
    !policyVersion ||
    !validStatuses.includes(status) ||
    (actionKind === 'fix_plan' &&
      (planVersion === undefined ||
        !strategyDigest ||
        !baselineRef ||
        !criteriaDigest ||
        !checkSetDigest ||
        !evidenceRefs ||
        evidenceRefs.length === 0))
  ) {
    return { ok: false, errors };
  }

  const binding: ApprovalBinding = {
    decisionId,
    actionKind,
    normalizedActionDigest,
    taskId,
    workspaceId,
    repositoryRevisionDigest,
    policyId,
    policyVersion,
    status,
    ...(planVersion !== undefined ? { planVersion } : {}),
    ...(strategyDigest !== undefined ? { strategyDigest } : {}),
    ...(baselineRef !== undefined ? { baselineRef } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(criteriaDigest !== undefined ? { criteriaDigest } : {}),
    ...(checkSetDigest !== undefined ? { checkSetDigest } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  return { ok: true, value: binding };
}

export function validateCommandView(
  input: unknown,
  options?: CommandViewValidationContext
): ValidationResult<CommandView> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'commandView', message: 'commandView must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, COMMAND_VIEW_ALLOWED_KEYS, '', errors);

  const viewId = validateNonEmptyString(input['viewId'], 'viewId', errors);
  const viewDigest = validateNonEmptyString(input['viewDigest'], 'viewDigest', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const canonicalRevisionDigest = validateNonEmptyString(input['canonicalRevisionDigest'], 'canonicalRevisionDigest', errors);
  const exclusionsPolicyVersion = validateNonEmptyString(input['exclusionsPolicyVersion'], 'exclusionsPolicyVersion', errors);
  const scratchIdentity = validateNonEmptyString(input['scratchIdentity'], 'scratchIdentity', errors);

  if (input['mountedReadOnly'] !== true) {
    errors.push({
      path: 'mountedReadOnly',
      message: 'CommandView must be mounted read-only (mountedReadOnly: true)',
      code: 'READONLY_REQUIRED',
    });
  }

  const admittedFiles: AdmittedFile[] = [];
  if (!Array.isArray(input['admittedFiles'])) {
    errors.push({
      path: 'admittedFiles',
      message: 'admittedFiles must be an array of admitted file records',
      code: 'INVALID_TYPE',
    });
  } else if (input['admittedFiles'].length === 0) {
    errors.push({
      path: 'admittedFiles',
      message: 'admittedFiles must contain at least one file',
      code: 'EMPTY_ADMITTED_FILES',
    });
  } else {
    for (let i = 0; i < input['admittedFiles'].length; i++) {
      const file = input['admittedFiles'][i];
      if (!isPlainObject(file)) {
        errors.push({
          path: `admittedFiles[${i}]`,
          message: `admittedFiles[${i}] must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }

      rejectUnknownKeys(file, ADMITTED_FILE_ALLOWED_KEYS, `admittedFiles[${i}]`, errors);

      const filePath = validateNonEmptyString(file['path'], `admittedFiles[${i}].path`, errors);
      const fileDigest = validateNonEmptyString(file['digest'], `admittedFiles[${i}].digest`, errors);

      if (filePath) {
        if (!isCanonicalRelativePath(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path must be a canonical relative path: ${filePath}`,
            code: 'WORKSPACE_ESCAPE',
          });
        }
        if (isProtectedPath(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path contains protected data which cannot be admitted: ${filePath}`,
            code: 'PROTECTED_DATA_ADMITTED',
          });
        }

        if (options?.trustedFileDigests !== undefined) {
          if (!(filePath in options.trustedFileDigests)) {
            errors.push({
              path: `admittedFiles[${i}]`,
              message: `Admitted file has no trusted evidence: ${filePath}`,
              code: 'UNTRUSTED_FILE_ADMISSION',
            });
          } else if (fileDigest && options.trustedFileDigests[filePath] !== fileDigest) {
            errors.push({
              path: `admittedFiles[${i}].digest`,
              message: `Admitted file digest mismatch for ${filePath}: expected ${options.trustedFileDigests[filePath]}, got ${fileDigest}`,
              code: 'FILE_DIGEST_MISMATCH',
            });
          }
        }
      }

      if (filePath && fileDigest) {
        admittedFiles.push({ path: filePath, digest: fileDigest });
      }
    }
  }

  if (
    options?.currentCanonicalRevisionDigest !== undefined &&
    canonicalRevisionDigest &&
    options.currentCanonicalRevisionDigest !== canonicalRevisionDigest
  ) {
    errors.push({
      path: 'canonicalRevisionDigest',
      message: `CommandView canonicalRevisionDigest (${canonicalRevisionDigest}) does not match current repository revision (${options.currentCanonicalRevisionDigest})`,
      code: 'STALE_COMMAND_VIEW',
    });
  }

  if (
    options?.currentExclusionsPolicyVersion !== undefined &&
    exclusionsPolicyVersion &&
    options.currentExclusionsPolicyVersion !== exclusionsPolicyVersion
  ) {
    errors.push({
      path: 'exclusionsPolicyVersion',
      message: `CommandView exclusionsPolicyVersion (${exclusionsPolicyVersion}) does not match current policy (${options.currentExclusionsPolicyVersion})`,
      code: 'STALE_EXCLUSIONS_POLICY',
    });
  }

  if (
    options?.expectedViewDigest !== undefined &&
    viewDigest &&
    options.expectedViewDigest !== viewDigest
  ) {
    errors.push({
      path: 'viewDigest',
      message: `CommandView viewDigest (${viewDigest}) does not match expected view digest (${options.expectedViewDigest})`,
      code: 'VIEW_DIGEST_MISMATCH',
    });
  }

  if (
    errors.length > 0 ||
    !viewId ||
    !viewDigest ||
    !taskId ||
    !workspaceId ||
    !canonicalRevisionDigest ||
    !exclusionsPolicyVersion ||
    !scratchIdentity ||
    input['mountedReadOnly'] !== true ||
    !Array.isArray(input['admittedFiles']) ||
    input['admittedFiles'].length === 0
  ) {
    return { ok: false, errors };
  }

  const commandView: CommandView = {
    viewId,
    viewDigest,
    taskId,
    workspaceId,
    canonicalRevisionDigest,
    admittedFiles,
    exclusionsPolicyVersion,
    scratchIdentity,
    mountedReadOnly: true,
  };

  return { ok: true, value: commandView };
}

/* ------------------------------------------------------------------
 * Slice 2 Validators: TaskEnvelope, TaskNode, Outcomes, PlanStep,
 * FixPlan, BudgetLedger, TaskState/Checkpoint, and State Transitions
 * ------------------------------------------------------------------ */

const TASK_ENVELOPE_ALLOWED_KEYS = [
  'schemaVersion',
  'requestId',
  'taskId',
  'runId',
  'workspaceId',
  'expectedStateVersion',
  'repositoryRevisionDigest',
  'trustedConfigId',
] as const;

export function validateTaskEnvelope(input: unknown): ValidationResult<TaskEnvelope> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'envelope', message: 'TaskEnvelope must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_ENVELOPE_ALLOWED_KEYS, '', errors);

  const schemaVersion = validateNonEmptyString(input['schemaVersion'], 'schemaVersion', errors);
  if (schemaVersion && schemaVersion !== CONTRACT_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `schemaVersion must match current contract version ${CONTRACT_VERSION}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const requestId = validateNonEmptyString(input['requestId'], 'requestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const expectedStateVersion = validateNonNegativeInteger(
    input['expectedStateVersion'],
    'expectedStateVersion',
    errors
  );
  const repositoryRevisionDigest = validateNonEmptyString(
    input['repositoryRevisionDigest'],
    'repositoryRevisionDigest',
    errors
  );
  const trustedConfigId = validateNonEmptyString(input['trustedConfigId'], 'trustedConfigId', errors);

  if (
    errors.length > 0 ||
    !schemaVersion ||
    schemaVersion !== CONTRACT_VERSION ||
    !requestId ||
    !taskId ||
    !runId ||
    !workspaceId ||
    expectedStateVersion === undefined ||
    !repositoryRevisionDigest ||
    !trustedConfigId
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      requestId,
      taskId,
      runId,
      workspaceId,
      expectedStateVersion,
      repositoryRevisionDigest,
      trustedConfigId,
    },
  };
}

export function validateTaskNode(input: unknown): ValidationResult<TaskNode> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'node', message: 'node must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_NODES.includes(input as TaskNode)) {
    return {
      ok: false,
      errors: [
        {
          path: 'node',
          message: `node must be one of: ${TASK_NODES.join(', ')}`,
          code: 'INVALID_NODE',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskNode };
}

export function validateTaskOutcome(input: unknown): ValidationResult<TaskOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'outcome', message: 'TaskOutcome must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_OUTCOMES.includes(input as TaskOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'outcome',
          message: `TaskOutcome must be one of: ${TASK_OUTCOMES.join(', ')}`,
          code: 'INVALID_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskOutcome };
}

export function validateEnvelopeOutcome(input: unknown): ValidationResult<EnvelopeOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: 'EnvelopeOutcome must be a string',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }
  if (!ENVELOPE_OUTCOMES.includes(input as EnvelopeOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: `EnvelopeOutcome must be one of: ${ENVELOPE_OUTCOMES.join(', ')}`,
          code: 'INVALID_ENVELOPE_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as EnvelopeOutcome };
}

const PLAN_STEP_ALLOWED_KEYS = [
  'stepId',
  'description',
  'status',
  'actionRefs',
  'evidenceRefs',
] as const;

export function validatePlanStep(input: unknown, path = 'planStep'): ValidationResult<PlanStep> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PLAN_STEP_ALLOWED_KEYS, path, errors);

  const stepId = validateNonEmptyString(input['stepId'], `${path}.stepId`, errors);
  const description = validateNonEmptyString(input['description'], `${path}.description`, errors);

  const status = input['status'] as PlanStepStatus;
  if (!PLAN_STEP_STATUSES.includes(status)) {
    errors.push({
      path: `${path}.status`,
      message: `${path}.status must be one of: ${PLAN_STEP_STATUSES.join(', ')}`,
      code: 'INVALID_STEP_STATUS',
    });
  }

  if (!Array.isArray(input['actionRefs'])) {
    errors.push({
      path: `${path}.actionRefs`,
      message: `${path}.actionRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['actionRefs'].length; i++) {
      if (typeof input['actionRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.actionRefs[${i}]`,
          message: `${path}.actionRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      if (typeof input['evidenceRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.evidenceRefs[${i}]`,
          message: `${path}.evidenceRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (
    errors.length > 0 ||
    !stepId ||
    !description ||
    !PLAN_STEP_STATUSES.includes(status) ||
    !Array.isArray(input['actionRefs']) ||
    !Array.isArray(input['evidenceRefs'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      stepId,
      description,
      status,
      actionRefs: input['actionRefs'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
    },
  };
}

const FIX_PLAN_ALLOWED_KEYS = [
  'planVersion',
  'diagnosis',
  'suspectedCauseLocations',
  'evidenceRefs',
  'strategy',
  'scopedChanges',
  'checkSetDigest',
  'baselineRef',
  'strategyDigest',
  'decisionRef',
] as const;

export function validateFixPlan(input: unknown, path = 'fixPlan'): ValidationResult<FixPlan> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, FIX_PLAN_ALLOWED_KEYS, path, errors);

  const planVersion = validatePositiveInteger(input['planVersion'], `${path}.planVersion`, errors);
  const diagnosis = validateNonEmptyString(input['diagnosis'], `${path}.diagnosis`, errors);
  const strategy = validateNonEmptyString(input['strategy'], `${path}.strategy`, errors);
  const checkSetDigest = validateNonEmptyString(input['checkSetDigest'], `${path}.checkSetDigest`, errors);
  const baselineRef = validateNonEmptyString(input['baselineRef'], `${path}.baselineRef`, errors);
  const strategyDigest = validateNonEmptyString(input['strategyDigest'], `${path}.strategyDigest`, errors);

  let decisionRef: string | undefined;
  if (input['decisionRef'] !== undefined) {
    decisionRef = validateNonEmptyString(input['decisionRef'], `${path}.decisionRef`, errors);
  }

  if (!Array.isArray(input['suspectedCauseLocations'])) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must be an array of location strings`,
      code: 'INVALID_TYPE',
    });
  } else if (input['suspectedCauseLocations'].length === 0) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must contain at least one location`,
      code: 'EMPTY_CAUSE_LOCATIONS',
    });
  } else {
    for (let i = 0; i < input['suspectedCauseLocations'].length; i++) {
      validateNonEmptyString(input['suspectedCauseLocations'][i], `${path}.suspectedCauseLocations[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of evidence references`,
      code: 'INVALID_TYPE',
    });
  } else if (input['evidenceRefs'].length === 0) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must contain at least one evidence reference`,
      code: 'EMPTY_EVIDENCE_REFS',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      validateNonEmptyString(input['evidenceRefs'][i], `${path}.evidenceRefs[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['scopedChanges'])) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must be an array of file/module paths`,
      code: 'INVALID_TYPE',
    });
  } else if (input['scopedChanges'].length === 0) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must contain at least one targeted path`,
      code: 'EMPTY_SCOPED_CHANGES',
    });
  } else {
    for (let i = 0; i < input['scopedChanges'].length; i++) {
      validateNonEmptyString(input['scopedChanges'][i], `${path}.scopedChanges[${i}]`, errors);
    }
  }

  if (
    errors.length > 0 ||
    planVersion === undefined ||
    !diagnosis ||
    !strategy ||
    !checkSetDigest ||
    !baselineRef ||
    !strategyDigest ||
    !Array.isArray(input['suspectedCauseLocations']) ||
    input['suspectedCauseLocations'].length === 0 ||
    !Array.isArray(input['evidenceRefs']) ||
    input['evidenceRefs'].length === 0 ||
    !Array.isArray(input['scopedChanges']) ||
    input['scopedChanges'].length === 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      planVersion,
      diagnosis,
      suspectedCauseLocations: input['suspectedCauseLocations'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
      strategy,
      scopedChanges: input['scopedChanges'] as readonly string[],
      checkSetDigest,
      baselineRef,
      strategyDigest,
      ...(decisionRef !== undefined ? { decisionRef } : {}),
    },
  };
}

const BUDGET_RESERVATION_ALLOWED_KEYS = ['reservationId', 'keyedId', 'amount'] as const;

const BUDGET_LEDGER_ALLOWED_KEYS = [
  'scope',
  'kind',
  'limit',
  'consumed',
  'reservations',
  'unit',
  'configurationId',
  'version',
] as const;

export function validateBudgetLedger(
  input: unknown,
  path = 'budgetLedger'
): ValidationResult<BudgetLedger> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BUDGET_LEDGER_ALLOWED_KEYS, path, errors);

  const scope = input['scope'];
  if (scope !== 'task' && scope !== 'run') {
    errors.push({
      path: `${path}.scope`,
      message: `${path}.scope must be "task" or "run"`,
      code: 'INVALID_SCOPE',
    });
  }

  const kind = validateNonEmptyString(input['kind'], `${path}.kind`, errors);
  const limit = validateNonNegativeNumber(input['limit'], `${path}.limit`, errors);
  const consumed = validateNonNegativeNumber(input['consumed'], `${path}.consumed`, errors);
  const unit = validateNonEmptyString(input['unit'], `${path}.unit`, errors);
  const configurationId = validateNonEmptyString(input['configurationId'], `${path}.configurationId`, errors);
  const version = validateNonNegativeInteger(input['version'], `${path}.version`, errors);

  const reservations: BudgetReservation[] = [];
  if (!Array.isArray(input['reservations'])) {
    errors.push({
      path: `${path}.reservations`,
      message: `${path}.reservations must be an array of reservations`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['reservations'].length; i++) {
      const resItem = input['reservations'][i];
      const resPath = `${path}.reservations[${i}]`;
      if (!isPlainObject(resItem)) {
        errors.push({
          path: resPath,
          message: `${resPath} must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }
      rejectUnknownKeys(resItem, BUDGET_RESERVATION_ALLOWED_KEYS, resPath, errors);
      const resId = validateNonEmptyString(resItem['reservationId'], `${resPath}.reservationId`, errors);
      const keyedId = validateNonEmptyString(resItem['keyedId'], `${resPath}.keyedId`, errors);
      const amount = validateNonNegativeNumber(resItem['amount'], `${resPath}.amount`, errors);
      if (resId && keyedId && amount !== undefined) {
        reservations.push({ reservationId: resId, keyedId, amount });
      }
    }
  }

  const ledgerTotal = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
  if (!Number.isFinite(ledgerTotal)) errors.push({ path, code: 'INVALID_ACCOUNTING_TOTAL', message: 'Ledger totals must remain finite' });
  if (kind !== 'cost') {
    const amounts = [limit, consumed, ...reservations.map(reservation => reservation.amount)];
    const total = (consumed ?? 0) + reservations.reduce((sum, reservation) => sum + reservation.amount, 0);
    if (amounts.some(amount => !Number.isSafeInteger(amount)) || !Number.isSafeInteger(total)) {
      errors.push({ path, code: 'UNSAFE_COUNT_SUM', message: 'Count ledger amounts and totals must be safe integers' });
    }
  }
  if (new Set(reservations.map(reservation => reservation.reservationId)).size !== reservations.length ||
      new Set(reservations.map(reservation => reservation.keyedId)).size !== reservations.length) {
    errors.push({ path, code: 'DUPLICATE_RESERVATION', message: 'Ledger reservation IDs and keys must be unique' });
  }

  if (
    errors.length > 0 ||
    (scope !== 'task' && scope !== 'run') ||
    !kind ||
    limit === undefined ||
    consumed === undefined ||
    !unit ||
    !configurationId ||
    version === undefined ||
    !Array.isArray(input['reservations'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      scope,
      kind,
      limit,
      consumed,
      reservations,
      unit,
      configurationId,
      version,
    },
  };
}

const TASK_STATE_ALLOWED_KEYS = [
  'schemaVersion',
  'stateVersion',
  'taskId',
  'runId',
  'workspaceId',
  'repositoryId',
  'repositoryRevisionDigest',
  'goal',
  'observedBehavior',
  'expectedBehavior',
  'reproduction',
  'acceptanceCriteria',
  'constraints',
  'requiredCheckIds',
  'taskContext',
  'node',
  'planVersion',
  'replanCount',
  'plan',
  'steps',
  'changedPaths',
  'evidenceRefs',
  'approvalDecisionRefs',
  'activeDecisionId',
  'reviewRefs',
  'latestReviewRef',
  'budgetLedgers',
  'checkpointConfigId',
  'checkpointVersion',
  'risks',
  'nextAction',
  'outcome',
] as const;

export function validateTaskState(input: unknown): ValidationResult<TaskState> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'taskState', message: 'TaskState must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_STATE_ALLOWED_KEYS, '', errors);

  for (const key of ['acceptanceCriteria', 'constraints', 'requiredCheckIds', 'changedPaths', 'evidenceRefs', 'approvalDecisionRefs', 'reviewRefs', 'risks']) {
    const value = input[key];
    if (Array.isArray(value)) value.forEach((item, index) => {
      validateNonEmptyString(item, `${key}[${index}]`, errors);
      if (key === 'changedPaths' && (typeof item !== 'string' ||
      !isCanonicalRelativePath(item))) errors.push({ path: `${key}[${index}]`, code: 'INVALID_PATH', message: 'Changed path must be canonical and relative' });
    });
  }
  const schemaVersion = validateNonEmptyString(input['schemaVersion'], 'schemaVersion', errors);
  if (schemaVersion && schemaVersion !== CONTRACT_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `schemaVersion must match current contract version ${CONTRACT_VERSION}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const stateVersion = validatePositiveInteger(input['stateVersion'], 'stateVersion', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const repositoryId = validateNonEmptyString(input['repositoryId'], 'repositoryId', errors);
  const repositoryRevisionDigest = validateNonEmptyString(
    input['repositoryRevisionDigest'],
    'repositoryRevisionDigest',
    errors
  );
  const goal = validateNonEmptyString(input['goal'], 'goal', errors);
  const nextAction = validateNonEmptyString(input['nextAction'], 'nextAction', errors);

  let observedBehavior: string | undefined;
  if (input['observedBehavior'] !== undefined) {
    observedBehavior = validateNonEmptyString(input['observedBehavior'], 'observedBehavior', errors);
  }

  let expectedBehavior: string | undefined;
  if (input['expectedBehavior'] !== undefined) {
    expectedBehavior = validateNonEmptyString(input['expectedBehavior'], 'expectedBehavior', errors);
  }

  let reproduction: string | undefined;
  if (input['reproduction'] !== undefined) {
    reproduction = validateNonEmptyString(input['reproduction'], 'reproduction', errors);
  }

  if (!Array.isArray(input['acceptanceCriteria'])) {
    errors.push({
      path: 'acceptanceCriteria',
      message: 'acceptanceCriteria must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  if (!Array.isArray(input['constraints'])) {
    errors.push({
      path: 'constraints',
      message: 'constraints must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  let requiredCheckIds: readonly string[] | undefined;
  if (input['requiredCheckIds'] !== undefined) {
    if (!Array.isArray(input['requiredCheckIds'])) {
      errors.push({
        path: 'requiredCheckIds',
        message: 'requiredCheckIds must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      requiredCheckIds = input['requiredCheckIds'] as readonly string[];
    }
  }

  let taskContext: BugTask | undefined;
  if (input['taskContext'] !== undefined) {
    const contextRes = validateBugTask(input['taskContext']);
    if (!contextRes.ok) {
      errors.push(...contextRes.errors);
    } else {
      taskContext = contextRes.value;
    }
  }

  if (!taskContext) errors.push({ path: 'taskContext', code: 'MISSING_TASK_CONTEXT', message: 'Complete original validated BugTask is required for recovery' });
  if (taskContext) {
    const originals: Record<string, unknown> = { taskId: taskContext.taskId, repositoryId: taskContext.repositoryId, goal: taskContext.goal, observedBehavior: taskContext.observedBehavior, expectedBehavior: taskContext.expectedBehavior, reproduction: taskContext.reproduction, acceptanceCriteria: taskContext.acceptanceCriteria, constraints: taskContext.constraints, requiredCheckIds: taskContext.requiredChecks.map(c => c.checkId) };
    for (const [key, value] of Object.entries(originals)) if (canonicalJsonStringify(input[key]) !== canonicalJsonStringify(value)) errors.push({ path: key, code: 'TASK_CONTEXT_MISMATCH', message: 'State must preserve original task context' });
  }
  const nodeRes = validateTaskNode(input['node']);
  let node: TaskNode | undefined;
  if (!nodeRes.ok) {
    errors.push(...nodeRes.errors);
  } else {
    node = nodeRes.value;
  }

  const planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
  const replanCount = validateNonNegativeInteger(input['replanCount'], 'replanCount', errors);
  if (replanCount !== undefined && replanCount > 3) {
    errors.push({
      path: 'replanCount',
      message: 'replanCount cannot exceed 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  let plan: FixPlan | undefined;
  if (input['plan'] !== undefined) {
    const planRes = validateFixPlan(input['plan'], 'plan');
    if (!planRes.ok) {
      errors.push(...planRes.errors);
    } else {
      plan = planRes.value;
    }
  }

  let steps: PlanStep[] | undefined;
  if (input['steps'] !== undefined) {
    if (!Array.isArray(input['steps'])) {
      errors.push({
        path: 'steps',
        message: 'steps must be an array of PlanStep objects',
        code: 'INVALID_TYPE',
      });
    } else {
      steps = [];
      for (let i = 0; i < input['steps'].length; i++) {
        const stepRes = validatePlanStep(input['steps'][i], `steps[${i}]`);
        if (!stepRes.ok) {
          errors.push(...stepRes.errors);
        } else {
          steps.push(stepRes.value);
        }
      }
    }
  }

  if (!Array.isArray(input['changedPaths'])) {
    errors.push({
      path: 'changedPaths',
      message: 'changedPaths must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: 'evidenceRefs',
      message: 'evidenceRefs must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  let approvalDecisionRefs: readonly string[] | undefined;
  if (input['approvalDecisionRefs'] !== undefined) {
    if (!Array.isArray(input['approvalDecisionRefs'])) {
      errors.push({
        path: 'approvalDecisionRefs',
        message: 'approvalDecisionRefs must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      approvalDecisionRefs = input['approvalDecisionRefs'] as readonly string[];
    }
  }

  let activeDecisionId: string | undefined;
  if (input['activeDecisionId'] !== undefined) {
    activeDecisionId = validateNonEmptyString(input['activeDecisionId'], 'activeDecisionId', errors);
  }

  let reviewRefs: readonly string[] | undefined;
  if (input['reviewRefs'] !== undefined) {
    if (!Array.isArray(input['reviewRefs'])) {
      errors.push({
        path: 'reviewRefs',
        message: 'reviewRefs must be an array of strings',
        code: 'INVALID_TYPE',
      });
    } else {
      reviewRefs = input['reviewRefs'] as readonly string[];
    }
  }

  let latestReviewRef: string | undefined;
  if (input['latestReviewRef'] !== undefined) {
    latestReviewRef = validateNonEmptyString(input['latestReviewRef'], 'latestReviewRef', errors);
  }

  let budgetLedgers: BudgetLedger[] | undefined;
  if (input['budgetLedgers'] !== undefined) {
    if (!Array.isArray(input['budgetLedgers'])) {
      errors.push({
        path: 'budgetLedgers',
        message: 'budgetLedgers must be an array of BudgetLedger objects',
        code: 'INVALID_TYPE',
      });
    } else {
      budgetLedgers = [];
      for (let i = 0; i < input['budgetLedgers'].length; i++) {
        const ledgerRes = validateBudgetLedger(input['budgetLedgers'][i], `budgetLedgers[${i}]`);
        if (!ledgerRes.ok) {
          errors.push(...ledgerRes.errors);
        } else {
          budgetLedgers.push(ledgerRes.value);
        }
      }
    }
  }

  const ledgerKeys = new Set<string>();
  for (const ledger of budgetLedgers ?? []) {
    const key = `${ledger.scope}:${ledger.kind}`;
    if (ledgerKeys.has(key)) errors.push({ path: 'budgetLedgers', code: 'DUPLICATE_LEDGER', message: 'Each accounting scope and kind must have one ledger' });
    ledgerKeys.add(key);
    if (ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) > ledger.limit) errors.push({ path: 'budgetLedgers', code: 'BUDGET_EXHAUSTED', message: 'Persisted charges cannot exceed the configured limit' });
  }
  if (replanCount !== undefined && replanCount > 0) {
    const ledger = budgetLedgers?.find(l => l.scope === 'task' && l.kind === 'replan');
    if (!ledger ||
      ledger.configurationId !== taskContext?.configId ||
      ledger.limit > 3 ||
      ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) < replanCount) errors.push({ path: 'budgetLedgers', code: 'MISSING_REPLAN_ACCOUNTING', message: 'Recovery must retain all task-scoped replan charges' });
  }

  let checkpointConfigId: string | undefined;
  if (input['checkpointConfigId'] !== undefined) {
    checkpointConfigId = validateNonEmptyString(input['checkpointConfigId'], 'checkpointConfigId', errors);
  }

  let checkpointVersion: number | undefined;
  if (input['checkpointVersion'] !== undefined) {
    checkpointVersion = validateNonNegativeInteger(input['checkpointVersion'], 'checkpointVersion', errors);
  }

  if (!Array.isArray(input['risks'])) {
    errors.push({
      path: 'risks',
      message: 'risks must be an array of strings',
      code: 'INVALID_TYPE',
    });
  }

  // Terminal vs Non-terminal outcome validation
  let outcome: TaskOutcome | undefined;
  const rawOutcome = input['outcome'];
  if (node === 'Deliver') {
    if (rawOutcome !== 'COMPLETED' && rawOutcome !== 'IMPLEMENTED_UNVERIFIED') {
      errors.push({
        path: 'outcome',
        message: 'Deliver node requires outcome COMPLETED or IMPLEMENTED_UNVERIFIED',
        code: 'INVALID_TERMINAL_OUTCOME',
      });
    } else {
      outcome = rawOutcome;
    }
  } else if (node === 'Incomplete') {
    if (rawOutcome !== 'INCOMPLETE' && rawOutcome !== 'FAILED') {
      errors.push({
        path: 'outcome',
        message: 'Incomplete node requires outcome INCOMPLETE or FAILED',
        code: 'INVALID_TERMINAL_OUTCOME',
      });
    } else {
      outcome = rawOutcome;
    }
  } else {
    if (rawOutcome !== undefined) {
      errors.push({
        path: 'outcome',
        message: `Non-terminal node ${node} cannot have an outcome set`,
        code: 'NON_TERMINAL_OUTCOME_SET',
      });
    }
  }

  if (
    errors.length > 0 ||
    !schemaVersion ||
    schemaVersion !== CONTRACT_VERSION ||
    stateVersion === undefined ||
    !taskId ||
    !runId ||
    !workspaceId ||
    !repositoryId ||
    !repositoryRevisionDigest ||
    !goal ||
    !Array.isArray(input['acceptanceCriteria']) ||
    !Array.isArray(input['constraints']) ||
    !node ||
    planVersion === undefined ||
    replanCount === undefined ||
    replanCount > 3 ||
    !Array.isArray(input['changedPaths']) ||
    !Array.isArray(input['evidenceRefs']) ||
    !Array.isArray(input['risks']) ||
    !nextAction
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      stateVersion,
      taskId,
      runId,
      workspaceId,
      repositoryId,
      repositoryRevisionDigest,
      goal,
      ...(observedBehavior !== undefined ? { observedBehavior } : {}),
      ...(expectedBehavior !== undefined ? { expectedBehavior } : {}),
      ...(reproduction !== undefined ? { reproduction } : {}),
      acceptanceCriteria: input['acceptanceCriteria'] as readonly string[],
      constraints: input['constraints'] as readonly string[],
      ...(requiredCheckIds !== undefined ? { requiredCheckIds } : {}),
      ...(taskContext !== undefined ? { taskContext } : {}),
      node,
      planVersion,
      replanCount,
      ...(plan !== undefined ? { plan } : {}),
      ...(steps !== undefined ? { steps } : {}),
      changedPaths: input['changedPaths'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
      ...(approvalDecisionRefs !== undefined ? { approvalDecisionRefs } : {}),
      ...(activeDecisionId !== undefined ? { activeDecisionId } : {}),
      ...(reviewRefs !== undefined ? { reviewRefs } : {}),
      ...(latestReviewRef !== undefined ? { latestReviewRef } : {}),
      ...(budgetLedgers !== undefined ? { budgetLedgers } : {}),
      ...(checkpointConfigId !== undefined ? { checkpointConfigId } : {}),
      ...(checkpointVersion !== undefined ? { checkpointVersion } : {}),
      risks: input['risks'] as readonly string[],
      nextAction,
      ...(outcome !== undefined ? { outcome } : {}),
    },
  };
}

export function validateStateTransition(
  priorState: unknown,
  nextState: unknown,
  options?: StateTransitionOptions
): ValidationResult<TaskState> {
  const priorRes = validateTaskState(priorState);
  if (!priorRes.ok) {
    return {
      ok: false,
      errors: priorRes.errors.map((e) => ({
        ...e,
        path: `priorState.${e.path}`,
      })),
    };
  }

  const nextRes = validateTaskState(nextState);
  if (!nextRes.ok) {
    return {
      ok: false,
      errors: nextRes.errors.map((e) => ({
        ...e,
        path: `nextState.${e.path}`,
      })),
    };
  }

  const prior = priorRes.value;
  const next = nextRes.value;
  const errors: ValidationError[] = [];

  // 1. CAS State Version Check
  if (next.stateVersion !== prior.stateVersion + 1) {
    errors.push({
      path: 'stateVersion',
      message: `CAS conflict: expected stateVersion ${prior.stateVersion + 1}, got ${next.stateVersion}`,
      code: 'CAS_CONFLICT',
    });
  }

  // 2. Identity preservation
  if (next.taskId !== prior.taskId) {
    errors.push({
      path: 'taskId',
      message: `Task identity mismatch: prior ${prior.taskId} !== next ${next.taskId}`,
      code: 'TASK_IDENTITY_MISMATCH',
    });
  }

  if (next.workspaceId !== prior.workspaceId) {
    errors.push({
      path: 'workspaceId',
      message: `Workspace identity mismatch: prior ${prior.workspaceId} !== next ${next.workspaceId}`,
      code: 'WORKSPACE_IDENTITY_MISMATCH',
    });
  }

  if (next.repositoryId !== prior.repositoryId) {
    errors.push({
      path: 'repositoryId',
      message: `Repository identity mismatch: prior ${prior.repositoryId} !== next ${next.repositoryId}`,
      code: 'REPOSITORY_IDENTITY_MISMATCH',
    });
  }

  if (next.schemaVersion !== prior.schemaVersion) {
    errors.push({
      path: 'schemaVersion',
      message: `Schema version mismatch: prior ${prior.schemaVersion} !== next ${next.schemaVersion}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const fail = (path: string, code: string, message: string): void => { errors.push({ path, code, message }); };
  if (canonicalJsonStringify(prior.taskContext) !== canonicalJsonStringify(next.taskContext)) fail('taskContext', 'IMMUTABLE_TASK_CONTEXT', 'Original task and configuration cannot change');
  if (next.plan && next.plan.planVersion !== next.planVersion) fail('planVersion', 'PLAN_VERSION_MISMATCH', 'Plan version must match state');
  if (prior.checkpointConfigId !== undefined && next.checkpointConfigId !== prior.checkpointConfigId) fail('checkpointConfigId', 'IMMUTABLE_CHECKPOINT_CONFIG', 'Checkpoint configuration cannot disappear or change');
  if (prior.checkpointVersion !== undefined && (next.checkpointVersion === undefined ||
      next.checkpointVersion < prior.checkpointVersion)) fail('checkpointVersion', 'CHECKPOINT_VERSION_RESET', 'Checkpoint version cannot disappear or reset');
  if (next.planVersion < prior.planVersion) fail('planVersion', 'PLAN_VERSION_DECREASED', 'Plan versions cannot reset');
  for (const ledger of prior.budgetLedgers ?? []) {
    const current = next.budgetLedgers?.find(l => l.scope === ledger.scope && l.kind === ledger.kind);
    if (!current ||
      current.configurationId !== ledger.configurationId ||
      current.limit !== ledger.limit ||
      current.unit !== ledger.unit ||
      current.consumed < ledger.consumed ||
      current.version < ledger.version) {
      fail('budgetLedgers', 'ACCOUNTING_RESET', 'Persisted accounting cannot disappear or reset'); continue;
    }
    const removed = ledger.reservations.filter(r => !current.reservations.some(n => n.reservationId === r.reservationId && n.keyedId === r.keyedId && n.amount === r.amount)).reduce((sum, r) => sum + r.amount, 0);
    if (current.consumed < ledger.consumed + removed) fail('budgetLedgers', 'ACCOUNTING_RESET', 'Removed reservations must remain charged as consumption');
  }
  if (prior.plan && !next.plan && next.planVersion !== prior.planVersion + 1) {
    fail('plan', 'PLAN_IDENTITY_DROPPED', 'Retain the recorded strategy until a new charged plan version is reserved');
  }
  const material = (prior.plan && next.plan && (prior.plan.strategyDigest !== next.plan.strategyDigest ||
      prior.plan.strategy !== next.plan.strategy)) ||
      next.planVersion > prior.planVersion ||
      (prior.node === 'Repair' && next.node === 'Investigate');
  if (material || next.replanCount > prior.replanCount) {
    const reservation = options?.trusted?.replanReservation;
    const ledger = next.budgetLedgers?.find(l => l.scope === 'task' && l.kind === 'replan');
    if (next.replanCount !== prior.replanCount + 1 ||
      !reservation ||
      !reservation.proposalId?.trim() ||
      prior.budgetLedgers?.some(l => l.reservations.some(r => r.reservationId === reservation.reservationId ||
      r.keyedId === reservation.proposalId)) ||
      reservation.taskId !== next.taskId ||
      reservation.configurationId !== next.taskContext?.configId ||
      reservation.priorCount !== prior.replanCount ||
      reservation.nextCount !== next.replanCount ||
      !ledger ||
      ledger.limit > 3 ||
      ledger.configurationId !== reservation.configurationId ||
      !ledger.reservations.some(r => r.reservationId === reservation.reservationId && r.keyedId === reservation.proposalId && r.amount === 1) ||
      ledger.consumed + ledger.reservations.reduce((sum, r) => sum + r.amount, 0) < next.replanCount) fail('replanCount', 'MISSING_REPLAN_RESERVATION', 'Material replan needs one monotone task-scoped reserved slot');
    if (prior.node === 'Repair' && next.node === 'Investigate' && next.planVersion !== prior.planVersion + 1) fail('planVersion', 'MATERIAL_PLAN_VERSION', 'Reserve the new plan version before investigation');
    if (prior.plan && next.plan && (prior.plan.strategyDigest !== next.plan.strategyDigest ||
      prior.plan.strategy !== next.plan.strategy) && next.planVersion !== prior.planVersion + 1) fail('planVersion', 'MATERIAL_PLAN_VERSION', 'Material strategy changes require a new plan version');
  }
  if (next.node === 'Patch') {
    const authorization = options?.trusted?.approval;
    const admitted = validateApprovalBinding(authorization?.binding, authorization?.freshness);
    const binding = admitted.ok ? admitted.value : undefined;
    const plan = next.plan;
    if (!binding ||
      binding.status !== 'approved' ||
      binding.actionKind !== 'fix_plan' ||
      !plan ||
      material ||
      binding.taskId !== next.taskId ||
      binding.workspaceId !== next.workspaceId ||
      binding.repositoryRevisionDigest !== next.repositoryRevisionDigest ||
      binding.planVersion !== next.planVersion ||
      binding.strategyDigest !== plan.strategyDigest ||
      binding.baselineRef !== plan.baselineRef ||
      binding.checkSetDigest !== plan.checkSetDigest ||
      binding.criteriaDigest !== computeCanonicalSha256(next.acceptanceCriteria) ||
      canonicalJsonStringify(binding.evidenceRefs) !== canonicalJsonStringify(plan.evidenceRefs) ||
      binding.decisionId !== next.activeDecisionId ||
      plan.decisionRef !== binding.decisionId) fail('node', 'UNAPPROVED_PATCH', 'Patch requires a fresh trusted approved binding for this exact plan');
  }
  if (next.outcome === 'COMPLETED') {
    const evidence = options?.trusted?.completion;
    const plan = next.plan;
    const rawChecksValid = evidence && Array.isArray(evidence.checks) && evidence.checks.every(record => {
      if (!isPlainObject(record)) return false;
      if ('checkId' in record) return Object.keys(record).every(key => ['checkId', 'outcome', 'repositoryRevisionDigest', 'diffDigest'].includes(key));
      const shape = validateVerificationResult(record);
      if (!shape.ok) return false;
      const matching = next.taskContext?.requiredChecks.filter(check => shape.value.testedIds.includes(check.checkId));
      return !!matching?.length && shape.value.testedIds.every(id => matching.some(check => check.checkId === id)) && matching.every(check => validateVerificationAdmission(record, {
        expectedTaskId: next.taskId, expectedRunId: next.runId,
        expectedRepoDigest: next.repositoryRevisionDigest, expectedDiffDigest: evidence.diffDigest,
        expectedCheckId: check.checkId, requiredPhase: check.purpose === 'reproduction' ? 'focused' : check.purpose,
      }).ok);
    });
    const rawReviewValid = evidence && evidence.review !== null && typeof evidence.review === 'object' && ('roleConfigId' in evidence.review
      ? Object.keys(evidence.review).every(key => ['reviewId', 'status', 'repositoryRevisionDigest', 'diffDigest', 'checkSetDigest', 'roleConfigId'].includes(key))
      : !!evidence.reviewerRoleConfigId && !!evidence.reviewIterationReservationRef && validateReviewAdmission(evidence.review, {
          expectedReviewId: next.latestReviewRef, expectedRepoDigest: next.repositoryRevisionDigest,
          expectedDiffDigest: evidence.diffDigest, expectedCheckSetDigest: evidence.checkSetDigest,
          expectedRoleConfigId: evidence.reviewerRoleConfigId,
          expectedIterationReservationRef: evidence.reviewIterationReservationRef,
        }).ok);

    if (!evidence ||
      !rawChecksValid || !rawReviewValid ||
      !plan ||
      evidence.taskId !== next.taskId ||
      evidence.runId !== next.runId ||
      evidence.repositoryRevisionDigest !== next.repositoryRevisionDigest ||
      !evidence.diffDigest?.trim() ||
      evidence.authorizedDiffDigest !== evidence.diffDigest ||
      evidence.baselineRef !== plan.baselineRef ||
      !next.evidenceRefs.includes(evidence.baselineRef) ||
      evidence.criteriaDigest !== computeCanonicalSha256(next.acceptanceCriteria) ||
      evidence.checkSetDigest !== plan.checkSetDigest ||
      !evidence.protectedTestsDigest?.trim() ||
      evidence.protectedTestsDigest !== evidence.originalProtectedTestsDigest ||
      !Array.isArray(evidence.checks) ||
      !next.taskContext?.requiredChecks.every(c => evidence.checks.some(r => {
        const checkIdMatch = 'checkId' in r ? r.checkId === c.checkId : ('testedIds' in r && Array.isArray((r as VerificationResult).testedIds) && (r as VerificationResult).testedIds.includes(c.checkId));
        const outcomeMatch = r.outcome === 'pass';
        const repoMatch = ('repositoryRevisionDigest' in r ? r.repositoryRevisionDigest : ('repoDigest' in r ? (r as VerificationResult).repoDigest : undefined)) === next.repositoryRevisionDigest;
        const diffMatch = r.diffDigest === evidence.diffDigest;
        return checkIdMatch && outcomeMatch && repoMatch && diffMatch;
      })) ||
      evidence.review?.status !== 'accepted' ||
      !('roleConfigId' in evidence.review ? evidence.review.roleConfigId?.trim() : evidence.review.reviewerRoleConfigId?.trim()) ||
      ('repositoryRevisionDigest' in evidence.review ? evidence.review.repositoryRevisionDigest : evidence.review.repoDigest) !== next.repositoryRevisionDigest ||
      evidence.review.diffDigest !== evidence.diffDigest ||
      evidence.review.checkSetDigest !== evidence.checkSetDigest ||
      evidence.review.reviewId !== next.latestReviewRef ||
      !next.reviewRefs?.includes(evidence.review.reviewId)) fail('outcome', 'UNSUPPORTED_COMPLETION', 'Completion requires trusted current baseline, authorized diff, passing checks, test protection and accepted read-only review');
  }

  // 3. Terminal node check
  if (prior.node === 'Deliver' || prior.node === 'Incomplete') {
    errors.push({
      path: 'node',
      message: `Cannot transition from terminal node: ${prior.node}`,
      code: 'TERMINAL_NODE_CANNOT_TRANSITION',
    });
  }

  // 4. Allowed Node Transition Check
  if (prior.node === next.node) {
    if (!options?.allowSameNode) {
      errors.push({
        path: 'node',
        message: `Self-transition on node ${prior.node} is not allowed without allowSameNode option`,
        code: 'INVALID_NODE_TRANSITION',
      });
    }
  } else {
    const allowed = ALLOWED_NODE_TRANSITIONS[prior.node] ?? [];
    if (!allowed.includes(next.node)) {
      errors.push({
        path: 'node',
        message: `Invalid transition from ${prior.node} to ${next.node}. Allowed: ${allowed.join(', ') || 'none'}`,
        code: 'INVALID_NODE_TRANSITION',
      });
    }
  }

  // 5. Material Replan Limits & Replenishment Prohibition
  if (next.replanCount < prior.replanCount) {
    errors.push({
      path: 'replanCount',
      message: `replanCount cannot decrease from ${prior.replanCount} to ${next.replanCount} (replenishment prohibited)`,
      code: 'REPLAN_COUNT_DECREASED',
    });
  }
  if (next.replanCount > 3) {
    errors.push({
      path: 'replanCount',
      message: 'replanCount exceeds 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  // 6. Plan required before entering AwaitPlan
  if (next.node === 'AwaitPlan' && !next.plan) {
    errors.push({
      path: 'plan',
      message: 'A baseline and fix plan must be recorded before entering AwaitPlan',
      code: 'MISSING_PLAN',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: next };
}

/* ------------------------------------------------------------------
 * Slice 3: Provider Accounting & Model Proposal / Result Validators
 * ------------------------------------------------------------------ */

const PROVIDER_USAGE_ALLOWED_KEYS = [
  'inputTokens',
  'outputTokens',
  'costUsd',
  'billableTokens',
] as const;

const MODEL_PROPOSAL_ALLOWED_KEYS = [
  'proposalId',
  'content',
  'actions',
] as const;

const MODEL_RESULT_ALLOWED_KEYS = [
  'proposal',
  'observedUsage',
] as const;

const PROVIDER_REQUEST_ALLOWED_KEYS = [
  'providerRequestId',
  'taskId',
  'runId',
  'role',
  'purpose',
  'providerId',
  'modelId',
  'configId',
  'pricingPolicyId',
  'contextDigest',
  'timeoutMs',
  'maxInputTokens',
  'maxOutputTokens',
  'maxBillableTokens',
  'maxCostUsd',
  'reservationRef',
  'dispatchState',
  'observedUsage',
  'uncertainReason',
] as const;

const RESERVATION_BUNDLE_ITEM_ALLOWED_KEYS = [
  'ledgerIdentity',
  'scope',
  'kind',
  'configurationId',
  'version',
  'requestId',
  'amount',
] as const;

const RESERVATION_BUNDLE_ALLOWED_KEYS = [
  'bundleId',
  'transactionRef',
  'taskId',
  'runId',
  'reservations',
] as const;

export function validateProviderUsage(input: unknown): ValidationResult<ProviderUsage> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'providerUsage', message: 'ProviderUsage must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PROVIDER_USAGE_ALLOWED_KEYS, '', errors);

  const inputTokens = validateNonNegativeInteger(input['inputTokens'], 'inputTokens', errors);
  const outputTokens = validateNonNegativeInteger(input['outputTokens'], 'outputTokens', errors);
  const costUsd = validateNonNegativeNumber(input['costUsd'], 'costUsd', errors);

  let billableTokens: number | undefined;
  if (input['billableTokens'] !== undefined) {
    billableTokens = validateNonNegativeInteger(input['billableTokens'], 'billableTokens', errors);
    if (
      billableTokens !== undefined &&
      inputTokens !== undefined &&
      outputTokens !== undefined &&
      billableTokens < inputTokens + outputTokens
    ) {
      errors.push({
        path: 'billableTokens',
        message: `billableTokens (${billableTokens}) cannot be less than sum of input and output tokens (${inputTokens + outputTokens})`,
        code: 'INVALID_BILLABLE_TOKENS',
      });
    }
  }

  if (typeof input['inputTokens'] === 'number' && typeof input['outputTokens'] === 'number' && !Number.isSafeInteger(input['inputTokens'] + input['outputTokens'])) errors.push({ path: 'inputTokens', code: 'UNSAFE_COUNT_SUM', message: 'Token totals must remain safe integers' });
  if (
    errors.length > 0 ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    costUsd === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      inputTokens,
      outputTokens,
      costUsd,
      ...(billableTokens !== undefined ? { billableTokens } : {}),
    },
  };
}

export function validateModelProposal(input: unknown): ValidationResult<ModelProposal> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'modelProposal', message: 'ModelProposal must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, MODEL_PROPOSAL_ALLOWED_KEYS, '', errors);

  const proposalId = validateNonEmptyString(input['proposalId'], 'proposalId', errors);
  let content: string | undefined;
  if (typeof input['content'] !== 'string') {
    errors.push({
      path: 'content',
      message: 'content must be a string',
      code: 'INVALID_TYPE',
    });
  } else {
    content = input['content'];
  }

  let actions: NormalizedAction[] | undefined;
  if (input['actions'] !== undefined) {
    if (!Array.isArray(input['actions'])) {
      errors.push({
        path: 'actions',
        message: 'actions must be an array of NormalizedAction',
        code: 'INVALID_TYPE',
      });
    } else {
      actions = [];
      const acts = input['actions'] as readonly unknown[];
      for (let i = 0; i < acts.length; i++) {
        const act = acts[i];
        const actionRes = validateNormalizedAction(act);
        if (!actionRes.ok) {
          errors.push(
            ...actionRes.errors.map((e) => ({
              ...e,
              path: e.path ? `actions[${i}].${e.path}` : `actions[${i}]`,
            }))
          );
        } else {
          actions.push(actionRes.value);
        }
      }
    }
  }

  if (errors.length > 0 || !proposalId || content === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      proposalId,
      content,
      ...(actions !== undefined ? { actions } : {}),
    },
  };
}

export function validateModelResult(input: unknown): ValidationResult<ModelResult> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'modelResult', message: 'ModelResult must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, MODEL_RESULT_ALLOWED_KEYS, '', errors);

  let proposal: ModelProposal | undefined;
  if (input['proposal'] === undefined) {
    errors.push({
      path: 'proposal',
      message: 'proposal is required in ModelResult',
      code: 'MISSING_PROPOSAL',
    });
  } else {
    const propRes = validateModelProposal(input['proposal']);
    if (!propRes.ok) {
      errors.push(...propRes.errors);
    } else {
      proposal = propRes.value;
    }
  }

  let observedUsage: ProviderUsage | undefined;
  if (input['observedUsage'] === undefined) {
    errors.push({
      path: 'observedUsage',
      message: 'observedUsage is required in ModelResult',
      code: 'MISSING_OBSERVED_USAGE',
    });
  } else {
    const usageRes = validateProviderUsage(input['observedUsage']);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    } else {
      observedUsage = usageRes.value;
    }
  }

  if (errors.length > 0 || !proposal || !observedUsage) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      proposal,
      observedUsage,
    },
  };
}

export function validateReservationBundle(input: unknown): ValidationResult<ReservationBundle> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'reservationBundle', message: 'ReservationBundle must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, RESERVATION_BUNDLE_ALLOWED_KEYS, '', errors);

  const bundleId = validateNonEmptyString(input['bundleId'], 'bundleId', errors);
  const transactionRef = validateNonEmptyString(input['transactionRef'], 'transactionRef', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);

  const reservations: ReservationBundleItem[] = [];
  if (!Array.isArray(input['reservations'])) {
    errors.push({
      path: 'reservations',
      message: 'reservations must be an array of reservation items',
      code: 'INVALID_TYPE',
    });
  } else if (input['reservations'].length === 0) {
    errors.push({
      path: 'reservations',
      message: 'reservations must not be empty',
      code: 'EMPTY_RESERVATIONS',
    });
  } else {
    const items = input['reservations'] as readonly unknown[];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemPath = `reservations[${i}]`;
      if (!isPlainObject(item)) {
        errors.push({
          path: itemPath,
          message: `${itemPath} must be an object`,
          code: 'INVALID_TYPE',
        });
        continue;
      }
      rejectUnknownKeys(item, RESERVATION_BUNDLE_ITEM_ALLOWED_KEYS, itemPath, errors);
      const ledgerIdentity = validateNonEmptyString(item['ledgerIdentity'], `${itemPath}.ledgerIdentity`, errors);
      const scope = item['scope'];
      if (scope !== 'task' && scope !== 'run') {
        errors.push({
          path: `${itemPath}.scope`,
          message: `${itemPath}.scope must be "task" or "run"`,
          code: 'INVALID_SCOPE',
        });
      }
      const kind = validateNonEmptyString(item['kind'], `${itemPath}.kind`, errors);
      const configurationId = validateNonEmptyString(item['configurationId'], `${itemPath}.configurationId`, errors);
      const version = validateNonNegativeInteger(item['version'], `${itemPath}.version`, errors);
      const requestId = validateNonEmptyString(item['requestId'], `${itemPath}.requestId`, errors);
      const amount = (kind === 'cost' ? validateNonNegativeNumber : validateNonNegativeInteger)(item['amount'], `${itemPath}.amount`, errors);

      if (
        ledgerIdentity &&
        (scope === 'task' || scope === 'run') &&
        kind &&
        configurationId &&
        version !== undefined &&
        requestId &&
        amount !== undefined
      ) {
        reservations.push({
          ledgerIdentity,
          scope,
          kind,
          configurationId,
          version,
          requestId,
          amount,
        });
      }
    }
  }

  if (
    errors.length > 0 ||
    !bundleId ||
    !transactionRef ||
    !taskId ||
    !runId ||
    !Array.isArray(input['reservations']) ||
    input['reservations'].length === 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      bundleId,
      transactionRef,
      taskId,
      runId,
      reservations,
    },
  };
}

export function validateProviderRequest(
  input: unknown,
  options?: ProviderRequestValidationContext
): ValidationResult<ProviderRequest> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'providerRequest', message: 'ProviderRequest must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PROVIDER_REQUEST_ALLOWED_KEYS, '', errors);

  const providerRequestId = validateNonEmptyString(input['providerRequestId'], 'providerRequestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);

  const role = input['role'];
  if (role !== 'coder' && role !== 'reviewer') {
    errors.push({
      path: 'role',
      message: 'role must be either "coder" or "reviewer"',
      code: 'INVALID_ROLE',
    });
  }

  const purpose = validateNonEmptyString(input['purpose'], 'purpose', errors);
  const providerId = validateNonEmptyString(input['providerId'], 'providerId', errors);
  const modelId = validateNonEmptyString(input['modelId'], 'modelId', errors);
  const configId = validateNonEmptyString(input['configId'], 'configId', errors);
  const pricingPolicyId = validateNonEmptyString(input['pricingPolicyId'], 'pricingPolicyId', errors);
  const contextDigest = validateNonEmptyString(input['contextDigest'], 'contextDigest', errors);

  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'timeoutMs', errors);
  const maxInputTokens = validateNonNegativeInteger(input['maxInputTokens'], 'maxInputTokens', errors);
  const maxOutputTokens = validateNonNegativeInteger(input['maxOutputTokens'], 'maxOutputTokens', errors);
  const maxBillableTokens = validateNonNegativeInteger(input['maxBillableTokens'], 'maxBillableTokens', errors);
  const maxCostUsd = validateNonNegativeNumber(input['maxCostUsd'], 'maxCostUsd', errors);

  if (
    maxBillableTokens !== undefined &&
    maxInputTokens !== undefined &&
    maxOutputTokens !== undefined &&
    maxBillableTokens < maxInputTokens + maxOutputTokens
  ) {
    errors.push({
      path: 'maxBillableTokens',
      message: `maxBillableTokens (${maxBillableTokens}) must include finite conservative overhead and cannot be less than maxInputTokens + maxOutputTokens (${maxInputTokens + maxOutputTokens})`,
      code: 'INVALID_BILLABLE_CEILING',
    });
  }

  const reservationRef = validateNonEmptyString(input['reservationRef'], 'reservationRef', errors);

  const validDispatchStates = ['reserved', 'dispatched', 'settled', 'uncertain'] as const;
  const dispatchState = input['dispatchState'] as 'reserved' | 'dispatched' | 'settled' | 'uncertain';
  if (!validDispatchStates.includes(dispatchState)) {
    errors.push({
      path: 'dispatchState',
      message: `dispatchState must be one of: ${validDispatchStates.join(', ')}`,
      code: 'INVALID_DISPATCH_STATE',
    });
  }

  let observedUsage: ProviderUsage | undefined;
  if (input['observedUsage'] !== undefined) {
    const usageRes = validateProviderUsage(input['observedUsage']);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    } else {
      observedUsage = usageRes.value;
    }
  }

  let uncertainReason: string | undefined;
  if (input['uncertainReason'] !== undefined) {
    uncertainReason = validateNonEmptyString(input['uncertainReason'], 'uncertainReason', errors);
  }

  // State-specific discrimination
  if (dispatchState === 'reserved') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A reserved ProviderRequest cannot have observedUsage set prior to dispatch and return',
        code: 'RESERVED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A reserved ProviderRequest cannot have uncertainReason set',
        code: 'RESERVED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'dispatched') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A dispatched ProviderRequest cannot have observedUsage set while in flight',
        code: 'DISPATCHED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A dispatched ProviderRequest cannot have uncertainReason set',
        code: 'DISPATCHED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'settled') {
    if (input['observedUsage'] === undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A settled ProviderRequest requires observedUsage to be recorded',
        code: 'SETTLED_REQUIRES_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A settled ProviderRequest cannot have uncertainReason set',
        code: 'SETTLED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'uncertain') {
    if (input['uncertainReason'] === undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'An uncertain ProviderRequest requires uncertainReason explaining the interruption or timeout',
        code: 'UNCERTAIN_REQUIRES_REASON',
      });
    }
  }

  // Trusted expected request identity comparison
  if (options) {
    if (options.expectedTaskId !== undefined && options.expectedTaskId !== taskId) {
      errors.push({
        path: 'taskId',
        message: `Request taskId (${taskId}) does not match expected taskId (${options.expectedTaskId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRunId !== undefined && options.expectedRunId !== runId) {
      errors.push({
        path: 'runId',
        message: `Request runId (${runId}) does not match expected runId (${options.expectedRunId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRole !== undefined && options.expectedRole !== role) {
      errors.push({
        path: 'role',
        message: `Request role (${role}) does not match expected role (${options.expectedRole})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPurpose !== undefined && options.expectedPurpose !== purpose) {
      errors.push({
        path: 'purpose',
        message: `Request purpose (${purpose}) does not match expected purpose (${options.expectedPurpose})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderId !== undefined && options.expectedProviderId !== providerId) {
      errors.push({
        path: 'providerId',
        message: `Request providerId (${providerId}) does not match expected providerId (${options.expectedProviderId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedModelId !== undefined && options.expectedModelId !== modelId) {
      errors.push({
        path: 'modelId',
        message: `Request modelId (${modelId}) does not match expected modelId (${options.expectedModelId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedConfigId !== undefined && options.expectedConfigId !== configId) {
      errors.push({
        path: 'configId',
        message: `Request configId (${configId}) does not match expected configId (${options.expectedConfigId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPricingPolicyId !== undefined && options.expectedPricingPolicyId !== pricingPolicyId) {
      errors.push({
        path: 'pricingPolicyId',
        message: `Request pricingPolicyId (${pricingPolicyId}) does not match expected pricingPolicyId (${options.expectedPricingPolicyId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedContextDigest !== undefined && options.expectedContextDigest !== contextDigest) {
      errors.push({
        path: 'contextDigest',
        message: `Request contextDigest (${contextDigest}) does not match expected contextDigest (${options.expectedContextDigest})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderRequestId !== undefined && options.expectedProviderRequestId !== providerRequestId) {
      errors.push({
        path: 'providerRequestId',
        message: `Request providerRequestId (${providerRequestId}) does not match expected providerRequestId (${options.expectedProviderRequestId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
  }

  if (typeof input['maxInputTokens'] === 'number' && typeof input['maxOutputTokens'] === 'number' && !Number.isSafeInteger(input['maxInputTokens'] + input['maxOutputTokens'])) errors.push({ path: 'maxBillableTokens', code: 'UNSAFE_COUNT_SUM', message: 'Token ceilings must remain safe integers' });
  if (
    errors.length > 0 ||
    !providerRequestId ||
    !taskId ||
    !runId ||
    (role !== 'coder' && role !== 'reviewer') ||
    !purpose ||
    !providerId ||
    !modelId ||
    !configId ||
    !pricingPolicyId ||
    !contextDigest ||
    timeoutMs === undefined ||
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    maxBillableTokens === undefined ||
    maxCostUsd === undefined ||
    !reservationRef ||
    !validDispatchStates.includes(dispatchState)
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      providerRequestId,
      taskId,
      runId,
      role,
      purpose,
      providerId,
      modelId,
      configId,
      pricingPolicyId,
      contextDigest,
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      maxBillableTokens,
      maxCostUsd,
      reservationRef,
      dispatchState,
      ...(observedUsage !== undefined ? { observedUsage } : {}),
      ...(uncertainReason !== undefined ? { uncertainReason } : {}),
    },
  };
}

export function validateDispatchAdmission(
  request: unknown,
  context: unknown
): ValidationResult<ProviderRequest> {
  const reqRes = validateProviderRequest(request);
  if (!reqRes.ok) {
    return reqRes;
  }
  const req = reqRes.value;
  const errors: ValidationError[] = [];

  // 1. Dispatch State Check: Only 'reserved' requests can be dispatched
  if (req.dispatchState === 'uncertain') {
    errors.push({
      path: 'dispatchState',
      message: 'Uncertain requests retain charge and cannot be replayed or dispatched',
      code: 'UNCERTAIN_CANNOT_REPLAY',
    });
    return { ok: false, errors };
  }
  if (req.dispatchState !== 'reserved') {
    errors.push({
      path: 'dispatchState',
      message: `Request in state "${req.dispatchState}" cannot be admitted for dispatch (must be "reserved")`,
      code: 'INVALID_DISPATCH_STATE',
    });
    return { ok: false, errors };
  }

  // 2. Context verification
  if (!isPlainObject(context)) {
    errors.push({
      path: 'context',
      message: 'Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)',
      code: 'UNTRUSTED_DISPATCH_AUTHORIZATION',
    });
    return { ok: false, errors };
  }

  // 3. Telemetry estimate prohibition: telemetry estimates or projections must NOT authorize
  if (context['isTelemetryEstimate'] === true) {
    errors.push({
      path: 'isTelemetryEstimate',
      message: 'A telemetry estimate or client projection must NOT authorize dispatch',
      code: 'TELEMETRY_ESTIMATE_CANNOT_AUTHORIZE',
    });
    return { ok: false, errors };
  }

  // Schema parsing alone does not authorize a network request. The host must supply
  // a complete trusted identity and the persisted task accounting snapshot.
  const fail = (code: string, message: string): void => { errors.push({ path: 'context', code, message }); };
  const expected = validateProviderRequest(context['expectedRequest']);
  if (!expected.ok || !Array.isArray(context['storedRequests']) ||
      context['taskAccountingStatus'] !== 'healthy' ||
      typeof context['requireRunReviewIteration'] !== 'boolean' ||
      typeof context['transactionRef'] !== 'string' || !context['transactionRef'].trim() ||
      !Array.isArray(context['ledgerIdentities']) || !isPlainObject(context['reservationIds'])) {
    fail('UNTRUSTED_DISPATCH_AUTHORIZATION', 'Complete trusted identity, receipt and healthy task accounting are required');
    return { ok: false, errors };
  }
  const identityKeys = PROVIDER_REQUEST_ALLOWED_KEYS;
  if (identityKeys.some(key => (req as unknown as Record<string, unknown>)[key] !==
      (expected.value as unknown as Record<string, unknown>)[key])) {
    fail('PROVIDER_IDENTITY_MISMATCH', 'Request differs from the complete trusted reserved envelope');
  }
  const seenRequestIds = new Set<string>();
  let storedMatches = 0;
  for (const raw of context['storedRequests']) {
    const stored = validateProviderRequest(raw);
    if (!stored.ok) { fail('INVALID_ACCOUNTING_HISTORY', 'Stored request history must be valid'); continue; }
    const value = stored.value;
    if (seenRequestIds.has(value.providerRequestId)) fail('DUPLICATE_REQUEST_ID', 'History contains duplicate request identity');
    seenRequestIds.add(value.providerRequestId);
    if (value.taskId === req.taskId && (value.dispatchState === 'uncertain' || value.dispatchState === 'dispatched')) {
      fail('UNRESOLVED_ACCOUNTING', 'Outstanding provider accounting prevents constrained dispatch');
    }
    if (value.providerRequestId === req.providerRequestId) {
      storedMatches++;
      if (identityKeys.some(key => (value as unknown as Record<string, unknown>)[key] !==
          (req as unknown as Record<string, unknown>)[key])) fail('REQUEST_REPLAY', 'Persisted request is not the same undispatched reservation');
    }
  }
  if (storedMatches !== 1) fail('MISSING_STORED_REQUEST', 'Exactly one persisted reserved request is required');

  // 4. Reservation bundle presence and validation
  const rawBundle = context['reservationBundle'];
  if (!rawBundle) {
    errors.push({
      path: 'reservationBundle',
      message: 'Missing reservation bundle in trusted context',
      code: 'ABSENT_RESERVATION_BUNDLE',
    });
    return { ok: false, errors };
  }

  const bundleRes = validateReservationBundle(rawBundle);
  if (!bundleRes.ok) {
    errors.push(...bundleRes.errors);
    return { ok: false, errors };
  }
  const bundle = bundleRes.value;

  if (req.reservationRef !== bundle.bundleId || context['transactionRef'] !== bundle.transactionRef) {
    fail('RESERVATION_MISMATCH', 'Request and atomic StatePort receipt must bind this exact bundle');
  }
  const itemIds = new Set<string>();
  for (const item of bundle.reservations) {
    const key = `${item.scope}:${item.kind}`;
    if (itemIds.has(key)) fail('DUPLICATE_RESERVATION', 'Duplicate budget entries cannot authorize dispatch');
    itemIds.add(key);
    if (item.configurationId !== req.configId) fail('LEDGER_CONFIG_MISMATCH', 'Reservation must use the trusted request configuration');
  }
  // 5. Bundle identity comparison
  if (bundle.taskId !== req.taskId) {
    errors.push({
      path: 'reservationBundle.taskId',
      message: `Reservation bundle taskId (${bundle.taskId}) does not match request taskId (${req.taskId})`,
      code: 'RESERVATION_MISMATCH',
    });
  }
  if (bundle.runId !== req.runId) {
    errors.push({
      path: 'reservationBundle.runId',
      message: `Reservation bundle runId (${bundle.runId}) does not match request runId (${req.runId})`,
      code: 'RESERVATION_MISMATCH',
    });
  }
  if (!bundle.transactionRef) {
    errors.push({
      path: 'reservationBundle.transactionRef',
      message: 'Reservation bundle requires an atomic transaction reference',
      code: 'MISSING_TRANSACTION_REF',
    });
  }

  // All reservations in the bundle must be tied to this request
  for (const item of bundle.reservations) {
    if (item.requestId !== req.providerRequestId) {
      errors.push({
        path: 'reservationBundle.reservations',
        message: `Reservation item requestId (${item.requestId}) does not match providerRequestId (${req.providerRequestId})`,
        code: 'RESERVATION_MISMATCH',
      });
    }
  }

  // 6. Required multi-budget ceilings in reservation bundle
  // Must have:
  // - task tokens (amount >= req.maxBillableTokens)
  // - task cost (amount >= req.maxCostUsd)
  // - run tokens (amount >= req.maxBillableTokens)
  // - run cost (amount >= req.maxCostUsd)
  // - if reviewer: iteration (amount >= 1)
  const taskTokenRes = bundle.reservations.find(
    (r) => r.scope === 'task' && (r.kind === 'tokens' || r.kind === 'token')
  );
  if (!taskTokenRes || taskTokenRes.amount < req.maxBillableTokens) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient task tokens reservation (required: ${req.maxBillableTokens}, reserved: ${taskTokenRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const taskCostRes = bundle.reservations.find(
    (r) => r.scope === 'task' && r.kind === 'cost'
  );
  if (!taskCostRes || taskCostRes.amount < req.maxCostUsd) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient task cost reservation (required: ${req.maxCostUsd}, reserved: ${taskCostRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const runTokenRes = bundle.reservations.find(
    (r) => r.scope === 'run' && (r.kind === 'tokens' || r.kind === 'token')
  );
  if (!runTokenRes || runTokenRes.amount < req.maxBillableTokens) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient run tokens reservation (required: ${req.maxBillableTokens}, reserved: ${runTokenRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  const runCostRes = bundle.reservations.find(
    (r) => r.scope === 'run' && r.kind === 'cost'
  );
  if (!runCostRes || runCostRes.amount < req.maxCostUsd) {
    errors.push({
      path: 'reservationBundle',
      message: `Missing or insufficient run cost reservation (required: ${req.maxCostUsd}, reserved: ${runCostRes?.amount ?? 0})`,
      code: 'PARTIAL_RESERVATION',
    });
  }

  if (req.role === 'reviewer') {
    const iterationRes = bundle.reservations.find(
      (r) => r.scope === 'task' && (r.kind === 'iteration' || r.kind === 'review_iteration')
    );
    if (!iterationRes || iterationRes.amount < 1) {
      errors.push({
        path: 'reservationBundle',
        message: 'Reviewer provider requests require an iteration reservation (amount >= 1) before dispatch',
        code: 'PARTIAL_RESERVATION',
      });
    }
  }

  if (req.role === 'reviewer' && context['requireRunReviewIteration'] === true &&
      !bundle.reservations.some(item => item.scope === 'run' && (item.kind === 'iteration' || item.kind === 'review_iteration') && item.amount >= 1)) {
    fail('PARTIAL_RESERVATION', 'Trusted profile also requires a run review iteration');
  }
  // 7. Ledgers validation and capacity check
  const rawLedgers = context['ledgers'];
  if (!Array.isArray(rawLedgers)) {
    errors.push({
      path: 'ledgers',
      message: 'Dispatch admission requires an array of trusted ledgers',
      code: 'ABSENT_LEDGERS',
    });
    return { ok: false, errors };
  }

  const validatedLedgers: BudgetLedger[] = [];
  const ledgersList = rawLedgers as readonly unknown[];
  for (let i = 0; i < ledgersList.length; i++) {
    const item = ledgersList[i];
    const lRes = validateBudgetLedger(item, `ledgers[${i}]`);
    if (!lRes.ok) {
      errors.push(...lRes.errors);
    } else {
      validatedLedgers.push(lRes.value);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const ledgerIds = context['ledgerIdentities'] as unknown[];
  if (ledgerIds.length !== validatedLedgers.length || ledgerIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(ledgerIds).size !== ledgerIds.length ||
      new Set(validatedLedgers.map(ledger => `${ledger.scope}:${ledger.kind}`)).size !== validatedLedgers.length) {
    fail('INVALID_LEDGER_IDENTITIES', 'Every authoritative ledger needs a unique identity and budget slot');
    return { ok: false, errors };
  }
  // Match each bundle reservation against a ledger
  for (const item of bundle.reservations) {
    const matchingLedger = validatedLedgers.find(
      (l, index) => ledgerIds[index] === item.ledgerIdentity && l.scope === item.scope && l.kind === item.kind
    );
    if (!matchingLedger) {
      errors.push({
        path: 'ledgers',
        message: `No ledger found for scope "${item.scope}" and kind "${item.kind}"`,
        code: 'LEDGER_NOT_FOUND',
      });
      continue;
    }

    if (matchingLedger.configurationId !== item.configurationId) {
      errors.push({
        path: 'ledgers',
        message: `Ledger configurationId (${matchingLedger.configurationId}) does not match reservation configurationId (${item.configurationId})`,
        code: 'LEDGER_CONFIG_MISMATCH',
      });
      continue;
    }

    const persisted = matchingLedger.reservations.filter(reservation => reservation.keyedId === req.providerRequestId);
    if (matchingLedger.version !== item.version || persisted.length !== 1 ||
        persisted[0]?.amount !== item.amount ||
        typeof context['reservationIds'][item.ledgerIdentity] !== 'string' ||
        persisted[0]?.reservationId !== context['reservationIds'][item.ledgerIdentity]) {
      fail('MISSING_PERSISTED_RESERVATION', 'Exact reserved amount, ID, ledger version and bundle identity must exist in StatePort');
    }
    // Capacity calculation: limit - consumed - sum(other reservations)
    const otherReservationsSum = matchingLedger.reservations
      .filter((r) => r.keyedId !== req.providerRequestId)
      .reduce((sum, r) => sum + r.amount, 0);

    const available = matchingLedger.limit - matchingLedger.consumed - otherReservationsSum;
    if (available < item.amount) {
      errors.push({
        path: 'ledgers',
        message: `Budget exhausted on ${item.scope} ${item.kind} ledger (limit: ${matchingLedger.limit}, consumed: ${matchingLedger.consumed}, other reserved: ${otherReservationsSum}, requested: ${item.amount}, available: ${available})`,
        code: 'BUDGET_EXHAUSTED',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: req };
}

export function isAdmittedForDispatch(
  request: unknown,
  context: unknown
): boolean {
  const res = validateDispatchAdmission(request, context);
  return res.ok;
}


/* ------------------------------------------------------------------
 * Slice 4: Evidence, Baseline, Verification, Review, and Exported Records
 * ------------------------------------------------------------------ */

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

// ---------------------------------------------------------------------------
// Compact helper functions
// ---------------------------------------------------------------------------

function validateStringArray(
  arr: unknown,
  fieldPath: string,
  errors: ValidationError[],
  options?: { allowEmpty?: boolean }
): void {
  if (!Array.isArray(arr)) {
    errors.push({
      path: fieldPath,
      message: `${fieldPath} must be an array of strings`,
      code: 'INVALID_TYPE',
    });
    return;
  }
  if (!options?.allowEmpty && arr.length === 0) {
    errors.push({
      path: fieldPath,
      message: `${fieldPath} cannot be empty`,
      code: 'ARRAY_EMPTY',
    });
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push({
        path: `${fieldPath}[${i}]`,
        message: `${fieldPath}[${i}] must be a non-empty string`,
        code: 'INVALID_STRING',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// CheckResult & Baseline
// ---------------------------------------------------------------------------

const CHECK_OUTCOMES = ['pass', 'fail', 'timeout', 'error', 'not-run'] as const;

export function validateCheckResult(input: unknown, path = 'checkResult'): ValidationResult<CheckResult> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = ['checkId', 'outcome', 'outputExcerpt', 'durationMs'];
  rejectUnknownKeys(input, allowedKeys, path, errors);

  if (typeof input.checkId !== 'string' || input.checkId.trim().length === 0) {
    errors.push({
      path: `${path}.checkId`,
      message: `${path}.checkId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (!CHECK_OUTCOMES.includes(input.outcome as CheckOutcome)) {
    errors.push({
      path: `${path}.outcome`,
      message: `${path}.outcome must be one of: ${CHECK_OUTCOMES.join(', ')}`,
      code: 'INVALID_CHECK_OUTCOME',
    });
  }

  if (input.outputExcerpt !== undefined && typeof input.outputExcerpt !== 'string') {
    errors.push({
      path: `${path}.outputExcerpt`,
      message: `${path}.outputExcerpt must be a string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.durationMs !== undefined) {
    validateNonNegativeInteger(input.durationMs, `${path}.durationMs`, errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as CheckResult };
}

export function validateBaseline(input: unknown, path = 'baseline'): ValidationResult<Baseline> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'evidenceId',
    'repositorySnapshotDigest',
    'checkSetDigest',
    'reproductionFailureSignature',
    'checkResults',
    'testProtectionDigest',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['reproductionFailureSignature', 'testProtectionDigest']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.evidenceId !== 'string' || input.evidenceId.trim().length === 0) {
    errors.push({
      path: `${path}.evidenceId`,
      message: `${path}.evidenceId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.repositorySnapshotDigest !== 'string' || input.repositorySnapshotDigest.trim().length === 0) {
    errors.push({
      path: `${path}.repositorySnapshotDigest`,
      message: `${path}.repositorySnapshotDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.checkSetDigest !== 'string' || input.checkSetDigest.trim().length === 0) {
    errors.push({
      path: `${path}.checkSetDigest`,
      message: `${path}.checkSetDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.reproductionFailureSignature !== 'string' || input.reproductionFailureSignature.trim().length === 0) {
    errors.push({
      path: `${path}.reproductionFailureSignature`,
      message: `${path}.reproductionFailureSignature must be a string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.testProtectionDigest !== 'string' || input.testProtectionDigest.trim().length === 0) {
    errors.push({
      path: `${path}.testProtectionDigest`,
      message: `${path}.testProtectionDigest must be a string`,
      code: 'INVALID_STRING',
    });
  }

  if (!Array.isArray(input.checkResults) || input.checkResults.length === 0) {
    errors.push({
      path: `${path}.checkResults`,
      message: `${path}.checkResults must be a non-empty array`,
      code: 'ARRAY_EMPTY',
    });
  } else {
    const seenCheckIds = new Set<string>();
    for (let i = 0; i < input.checkResults.length; i++) {
      const itemRes = validateCheckResult(input.checkResults[i], `${path}.checkResults[${i}]`);
      if (!itemRes.ok) {
        errors.push(...itemRes.errors);
      } else {
        if (seenCheckIds.has(itemRes.value.checkId)) {
          errors.push({
            path: `${path}.checkResults[${i}].checkId`,
            message: `Duplicate checkId: ${itemRes.value.checkId}`,
            code: 'DUPLICATE_CHECK_ID',
          });
        } else {
          seenCheckIds.add(itemRes.value.checkId);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as Baseline };
}

export function validateBaselineAdmission(baseline: unknown, context: BaselineAdmissionContext): ValidationResult<Baseline> {
  const shapeRes = validateBaseline(baseline);
  if (!shapeRes.ok) {
    return shapeRes;
  }
  const value = shapeRes.value;
  const errors: ValidationError[] = [];
  if (context.expectedEvidenceId !== undefined && value.evidenceId !== context.expectedEvidenceId) errors.push({ path: 'evidenceId', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });

  if (context.expectedRepositorySnapshotDigest !== undefined && value.repositorySnapshotDigest !== context.expectedRepositorySnapshotDigest) {
    errors.push({
      path: 'baseline.repositorySnapshotDigest',
      message: `Repository snapshot digest mismatch: expected ${context.expectedRepositorySnapshotDigest}, got ${value.repositorySnapshotDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedCheckSetDigest !== undefined && value.checkSetDigest !== context.expectedCheckSetDigest) {
    errors.push({
      path: 'baseline.checkSetDigest',
      message: `Check set digest mismatch: expected ${context.expectedCheckSetDigest}, got ${value.checkSetDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedTestProtectionDigest !== undefined && value.testProtectionDigest !== context.expectedTestProtectionDigest) {
    errors.push({
      path: 'baseline.testProtectionDigest',
      message: `Test protection digest mismatch: expected ${context.expectedTestProtectionDigest}, got ${value.testProtectionDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  const checkMap = new Map<string, CheckResult>();
  for (const c of value.checkResults) {
    checkMap.set(c.checkId, c);
  }

  if (context.expectedReproductionCheckId !== undefined) {
    const reproCheck = checkMap.get(context.expectedReproductionCheckId);
    if (!reproCheck) {
      errors.push({
        path: 'baseline.checkResults',
        message: `Expected reproduction checkId ${context.expectedReproductionCheckId} not found in checkResults`,
        code: 'MISSING_REPRODUCTION_CHECK',
      });
    } else if (reproCheck.outcome !== 'fail') {
      errors.push({
        path: `baseline.checkResults.${context.expectedReproductionCheckId}.outcome`,
        message: `Expected reproduction check ${context.expectedReproductionCheckId} must have outcome 'fail', got '${reproCheck.outcome}'`,
        code: 'INVALID_REPRODUCTION_OUTCOME',
      });
    }
  }

  if (context.expectedPassingCheckIds !== undefined) {
    for (const passingId of context.expectedPassingCheckIds) {
      const passingCheck = checkMap.get(passingId);
      if (!passingCheck) {
        errors.push({
          path: 'baseline.checkResults',
          message: `Expected passing checkId ${passingId} not found in checkResults`,
          code: 'MISSING_PASSING_CHECK',
        });
      } else if (passingCheck.outcome !== 'pass') {
        errors.push({
          path: `baseline.checkResults.${passingId}.outcome`,
          message: `Expected passing check ${passingId} must have outcome 'pass', got '${passingCheck.outcome}'`,
          code: 'PASSING_CHECK_FAILED',
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// VerificationResult
// ---------------------------------------------------------------------------

const VERIFICATION_PHASES = ['baseline', 'focused', 'regression', 'compatibility', 'diff'] as const;

export function validateVerificationResult(input: unknown, path = 'verificationResult'): ValidationResult<VerificationResult> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'evidenceId',
    'taskId',
    'runId',
    'actionId',
    'phase',
    'repoDigest',
    'diffDigest',
    'commandIdentity',
    'outcome',
    'testedIds',
    'diagnosticRefs',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['repoDigest', 'diagnosticRefs']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.evidenceId !== 'string' || input.evidenceId.trim().length === 0) {
    errors.push({
      path: `${path}.evidenceId`,
      message: `${path}.evidenceId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.actionId !== 'string' || input.actionId.trim().length === 0) {
    errors.push({
      path: `${path}.actionId`,
      message: `${path}.actionId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (!VERIFICATION_PHASES.includes(input.phase as VerificationPhase)) {
    errors.push({
      path: `${path}.phase`,
      message: `${path}.phase must be one of: ${VERIFICATION_PHASES.join(', ')}`,
      code: 'INVALID_VERIFICATION_PHASE',
    });
  }

  if (input.repoDigest !== undefined && (typeof input.repoDigest !== 'string' || input.repoDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.repoDigest`,
      message: `${path}.repoDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.diffDigest !== undefined && (typeof input.diffDigest !== 'string' || input.diffDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.diffDigest`,
      message: `${path}.diffDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.commandIdentity !== 'string' || input.commandIdentity.trim().length === 0) {
    errors.push({
      path: `${path}.commandIdentity`,
      message: `${path}.commandIdentity must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (!CHECK_OUTCOMES.includes(input.outcome as CheckOutcome)) {
    errors.push({
      path: `${path}.outcome`,
      message: `${path}.outcome must be one of: ${CHECK_OUTCOMES.join(', ')}`,
      code: 'INVALID_CHECK_OUTCOME',
    });
  }

  validateStringArray(input.testedIds, `${path}.testedIds`, errors, { allowEmpty: false });

  if (input.diagnosticRefs !== undefined) {
    validateStringArray(input.diagnosticRefs, `${path}.diagnosticRefs`, errors, { allowEmpty: true });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as VerificationResult };
}

export function validateVerificationAdmission(result: unknown, context: VerificationAdmissionContext): ValidationResult<VerificationResult> {
  const shapeRes = validateVerificationResult(result);
  if (!shapeRes.ok) {
    return shapeRes;
  }
  const value = shapeRes.value;
  const errors: ValidationError[] = [];

  if (value.outcome !== 'pass') {
    errors.push({
      path: 'verificationResult.outcome',
      message: `Verification outcome must be 'pass' for admission, got '${value.outcome}'`,
      code: 'VERIFICATION_OUTCOME_NOT_PASS',
    });
  }

  if (context.expectedTaskId !== undefined && value.taskId !== context.expectedTaskId) {
    errors.push({
      path: 'verificationResult.taskId',
      message: `Task ID mismatch: expected ${context.expectedTaskId}, got ${value.taskId}`,
      code: 'TASK_ID_MISMATCH',
    });
  }

  if (context.expectedRunId !== undefined && value.runId !== context.expectedRunId) {
    errors.push({
      path: 'verificationResult.runId',
      message: `Run ID mismatch: expected ${context.expectedRunId}, got ${value.runId}`,
      code: 'RUN_ID_MISMATCH',
    });
  }

  if (context.expectedRepoDigest !== undefined && value.repoDigest !== context.expectedRepoDigest) {
    errors.push({
      path: 'verificationResult.repoDigest',
      message: `Repo digest mismatch: expected ${context.expectedRepoDigest}, got ${value.repoDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedDiffDigest !== undefined && value.diffDigest !== context.expectedDiffDigest) {
    errors.push({
      path: 'verificationResult.diffDigest',
      message: `Diff digest mismatch: expected ${context.expectedDiffDigest}, got ${value.diffDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.requiredPhase !== undefined && value.phase !== context.requiredPhase) {
    errors.push({
      path: 'verificationResult.phase',
      message: `Phase mismatch: expected ${context.requiredPhase}, got ${value.phase}`,
      code: 'PHASE_MISMATCH',
    });
  }

  if (context.expectedCheckId !== undefined && !value.testedIds.includes(context.expectedCheckId)) {
    errors.push({
      path: 'verificationResult.testedIds',
      message: `Expected checkId ${context.expectedCheckId} not found in testedIds`,
      code: 'CHECK_ID_NOT_TESTED',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// SourceEvidence
// ---------------------------------------------------------------------------

export function validateSourceEvidence(input: unknown, limits?: SourceEvidenceLimits, path = 'sourceEvidence'): ValidationResult<SourceEvidence> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = ['path', 'revisionDigest', 'boundedExcerpt', 'resultCount', 'truncated'];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['revisionDigest']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.path !== 'string' || !isCanonicalRelativePath(input.path) || isProtectedPath(input.path)) {
    errors.push({
      path: `${path}.path`,
      message: `${path}.path must be a canonical non-protected repository-relative path`,
      code: 'INVALID_CANONICAL_PATH',
    });
  }

  if (input.revisionDigest !== undefined && (typeof input.revisionDigest !== 'string' || input.revisionDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.revisionDigest`,
      message: `${path}.revisionDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.boundedExcerpt !== 'string') {
    errors.push({
      path: `${path}.boundedExcerpt`,
      message: `${path}.boundedExcerpt must be a string`,
      code: 'INVALID_STRING',
    });
  }

  validateNonNegativeInteger(input.resultCount, `${path}.resultCount`, errors);

  if (typeof input.truncated !== 'boolean') {
    errors.push({
      path: `${path}.truncated`,
      message: `${path}.truncated must be a boolean`,
      code: 'INVALID_BOOLEAN',
    });
  }

  if (limits !== undefined && typeof input.boundedExcerpt === 'string' && typeof input.resultCount === 'number' && typeof input.path === 'string') {
    if (limits.maxExcerptBytes !== undefined && Buffer.byteLength(input.boundedExcerpt, 'utf-8') > limits.maxExcerptBytes) {
      errors.push({
        path: `${path}.boundedExcerpt`,
        message: `Excerpt size exceeds maxExcerptBytes limit (${limits.maxExcerptBytes})`,
        code: 'LIMIT_EXCEEDED',
      });
    }
    if (limits.maxResultCount !== undefined && input.resultCount > limits.maxResultCount) {
      errors.push({
        path: `${path}.resultCount`,
        message: `Result count exceeds maxResultCount limit (${limits.maxResultCount})`,
        code: 'LIMIT_EXCEEDED',
      });
    }
    if (limits.allowedPaths !== undefined && !limits.allowedPaths.includes(input.path)) {
      errors.push({
        path: `${path}.path`,
        message: `Path '${input.path}' is not in allowedPaths allowlist`,
        code: 'PATH_NOT_ALLOWED',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as SourceEvidence };
}

// ---------------------------------------------------------------------------
// ReviewFinding & ReviewResult
// ---------------------------------------------------------------------------

const REVIEW_SIDES = ['old', 'new'] as const;
const REVIEW_SEVERITIES = ['error', 'warning', 'info'] as const;
const REVIEW_STATUSES = ['accepted', 'findings', 'invalid'] as const;

export function validateReviewFinding(input: unknown, path = 'reviewFinding'): ValidationResult<ReviewFinding> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = ['file', 'line', 'side', 'severity', 'message', 'evidenceRef'];
  rejectUnknownKeys(input, allowedKeys, path, errors);

  if (typeof input.file !== 'string' || !isCanonicalRelativePath(input.file) || isProtectedPath(input.file)) {
    errors.push({
      path: `${path}.file`,
      message: `${path}.file must be a canonical non-protected repository-relative path`,
      code: 'INVALID_CANONICAL_PATH',
    });
  }

  validatePositiveInteger(input.line, `${path}.line`, errors);

  if (!REVIEW_SIDES.includes(input.side as ReviewSide)) {
    errors.push({
      path: `${path}.side`,
      message: `${path}.side must be one of: ${REVIEW_SIDES.join(', ')}`,
      code: 'INVALID_REVIEW_SIDE',
    });
  }

  if (!REVIEW_SEVERITIES.includes(input.severity as ReviewSeverity)) {
    errors.push({
      path: `${path}.severity`,
      message: `${path}.severity must be one of: ${REVIEW_SEVERITIES.join(', ')}`,
      code: 'INVALID_REVIEW_SEVERITY',
    });
  }

  if (typeof input.message !== 'string' || input.message.trim().length === 0) {
    errors.push({
      path: `${path}.message`,
      message: `${path}.message must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.evidenceRef !== undefined && (typeof input.evidenceRef !== 'string' || input.evidenceRef.trim().length === 0)) {
    errors.push({
      path: `${path}.evidenceRef`,
      message: `${path}.evidenceRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as ReviewFinding };
}

export function validateReviewResult(input: unknown, path = 'reviewResult'): ValidationResult<ReviewResult> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'reviewId',
    'reviewerRoleConfigId',
    'repoDigest',
    'diffDigest',
    'checkSetDigest',
    'status',
    'findings',
    'iterationReservationRef',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['repoDigest', 'diffDigest', 'checkSetDigest', 'iterationReservationRef']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.reviewId !== 'string' || input.reviewId.trim().length === 0) {
    errors.push({
      path: `${path}.reviewId`,
      message: `${path}.reviewId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.reviewerRoleConfigId !== 'string' || input.reviewerRoleConfigId.trim().length === 0) {
    errors.push({
      path: `${path}.reviewerRoleConfigId`,
      message: `${path}.reviewerRoleConfigId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.repoDigest !== undefined && (typeof input.repoDigest !== 'string' || input.repoDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.repoDigest`,
      message: `${path}.repoDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.diffDigest !== undefined && (typeof input.diffDigest !== 'string' || input.diffDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.diffDigest`,
      message: `${path}.diffDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.checkSetDigest !== undefined && (typeof input.checkSetDigest !== 'string' || input.checkSetDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.checkSetDigest`,
      message: `${path}.checkSetDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (!REVIEW_STATUSES.includes(input.status as ReviewResult['status'])) {
    errors.push({
      path: `${path}.status`,
      message: `${path}.status must be one of: ${REVIEW_STATUSES.join(', ')}`,
      code: 'INVALID_REVIEW_STATUS',
    });
  }

  const findingsList: ReviewFinding[] = [];
  if (!Array.isArray(input.findings)) {
    errors.push({
      path: `${path}.findings`,
      message: `${path}.findings must be an array`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input.findings.length; i++) {
      const fRes = validateReviewFinding(input.findings[i], `${path}.findings[${i}]`);
      if (!fRes.ok) {
        errors.push(...fRes.errors);
      } else {
        findingsList.push(fRes.value);
      }
    }
  }

  if (input.iterationReservationRef !== undefined && (typeof input.iterationReservationRef !== 'string' || input.iterationReservationRef.trim().length === 0)) {
    errors.push({
      path: `${path}.iterationReservationRef`,
      message: `${path}.iterationReservationRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (errors.length === 0) {
    const actionableFindings = findingsList.filter(f => f.severity === 'error' || f.severity === 'warning');
    if (input.status === 'accepted' && actionableFindings.length > 0) {
      errors.push({
        path: `${path}.findings`,
        message: `ReviewResult with status 'accepted' cannot contain actionable findings (error or warning)`,
        code: 'ACTIONABLE_FINDINGS_IN_ACCEPTED_REVIEW',
      });
    }
    if (input.status === 'findings' && actionableFindings.length === 0) {
      errors.push({
        path: `${path}.findings`,
        message: `ReviewResult with status 'findings' must contain at least one actionable finding (error or warning)`,
        code: 'NO_ACTIONABLE_FINDINGS',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as ReviewResult };
}

export function validateReviewAdmission(review: unknown, context: ReviewAdmissionContext): ValidationResult<ReviewResult> {
  const shapeRes = validateReviewResult(review);
  if (!shapeRes.ok) {
    return shapeRes;
  }
  const value = shapeRes.value;
  const errors: ValidationError[] = [];
  if (context.expectedReviewId !== undefined && value.reviewId !== context.expectedReviewId) errors.push({ path: 'reviewId', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });

  if (context.expectedRepoDigest !== undefined && value.repoDigest !== context.expectedRepoDigest) {
    errors.push({
      path: 'reviewResult.repoDigest',
      message: `Repo digest mismatch: expected ${context.expectedRepoDigest}, got ${value.repoDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedDiffDigest !== undefined && value.diffDigest !== context.expectedDiffDigest) {
    errors.push({
      path: 'reviewResult.diffDigest',
      message: `Diff digest mismatch: expected ${context.expectedDiffDigest}, got ${value.diffDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedCheckSetDigest !== undefined && value.checkSetDigest !== context.expectedCheckSetDigest) {
    errors.push({
      path: 'reviewResult.checkSetDigest',
      message: `Check set digest mismatch: expected ${context.expectedCheckSetDigest}, got ${value.checkSetDigest}`,
      code: 'DIGEST_MISMATCH',
    });
  }

  if (context.expectedRoleConfigId !== undefined && value.reviewerRoleConfigId !== context.expectedRoleConfigId) {
    errors.push({
      path: 'reviewResult.reviewerRoleConfigId',
      message: `Reviewer role config ID mismatch: expected ${context.expectedRoleConfigId}, got ${value.reviewerRoleConfigId}`,
      code: 'ROLE_CONFIG_MISMATCH',
    });
  }

  if (context.expectedIterationReservationRef !== undefined && value.iterationReservationRef !== context.expectedIterationReservationRef) {
    errors.push({
      path: 'reviewResult.iterationReservationRef',
      message: `Iteration reservation ref mismatch: expected ${context.expectedIterationReservationRef}, got ${value.iterationReservationRef}`,
      code: 'RESERVATION_REF_MISMATCH',
    });
  }

  if (context.trustedDiffLines !== undefined) {
    for (let i = 0; i < value.findings.length; i++) {
      const finding = value.findings[i];
      if (!finding) continue;
      const fileDiff = context.trustedDiffLines[finding.file];
      if (!fileDiff) {
        errors.push({
          path: `reviewResult.findings[${i}].file`,
          message: `Finding file '${finding.file}' is not in trusted diff lines`,
          code: 'FILE_NOT_IN_TRUSTED_DIFF',
        });
        continue;
      }
      if (finding.side === 'new') {
        if (!fileDiff.newLines || !fileDiff.newLines.includes(finding.line)) {
          errors.push({
            path: `reviewResult.findings[${i}].line`,
            message: `Line ${finding.line} on new side is not in trusted modified diff lines`,
            code: 'LINE_NOT_IN_TRUSTED_DIFF',
          });
        }
      } else if (finding.side === 'old') {
        if (!fileDiff.oldLines || !fileDiff.oldLines.includes(finding.line)) {
          errors.push({
            path: `reviewResult.findings[${i}].line`,
            message: `Line ${finding.line} on old side is not in trusted deleted/modified diff lines`,
            code: 'LINE_NOT_IN_TRUSTED_DIFF',
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Exported Record Schemas: TaskWorkspace, Run, ActivityEvent, Delivery
// ---------------------------------------------------------------------------

export function validateTaskWorkspace(
  input: unknown,
  context?: TaskWorkspaceValidationContext,
  path = 'taskWorkspace'
): ValidationResult<TaskWorkspace> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'taskId',
    'workspaceId',
    'containerImageDigest',
    'repoVolumeId',
    'scratchVolumeId',
    'expectedRepoState',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['expectedRepoState']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
    errors.push({
      path: `${path}.workspaceId`,
      message: `${path}.workspaceId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.containerImageDigest !== 'string' || input.containerImageDigest.trim().length === 0) {
    errors.push({
      path: `${path}.containerImageDigest`,
      message: `${path}.containerImageDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.repoVolumeId !== 'string' || input.repoVolumeId.trim().length === 0) {
    errors.push({
      path: `${path}.repoVolumeId`,
      message: `${path}.repoVolumeId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.scratchVolumeId !== 'string' || input.scratchVolumeId.trim().length === 0) {
    errors.push({
      path: `${path}.scratchVolumeId`,
      message: `${path}.scratchVolumeId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.expectedRepoState !== undefined && (typeof input.expectedRepoState !== 'string' || input.expectedRepoState.trim().length === 0)) {
    errors.push({
      path: `${path}.expectedRepoState`,
      message: `${path}.expectedRepoState must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (context !== undefined) {
    if (context.expectedTaskId !== undefined && input.taskId !== context.expectedTaskId) {
      errors.push({
        path: `${path}.taskId`,
        message: `Task ID mismatch: expected ${context.expectedTaskId}, got ${input.taskId}`,
        code: 'TASK_ID_MISMATCH',
      });
    }
    if (context.expectedWorkspaceId !== undefined && input.workspaceId !== context.expectedWorkspaceId) {
      errors.push({
        path: `${path}.workspaceId`,
        message: `Workspace ID mismatch: expected ${context.expectedWorkspaceId}, got ${input.workspaceId}`,
        code: 'WORKSPACE_ID_MISMATCH',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as TaskWorkspace };
}

export function validateRun(input: unknown, path = 'run'): ValidationResult<Run> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = ['runId', 'taskId', 'startTime', 'endTime', 'totalUsage', 'outcome'];
  rejectUnknownKeys(input, allowedKeys, path, errors);

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.startTime !== 'string' || Number.isNaN(Date.parse(input.startTime))) {
    errors.push({
      path: `${path}.startTime`,
      message: `${path}.startTime must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (input.endTime !== undefined && (typeof input.endTime !== 'string' || Number.isNaN(Date.parse(input.endTime)))) {
    errors.push({
      path: `${path}.endTime`,
      message: `${path}.endTime must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (input.totalUsage !== undefined) {
    const usageRes = validateProviderUsage(input.totalUsage);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    }
  }

  if (input.outcome !== undefined) {
    const outcomeRes = validateTaskOutcome(input.outcome);
    if (!outcomeRes.ok) {
      errors.push(...outcomeRes.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as Run };
}

export function validateActivityEvent(input: unknown, path = 'activityEvent'): ValidationResult<ActivityEvent> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'eventId',
    'taskId',
    'runId',
    'timestamp',
    'node',
    'actionType',
    'outcome',
    'durationMs',
    'evidenceRefs',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['outcome', 'durationMs', 'evidenceRefs']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0) {
    errors.push({
      path: `${path}.eventId`,
      message: `${path}.eventId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.timestamp !== 'string' || Number.isNaN(Date.parse(input.timestamp))) {
    errors.push({
      path: `${path}.timestamp`,
      message: `${path}.timestamp must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (typeof input.node !== 'string' || input.node.trim().length === 0) {
    errors.push({
      path: `${path}.node`,
      message: `${path}.node must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.actionType !== 'string' || input.actionType.trim().length === 0) {
    errors.push({
      path: `${path}.actionType`,
      message: `${path}.actionType must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.outcome !== undefined && (typeof input.outcome !== 'string' || input.outcome.trim().length === 0)) {
    errors.push({
      path: `${path}.outcome`,
      message: `${path}.outcome must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.durationMs !== undefined) {
    validateNonNegativeInteger(input.durationMs, `${path}.durationMs`, errors);
  }

  if (input.evidenceRefs !== undefined) {
    validateStringArray(input.evidenceRefs, `${path}.evidenceRefs`, errors, { allowEmpty: true });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as ActivityEvent };
}

export function validateDelivery(
  input: unknown,
  context?: DeliveryValidationContext,
  path = 'delivery'
): ValidationResult<Delivery> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'taskId',
    'runId',
    'outcome',
    'diffDigest',
    'changedFiles',
    'baselineRef',
    'verificationRefs',
    'reviewRef',
    'limitations',
    'safeNextAction',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['diffDigest', 'changedFiles', 'baselineRef', 'verificationRefs', 'reviewRef', 'limitations', 'safeNextAction']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  const outcomeRes = validateTaskOutcome(input.outcome);
  if (!outcomeRes.ok) {
    errors.push(...outcomeRes.errors);
  }

  if (input.diffDigest !== undefined && (typeof input.diffDigest !== 'string' || input.diffDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.diffDigest`,
      message: `${path}.diffDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.changedFiles !== undefined) {
    if (!Array.isArray(input.changedFiles)) {
      errors.push({
        path: `${path}.changedFiles`,
        message: `${path}.changedFiles must be an array of paths`,
        code: 'INVALID_TYPE',
      });
    } else {
      if (input.outcome === 'COMPLETED' && input.changedFiles.length === 0) {
        errors.push({
          path: `${path}.changedFiles`,
          message: `${path}.changedFiles cannot be empty for COMPLETED outcome`,
          code: 'ARRAY_EMPTY',
        });
      }
      for (let i = 0; i < input.changedFiles.length; i++) {
        const file = input.changedFiles[i];
        if (typeof file !== 'string' || !isCanonicalRelativePath(file) || isProtectedPath(file)) {
          errors.push({
            path: `${path}.changedFiles[${i}]`,
            message: `${path}.changedFiles[${i}] must be a canonical non-protected repository-relative path`,
            code: 'INVALID_CANONICAL_PATH',
          });
        }
      }
    }
  }

  if (input.baselineRef !== undefined && (typeof input.baselineRef !== 'string' || input.baselineRef.trim().length === 0)) {
    errors.push({
      path: `${path}.baselineRef`,
      message: `${path}.baselineRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.verificationRefs !== undefined) {
    if (!Array.isArray(input.verificationRefs)) {
      errors.push({
        path: `${path}.verificationRefs`,
        message: `${path}.verificationRefs must be an array of strings`,
        code: 'INVALID_TYPE',
      });
    } else {
      if (input.outcome === 'COMPLETED' && input.verificationRefs.length === 0) {
        errors.push({
          path: `${path}.verificationRefs`,
          message: `${path}.verificationRefs cannot be empty for COMPLETED outcome`,
          code: 'ARRAY_EMPTY',
        });
      }
      for (let i = 0; i < input.verificationRefs.length; i++) {
        const ref = input.verificationRefs[i];
        if (typeof ref !== 'string' || ref.trim().length === 0) {
          errors.push({
            path: `${path}.verificationRefs[${i}]`,
            message: `${path}.verificationRefs[${i}] must be a non-empty string`,
            code: 'INVALID_STRING',
          });
        }
      }
    }
  }

  if (input.reviewRef !== undefined && (typeof input.reviewRef !== 'string' || input.reviewRef.trim().length === 0)) {
    errors.push({
      path: `${path}.reviewRef`,
      message: `${path}.reviewRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.limitations !== undefined) {
    validateStringArray(input.limitations, `${path}.limitations`, errors, { allowEmpty: true });
  }

  if (input.safeNextAction !== undefined && (typeof input.safeNextAction !== 'string' || input.safeNextAction.trim().length === 0)) {
    errors.push({
      path: `${path}.safeNextAction`,
      message: `${path}.safeNextAction must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (context !== undefined) {
    if (context.expectedDiffDigest !== undefined && input.diffDigest !== context.expectedDiffDigest) errors.push({ path: 'diffDigest', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedBaselineRef !== undefined && input.baselineRef !== context.expectedBaselineRef) errors.push({ path: 'baselineRef', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedReviewRef !== undefined && input.reviewRef !== context.expectedReviewRef) errors.push({ path: 'reviewRef', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedTaskId !== undefined && input.taskId !== context.expectedTaskId) {
      errors.push({
        path: `${path}.taskId`,
        message: `Task ID mismatch: expected ${context.expectedTaskId}, got ${input.taskId}`,
        code: 'TASK_ID_MISMATCH',
      });
    }
    if (context.expectedRunId !== undefined && input.runId !== context.expectedRunId) {
      errors.push({
        path: `${path}.runId`,
        message: `Run ID mismatch: expected ${context.expectedRunId}, got ${input.runId}`,
        code: 'RUN_ID_MISMATCH',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as Delivery };
}
