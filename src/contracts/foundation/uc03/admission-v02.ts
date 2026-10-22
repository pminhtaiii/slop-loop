/**
 * UC-03 v0.2.0 Atomic Admission Validators.
 *
 * SUT for atomic admission validation covering repository actions and provider requests.
 * T037: Neutral fail-closed validator bodies with real exported SUT;
 *       positive assertions fail behaviorally.
 * T038: Full implementation turning positive assertions green.
 */

import { computeCanonicalSha256 } from './identity.ts';
import type {
  AdmissionContextV02,
  ProviderAdmissionContextV02,
  RepositoryAdmissionContextV02,
} from './ports-v02.ts';
import type { ValidationError, ValidationResult } from './types.ts';
import { isPlainObject } from './validation/common.ts';

/**
 * Recompute canonical requestContentDigest from immutable ProviderRequest envelope.
 * Excludes mutable dispatch state, observed usage, uncertain reason, and reservation ref.
 */
export function computeRequestContentDigest(request: unknown): string {
  if (!isPlainObject(request)) {
    throw new Error('computeRequestContentDigest requires an object');
  }
  const envelope: Record<string, unknown> = {
    providerRequestId: request['providerRequestId'],
    taskId: request['taskId'],
    runId: request['runId'],
    role: request['role'],
    purpose: request['purpose'],
    providerId: request['providerId'],
    modelId: request['modelId'],
    configId: request['configId'],
    pricingPolicyId: request['pricingPolicyId'],
    contextDigest: request['contextDigest'],
    timeoutMs: request['timeoutMs'],
    maxInputTokens: request['maxInputTokens'],
    maxOutputTokens: request['maxOutputTokens'],
    maxBillableTokens: request['maxBillableTokens'],
    maxCostUsd: request['maxCostUsd'],
  };
  return computeCanonicalSha256(envelope);
}

/**
 * Recompute admission digest over canonical admission context.
 */
export function computeAdmissionDigest(context: unknown): string {
  if (!isPlainObject(context)) {
    throw new Error('computeAdmissionDigest requires an object');
  }
  const copy = { ...(context as Record<string, unknown>) };
  delete copy['admissionDigest'];
  return computeCanonicalSha256(copy);
}

/**
 * Validate repository action admission context (v0.2).
 * T037: SUT neutral fail-closed validator.
 */
export function validateRepositoryAdmissionV02(
  input: unknown
): ValidationResult<RepositoryAdmissionContextV02> {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        {
          path: 'context',
          message: 'Repository admission context must be a plain object',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }

  // Cross-branch rejection: provider fields on repository context
  if (
    input['providerRequestId'] !== undefined ||
    input['requestContentDigest'] !== undefined ||
    input['providerRequest'] !== undefined ||
    input['providerAdmissionReceipt'] !== undefined ||
    input['requestReservationReceipt'] !== undefined ||
    input['budgetRefs'] !== undefined
  ) {
    errors.push({
      path: 'context',
      message: 'Provider-branch fields are forbidden on repository admission context',
      code: 'CROSS_BRANCH_FIELDS_FORBIDDEN',
    });
    return { ok: false, errors };
  }

  // Basic structure checks
  if (input['schemaVersion'] !== '0.2.0') {
    errors.push({
      path: 'schemaVersion',
      message: 'schemaVersion must be "0.2.0"',
      code: 'INVALID_SCHEMA_VERSION',
    });
    return { ok: false, errors };
  }

  if (input['subjectKind'] !== 'repository-action') {
    errors.push({
      path: 'subjectKind',
      message: 'subjectKind must be "repository-action"',
      code: 'INVALID_SUBJECT_KIND',
    });
    return { ok: false, errors };
  }

  // T037 neutral fail-closed: even structurally candidate inputs fail behaviorally
  errors.push({
    path: 'admission',
    message: 'T037_NEUTRAL_FAIL_CLOSED: SUT neutral fail-closed validator; green implementation in T038',
    code: 'SUT_NEUTRAL_FAIL_CLOSED',
  });
  return { ok: false, errors };
}

/**
 * Validate provider request admission context (v0.2).
 * T037: SUT neutral fail-closed validator.
 */
export function validateProviderAdmissionV02(
  input: unknown
): ValidationResult<ProviderAdmissionContextV02> {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [
        {
          path: 'context',
          message: 'Provider admission context must be a plain object',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }

  // Cross-branch rejection: repository fields on provider context
  if (
    input['action'] !== undefined ||
    input['actionDigest'] !== undefined ||
    input['commandView'] !== undefined ||
    input['policyEvaluationReceipt'] !== undefined ||
    input['actionDecisionReceipt'] !== undefined ||
    input['patchDigest'] !== undefined ||
    input['baseRevision'] !== undefined
  ) {
    errors.push({
      path: 'context',
      message: 'Repository-branch fields are forbidden on provider admission context',
      code: 'CROSS_BRANCH_FIELDS_FORBIDDEN',
    });
    return { ok: false, errors };
  }

  if (input['schemaVersion'] !== '0.2.0') {
    errors.push({
      path: 'schemaVersion',
      message: 'schemaVersion must be "0.2.0"',
      code: 'INVALID_SCHEMA_VERSION',
    });
    return { ok: false, errors };
  }

  if (input['subjectKind'] !== 'provider-request') {
    errors.push({
      path: 'subjectKind',
      message: 'subjectKind must be "provider-request"',
      code: 'INVALID_SUBJECT_KIND',
    });
    return { ok: false, errors };
  }

  // T037 neutral fail-closed: even structurally candidate inputs fail behaviorally
  errors.push({
    path: 'admission',
    message: 'T037_NEUTRAL_FAIL_CLOSED: SUT neutral fail-closed validator; green implementation in T038',
    code: 'SUT_NEUTRAL_FAIL_CLOSED',
  });
  return { ok: false, errors };
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
          message: 'Admission context must be a plain object',
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
