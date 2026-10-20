/** Check results and baseline evidence validation. */

import type { Baseline, BaselineAdmissionContext, CheckOutcome, CheckResult, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonNegativeInteger } from '../common.ts';

export const CHECK_OUTCOMES = ['pass', 'fail', 'timeout', 'error', 'not-run'] as const;

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
