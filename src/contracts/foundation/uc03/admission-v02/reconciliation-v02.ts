import type { AttemptReconciliationReceiptV02, ObservedOutcomeReconciliationReceiptV02, UncertainAttemptReconciliationReceiptV02 } from '../ports-v02.ts';
import type { ValidationError, ValidationResult } from '../types.ts';
import { validatePositiveInteger, isPlainObject, rejectUnknownKeys } from '../validation/common.ts';
import { validateProviderUsage } from '../validation/provider/records.ts';
import { protectValidator } from './snapshot.ts';
import {
  COMMON_KEYS, REPO_BRANCH_KEYS, PROVIDER_BRANCH_KEYS, REC_KEYS, addErr, canonicalEqual, checkTrustedEvidence,
  digestWithout, validateCommon, validateSafeRef, validateSafeRefArray,
  type AttemptReconciliationValidationContextV02,
} from './reconciliation-common-v02.ts';
export type { AttemptReconciliationValidationContextV02, TrustedFencingProofV02 } from './reconciliation-common-v02.ts';

function validateUncertainImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<UncertainAttemptReconciliationReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const validContext = validateCommon(input, 'uncertain-attempt', context, errors);
  if (input['disposition'] === 'observed-and-accounted') {
    const allowed = validContext && context.trustedAdmission.subjectKind === 'repository-action'
      ? [...COMMON_KEYS, ...REPO_BRANCH_KEYS, ...REC_KEYS, 'disposition', 'effectEvidenceRef', 'accountingEvidenceRefs', 'observedUsage']
      : [...COMMON_KEYS, ...PROVIDER_BRANCH_KEYS, ...REC_KEYS, 'disposition', 'effectEvidenceRef', 'accountingEvidenceRefs', 'observedUsage'];
    rejectUnknownKeys(input, allowed, 'receipt', errors);
    validateSafeRef(input['effectEvidenceRef'], 'effectEvidenceRef', errors);
    validateSafeRefArray(input['accountingEvidenceRefs'], 'accountingEvidenceRefs', errors);
    if (!validContext || !context.trustedObservedEffectRef || !context.trustedAccountingEvidenceRefs?.length) addErr(errors, 'trustedContext', 'Trusted observed effect and accounting evidence are required', 'TRUSTED_OBSERVED_EVIDENCE_REQUIRED');
    else {
      if (!canonicalEqual(input['effectEvidenceRef'], context.trustedObservedEffectRef)) addErr(errors, 'effectEvidenceRef', 'Effect evidence is not branch-matched trusted evidence', 'EFFECT_EVIDENCE_MISMATCH');
      if (!canonicalEqual(input['accountingEvidenceRefs'], context.trustedAccountingEvidenceRefs)) addErr(errors, 'accountingEvidenceRefs', 'Accounting evidence is not branch-matched trusted evidence', 'ACCOUNTING_EVIDENCE_MISMATCH');
      checkTrustedEvidence(input['evidenceRefs'], [context.trustedObservedEffectRef, ...context.trustedAccountingEvidenceRefs], 'evidenceRefs', errors);
    }
    if (validContext && context.trustedAdmission.subjectKind === 'provider-request') {
      if (input['observedUsage'] === undefined || context.trustedObservedUsage === undefined) addErr(errors, 'observedUsage', 'Provider observed/accounted reconciliation requires independently verified usage', 'OBSERVED_USAGE_REQUIRED');
      else {
        const usage = validateProviderUsage(input['observedUsage']);
        if (!usage.ok) errors.push(...usage.errors);
        if (!canonicalEqual(input['observedUsage'], context.trustedObservedUsage)) addErr(errors, 'observedUsage', 'Provider usage does not match trusted accounting facts', 'OBSERVED_USAGE_MISMATCH');
      }
    } else if (input['observedUsage'] !== undefined) addErr(errors, 'observedUsage', 'Repository reconciliation cannot contain provider usage', 'CROSS_BRANCH_FIELDS_FORBIDDEN');
  } else if (input['disposition'] === 'proven-not-dispatched') {
    const allowed = validContext && context.trustedAdmission.subjectKind === 'repository-action'
      ? [...COMMON_KEYS, ...REPO_BRANCH_KEYS, ...REC_KEYS, 'disposition', 'adapterEvidenceRefs', 'fencedRecipientIdentity', 'fencingGeneration', 'fencingProof']
      : [...COMMON_KEYS, ...PROVIDER_BRANCH_KEYS, ...REC_KEYS, 'disposition', 'adapterEvidenceRefs', 'fencedRecipientIdentity', 'fencingGeneration', 'fencingProof'];
    rejectUnknownKeys(input, allowed, 'receipt', errors);
    validateSafeRefArray(input['adapterEvidenceRefs'], 'adapterEvidenceRefs', errors);
    validateSafeRef(input['fencingProof'], 'fencingProof', errors);
    if (!validContext || !context.trustedFencingProof) addErr(errors, 'trustedContext.trustedFencingProof', 'Independent fencing proof is required', 'FENCING_PROOF_REQUIRED');
    else if (!Array.isArray(context.trustedEvidenceRefs) || context.trustedEvidenceRefs.length === 0) addErr(errors, 'trustedContext.trustedEvidenceRefs', 'Non-dispatch reconciliation requires adapter evidence in addition to fencing proof', 'FENCING_EVIDENCE_REQUIRED');
    else {
      const proof = context.trustedFencingProof;
      if (!canonicalEqual(input['fencedRecipientIdentity'], proof.fencedRecipientIdentity) || !canonicalEqual(proof.fencedRecipientIdentity, context.trustedAttempt.executorIdentity)) addErr(errors, 'fencedRecipientIdentity', 'Fenced recipient identity/incarnation does not match the consumed attempt', 'FENCED_RECIPIENT_MISMATCH');
      validatePositiveInteger(input['fencingGeneration'], 'fencingGeneration', errors);
      if (input['fencingGeneration'] !== proof.fencingGeneration || proof.fencingGeneration <= context.trustedAttempt.executorIdentity.fencingGeneration) addErr(errors, 'fencingGeneration', 'Trusted fencing generation must supersede the dispatched recipient', 'FENCING_GENERATION_INVALID');
      if (!canonicalEqual(input['fencingProof'], proof.proofRef)) addErr(errors, 'fencingProof', 'Fencing proof reference mismatch', 'FENCING_PROOF_MISMATCH');
      checkTrustedEvidence(input['adapterEvidenceRefs'], context.trustedEvidenceRefs, 'adapterEvidenceRefs', errors);
      checkTrustedEvidence(input['evidenceRefs'], [...context.trustedEvidenceRefs, proof.proofRef], 'evidenceRefs', errors);
    }
  } else addErr(errors, 'disposition', 'Invalid uncertain reconciliation disposition', 'INVALID_DISPOSITION');
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as UncertainAttemptReconciliationReceiptV02 };
}

function validateObservedImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<ObservedOutcomeReconciliationReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  if (input['disposition'] !== undefined || input['outcome'] !== undefined || input['effectEvidenceRef'] !== undefined || input['accountingEvidenceRefs'] !== undefined) addErr(errors, 'disposition', 'Observed-unsettled receipt cannot rewrite the outcome or accounting', 'OUTCOME_REWRITE_FORBIDDEN');
  validateCommon(input, 'observed-unsettled', context, errors);
  if (context) {
    const branch = context.trustedAdmission.subjectKind === 'repository-action' ? REPO_BRANCH_KEYS : PROVIDER_BRANCH_KEYS;
    rejectUnknownKeys(input, [...COMMON_KEYS, ...branch, ...REC_KEYS], 'receipt', errors);
    checkTrustedEvidence(input['evidenceRefs'], context.trustedEvidenceRefs, 'evidenceRefs', errors);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as ObservedOutcomeReconciliationReceiptV02 };
}

function validateReconciliationImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<AttemptReconciliationReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  return input['reconciliationKind'] === 'uncertain-attempt'
    ? validateUncertainImpl(input, context)
    : input['reconciliationKind'] === 'observed-unsettled'
      ? validateObservedImpl(input, context)
      : { ok: false, errors: [{ path: 'reconciliationKind', message: 'Invalid reconciliation kind', code: 'INVALID_RECONCILIATION_KIND' }] };
}

export const computeReconciliationDigest = (receipt: unknown): string => {
  if (!isPlainObject(receipt)) throw new Error('Requires object');
  return digestWithout(receipt, 'reconciliationDigest');
};

export const validateUncertainAttemptReconciliationReceiptV02 = protectValidator(validateUncertainImpl);
export const validateObservedOutcomeReconciliationReceiptV02 = protectValidator(validateObservedImpl);
export const validateAttemptReconciliationReceiptV02 = protectValidator(validateReconciliationImpl);
