/**
 * UC-03 v0.2.0 Atomic Admission Validators.
 *
 * Entrypoint for v0.2 atomic admission validation.
 * Cohesive validators are organized in ./admission-v02/:
 *  - repository.ts: validateRepositoryAdmissionV02
 *  - provider.ts: validateProviderAdmissionV02, computeRequestContentDigest
 */

import { computeCanonicalSha256 } from './identity.ts';
import {
  computeRequestContentDigest,
  validateProviderAdmissionV02,
} from './admission-v02/provider.ts';
import { validateRepositoryAdmissionV02 } from './admission-v02/repository.ts';
import type { AdmissionContextV02 } from './ports-v02.ts';
import type { ValidationResult } from './types.ts';
import { isPlainObject } from './validation/common.ts';

export {
  computeRequestContentDigest,
  validateProviderAdmissionV02,
  validateRepositoryAdmissionV02,
};

/**
 * Recompute admission digest over canonical admission context.
 */
export function computeAdmissionDigest(context: unknown): string {
  if (!isPlainObject(context)) throw new Error('computeAdmissionDigest requires an object');
  const copy = { ...(context as Record<string, unknown>) };
  delete copy['admissionDigest'];
  return computeCanonicalSha256(copy);
}

/**
 * Validate any v0.2 admission context (tagged union).
 */
export function validateAdmissionV02(
  input: unknown
): ValidationResult<AdmissionContextV02> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        {
          path: 'context',
          message: 'Admission context must be an object',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }

  if (input['subjectKind'] === 'repository-action') {
    return validateRepositoryAdmissionV02(input);
  }
  if (input['subjectKind'] === 'provider-request') {
    return validateProviderAdmissionV02(input);
  }

  return {
    ok: false,
    errors: [
      {
        path: 'subjectKind',
        message: 'subjectKind must be either "repository-action" or "provider-request"',
        code: 'INVALID_SUBJECT_KIND',
      },
    ],
  };
}
