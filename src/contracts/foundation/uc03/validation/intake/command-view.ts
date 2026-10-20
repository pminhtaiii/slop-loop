/** Command-view and admitted-file validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../../identity.ts';
import type { AdmittedFile, CommandView, CommandViewValidationContext, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString } from '../common.ts';

const COMMAND_VIEW_ALLOWED_KEYS = [
  'viewId',
  'viewDigest',
  'taskId',
  'workspaceId',
  'canonicalRevisionDigest',
  'admittedFiles',
  'exclusionsPolicyVersion',
  'scratchIdentity',
  'mountedReadOnly',
] as const;

const ADMITTED_FILE_ALLOWED_KEYS = ['path', 'digest'] as const;

export function validateCommandView(
  input: unknown,
  options?: CommandViewValidationContext
): ValidationResult<CommandView> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'commandView', message: 'commandView must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, COMMAND_VIEW_ALLOWED_KEYS, '', errors);

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

      rejectUnknownKeys(file, ADMITTED_FILE_ALLOWED_KEYS, `admittedFiles[${i}]`, errors);

      const filePath = validateNonEmptyString(file['path'], `admittedFiles[${i}].path`, errors);
      const fileDigest = validateNonEmptyString(file['digest'], `admittedFiles[${i}].digest`, errors);

      if (filePath) {
        if (!isCanonicalRelativePath(filePath)) {
          errors.push({
            path: `admittedFiles[${i}].path`,
            message: `admittedFiles[${i}].path must be a canonical relative path: ${filePath}`,
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

        if (options?.trustedFileDigests !== undefined) {
          if (!(filePath in options.trustedFileDigests)) {
            errors.push({
              path: `admittedFiles[${i}]`,
              message: `Admitted file has no trusted evidence: ${filePath}`,
              code: 'UNTRUSTED_FILE_ADMISSION',
            });
          } else if (fileDigest && options.trustedFileDigests[filePath] !== fileDigest) {
            errors.push({
              path: `admittedFiles[${i}].digest`,
              message: `Admitted file digest mismatch for ${filePath}: expected ${options.trustedFileDigests[filePath]}, got ${fileDigest}`,
              code: 'FILE_DIGEST_MISMATCH',
            });
          }
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
    options?.currentExclusionsPolicyVersion !== undefined &&
    exclusionsPolicyVersion &&
    options.currentExclusionsPolicyVersion !== exclusionsPolicyVersion
  ) {
    errors.push({
      path: 'exclusionsPolicyVersion',
      message: `CommandView exclusionsPolicyVersion (${exclusionsPolicyVersion}) does not match current policy (${options.currentExclusionsPolicyVersion})`,
      code: 'STALE_EXCLUSIONS_POLICY',
    });
  }

  if (
    options?.expectedViewDigest !== undefined &&
    viewDigest &&
    options.expectedViewDigest !== viewDigest
  ) {
    errors.push({
      path: 'viewDigest',
      message: `CommandView viewDigest (${viewDigest}) does not match expected view digest (${options.expectedViewDigest})`,
      code: 'VIEW_DIGEST_MISMATCH',
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
