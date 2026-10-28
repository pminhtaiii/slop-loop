import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import type { DispatchClaim } from './types.ts';
import { addError, invalidObject, isRecord, rejectUnknownKeys, validateDigest, validateId, validateIdArray, validatePositiveInteger, validateSchemaVersion } from './validation.ts';

const POLICY_IDENTITY_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion'] as const;
const DISPATCH_CLAIM_KEYS = [
  'schemaVersion', 'claimId', 'actionId', 'taskId', 'expectedControlVersion', 'expectedEpoch',
  'repositoryStateDigest', 'policyIdentity', 'decisionRefs', 'reservationRefs', 'phase', 'resultRef',
] as const;

/** Require the exact policy and configuration identity fields with bounded identifier values. */
export function validatePolicyIdentity(input: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(input)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be an identity object`);
    return;
  }
  rejectUnknownKeys(input, POLICY_IDENTITY_KEYS, path, errors);
  for (const field of POLICY_IDENTITY_KEYS) validateId(input[field], `${path}.${field}`, errors);
}

/** Validate claim identity, reservations and lifecycle fields, including required outcome references. */
export function validateDispatchClaim(input: unknown): ValidationResult<DispatchClaim> {
  const path = 'dispatchClaim';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, DISPATCH_CLAIM_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  for (const field of ['claimId', 'actionId', 'taskId'] as const) validateId(input[field], `${path}.${field}`, errors);
  validatePositiveInteger(input['expectedControlVersion'], `${path}.expectedControlVersion`, errors);
  validatePositiveInteger(input['expectedEpoch'], `${path}.expectedEpoch`, errors);
  validateDigest(input['repositoryStateDigest'], `${path}.repositoryStateDigest`, errors);
  validatePolicyIdentity(input['policyIdentity'], `${path}.policyIdentity`, errors);
  validateIdArray(input['decisionRefs'], `${path}.decisionRefs`, errors);
  validateIdArray(input['reservationRefs'], `${path}.reservationRefs`, errors, false);
  const phases = ['claimed', 'dispatched', 'observed', 'uncertain', 'reconciled'] as const;
  if (!phases.includes(input['phase'] as typeof phases[number])) addError(errors, `${path}.phase`, 'INVALID_PHASE', 'claim phase is not in the safe lifecycle vocabulary');
  if (input['resultRef'] !== null) validateId(input['resultRef'], `${path}.resultRef`, errors);
  if (['observed', 'uncertain', 'reconciled'].includes(String(input['phase'])) && input['resultRef'] === null) {
    addError(errors, `${path}.resultRef`, 'MISSING_RESULT_REFERENCE', 'post-dispatch claim phases require a result or reconciliation reference');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as DispatchClaim };
}
