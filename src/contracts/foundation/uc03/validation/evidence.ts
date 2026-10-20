/** Check, baseline, verification, source, and review evidence validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../identity.ts';
import type { Baseline, BaselineAdmissionContext, CheckOutcome, CheckResult, ReviewAdmissionContext, ReviewFinding, ReviewResult, ReviewSeverity, ReviewSide, SourceEvidence, SourceEvidenceLimits, ValidationError, ValidationResult, VerificationAdmissionContext, VerificationPhase, VerificationResult } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonNegativeInteger, validatePositiveInteger, validateStringArray } from './common.ts';

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
