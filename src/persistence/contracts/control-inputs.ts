import type {
  ClaimDispatchInput,
  PauseTaskInput,
  ResumeTaskInput,
  RecordAndSettleInput,
  RecoverTaskInput,
  ValidationResult,
  ValidationError,
} from './types.ts';
import { isObject, checkStr, checkNum, checkInt } from './validation.ts';
import { validateWorkspaceBaseline } from './task.ts';

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
