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

function checkStr(errors: ValidationError[], val: unknown, path: string, message: string, code: string): void {
  if (typeof val !== 'string' || !val.trim()) errors.push({ path, message, code });
}

function checkNum(errors: ValidationError[], val: unknown, path: string, message: string, code: string, min = 0): void {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min) errors.push({ path, message, code });
}

function checkInt(errors: ValidationError[], val: unknown, path: string, message: string, code: string, min = 1): void {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min) errors.push({ path, message, code });
}

export function validateBudgetLedger(val: unknown, path = 'ledger'): ValidationResult<BudgetLedger> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  if (val.scope !== 'task' && val.scope !== 'run') {
    errors.push({ path: `${path}.scope`, message: 'Ledger scope must be task or run', code: 'INVALID_SCOPE' });
  }
  if (!['tokens', 'token', 'cost', 'repair', 'reviewer'].includes(val.kind as string)) {
    errors.push({ path: `${path}.kind`, message: 'Invalid ledger kind', code: 'INVALID_KIND' });
  }
  checkNum(errors, val.limit, `${path}.limit`, 'Ledger limit must be a non-negative finite number', 'INVALID_LIMIT');
  checkNum(errors, val.consumed, `${path}.consumed`, 'Ledger consumed must be a non-negative finite number', 'INVALID_CONSUMED');

  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'Ledger reservations must be an array', code: 'INVALID_RESERVATIONS' });
  } else {
    for (let i = 0; i < val.reservations.length; i++) {
      const res = val.reservations[i];
      if (!isObject(res)) {
        errors.push({ path: `${path}.reservations[${i}]`, message: 'Reservation item must be an object', code: 'INVALID_TYPE' });
        continue;
      }
      checkStr(errors, res.reservationId, `${path}.reservations[${i}].reservationId`, 'reservationId must be a non-empty string', 'INVALID_RESERVATION_ID');
      checkStr(errors, res.keyedId, `${path}.reservations[${i}].keyedId`, 'keyedId must be a non-empty string', 'INVALID_KEYED_ID');
      checkNum(errors, res.amount, `${path}.reservations[${i}].amount`, 'amount must be a non-negative finite number', 'INVALID_AMOUNT');
    }
  }
  checkStr(errors, val.configurationId, `${path}.configurationId`, 'configurationId must be a non-empty string', 'INVALID_CONFIG_ID');
  checkInt(errors, val.version, `${path}.version`, 'Ledger version must be an integer >= 1', 'INVALID_VERSION');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as BudgetLedger };
}

export function validateReservationBundle(val: unknown, path = 'bundle'): ValidationResult<ReservationBundle> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.bundleId, `${path}.bundleId`, 'bundleId must be a non-empty string', 'INVALID_BUNDLE_ID');
  checkStr(errors, val.transactionRef, `${path}.transactionRef`, 'transactionRef must be a non-empty string', 'INVALID_TX_REF');
  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be a non-empty string', 'INVALID_TASK_ID');
  checkStr(errors, val.runId, `${path}.runId`, 'runId must be a non-empty string', 'INVALID_RUN_ID');

  if (!Array.isArray(val.reservations)) {
    errors.push({ path: `${path}.reservations`, message: 'reservations must be an array', code: 'INVALID_RESERVATIONS' });
  } else {
    for (let i = 0; i < val.reservations.length; i++) {
      const item = val.reservations[i];
      if (!isObject(item)) {
        errors.push({ path: `${path}.reservations[${i}]`, message: 'Reservation bundle item must be an object', code: 'INVALID_TYPE' });
        continue;
      }
      checkStr(errors, item.ledgerIdentity, `${path}.reservations[${i}].ledgerIdentity`, 'ledgerIdentity must be non-empty', 'INVALID_LEDGER_ID');
      if (item.scope !== 'task' && item.scope !== 'run') {
        errors.push({ path: `${path}.reservations[${i}].scope`, message: 'scope must be task or run', code: 'INVALID_SCOPE' });
      }
      if (!['tokens', 'token', 'cost', 'repair', 'reviewer'].includes(item.kind as string)) {
        errors.push({ path: `${path}.reservations[${i}].kind`, message: 'invalid kind', code: 'INVALID_KIND' });
      }
      checkStr(errors, item.configurationId, `${path}.reservations[${i}].configurationId`, 'configurationId must be non-empty', 'INVALID_CONFIG_ID');
      checkInt(errors, item.version, `${path}.reservations[${i}].version`, 'version must be an integer >= 1', 'INVALID_VERSION');
      checkStr(errors, item.requestId, `${path}.reservations[${i}].requestId`, 'requestId must be non-empty', 'INVALID_REQUEST_ID');
      checkNum(errors, item.amount, `${path}.reservations[${i}].amount`, 'amount must be a positive finite number', 'INVALID_AMOUNT', 0.000001);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ReservationBundle };
}

