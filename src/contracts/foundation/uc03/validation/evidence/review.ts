/** Review finding, result, and admission validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../../identity.ts';
import type { ReviewAdmissionContext, ReviewFinding, ReviewResult, ReviewSeverity, ReviewSide, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validatePositiveInteger } from '../common.ts';

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
