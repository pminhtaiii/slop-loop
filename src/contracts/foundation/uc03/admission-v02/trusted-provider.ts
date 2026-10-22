import { computeCanonicalSha256 } from '../identity.ts';
import type { ProviderAdmissionTrustedContextV02 } from '../ports-v02.ts';
import type { ValidationError } from '../types.ts';
import { isPlainObject } from '../validation/common.ts';

const CONTEXT_KEYS = [
  'subjectKind', 'taskStateSchemaVersion', 'expectedTaskStateVersion', 'controlSchemaVersion',
  'expectedControlVersion', 'expectedEpoch', 'taskId', 'runId', 'runnableNode', 'planApplicability',
  'planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'role',
  'providerRequestId', 'requestContentDigest', 'providerAdmissionReceiptRef',
  'providerAdmissionReceiptDigest', 'requestReservationReceipt', 'budgetRefs', 'providerIdentity', 'requestLimits',
] as const;
const IDENTITY_KEYS = [
  'providerId', 'modelId', 'configId', 'configVersion', 'pricingPolicyId',
  'pricingPolicyVersion', 'issuerKeyRef', 'decisionAuthorityGeneration',
] as const;
const LIMIT_KEYS = [
  'timeoutMs', 'maxInputTokens', 'maxOutputTokens', 'maxBillableTokens', 'maxCostUsd', 'maxReviewerIterations',
] as const;

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const issue = (path: string, code: string): ValidationError => ({ path, message: 'Provider admission does not match trusted current facts', code });

export function isProviderAdmissionTrustedContextV02(value: unknown): value is ProviderAdmissionTrustedContextV02 {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !CONTEXT_KEYS.includes(key as typeof CONTEXT_KEYS[number]))) return false;
  if (value['subjectKind'] !== 'provider-request' || !['coder', 'reviewer'].includes(value['role'] as string)) return false;
  if (!['taskStateSchemaVersion', 'controlSchemaVersion', 'taskId', 'runId', 'runnableNode', 'providerRequestId',
    'requestContentDigest', 'providerAdmissionReceiptRef', 'providerAdmissionReceiptDigest',
    'requestReservationReceipt'].every((key) => text(value[key]))) return false;
  if (!['expectedTaskStateVersion', 'expectedControlVersion', 'expectedEpoch'].every((key) => nonNegativeInteger(value[key]))) return false;
  const applicability = value['planApplicability'];
  if (applicability === 'approved-plan') {
    if (!text(value['planBindingDigest']) || !text(value['planDecisionRef']) ||
      value['diagnosticPurpose'] !== undefined && !text(value['diagnosticPurpose']) ||
      value['taskCriteriaDigest'] !== undefined && !text(value['taskCriteriaDigest'])) return false;
  } else if (applicability === 'pre-plan-diagnostic') {
    if (value['runnableNode'] !== 'Investigate' || value['planBindingDigest'] !== undefined || value['planDecisionRef'] !== undefined ||
      !text(value['diagnosticPurpose']) || !text(value['taskCriteriaDigest'])) return false;
  } else return false;

  const budgets = value['budgetRefs'];
  if (!Array.isArray(budgets) || budgets.length === 0 || !budgets.every(text) || new Set(budgets).size !== budgets.length) return false;
  const identity = value['providerIdentity'];
  if (!isPlainObject(identity) || Object.keys(identity).some((key) => !IDENTITY_KEYS.includes(key as typeof IDENTITY_KEYS[number])) ||
    !IDENTITY_KEYS.filter((key) => key !== 'decisionAuthorityGeneration').every((key) => text(identity[key])) ||
    !positiveInteger(identity['decisionAuthorityGeneration'])) return false;
  const limits = value['requestLimits'];
  if (!isPlainObject(limits) || Object.keys(limits).some((key) => !LIMIT_KEYS.includes(key as typeof LIMIT_KEYS[number]))) return false;
  if (!['timeoutMs', 'maxInputTokens', 'maxOutputTokens', 'maxBillableTokens'].every((key) => positiveInteger(limits[key])) ||
    !positiveNumber(limits['maxCostUsd'])) return false;
  return value['role'] === 'reviewer'
    ? positiveInteger(limits['maxReviewerIterations'])
    : limits['maxReviewerIterations'] === undefined;
}

function sameRefs(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index]);
}

