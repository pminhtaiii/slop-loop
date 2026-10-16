/**
 * UC-03 Verified Code Repair - Canonical v0.1 Contracts and Runtime Validators
 *
 * Owned path: src/contracts/uc03.ts
 * Feature: specs/001-verified-code-repair
 */

export const CONTRACT_VERSION = '0.1.0' as const;

export type TaskOutcome =
  | 'COMPLETED'
  | 'IMPLEMENTED_UNVERIFIED'
  | 'INCOMPLETE'
  | 'FAILED';

export type EnvelopeOutcome =
  | 'success'
  | 'needs-info'
  | 'pending-approval'
  | 'denied'
  | 'conflict'
  | 'exhausted'
  | 'timeout'
  | 'error'
  | 'uncertain-effect';

export type PermissionClass =
  | 'ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'FORBIDDEN';

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
  readonly maxCpuCores?: number | undefined;
  readonly maxMemoryBytes?: number | undefined;
  readonly maxPids?: number | undefined;
}

export interface BudgetLimits {
  readonly maxReplanCount: number;
  readonly maxTokens?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly maxRepairAttempts?: number | undefined;
  readonly maxReviewIterations?: number | undefined;
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
  readonly status: ApprovalStatus;
  readonly reason?: string | undefined;
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

export interface TaskState {
  readonly schemaVersion: string;
  readonly stateVersion: number;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly node: string;
  readonly planVersion: number;
  readonly changedPaths: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly risks: readonly string[];
  readonly nextAction: string;
  readonly outcome?: TaskOutcome | undefined;
}

export interface PlanStep {
  readonly stepId: string;
  readonly description: string;
  readonly status: 'todo' | 'doing' | 'done' | 'failed';
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

function isPathEscaping(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized === '..' ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return true;
  }
  return false;
}

function isProtectedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const baseName = normalized.split('/').pop() ?? normalized;

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
  if (normalized.startsWith('.git/') || normalized === '.git') {
    return true;
  }
  // Hidden evaluation / grading
  if (normalized.startsWith('eval/uc03/private/') || normalized.includes('/private/grading')) {
    return true;
  }
  return false;
}

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
  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'limits.timeoutMs', errors);
  const maxOutputBytes = validatePositiveInteger(input['maxOutputBytes'], 'limits.maxOutputBytes', errors);

  let maxCpuCores: number | undefined;
  if (input['maxCpuCores'] !== undefined) {
    maxCpuCores = validatePositiveNumber(input['maxCpuCores'], 'limits.maxCpuCores', errors);
  }

  let maxMemoryBytes: number | undefined;
  if (input['maxMemoryBytes'] !== undefined) {
    maxMemoryBytes = validatePositiveInteger(input['maxMemoryBytes'], 'limits.maxMemoryBytes', errors);
  }

  let maxPids: number | undefined;
  if (input['maxPids'] !== undefined) {
    maxPids = validatePositiveInteger(input['maxPids'], 'limits.maxPids', errors);
  }

  if (errors.length > 0 || timeoutMs === undefined || maxOutputBytes === undefined) {
    return { ok: false, errors };
  }

  const result: ExecutionLimits = {
    timeoutMs,
    maxOutputBytes,
    ...(maxCpuCores !== undefined ? { maxCpuCores } : {}),
    ...(maxMemoryBytes !== undefined ? { maxMemoryBytes } : {}),
    ...(maxPids !== undefined ? { maxPids } : {}),
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
  const replan = validateNonNegativeInteger(input['maxReplanCount'], 'budgetLimits.maxReplanCount', errors);
  if (replan !== undefined && replan > 3) {
    errors.push({
      path: 'budgetLimits.maxReplanCount',
      message: 'maxReplanCount cannot exceed 3 (fixed task-scoped replan limit)',
      code: 'REPLAN_CAP_EXCEEDED',
    });
  }

  let maxTokens: number | undefined;
  if (input['maxTokens'] !== undefined) {
    maxTokens = validatePositiveInteger(input['maxTokens'], 'budgetLimits.maxTokens', errors);
  }

  let maxCostUsd: number | undefined;
  if (input['maxCostUsd'] !== undefined) {
    maxCostUsd = validatePositiveNumber(input['maxCostUsd'], 'budgetLimits.maxCostUsd', errors);
  }

  let maxRepairAttempts: number | undefined;
  if (input['maxRepairAttempts'] !== undefined) {
    maxRepairAttempts = validatePositiveInteger(input['maxRepairAttempts'], 'budgetLimits.maxRepairAttempts', errors);
  }

  let maxReviewIterations: number | undefined;
  if (input['maxReviewIterations'] !== undefined) {
    maxReviewIterations = validatePositiveInteger(input['maxReviewIterations'], 'budgetLimits.maxReviewIterations', errors);
  }

  if (errors.length > 0 || replan === undefined || replan > 3) {
    return { ok: false, errors };
  }

  const result: BudgetLimits = {
    maxReplanCount: replan,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxRepairAttempts !== undefined ? { maxRepairAttempts } : {}),
    ...(maxReviewIterations !== undefined ? { maxReviewIterations } : {}),
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

  const checkId = validateNonEmptyString(input['checkId'], `${path}.checkId`, errors);
  const executable = validateNonEmptyString(input['executable'], `${path}.executable`, errors);

  if (!Array.isArray(input['argv'])) {
    errors.push({
      path: `${path}.argv`,
      message: `${path}.argv must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['argv'].length; i++) {
      if (typeof input['argv'][i] !== 'string') {
        errors.push({
          path: `${path}.argv[${i}]`,
          message: `${path}.argv[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
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
    !checkId ||
    !executable ||
    !Array.isArray(input['argv']) ||
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

  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const repositoryId = validateNonEmptyString(input['repositoryId'], 'repositoryId', errors);
  const initialRevisionDigest = validateNonEmptyString(input['initialRevisionDigest'], 'initialRevisionDigest', errors);
  const goal = validateNonEmptyString(input['goal'], 'goal', errors);
  const observedBehavior = validateNonEmptyString(input['observedBehavior'], 'observedBehavior', errors);
  const expectedBehavior = validateNonEmptyString(input['expectedBehavior'], 'expectedBehavior', errors);
  const reproduction = validateNonEmptyString(input['reproduction'], 'reproduction', errors);

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
    const executable = validateNonEmptyString(input['executable'], 'executable', errors);
    if (executable) {
      // Reject shell metacharacters and arbitrary shell execution
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
    const patchContent = validateNonEmptyString(input['patchContent'], 'patchContent', errors);
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
        if (p && isPathEscaping(p)) {
          errors.push({
            path: `targetPaths[${i}]`,
            message: `targetPaths[${i}] must not escape repository workspace: ${p}`,
            code: 'WORKSPACE_ESCAPE',
          });
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

export function validateApprovalBinding(input: unknown): ValidationResult<ApprovalBinding> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'approvalBinding', message: 'approvalBinding must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  const decisionId = validateNonEmptyString(input['decisionId'], 'decisionId', errors);
  const actionKind = input['actionKind'];
  if (actionKind !== 'action' && actionKind !== 'fix_plan') {
    errors.push({
      path: 'actionKind',
      message: 'actionKind must be either "action" or "fix_plan"',
      code: 'INVALID_ACTION_KIND',
    });
  }

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
  } else {
    if (input['planVersion'] !== undefined) {
      planVersion = validatePositiveInteger(input['planVersion'], 'planVersion', errors);
    }
    if (input['strategyDigest'] !== undefined) {
      strategyDigest = validateNonEmptyString(input['strategyDigest'], 'strategyDigest', errors);
    }
  }

  let reason: string | undefined;
  if (input['reason'] !== undefined) {
    reason = validateNonEmptyString(input['reason'], 'reason', errors);
  }

  if (
    errors.length > 0 ||
    !decisionId ||
    (actionKind !== 'action' && actionKind !== 'fix_plan') ||
    !normalizedActionDigest ||
    !taskId ||
    !workspaceId ||
    !repositoryRevisionDigest ||
    !policyId ||
    !policyVersion ||
    !validStatuses.includes(status)
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
    ...(reason !== undefined ? { reason } : {}),
  };

  return { ok: true, value: binding };
}

export function validateCommandView(
  input: unknown,
  options?: { readonly currentCanonicalRevisionDigest?: string }
): ValidationResult<CommandView> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'commandView', message: 'commandView must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
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

      const filePath = validateNonEmptyString(file['path'], `admittedFiles[${i}].path`, errors);
      const fileDigest = validateNonEmptyString(file['digest'], `admittedFiles[${i}].digest`, errors);

      if (filePath) {
        if (isPathEscaping(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path escapes repository workspace: ${filePath}`,
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
