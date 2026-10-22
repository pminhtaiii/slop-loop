import {
  UC04_SCHEMA_VERSION,
  type BudgetLedger,
  type ReservationBundle,
  type DeliberatePauseRecord,
  type ApprovalRequestBinding,
  type CheckpointRecord,
  type ClaimDispatchInput,
  type PauseTaskInput,
  type ResumeTaskInput,
  type RecordAndSettleInput,
  type RecoverTaskInput,
  type ValidationResult,
  type ValidationError,
} from './types.ts';
import { validateTaskState, validateWorkspaceBaseline } from './task.ts';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
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
  if (typeof val.limit !== 'number' || !Number.isFinite(val.limit) || val.limit < 0) {
    errors.push({ path: `${path}.limit`, message: 'Ledger limit must be a non-negative finite number', code: 'INVALID_LIMIT' });
  }
  if (typeof val.consumed !== 'number' || !Number.isFinite(val.consumed) || val.consumed < 0) {
    errors.push({ path: `${path}.consumed`, message: 'Ledger consumed must be a non-negative finite number', code: 'INVALID_CONSUMED' });
  }
  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'Ledger reservations must be an array', code: 'INVALID_RESERVATIONS' });
  }
  if (typeof val.version !== 'number' || !Number.isInteger(val.version) || val.version < 1) {
    errors.push({ path: `${path}.version`, message: 'Ledger version must be an integer >= 1', code: 'INVALID_VERSION' });
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

export function validateDeliberatePauseRecord(val: unknown, path = 'deliberatePause'): ValidationResult<DeliberatePauseRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) {
    errors.push({ path: `${path}.taskId`, message: 'taskId must be non-empty', code: 'INVALID_TASK_ID' });
  }
  if (typeof val.active !== 'boolean') {
    errors.push({ path: `${path}.active`, message: 'active must be a boolean', code: 'INVALID_ACTIVE' });
  }
  if (typeof val.pauseKey !== 'string' || !val.pauseKey.trim()) {
    errors.push({ path: `${path}.pauseKey`, message: 'pauseKey must be non-empty', code: 'INVALID_PAUSE_KEY' });
  }
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) {
    errors.push({ path: `${path}.operatorRef`, message: 'operatorRef must be non-empty', code: 'INVALID_OPERATOR_REF' });
  }
  if (typeof val.acceptedAt !== 'string' || !val.acceptedAt.trim()) {
    errors.push({ path: `${path}.acceptedAt`, message: 'acceptedAt must be a valid timestamp string', code: 'INVALID_TIMESTAMP' });
  }
  if (typeof val.revision !== 'number' || !Number.isInteger(val.revision) || val.revision < 1) {
    errors.push({ path: `${path}.revision`, message: 'revision must be an integer >= 1', code: 'INVALID_REVISION' });
  }
  if (typeof val.epoch !== 'number' || !Number.isInteger(val.epoch) || val.epoch < 1) {
    errors.push({ path: `${path}.epoch`, message: 'epoch must be an integer >= 1', code: 'INVALID_EPOCH' });
  }
  if (val.resumeKey !== null && typeof val.resumeKey !== 'string') {
    errors.push({ path: `${path}.resumeKey`, message: 'resumeKey must be null or string', code: 'INVALID_RESUME_KEY' });
  }
  if (!Array.isArray(val.outstandingAttemptRefs)) {
    errors.push({ path: `${path}.outstandingAttemptRefs`, message: 'outstandingAttemptRefs must be array', code: 'INVALID_ATTEMPTS' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as DeliberatePauseRecord };
}

export function validateApprovalRequestBinding(val: unknown, path = 'approval'): ValidationResult<ApprovalRequestBinding> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.requestId !== 'string' || !val.requestId.trim()) {
    errors.push({ path: `${path}.requestId`, message: 'requestId required', code: 'INVALID_REQUEST_ID' });
  }
  if (typeof val.actionType !== 'string' || !val.actionType.trim()) {
    errors.push({ path: `${path}.actionType`, message: 'actionType required', code: 'INVALID_ACTION_TYPE' });
  }
  if (!Array.isArray(val.targetFiles)) {
    errors.push({ path: `${path}.targetFiles`, message: 'targetFiles must be array', code: 'INVALID_TARGET_FILES' });
  }
  if (typeof val.normalizedActionDigest !== 'string' || !val.normalizedActionDigest.trim()) {
    errors.push({ path: `${path}.normalizedActionDigest`, message: 'normalizedActionDigest required', code: 'INVALID_DIGEST' });
  }
  if (typeof val.repoCommit !== 'string' || val.repoCommit.length < 7) {
    errors.push({ path: `${path}.repoCommit`, message: 'repoCommit required', code: 'INVALID_COMMIT' });
  }
  if (typeof val.policyVersion !== 'string' || !val.policyVersion.trim()) {
    errors.push({ path: `${path}.policyVersion`, message: 'policyVersion required', code: 'INVALID_POLICY_VERSION' });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ApprovalRequestBinding };
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