export function checkProviderAdmissionBindingsV02(
  input: Record<string, unknown>,
  trust: ProviderAdmissionTrustedContextV02,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const pairs: readonly [string, keyof ProviderAdmissionTrustedContextV02][] = [
    ['taskStateSchemaVersion', 'taskStateSchemaVersion'], ['expectedTaskStateVersion', 'expectedTaskStateVersion'],
    ['controlSchemaVersion', 'controlSchemaVersion'], ['expectedControlVersion', 'expectedControlVersion'],
    ['expectedEpoch', 'expectedEpoch'], ['taskId', 'taskId'], ['runId', 'runId'], ['runnableNode', 'runnableNode'],
    ['role', 'role'], ['providerRequestId', 'providerRequestId'], ['requestContentDigest', 'requestContentDigest'],
    ['planApplicability', 'planApplicability'],
  ];
  for (const [field, trustedField] of pairs) {
    if (input[field] !== trust[trustedField]) errors.push(issue(field, 'TRUSTED_CONTEXT_MISMATCH'));
  }
  const request = input['providerRequest'];
  const receipt = input['providerAdmissionReceipt'];
  const identity = input['providerIdentity'];
  if (!isPlainObject(request) || !isPlainObject(receipt) || !isPlainObject(identity)) return errors;

  for (const field of ['taskId', 'runId', 'role', 'providerRequestId'] as const) {
    if (request[field] !== trust[field]) errors.push(issue(`providerRequest.${field}`, 'PROVIDER_REQUEST_BINDING_MISMATCH'));
  }
  if (request['reservationRef'] !== trust.requestReservationReceipt) errors.push(issue('providerRequest.reservationRef', 'RESERVATION_BINDING_MISMATCH'));
  if (request['requestContentDigest'] !== undefined) errors.push(issue('providerRequest.requestContentDigest', 'UNKNOWN_PROVIDER_REQUEST_FIELD'));
  const receiptPairs: readonly [string, string][] = [
    ['receiptId', trust.providerAdmissionReceiptRef], ['receiptDigest', trust.providerAdmissionReceiptDigest],
    ['providerRequestId', trust.providerRequestId], ['role', trust.role], ['requestContentDigest', trust.requestContentDigest],
  ];
  for (const [field, expected] of receiptPairs) if (receipt[field] !== expected) errors.push(issue(`providerAdmissionReceipt.${field}`, 'PROVIDER_RECEIPT_BINDING_MISMATCH'));
  if (computeCanonicalSha256(identity) !== computeCanonicalSha256(trust.providerIdentity)) errors.push(issue('providerIdentity', 'PROVIDER_IDENTITY_MISMATCH'));
  if (input['requestReservationReceipt'] !== trust.requestReservationReceipt) errors.push(issue('requestReservationReceipt', 'RESERVATION_BINDING_MISMATCH'));
  if (!sameRefs(input['budgetRefs'], trust.budgetRefs)) errors.push(issue('budgetRefs', 'BUDGET_REFS_MISMATCH'));

  const declared = input['finiteBounds'];
  if (!isPlainObject(declared)) return errors;
  const requestFields = ['maxInputTokens', 'maxOutputTokens', 'maxBillableTokens', 'maxCostUsd'] as const;
  for (const field of requestFields) {
    const requestValue = request[field];
    const bound = declared[field];
    const ceiling = trust.requestLimits[field];
    if (typeof requestValue !== 'number' || typeof bound !== 'number' || typeof ceiling !== 'number' ||
      requestValue > bound || bound > ceiling) errors.push(issue(`finiteBounds.${field}`, 'PROVIDER_BOUND_EXCEEDED'));
  }
  if (typeof request['timeoutMs'] !== 'number' || request['timeoutMs'] > trust.requestLimits.timeoutMs) {
    errors.push(issue('providerRequest.timeoutMs', 'PROVIDER_BOUND_EXCEEDED'));
  }
  if (trust.role === 'reviewer') {
    if (typeof declared['maxReviewerIterations'] !== 'number' || declared['maxReviewerIterations'] <= 0 ||
      declared['maxReviewerIterations'] > (trust.requestLimits.maxReviewerIterations ?? 0)) {
      errors.push(issue('finiteBounds.maxReviewerIterations', 'PROVIDER_BOUND_EXCEEDED'));
    }
  } else if (declared['maxReviewerIterations'] !== undefined) {
    errors.push(issue('finiteBounds.maxReviewerIterations', 'ROLE_BOUND_FORBIDDEN'));
  }

  if (trust.planApplicability === 'approved-plan') {
    for (const field of ['planBindingDigest', 'planDecisionRef'] as const) {
      if (input[field] !== trust[field]) errors.push(issue(field, 'PLAN_BINDING_MISMATCH'));
    }
    for (const field of ['diagnosticPurpose', 'taskCriteriaDigest'] as const) {
      if (Object.hasOwn(input, field) !== (trust[field] !== undefined) || input[field] !== trust[field]) errors.push(issue(field, 'DIAGNOSTIC_SCOPE_MISMATCH'));
    }
  } else {
    if (input['diagnosticPurpose'] !== trust.diagnosticPurpose) errors.push(issue('diagnosticPurpose', 'DIAGNOSTIC_PURPOSE_MISMATCH'));
    if (input['taskCriteriaDigest'] !== trust.taskCriteriaDigest) errors.push(issue('taskCriteriaDigest', 'TASK_CRITERIA_MISMATCH'));
  }
  return errors;
}
