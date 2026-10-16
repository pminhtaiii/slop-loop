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
  readonly maxCostUsd: number;
  readonly reservationRef: string;
  readonly dispatchState: 'reserved' | 'dispatched' | 'settled' | 'uncertain';
  readonly observedUsage?: ProviderUsage | undefined;
  readonly uncertainReason?: string | undefined;
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

export interface StateTransitionOptions {
  readonly allowSameNode?: boolean | undefined;
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

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'info';
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

export interface ModelPort {
  propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ModelResult>;
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
  settle(actionId: string, observed: ProviderUsage): Promise<void>;
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
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
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
  if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
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

export function validateApprovalBinding(
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