export function validateClaimDispatchInput(val: unknown, path = 'claim'): ValidationResult<ClaimDispatchInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.runId !== 'string' || !val.runId.trim()) errors.push({ path: `${path}.runId`, message: 'runId required', code: 'INVALID_RUN_ID' });
  if (typeof val.stepId !== 'string' || !val.stepId.trim()) errors.push({ path: `${path}.stepId`, message: 'stepId required', code: 'INVALID_STEP_ID' });
  if (typeof val.actionId !== 'string' || !val.actionId.trim()) errors.push({ path: `${path}.actionId`, message: 'actionId required', code: 'INVALID_ACTION_ID' });
  if (typeof val.expectedEpoch !== 'number' || !Number.isInteger(val.expectedEpoch) || val.expectedEpoch < 1) errors.push({ path: `${path}.expectedEpoch`, message: 'expectedEpoch >= 1', code: 'INVALID_EPOCH' });
  if (typeof val.expectedStateVersion !== 'number' || !Number.isInteger(val.expectedStateVersion) || val.expectedStateVersion < 1) errors.push({ path: `${path}.expectedStateVersion`, message: 'expectedStateVersion >= 1', code: 'INVALID_VERSION' });
  if (!Array.isArray(val.requiredEvidenceRefs)) errors.push({ path: `${path}.requiredEvidenceRefs`, message: 'must be array', code: 'INVALID_REFS' });
  if (!Array.isArray(val.reservationRefs)) errors.push({ path: `${path}.reservationRefs`, message: 'must be array', code: 'INVALID_REFS' });
  if (typeof val.repoDigest !== 'string' || !val.repoDigest.trim()) errors.push({ path: `${path}.repoDigest`, message: 'repoDigest required', code: 'INVALID_DIGEST' });
  if (typeof val.policyVersion !== 'string' || !val.policyVersion.trim()) errors.push({ path: `${path}.policyVersion`, message: 'policyVersion required', code: 'INVALID_VERSION' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ClaimDispatchInput };
}

export function validatePauseTaskInput(val: unknown, path = 'pause'): ValidationResult<PauseTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.expectedRevision !== 'number' || !Number.isInteger(val.expectedRevision) || val.expectedRevision < 1) errors.push({ path: `${path}.expectedRevision`, message: 'expectedRevision >= 1', code: 'INVALID_REVISION' });
  if (typeof val.pauseKey !== 'string' || !val.pauseKey.trim()) errors.push({ path: `${path}.pauseKey`, message: 'pauseKey required', code: 'INVALID_PAUSE_KEY' });
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) errors.push({ path: `${path}.operatorRef`, message: 'operatorRef required', code: 'INVALID_OPERATOR_REF' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PauseTaskInput };
}

export function validateResumeTaskInput(val: unknown, path = 'resume'): ValidationResult<ResumeTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.expectedRevision !== 'number' || !Number.isInteger(val.expectedRevision) || val.expectedRevision < 1) errors.push({ path: `${path}.expectedRevision`, message: 'expectedRevision >= 1', code: 'INVALID_REVISION' });
  if (typeof val.resumeKey !== 'string' || !val.resumeKey.trim()) errors.push({ path: `${path}.resumeKey`, message: 'resumeKey required', code: 'INVALID_RESUME_KEY' });
  if (typeof val.operatorRef !== 'string' || !val.operatorRef.trim()) errors.push({ path: `${path}.operatorRef`, message: 'operatorRef required', code: 'INVALID_OPERATOR_REF' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ResumeTaskInput };
}

export function validateRecordAndSettleInput(val: unknown, path = 'settle'): ValidationResult<RecordAndSettleInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.runId !== 'string' || !val.runId.trim()) errors.push({ path: `${path}.runId`, message: 'runId required', code: 'INVALID_RUN_ID' });
  if (typeof val.claimId !== 'string' || !val.claimId.trim()) errors.push({ path: `${path}.claimId`, message: 'claimId required', code: 'INVALID_CLAIM_ID' });
  if (typeof val.requestId !== 'string' || !val.requestId.trim()) errors.push({ path: `${path}.requestId`, message: 'requestId required', code: 'INVALID_REQUEST_ID' });
  if (!['success', 'failure', 'uncertain'].includes(val.observedOutcome as string)) {
    errors.push({ path: `${path}.observedOutcome`, message: 'outcome must be success, failure, or uncertain', code: 'INVALID_OUTCOME' });
  }
  if (!isObject(val.observedUsage)) {
    errors.push({ path: `${path}.observedUsage`, message: 'observedUsage required', code: 'INVALID_USAGE' });
  }
  if (!Array.isArray(val.evidenceRefs)) errors.push({ path: `${path}.evidenceRefs`, message: 'evidenceRefs must be array', code: 'INVALID_REFS' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecordAndSettleInput };
}

export function validateRecoverTaskInput(val: unknown, path = 'recover'): ValidationResult<RecoverTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };
  if (typeof val.taskId !== 'string' || !val.taskId.trim()) errors.push({ path: `${path}.taskId`, message: 'taskId required', code: 'INVALID_TASK_ID' });
  if (typeof val.newRunId !== 'string' || !val.newRunId.trim()) errors.push({ path: `${path}.newRunId`, message: 'newRunId required', code: 'INVALID_RUN_ID' });
  const wsRes = validateWorkspaceBaseline(val.repoEvidence, `${path}.repoEvidence`);
  if (!wsRes.ok) errors.push(...wsRes.errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecoverTaskInput };
}
