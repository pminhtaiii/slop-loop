import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../versions.ts';
import type { ActionDecisionReceipt, ClaimClosureReceipt, PolicyEvaluationReceipt, ProviderAdmissionReceipt } from './types.ts';
import { computeActionDecisionReceiptDigest, computeClaimClosureReceiptDigest, computePolicyEvaluationReceiptDigest, computeProviderAdmissionReceiptDigest } from './digests.ts';
import { ACTION_DECISION_RECEIPT_KEYS, CLAIM_CLOSURE_RECEIPT_KEYS, EXECUTOR_IDENTITY_KEYS, NO_ATTEMPT_PROOF_KEYS, PAUSE_OR_DENIAL_EVENT_KEYS, POLICY_EVALUATION_RECEIPT_KEYS, PROVIDER_ADMISSION_RECEIPT_KEYS, RESERVATION_DISPOSITION_KEYS, validateNonNegativeInteger } from './validation.ts';
import { addError, hasNonEmptyString, invalidObject, isBoundedDenseArray, isRecord, rejectUnknownKeys, validateBoundedText, validateDigest, validateId, validatePositiveInteger, validateVersionString } from '../v01/validation.ts';

export function validatePolicyEvaluationReceipt(input: unknown): ValidationResult<PolicyEvaluationReceipt> {
  const path = 'policyEvaluationReceipt';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];

  for (const k of ['providerRequestId', 'requestContentDigest', 'role', 'modelId', 'planBindingDigest', 'planDecisionRef'] as const) {
    if (Object.hasOwn(input, k)) {
      addError(errors, `${path}.${k}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `cross-branch field ${k} forbidden on policy evaluation receipt`);
    }
  }

  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    addError(errors, `${path}.schemaVersion`, 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION_V02}`);
  }

  rejectUnknownKeys(input, POLICY_EVALUATION_RECEIPT_KEYS, path, errors);
  validateId(input['receiptId'], `${path}.receiptId`, errors);
  validateDigest(input['receiptDigest'], `${path}.receiptDigest`, errors);
  validateDigest(input['actionDigest'], `${path}.actionDigest`, errors);
  validateDigest(input['freshnessContextDigest'], `${path}.freshnessContextDigest`, errors);
  validateId(input['policyId'], `${path}.policyId`, errors);
  validateId(input['policyVersion'], `${path}.policyVersion`, errors);
  validateId(input['configId'], `${path}.configId`, errors);
  validateId(input['configVersion'], `${path}.configVersion`, errors);
  validatePositiveInteger(input['decisionAuthorityGeneration'], `${path}.decisionAuthorityGeneration`, errors);

  const res = input['result'];
  if (res !== 'ALLOWED' && res !== 'APPROVAL_REQUIRED' && res !== 'FORBIDDEN') {
    addError(errors, `${path}.result`, 'INVALID_RESULT', 'result must be ALLOWED, APPROVAL_REQUIRED, or FORBIDDEN');
  }

  if (errors.length === 0 && typeof input['receiptDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(input['receiptDigest'])) {
    const computed = computePolicyEvaluationReceiptDigest(input);
    if (input['receiptDigest'] !== computed) {
      addError(errors, `${path}.receiptDigest`, 'RECEIPT_DIGEST_MISMATCH', 'receiptDigest does not match canonical digest');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as PolicyEvaluationReceipt };
}

/** Validate ActionDecisionReceipt (v0.2). */
export function validateActionDecisionReceipt(input: unknown): ValidationResult<ActionDecisionReceipt> {
  const path = 'actionDecisionReceipt';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];

  for (const k of ['providerRequestId', 'requestContentDigest', 'role', 'modelId', 'planBindingDigest', 'planDecisionRef'] as const) {
    if (Object.hasOwn(input, k)) {
      addError(errors, `${path}.${k}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `cross-branch field ${k} forbidden on action decision receipt`);
    }
  }

  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    addError(errors, `${path}.schemaVersion`, 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION_V02}`);
  }

  rejectUnknownKeys(input, ACTION_DECISION_RECEIPT_KEYS, path, errors);
  validateId(input['decisionId'], `${path}.decisionId`, errors);
  validateDigest(input['decisionDigest'], `${path}.decisionDigest`, errors);
  validateDigest(input['actionDigest'], `${path}.actionDigest`, errors);
  validateId(input['evaluationReceiptRef'], `${path}.evaluationReceiptRef`, errors);
  validatePositiveInteger(input['decisionAuthorityGeneration'], `${path}.decisionAuthorityGeneration`, errors);

  if (input['status'] !== 'approved') {
    addError(errors, `${path}.status`, 'INVALID_STATUS', 'status must be approved');
  }
  if (Object.hasOwn(input, 'reason') && !hasNonEmptyString(input['reason'])) {
    addError(errors, `${path}.reason`, 'INVALID_TEXT', 'reason must be a non-empty string');
  }

  if (errors.length === 0 && typeof input['decisionDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(input['decisionDigest'])) {
    const computed = computeActionDecisionReceiptDigest(input);
    if (input['decisionDigest'] !== computed) {
      addError(errors, `${path}.decisionDigest`, 'DECISION_DIGEST_MISMATCH', 'decisionDigest does not match canonical digest');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ActionDecisionReceipt };
}

/** Validate ProviderAdmissionReceipt (v0.2). */
export function validateProviderAdmissionReceipt(input: unknown): ValidationResult<ProviderAdmissionReceipt> {
  const path = 'providerAdmissionReceipt';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];

  for (const k of ['actionDigest', 'actionId', 'actionRef', 'evaluationReceiptRef', 'commandView', 'patchDigest', 'baseRevision', 'targetPaths'] as const) {
    if (Object.hasOwn(input, k)) {
      addError(errors, `${path}.${k}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `repository field ${k} forbidden on provider admission receipt`);
    }
  }

  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    addError(errors, `${path}.schemaVersion`, 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION_V02}`);
  }

  rejectUnknownKeys(input, PROVIDER_ADMISSION_RECEIPT_KEYS, path, errors);
  validateId(input['receiptId'], `${path}.receiptId`, errors);
  validateDigest(input['receiptDigest'], `${path}.receiptDigest`, errors);
  validateId(input['providerRequestId'], `${path}.providerRequestId`, errors);
  if (input['role'] !== 'coder' && input['role'] !== 'reviewer') {
    addError(errors, `${path}.role`, 'INVALID_ROLE', 'role must be coder or reviewer');
  }
  validateId(input['policyId'], `${path}.policyId`, errors);
  validateId(input['policyVersion'], `${path}.policyVersion`, errors);
  validateDigest(input['requestContentDigest'], `${path}.requestContentDigest`, errors);
  validateId(input['providerId'], `${path}.providerId`, errors);
  validateId(input['modelId'], `${path}.modelId`, errors);
  validateId(input['configId'], `${path}.configId`, errors);
  validateId(input['configVersion'], `${path}.configVersion`, errors);
  validatePositiveInteger(input['decisionAuthorityGeneration'], `${path}.decisionAuthorityGeneration`, errors);

  const planApp = input['planApplicability'];
  if (planApp === 'pre-plan-diagnostic') {
    for (const key of ['planBindingDigest', 'planDecisionRef'] as const) {
      if (Object.hasOwn(input, key)) addError(errors, `${path}.${key}`, 'PLAN_FIELDS_FORBIDDEN_IN_PRE_PLAN', `${key} forbidden in pre-plan-diagnostic`);
    }
    validateBoundedText(input['diagnosticPurpose'], `${path}.diagnosticPurpose`, errors, 512);
    validateDigest(input['taskCriteriaDigest'], `${path}.taskCriteriaDigest`, errors);
  } else if (planApp === 'approved-plan') {
    validateDigest(input['planBindingDigest'], `${path}.planBindingDigest`, errors);
    validateId(input['planDecisionRef'], `${path}.planDecisionRef`, errors);
    for (const key of ['diagnosticPurpose', 'taskCriteriaDigest'] as const) {
      if (Object.hasOwn(input, key)) addError(errors, `${path}.${key}`, 'DIAGNOSTIC_FIELDS_FORBIDDEN_IN_APPROVED_PLAN', `${key} forbidden in approved-plan`);
    }
  } else {
    addError(errors, `${path}.planApplicability`, 'INVALID_PLAN_APPLICABILITY', 'planApplicability must be pre-plan-diagnostic or approved-plan');
  }

  if (errors.length === 0 && typeof input['receiptDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(input['receiptDigest'])) {
    const computed = computeProviderAdmissionReceiptDigest(input);
    if (input['receiptDigest'] !== computed) {
      addError(errors, `${path}.receiptDigest`, 'RECEIPT_DIGEST_MISMATCH', 'receiptDigest does not match canonical digest');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ProviderAdmissionReceipt };
}

/** Validate ClaimClosureReceipt (v0.2). */
export function validateClaimClosureReceipt(input: unknown): ValidationResult<ClaimClosureReceipt> {
  const path = 'claimClosureReceipt';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];

  if (input['attemptId'] !== undefined) {
    addError(errors, `${path}.attemptId`, 'CLAIM_CLOSURE_CANNOT_HAVE_ATTEMPT_ID', 'claim closure receipt cannot contain attemptId');
  }

  for (const k of ['actionDigest', 'providerRequestId', 'outcome', 'disposition', 'reconciliationKind'] as const) {
    if (input[k] !== undefined) {
      addError(errors, `${path}.${k}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `field ${k} forbidden on claim closure receipt`);
    }
  }

  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    addError(errors, `${path}.schemaVersion`, 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION_V02}`);
  }

  rejectUnknownKeys(input, CLAIM_CLOSURE_RECEIPT_KEYS, path, errors);
  validateId(input['receiptId'], `${path}.receiptId`, errors);
  validateDigest(input['receiptDigest'], `${path}.receiptDigest`, errors);
  validateId(input['claimId'], `${path}.claimId`, errors);
  validateDigest(input['claimDigest'], `${path}.claimDigest`, errors);
  validateId(input['taskId'], `${path}.taskId`, errors);
  validateId(input['runId'], `${path}.runId`, errors);
  validateVersionString(input['taskStateSchemaVersion'], `${path}.taskStateSchemaVersion`, errors);
  validateNonNegativeInteger(input['expectedTaskStateVersion'], `${path}.expectedTaskStateVersion`, errors);
  validateVersionString(input['controlSchemaVersion'], `${path}.controlSchemaVersion`, errors);
  validatePositiveInteger(input['expectedControlVersion'], `${path}.expectedControlVersion`, errors);
  validatePositiveInteger(input['expectedEpoch'], `${path}.expectedEpoch`, errors);
  if (!hasNonEmptyString(input['reason'])) {
    addError(errors, `${path}.reason`, 'INVALID_TEXT', 'reason must be a non-empty string');
  }

  const event = input['pauseOrDenialEvent'];
  if (!isRecord(event)) {
    addError(errors, `${path}.pauseOrDenialEvent`, 'INVALID_TYPE', 'pauseOrDenialEvent must be an object');
  } else {
    rejectUnknownKeys(event, PAUSE_OR_DENIAL_EVENT_KEYS, `${path}.pauseOrDenialEvent`, errors);
    if (event['eventKind'] !== 'pause' && event['eventKind'] !== 'denial') {
      addError(errors, `${path}.pauseOrDenialEvent.eventKind`, 'INVALID_EVENT_KIND', 'eventKind must be pause or denial');
    }
    validateId(event['eventRef'], `${path}.pauseOrDenialEvent.eventRef`, errors);
    validateDigest(event['eventDigest'], `${path}.pauseOrDenialEvent.eventDigest`, errors);
  }

  const fenced = input['fencedExecutorIdentity'];
  if (!isRecord(fenced)) {
    addError(errors, `${path}.fencedExecutorIdentity`, 'INVALID_TYPE', 'fencedExecutorIdentity must be an object');
  } else {
    rejectUnknownKeys(fenced, EXECUTOR_IDENTITY_KEYS, `${path}.fencedExecutorIdentity`, errors);
    validateId(fenced['adapterIdentity'], `${path}.fencedExecutorIdentity.adapterIdentity`, errors);
    validateId(fenced['processIncarnation'], `${path}.fencedExecutorIdentity.processIncarnation`, errors);
    validatePositiveInteger(fenced['fencingGeneration'], `${path}.fencedExecutorIdentity.fencingGeneration`, errors);
    validateDigest(fenced['payloadDigest'], `${path}.fencedExecutorIdentity.payloadDigest`, errors);
  }

  const noAttemptProof = input['noAttemptProof'];
  if (!isRecord(noAttemptProof)) {
    addError(errors, `${path}.noAttemptProof`, 'INVALID_TYPE', 'noAttemptProof must be an object');
  } else {
    rejectUnknownKeys(noAttemptProof, NO_ATTEMPT_PROOF_KEYS, `${path}.noAttemptProof`, errors);
    validateId(noAttemptProof['journalRef'], `${path}.noAttemptProof.journalRef`, errors);
    validateDigest(noAttemptProof['journalDigest'], `${path}.noAttemptProof.journalDigest`, errors);
    if (noAttemptProof['claimPhase'] !== 'claimed') {
      addError(errors, `${path}.noAttemptProof.claimPhase`, 'ATTEMPT_ALREADY_COMMITTED', 'no-attempt proof must bind the still-claimed phase');
    }
  }

  const dispositions = input['reservationDispositions'];
  if (!isBoundedDenseArray(dispositions, 128)) {
    addError(errors, `${path}.reservationDispositions`, 'INVALID_TYPE', 'reservationDispositions must be a bounded dense array');
  } else {
    if (dispositions.length === 0) addError(errors, `${path}.reservationDispositions`, 'MISSING_RESERVATION_DISPOSITION', 'every unattempted claim reservation must have a release disposition');
    const seen = new Set<string>();
    dispositions.forEach((item: unknown, index: number) => {
      const itemPath = `${path}.reservationDispositions[${index}]`;
      if (!isRecord(item)) {
        addError(errors, itemPath, 'INVALID_TYPE', `${itemPath} must be an object`);
        return;
      }
      rejectUnknownKeys(item, RESERVATION_DISPOSITION_KEYS, itemPath, errors);
      validateId(item['reservationRef'], `${itemPath}.reservationRef`, errors);
      if (item['disposition'] !== 'released') {
        addError(errors, `${itemPath}.disposition`, 'INVALID_DISPOSITION', 'unattempted claim reservations must be released');
      }
      if (typeof item['reservationRef'] === 'string') {
        if (seen.has(item['reservationRef'])) addError(errors, `${itemPath}.reservationRef`, 'DUPLICATE_RESERVATION', 'each reservation may have only one disposition');
        seen.add(item['reservationRef']);
      }
    });
  }

  if (errors.length === 0 && typeof input['receiptDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(input['receiptDigest'])) {
    const computed = computeClaimClosureReceiptDigest(input);
    if (input['receiptDigest'] !== computed) {
      addError(errors, `${path}.receiptDigest`, 'RECEIPT_DIGEST_MISMATCH', 'receiptDigest does not match canonical digest');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ClaimClosureReceipt };
}

export const validatePolicyEvaluationReceiptV02 = validatePolicyEvaluationReceipt;
export const validateActionDecisionReceiptV02 = validateActionDecisionReceipt;
export const validateProviderAdmissionReceiptV02 = validateProviderAdmissionReceipt;
export const validateClaimClosureReceiptV02 = validateClaimClosureReceipt;

/** Validate DispatchClaimV02 (v0.2). */
