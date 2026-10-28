/** Verification result and admission validation. */

import type { CheckOutcome, ValidationError, ValidationResult, VerificationAdmissionContext, VerificationPhase, VerificationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateStringArray } from '../common.ts';
import { CHECK_OUTCOMES } from './baseline.ts';

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