export function validateDeliberatePauseRecord(val: unknown, path = 'deliberatePause'): ValidationResult<DeliberatePauseRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  if (val.schemaVersion !== UC04_SCHEMA_VERSION) {
    errors.push({ path: `${path}.schemaVersion`, message: `Expected schema version ${UC04_SCHEMA_VERSION}`, code: 'INCOMPATIBLE_VERSION' });
  }
  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be non-empty', 'INVALID_TASK_ID');
  if (typeof val.active !== 'boolean') {
    errors.push({ path: `${path}.active`, message: 'active must be a boolean', code: 'INVALID_ACTIVE' });
  }
  checkStr(errors, val.pauseKey, `${path}.pauseKey`, 'pauseKey must be non-empty', 'INVALID_PAUSE_KEY');
  checkStr(errors, val.operatorRef, `${path}.operatorRef`, 'operatorRef must be non-empty', 'INVALID_OPERATOR_REF');
  checkStr(errors, val.acceptedAt, `${path}.acceptedAt`, 'acceptedAt must be a valid timestamp string', 'INVALID_TIMESTAMP');
  checkInt(errors, val.revision, `${path}.revision`, 'revision must be an integer >= 1', 'INVALID_REVISION');
  checkInt(errors, val.epoch, `${path}.epoch`, 'epoch must be an integer >= 1', 'INVALID_EPOCH');

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
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.requestId, `${path}.requestId`, 'requestId required', 'INVALID_REQUEST_ID');
  checkStr(errors, val.actionType, `${path}.actionType`, 'actionType required', 'INVALID_ACTION_TYPE');
  if (!Array.isArray(val.targetFiles)) {
    errors.push({ path: `${path}.targetFiles`, message: 'targetFiles must be array', code: 'INVALID_TARGET_FILES' });
  }
  checkStr(errors, val.normalizedActionDigest, `${path}.normalizedActionDigest`, 'normalizedActionDigest required', 'INVALID_DIGEST');
  if (typeof val.repoCommit !== 'string' || val.repoCommit.length < 7) {
    errors.push({ path: `${path}.repoCommit`, message: 'repoCommit required', code: 'INVALID_COMMIT' });
  }
  checkStr(errors, val.policyVersion, `${path}.policyVersion`, 'policyVersion required', 'INVALID_POLICY_VERSION');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ApprovalRequestBinding };
}

export function validateCheckpointRecord(val: unknown, path = 'checkpoint'): ValidationResult<CheckpointRecord> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.checkpointId, `${path}.checkpointId`, 'checkpointId must be a non-empty string', 'INVALID_CHECKPOINT_ID');
  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId must be a non-empty string', 'INVALID_TASK_ID');
  checkStr(errors, val.runId, `${path}.runId`, 'runId must be a non-empty string', 'INVALID_RUN_ID');
  checkInt(errors, val.stepIndex, `${path}.stepIndex`, 'stepIndex must be a non-negative integer', 'INVALID_STEP_INDEX', 0);
  checkInt(errors, val.stateVersion, `${path}.stateVersion`, 'stateVersion must be an integer >= 1', 'INVALID_STATE_VERSION', 1);
  checkStr(errors, val.timestamp, `${path}.timestamp`, 'timestamp must be a non-empty string', 'INVALID_TIMESTAMP');
  checkStr(errors, val.checksum, `${path}.checksum`, 'checksum must be a non-empty string', 'INVALID_CHECKSUM');

  const stateRes = validateTaskState(val.state, `${path}.state`);
  if (!stateRes.ok) {
    errors.push(...stateRes.errors);
  } else {
    if (val.taskId !== stateRes.value.taskId) {
      errors.push({ path: `${path}.taskId`, message: `checkpoint taskId (${String(val.taskId)}) must match state taskId (${stateRes.value.taskId})`, code: 'INCOHERENT_CHECKPOINT' });
    }
    if (val.runId !== stateRes.value.runId) {
      errors.push({ path: `${path}.runId`, message: `checkpoint runId (${String(val.runId)}) must match state runId (${stateRes.value.runId})`, code: 'INCOHERENT_CHECKPOINT' });
    }
    if (val.stepIndex !== stateRes.value.currentStepIndex) {
      errors.push({ path: `${path}.stepIndex`, message: `checkpoint stepIndex (${String(val.stepIndex)}) must match state currentStepIndex (${stateRes.value.currentStepIndex})`, code: 'INCOHERENT_CHECKPOINT' });
    }
    if (val.stateVersion !== stateRes.value.stateVersion) {
      errors.push({ path: `${path}.stateVersion`, message: `checkpoint stateVersion (${String(val.stateVersion)}) must match state stateVersion (${stateRes.value.stateVersion})`, code: 'INCOHERENT_CHECKPOINT' });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as CheckpointRecord };
}

