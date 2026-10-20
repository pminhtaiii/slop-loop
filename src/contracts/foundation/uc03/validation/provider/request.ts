/** Provider request validation. */

import type { ProviderRequest, ProviderRequestValidationContext, ProviderUsage, ValidationError, ValidationResult } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateNonNegativeNumber, validatePositiveInteger } from '../common.ts';

import { validateProviderUsage } from './records.ts';

export const PROVIDER_REQUEST_ALLOWED_KEYS = [
  'providerRequestId',
  'taskId',
  'runId',
  'role',
  'purpose',
  'providerId',
  'modelId',
  'configId',
  'pricingPolicyId',
  'contextDigest',
  'timeoutMs',
  'maxInputTokens',
  'maxOutputTokens',
  'maxBillableTokens',
  'maxCostUsd',
  'reservationRef',
  'dispatchState',
  'observedUsage',
  'uncertainReason',
] as const;

export function validateProviderRequest(
  input: unknown,
  options?: ProviderRequestValidationContext
): ValidationResult<ProviderRequest> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'providerRequest', message: 'ProviderRequest must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PROVIDER_REQUEST_ALLOWED_KEYS, '', errors);

  const providerRequestId = validateNonEmptyString(input['providerRequestId'], 'providerRequestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);

  const role = input['role'];
  if (role !== 'coder' && role !== 'reviewer') {
    errors.push({
      path: 'role',
      message: 'role must be either "coder" or "reviewer"',
      code: 'INVALID_ROLE',
    });
  }

  const purpose = validateNonEmptyString(input['purpose'], 'purpose', errors);
  const providerId = validateNonEmptyString(input['providerId'], 'providerId', errors);
  const modelId = validateNonEmptyString(input['modelId'], 'modelId', errors);
  const configId = validateNonEmptyString(input['configId'], 'configId', errors);
  const pricingPolicyId = validateNonEmptyString(input['pricingPolicyId'], 'pricingPolicyId', errors);
  const contextDigest = validateNonEmptyString(input['contextDigest'], 'contextDigest', errors);

  const timeoutMs = validatePositiveInteger(input['timeoutMs'], 'timeoutMs', errors);
  const maxInputTokens = validateNonNegativeInteger(input['maxInputTokens'], 'maxInputTokens', errors);
  const maxOutputTokens = validateNonNegativeInteger(input['maxOutputTokens'], 'maxOutputTokens', errors);
  const maxBillableTokens = validateNonNegativeInteger(input['maxBillableTokens'], 'maxBillableTokens', errors);
  const maxCostUsd = validateNonNegativeNumber(input['maxCostUsd'], 'maxCostUsd', errors);

  if (
    maxBillableTokens !== undefined &&
    maxInputTokens !== undefined &&
    maxOutputTokens !== undefined &&
    maxBillableTokens < maxInputTokens + maxOutputTokens
  ) {
    errors.push({
      path: 'maxBillableTokens',
      message: `maxBillableTokens (${maxBillableTokens}) must include finite conservative overhead and cannot be less than maxInputTokens + maxOutputTokens (${maxInputTokens + maxOutputTokens})`,
      code: 'INVALID_BILLABLE_CEILING',
    });
  }

  const reservationRef = validateNonEmptyString(input['reservationRef'], 'reservationRef', errors);

  const validDispatchStates = ['reserved', 'dispatched', 'settled', 'uncertain'] as const;
  const dispatchState = input['dispatchState'] as 'reserved' | 'dispatched' | 'settled' | 'uncertain';
  if (!validDispatchStates.includes(dispatchState)) {
    errors.push({
      path: 'dispatchState',
      message: `dispatchState must be one of: ${validDispatchStates.join(', ')}`,
      code: 'INVALID_DISPATCH_STATE',
    });
  }

  let observedUsage: ProviderUsage | undefined;
  if (input['observedUsage'] !== undefined) {
    const usageRes = validateProviderUsage(input['observedUsage']);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    } else {
      observedUsage = usageRes.value;
    }
  }

  let uncertainReason: string | undefined;
  if (input['uncertainReason'] !== undefined) {
    uncertainReason = validateNonEmptyString(input['uncertainReason'], 'uncertainReason', errors);
  }

  // State-specific discrimination
  if (dispatchState === 'reserved') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A reserved ProviderRequest cannot have observedUsage set prior to dispatch and return',
        code: 'RESERVED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A reserved ProviderRequest cannot have uncertainReason set',
        code: 'RESERVED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'dispatched') {
    if (input['observedUsage'] !== undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A dispatched ProviderRequest cannot have observedUsage set while in flight',
        code: 'DISPATCHED_CANNOT_HAVE_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A dispatched ProviderRequest cannot have uncertainReason set',
        code: 'DISPATCHED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'settled') {
    if (input['observedUsage'] === undefined) {
      errors.push({
        path: 'observedUsage',
        message: 'A settled ProviderRequest requires observedUsage to be recorded',
        code: 'SETTLED_REQUIRES_USAGE',
      });
    }
    if (input['uncertainReason'] !== undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'A settled ProviderRequest cannot have uncertainReason set',
        code: 'SETTLED_CANNOT_HAVE_UNCERTAIN_REASON',
      });
    }
  } else if (dispatchState === 'uncertain') {
    if (input['uncertainReason'] === undefined) {
      errors.push({
        path: 'uncertainReason',
        message: 'An uncertain ProviderRequest requires uncertainReason explaining the interruption or timeout',
        code: 'UNCERTAIN_REQUIRES_REASON',
      });
    }
  }

  // Trusted expected request identity comparison
  if (options) {
    if (options.expectedTaskId !== undefined && options.expectedTaskId !== taskId) {
      errors.push({
        path: 'taskId',
        message: `Request taskId (${taskId}) does not match expected taskId (${options.expectedTaskId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRunId !== undefined && options.expectedRunId !== runId) {
      errors.push({
        path: 'runId',
        message: `Request runId (${runId}) does not match expected runId (${options.expectedRunId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedRole !== undefined && options.expectedRole !== role) {
      errors.push({
        path: 'role',
        message: `Request role (${role}) does not match expected role (${options.expectedRole})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPurpose !== undefined && options.expectedPurpose !== purpose) {
      errors.push({
        path: 'purpose',
        message: `Request purpose (${purpose}) does not match expected purpose (${options.expectedPurpose})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderId !== undefined && options.expectedProviderId !== providerId) {
      errors.push({
        path: 'providerId',
        message: `Request providerId (${providerId}) does not match expected providerId (${options.expectedProviderId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedModelId !== undefined && options.expectedModelId !== modelId) {
      errors.push({
        path: 'modelId',
        message: `Request modelId (${modelId}) does not match expected modelId (${options.expectedModelId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedConfigId !== undefined && options.expectedConfigId !== configId) {
      errors.push({
        path: 'configId',
        message: `Request configId (${configId}) does not match expected configId (${options.expectedConfigId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedPricingPolicyId !== undefined && options.expectedPricingPolicyId !== pricingPolicyId) {
      errors.push({
        path: 'pricingPolicyId',
        message: `Request pricingPolicyId (${pricingPolicyId}) does not match expected pricingPolicyId (${options.expectedPricingPolicyId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedContextDigest !== undefined && options.expectedContextDigest !== contextDigest) {
      errors.push({
        path: 'contextDigest',
        message: `Request contextDigest (${contextDigest}) does not match expected contextDigest (${options.expectedContextDigest})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
    if (options.expectedProviderRequestId !== undefined && options.expectedProviderRequestId !== providerRequestId) {
      errors.push({
        path: 'providerRequestId',
        message: `Request providerRequestId (${providerRequestId}) does not match expected providerRequestId (${options.expectedProviderRequestId})`,
        code: 'REQUEST_IDENTITY_MISMATCH',
      });
    }
  }

  if (typeof input['maxInputTokens'] === 'number' && typeof input['maxOutputTokens'] === 'number' && !Number.isSafeInteger(input['maxInputTokens'] + input['maxOutputTokens'])) errors.push({ path: 'maxBillableTokens', code: 'UNSAFE_COUNT_SUM', message: 'Token ceilings must remain safe integers' });
  if (
    errors.length > 0 ||
    !providerRequestId ||
    !taskId ||
    !runId ||
    (role !== 'coder' && role !== 'reviewer') ||
    !purpose ||
    !providerId ||
    !modelId ||
    !configId ||
    !pricingPolicyId ||
    !contextDigest ||
    timeoutMs === undefined ||
    maxInputTokens === undefined ||
    maxOutputTokens === undefined ||
    maxBillableTokens === undefined ||
    maxCostUsd === undefined ||
    !reservationRef ||
    !validDispatchStates.includes(dispatchState)
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      providerRequestId,
      taskId,
      runId,
      role,
      purpose,
      providerId,
      modelId,
      configId,
      pricingPolicyId,
      contextDigest,
      timeoutMs,
      maxInputTokens,
      maxOutputTokens,
      maxBillableTokens,
      maxCostUsd,
      reservationRef,
      dispatchState,
      ...(observedUsage !== undefined ? { observedUsage } : {}),
      ...(uncertainReason !== undefined ? { uncertainReason } : {}),
    },
  };
}
