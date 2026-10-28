import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import { UC05_APPROVAL_SCHEMA_VERSION, UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../versions.ts';
import type { DispatchClaimPhaseV02, DispatchClaimV02 } from './types.ts';
import { computeDispatchClaimDigestV02 } from './digests.ts';
import { DISPATCH_CLAIM_V02_KEYS, DISPATCH_CLAIM_V02_PHASES, validateNonNegativeInteger } from './validation.ts';
import { validatePolicyIdentity } from '../v01/claim-validator.ts';
import { addError, invalidObject, isRecord, rejectUnknownKeys, validateBoundedText, validateDigest, validateId, validateIdArray, validatePositiveInteger, validateVersionString } from '../v01/validation.ts';

export function validateDispatchClaimV02(input: unknown): ValidationResult<DispatchClaimV02> {
  const path = 'dispatchClaimV02';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];

  if (input['schemaVersion'] === UC05_APPROVAL_SCHEMA_VERSION) {
    addError(errors, `${path}.schemaVersion`, 'OLD_SCHEMA_VERSION_REJECTED', `v0.1 schemaVersion ${UC05_APPROVAL_SCHEMA_VERSION} rejected by v0.2 validator`);
    return { ok: false, errors };
  }
  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
    addError(errors, `${path}.schemaVersion`, 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION_V02}`);
  }

  rejectUnknownKeys(input, DISPATCH_CLAIM_V02_KEYS, path, errors);
  validateId(input['claimId'], `${path}.claimId`, errors);
  validateDigest(input['claimDigest'], `${path}.claimDigest`, errors);
  validateId(input['taskId'], `${path}.taskId`, errors);
  validateId(input['runId'], `${path}.runId`, errors);
  validateVersionString(input['taskStateSchemaVersion'], `${path}.taskStateSchemaVersion`, errors);
  validateNonNegativeInteger(input['expectedTaskStateVersion'], `${path}.expectedTaskStateVersion`, errors);
  validateVersionString(input['controlSchemaVersion'], `${path}.controlSchemaVersion`, errors);
  validatePositiveInteger(input['expectedControlVersion'], `${path}.expectedControlVersion`, errors);
  validatePositiveInteger(input['expectedEpoch'], `${path}.expectedEpoch`, errors);
  validatePolicyIdentity(input['policyIdentity'], `${path}.policyIdentity`, errors);
  validateIdArray(input['decisionRefs'], `${path}.decisionRefs`, errors);
  validateIdArray(input['reservationRefs'], `${path}.reservationRefs`, errors, false);

  const phase = input['phase'];
  if (!DISPATCH_CLAIM_V02_PHASES.includes(phase as DispatchClaimPhaseV02)) {
    addError(errors, `${path}.phase`, 'INVALID_PHASE', 'claim phase is not in the safe v0.2 lifecycle vocabulary');
  }
  if (phase === 'claimed') {
    if (Object.hasOwn(input, 'attemptId')) addError(errors, `${path}.attemptId`, 'INCOMPATIBLE_ATTEMPT_ID', 'claimed phase cannot have attemptId');
    if (input['resultRef'] !== null) addError(errors, `${path}.resultRef`, 'INCOMPATIBLE_RESULT_REFERENCE', 'claimed phase must have a null resultRef');
  } else {
    validateId(input['attemptId'], `${path}.attemptId`, errors);
    if (phase === 'attempting') {
      if (input['resultRef'] !== null) addError(errors, `${path}.resultRef`, 'INCOMPATIBLE_RESULT_REFERENCE', 'attempting phase must have a null resultRef');
    } else if (phase === 'dispatched') {
      if (input['resultRef'] !== null) validateId(input['resultRef'], `${path}.resultRef`, errors);
    } else {
      validateId(input['resultRef'], `${path}.resultRef`, errors);
    }
  }

  const subjectKind = input['subjectKind'];
  if (subjectKind !== 'repository-action' && subjectKind !== 'provider-request') {
    addError(errors, `${path}.subjectKind`, 'INVALID_SUBJECT_KIND', 'subjectKind must be repository-action or provider-request');
  } else if (subjectKind === 'repository-action') {
    for (const key of ['providerRequestId', 'requestContentDigest', 'role'] as const) {
      if (Object.hasOwn(input, key)) {
        addError(errors, `${path}.${key}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `provider field ${key} forbidden on repository-action claim`);
      }
    }
    validateId(input['actionId'], `${path}.actionId`, errors);
    validateDigest(input['actionDigest'], `${path}.actionDigest`, errors);
    validateDigest(input['repositoryStateDigest'], `${path}.repositoryStateDigest`, errors);
  } else if (subjectKind === 'provider-request') {
    for (const key of ['actionId', 'actionDigest', 'repositoryStateDigest'] as const) {
      if (Object.hasOwn(input, key)) {
        addError(errors, `${path}.${key}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN', `repository field ${key} forbidden on provider-request claim`);
      }
    }
    validateId(input['providerRequestId'], `${path}.providerRequestId`, errors);
    validateDigest(input['requestContentDigest'], `${path}.requestContentDigest`, errors);
    if (input['role'] !== 'coder' && input['role'] !== 'reviewer') {
      addError(errors, `${path}.role`, 'INVALID_ROLE', 'role must be coder or reviewer');
    }
  }

  const planApp = input['planApplicability'];
  if (planApp !== 'pre-plan-diagnostic' && planApp !== 'approved-plan') {
    addError(errors, `${path}.planApplicability`, 'INVALID_PLAN_APPLICABILITY', 'planApplicability must be pre-plan-diagnostic or approved-plan');
  } else if (planApp === 'pre-plan-diagnostic') {
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
  }

  if (typeof input['claimDigest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(input['claimDigest'])) {
    const computed = computeDispatchClaimDigestV02(input);
    if (input['claimDigest'] !== computed) {
      addError(errors, `${path}.claimDigest`, 'CLAIM_DIGEST_MISMATCH', 'claimDigest does not match canonical digest');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as DispatchClaimV02 };
}
