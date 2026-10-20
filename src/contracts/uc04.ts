import type {
  StepStatus,
  PlanStep,
  TaskState,
  BudgetLedger,
  ReservationBundle,
  ApprovalRequestBinding,
  WorkspaceBaseline,
  CheckpointRecord,
} from '../state/types.ts';

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function validateStepStatus(status: unknown): ValidationResult<StepStatus> {
  if (status === 'todo' || status === 'doing' || status === 'done' || status === 'failed') {
    return { ok: true, value: status };
  }
  return {
    ok: false,
    errors: [
      {
        path: 'status',
        message: 'Expected one of canonical step statuses: todo, doing, done, failed',
        code: 'INVALID_STEP_STATUS',
      },
    ],
  };
}

export function validatePlanStep(val: unknown, path = 'step'): ValidationResult<PlanStep> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.id !== 'string' || !val.id.trim()) {
    errors.push({ path: `${path}.id`, message: 'Step id must be a non-empty string', code: 'INVALID_ID' });
  }

  if (typeof val.title !== 'string' || !val.title.trim()) {
    errors.push({ path: `${path}.title`, message: 'Step title must be a non-empty string', code: 'INVALID_TITLE' });
  }

  if (typeof val.description !== 'string') {
    errors.push({ path: `${path}.description`, message: 'Step description must be a string', code: 'INVALID_DESCRIPTION' });
  }

  const statusRes = validateStepStatus(val.status);
  if (!statusRes.ok) {
    errors.push(...statusRes.errors.map((e) => ({ ...e, path: `${path}.${e.path}` })));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PlanStep };
}

export function validateBudgetLedger(val: unknown, path = 'ledger'): ValidationResult<BudgetLedger> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (val.scope !== 'task' && val.scope !== 'run') {
    errors.push({ path: `${path}.scope`, message: 'Ledger scope must be task or run', code: 'INVALID_SCOPE' });
  }

  if (!['tokens', 'token', 'cost', 'repair', 'reviewer'].includes(val.kind as string)) {
    errors.push({ path: `${path}.kind`, message: 'Invalid ledger kind', code: 'INVALID_KIND' });
  }

  if (typeof val.limit !== 'number' || val.limit < 0) {
    errors.push({ path: `${path}.limit`, message: 'Ledger limit must be a non-negative number', code: 'INVALID_LIMIT' });
  }

  if (typeof val.consumed !== 'number' || val.consumed < 0) {
    errors.push({ path: `${path}.consumed`, message: 'Ledger consumed must be a non-negative number', code: 'INVALID_CONSUMED' });
  }

  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'Ledger reservations must be an array', code: 'INVALID_RESERVATIONS' });
  }

  if (typeof val.version !== 'number' || val.version < 1) {
    errors.push({ path: `${path}.version`, message: 'Ledger version must be >= 1', code: 'INVALID_VERSION' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as BudgetLedger };
}

export function validateReservationBundle(val: unknown, path = 'bundle'): ValidationResult<ReservationBundle> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.bundleId !== 'string' || !val.bundleId.trim()) {
    errors.push({ path: `${path}.bundleId`, message: 'bundleId must be a non-empty string', code: 'INVALID_BUNDLE_ID' });
  }

  if (typeof val.transactionRef !== 'string' || !val.transactionRef.trim()) {
    errors.push({ path: `${path}.transactionRef`, message: 'transactionRef must be a non-empty string', code: 'INVALID_TX_REF' });
  }

  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'reservations must be an array', code: 'INVALID_RESERVATIONS' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ReservationBundle };
}