export function validateClaimDispatchInput(val: unknown, path = 'claim'): ValidationResult<ClaimDispatchInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId required', 'INVALID_TASK_ID');
  checkStr(errors, val.runId, `${path}.runId`, 'runId required', 'INVALID_RUN_ID');
  checkStr(errors, val.stepId, `${path}.stepId`, 'stepId required', 'INVALID_STEP_ID');
  checkStr(errors, val.actionId, `${path}.actionId`, 'actionId required', 'INVALID_ACTION_ID');
  checkInt(errors, val.expectedEpoch, `${path}.expectedEpoch`, 'expectedEpoch >= 1', 'INVALID_EPOCH');
  checkInt(errors, val.expectedStateVersion, `${path}.expectedStateVersion`, 'expectedStateVersion >= 1', 'INVALID_VERSION');
  if (!Array.isArray(val.requiredEvidenceRefs)) errors.push({ path: `${path}.requiredEvidenceRefs`, message: 'must be array', code: 'INVALID_REFS' });
  if (!Array.isArray(val.reservationRefs)) errors.push({ path: `${path}.reservationRefs`, message: 'must be array', code: 'INVALID_REFS' });
  checkStr(errors, val.repoDigest, `${path}.repoDigest`, 'repoDigest required', 'INVALID_DIGEST');
  checkStr(errors, val.policyVersion, `${path}.policyVersion`, 'policyVersion required', 'INVALID_VERSION');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ClaimDispatchInput };
}

export function validatePauseTaskInput(val: unknown, path = 'pause'): ValidationResult<PauseTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId required', 'INVALID_TASK_ID');
  checkInt(errors, val.expectedRevision, `${path}.expectedRevision`, 'expectedRevision >= 1', 'INVALID_REVISION');
  checkStr(errors, val.pauseKey, `${path}.pauseKey`, 'pauseKey required', 'INVALID_PAUSE_KEY');
  checkStr(errors, val.operatorRef, `${path}.operatorRef`, 'operatorRef required', 'INVALID_OPERATOR_REF');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as PauseTaskInput };
}

export function validateResumeTaskInput(val: unknown, path = 'resume'): ValidationResult<ResumeTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId required', 'INVALID_TASK_ID');
  checkInt(errors, val.expectedRevision, `${path}.expectedRevision`, 'expectedRevision >= 1', 'INVALID_REVISION');
  checkStr(errors, val.resumeKey, `${path}.resumeKey`, 'resumeKey required', 'INVALID_RESUME_KEY');
  checkStr(errors, val.operatorRef, `${path}.operatorRef`, 'operatorRef required', 'INVALID_OPERATOR_REF');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as ResumeTaskInput };
}

export function validateRecordAndSettleInput(val: unknown, path = 'settle'): ValidationResult<RecordAndSettleInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId required', 'INVALID_TASK_ID');
  checkStr(errors, val.runId, `${path}.runId`, 'runId required', 'INVALID_RUN_ID');
  checkStr(errors, val.claimId, `${path}.claimId`, 'claimId required', 'INVALID_CLAIM_ID');
  checkStr(errors, val.requestId, `${path}.requestId`, 'requestId required', 'INVALID_REQUEST_ID');

  if (!['success', 'failure', 'uncertain'].includes(val.observedOutcome as string)) {
    errors.push({ path: `${path}.observedOutcome`, message: 'outcome must be success, failure, or uncertain', code: 'INVALID_OUTCOME' });
  }
  if (!isObject(val.observedUsage)) {
    errors.push({ path: `${path}.observedUsage`, message: 'observedUsage required', code: 'INVALID_USAGE' });
  } else {
    const u = val.observedUsage;
    checkNum(errors, u.inputTokens, `${path}.observedUsage.inputTokens`, 'inputTokens must be a non-negative finite number', 'INVALID_USAGE');
    checkNum(errors, u.outputTokens, `${path}.observedUsage.outputTokens`, 'outputTokens must be a non-negative finite number', 'INVALID_USAGE');
    checkNum(errors, u.costUsd, `${path}.observedUsage.costUsd`, 'costUsd must be a non-negative finite number', 'INVALID_USAGE');
    if (u.billableTokens !== undefined) {
      checkNum(errors, u.billableTokens, `${path}.observedUsage.billableTokens`, 'billableTokens must be a non-negative finite number', 'INVALID_USAGE');
    }
  }
  if (!Array.isArray(val.evidenceRefs)) errors.push({ path: `${path}.evidenceRefs`, message: 'evidenceRefs must be array', code: 'INVALID_REFS' });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecordAndSettleInput };
}

export function validateRecoverTaskInput(val: unknown, path = 'recover'): ValidationResult<RecoverTaskInput> {
  const errors: ValidationError[] = [];
  if (!isObject(val)) return { ok: false, errors: [{ path, message: `${path} must be object`, code: 'INVALID_TYPE' }] };

  checkStr(errors, val.taskId, `${path}.taskId`, 'taskId required', 'INVALID_TASK_ID');
  checkStr(errors, val.newRunId, `${path}.newRunId`, 'newRunId required', 'INVALID_RUN_ID');
  const wsRes = validateWorkspaceBaseline(val.repoEvidence, `${path}.repoEvidence`);
  if (!wsRes.ok) errors.push(...wsRes.errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: val as unknown as RecoverTaskInput };
}
