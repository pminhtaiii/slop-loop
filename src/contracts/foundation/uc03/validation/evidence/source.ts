/** Admitted source evidence validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../../identity.ts';
import type { SourceEvidence, SourceEvidenceLimits, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonNegativeInteger } from '../common.ts';

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