export function validateApprovalRequestBinding(val: unknown, path = 'approval'): ValidationResult<ApprovalRequestBinding> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.requestId !== 'string' || !val.requestId.trim()) {
    errors.push({ path: `${path}.requestId`, message: 'requestId must be a non-empty string', code: 'INVALID_REQUEST_ID' });
  }

  if (typeof val.actionType !== 'string' || !val.actionType.trim()) {
    errors.push({ path: `${path}.actionType`, message: 'actionType must be a non-empty string', code: 'INVALID_ACTION_TYPE' });
  }

  if (!Array.isArray(val.targetFiles)) {
    errors.push({ path: `${path}.targetFiles`, message: 'targetFiles must be an array of strings', code: 'INVALID_TARGET_FILES' });
  }

  if (typeof val.normalizedActionDigest !== 'string' || !val.normalizedActionDigest.trim()) {
    errors.push({ path: `${path}.normalizedActionDigest`, message: 'normalizedActionDigest must be a non-empty string', code: 'INVALID_DIGEST' });
  }

  if (typeof val.repoCommit !== 'string' || val.repoCommit.length < 7) {
    errors.push({ path: `${path}.repoCommit`, message: 'repoCommit must be a valid commit hash', code: 'INVALID_COMMIT' });
  }

  if (typeof val.policyVersion !== 'string' || !val.policyVersion.trim()) {
    errors.push({ path: `${path}.policyVersion`, message: 'policyVersion must be a non-empty string', code: 'INVALID_POLICY' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ApprovalRequestBinding };
}

export function validateWorkspaceBaseline(val: unknown, path = 'workspaceBaseline'): ValidationResult<WorkspaceBaseline> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.commitHash !== 'string' || val.commitHash.length < 7) {
    errors.push({ path: `${path}.commitHash`, message: 'commitHash must be a valid commit hash string', code: 'INVALID_COMMIT' });
  }

  if (typeof val.branch !== 'string' || !val.branch.trim()) {
    errors.push({ path: `${path}.branch`, message: 'branch must be a non-empty string', code: 'INVALID_BRANCH' });
  }

  if (typeof val.isClean !== 'boolean') {
    errors.push({ path: `${path}.isClean`, message: 'isClean must be a boolean', code: 'INVALID_CLEAN_STATUS' });
  }

  if (typeof val.trackedFilesHash !== 'string' || !val.trackedFilesHash.trim()) {
    errors.push({ path: `${path}.trackedFilesHash`, message: 'trackedFilesHash must be a non-empty string', code: 'INVALID_FILES_HASH' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as WorkspaceBaseline };
}

export function validateTaskState(val: unknown, path = 'task'): ValidationResult<TaskState> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be a non-empty string', code: 'INVALID_TASK_ID' });
  }

  if (typeof val.runId !== 'string' || !val.runId.trim()) {
    errors.push({ path: `${path}.runId`, message: 'runId must be a non-empty string', code: 'INVALID_RUN_ID' });
  }

  if (!['feature', 'bugfix', 'refactor'].includes(val.taskType as string)) {
    errors.push({ path: `${path}.taskType`, message: 'taskType must be feature, bugfix, or refactor', code: 'INVALID_TASK_TYPE' });
  }

  if (typeof val.goal !== 'string' || !val.goal.trim()) {
    errors.push({ path: `${path}.goal`, message: 'goal must be a non-empty string', code: 'INVALID_GOAL' });
  }

  if (!Array.isArray(val.acceptanceCriteria)) {
    errors.push({ path: `${path}.acceptanceCriteria`, message: 'acceptanceCriteria must be an array', code: 'INVALID_CRITERIA' });
  }

  if (!Array.isArray(val.constraints)) {
    errors.push({ path: `${path}.constraints`, message: 'constraints must be an array', code: 'INVALID_CONSTRAINTS' });
  }

  if (!Array.isArray(val.plan)) {
    errors.push({ path: `${path}.plan`, message: 'plan must be an array of steps', code: 'INVALID_PLAN' });
  } else {
    val.plan.forEach((step, idx) => {
      const stepRes = validatePlanStep(step, `${path}.plan[${idx}]`);
      if (!stepRes.ok) errors.push(...stepRes.errors);
    });
  }

  if (!['pending', 'running', 'waiting_approval', 'completed', 'failed'].includes(val.status as string)) {
    errors.push({ path: `${path}.status`, message: 'status must be a valid task status', code: 'INVALID_STATUS' });
  }

  if (typeof val.stateVersion !== 'number' || val.stateVersion < 1) {
    errors.push({ path: `${path}.stateVersion`, message: 'stateVersion must be >= 1', code: 'INVALID_VERSION' });
  }

  if (!Array.isArray(val.budgetLedgers)) {
    errors.push({ path: `${path}.budgetLedgers`, message: 'budgetLedgers must be an array', code: 'INVALID_LEDGERS' });
  } else {
    val.budgetLedgers.forEach((ledger, idx) => {
      const ledgerRes = validateBudgetLedger(ledger, `${path}.budgetLedgers[${idx}]`);
      if (!ledgerRes.ok) errors.push(...ledgerRes.errors);
    });
  }

  if (val.workspaceBaseline !== undefined) {
    const wsRes = validateWorkspaceBaseline(val.workspaceBaseline, `${path}.workspaceBaseline`);
    if (!wsRes.ok) errors.push(...wsRes.errors);
  } else {
    errors.push({ path: `${path}.workspaceBaseline`, message: 'workspaceBaseline is required', code: 'REQUIRED_FIELD' });
  }

  if (val.pendingApproval !== undefined) {
    const appRes = validateApprovalRequestBinding(val.pendingApproval, `${path}.pendingApproval`);
    if (!appRes.ok) errors.push(...appRes.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as TaskState };
}

export function validateCheckpointRecord(val: unknown, path = 'checkpoint'): ValidationResult<CheckpointRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  if (typeof val.checkpointId !== 'string' || !val.checkpointId.trim()) {
    errors.push({ path: `${path}.checkpointId`, message: 'checkpointId must be a non-empty string', code: 'INVALID_CHECKPOINT_ID' });
  }

  if (typeof val.checksum !== 'string' || !val.checksum.trim()) {
    errors.push({ path: `${path}.checksum`, message: 'checksum must be a non-empty string', code: 'INVALID_CHECKSUM' });
  }

  const stateRes = validateTaskState(val.state, `${path}.state`);
  if (!stateRes.ok) errors.push(...stateRes.errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CheckpointRecord };
}
