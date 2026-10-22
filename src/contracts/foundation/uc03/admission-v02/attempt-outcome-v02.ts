import type { AttemptOutcomeReceiptV02, ProviderAdmissionContextV02, ProviderRequestOutcomeReceiptV02, RepositoryActionOutcomeReceiptV02, RepositoryAdmissionContextV02 } from '../ports-v02.ts';
import type { ValidationError, ValidationResult } from '../types.ts';
import { validateProviderUsage } from '../validation/provider/records.ts';
import { isPlainObject, validateNonEmptyString } from '../validation/common.ts';
import { protectValidator } from './snapshot.ts';
import {
  REPO_KEYS,
  PROVIDER_KEYS,
  addErr,
  canonicalEqual,
  checkCommon,
  sha256,
  type AttemptOutcomeValidationContextV02,
} from './attempt-outcome-common-v02.ts';
export type { AttemptOutcomeValidationContextV02 } from './attempt-outcome-common-v02.ts';
function checkRepository(input: Record<string, unknown>, context: AttemptOutcomeValidationContextV02 | undefined, errors: ValidationError[]): void {
  checkCommon(input, REPO_KEYS, context, errors);
  if (input['subjectKind'] !== 'repository-action') addErr(errors, 'subjectKind', 'Invalid repository outcome subject', 'INVALID_SUBJECT_KIND');
  if (!context || context.trustedAdmission.subjectKind !== 'repository-action') { addErr(errors, 'trustedContext', 'Repository admission is required', 'TRUSTED_CONTEXT_REQUIRED'); return; }
  const admission = context.trustedAdmission as RepositoryAdmissionContextV02;
  if (input['planApplicability'] !== admission.planApplicability) addErr(errors, 'planApplicability', 'Plan applicability mismatch', 'PLAN_APPLICABILITY_MISMATCH');
  if (input['actionDigest'] !== admission.actionDigest) addErr(errors, 'actionDigest', 'Action digest mismatch', 'ACTION_DIGEST_MISMATCH');
  const operation = admission.action.kind === 'apply_patch' ? 'apply-patch' : 'run-command';
  if (input['repositoryOperation'] !== operation) addErr(errors, 'repositoryOperation', 'Repository operation does not match admitted action', 'REPOSITORY_OPERATION_MISMATCH');
  validateNonEmptyString(input['actionDigest'], 'actionDigest', errors);
  const policy = admission.policyAuthorityRef;
  if (!canonicalEqual(input['policyAuthorityRef'], policy)) addErr(errors, 'policyAuthorityRef', 'Policy authority mismatch', 'AUTHORITY_BINDING_MISMATCH');
  if (input['policyEvaluationReceiptRef'] !== admission.policyEvaluationReceipt.receiptId || input['policyEvaluationReceiptDigest'] !== admission.policyEvaluationReceipt.receiptDigest || input['freshnessContextDigest'] !== admission.policyEvaluationReceipt.freshnessContextDigest) addErr(errors, 'policyEvaluationReceiptRef', 'Policy evaluation/freshness binding mismatch', 'POLICY_BINDING_MISMATCH');
  if (admission.planApplicability === 'approved-plan') {
    if (input['planBindingDigest'] !== admission.planBindingDigest || input['planDecisionRef'] !== admission.planDecisionRef) addErr(errors, 'planBindingDigest', 'Approved plan binding mismatch', 'PLAN_BINDING_MISMATCH');
    for (const key of ['diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest'] as const) if (Object.hasOwn(input, key) !== (admission[key] !== undefined) || input[key] !== admission[key]) addErr(errors, key, `Unexpected/mismatched ${key}`, 'PLAN_SCOPE_MISMATCH');
  } else {
    if (Object.hasOwn(input, 'planBindingDigest') || Object.hasOwn(input, 'planDecisionRef')) addErr(errors, 'planBindingDigest', 'Pre-plan receipt cannot fabricate a plan', 'FABRICATED_PLAN_FIELDS_FORBIDDEN');
    for (const key of ['diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest'] as const) if (input[key] !== admission[key]) addErr(errors, key, `Pre-plan ${key} mismatch`, 'PLAN_SCOPE_MISMATCH');
  }
  if (input['repositoryOperation'] === 'apply-patch' && input['outcome'] === 'observed') {
    const revision = input['observedResultRevisionDigest'];
    if (typeof revision !== 'string' || !sha256.test(revision)) addErr(errors, 'observedResultRevisionDigest', 'Observed patch requires a canonical result revision', 'MISSING_RESULT_REVISION');
    const effects = input['proposedEffects'];
    if (!isPlainObject(effects) || !isPlainObject(effects['revision']) || effects['revision']['kind'] !== 'advance' || effects['revision']['revisionDigest'] !== revision) addErr(errors, 'proposedEffects.revision', 'Patch settlement must record the observed result revision', 'RESULT_REVISION_MISMATCH');
  } else if (input['observedResultRevisionDigest'] !== undefined) addErr(errors, 'observedResultRevisionDigest', 'Only observed patch outcomes carry a result revision', 'CROSS_BRANCH_FIELDS_FORBIDDEN');
  if (input['outcome'] === 'observed' && input['repositoryOperation'] !== 'apply-patch') {
    const effects = input['proposedEffects'];
    if (!isPlainObject(effects) || !isPlainObject(effects['revision']) || effects['revision']['kind'] !== 'preserve') addErr(errors, 'proposedEffects.revision', 'Command/test outcomes preserve repository revision', 'REVISION_EFFECT_MISMATCH');
  }
  if (input['proposedEffects'] && isPlainObject(input['proposedEffects']) && isPlainObject(input['proposedEffects']['accounting'])) {
    const refs = admission.reservationRefs;
    if (!canonicalEqual(input['proposedEffects']['accounting']['reservationRefs'], refs)) addErr(errors, 'proposedEffects.accounting.reservationRefs', 'Repository reservation refs mismatch', 'RESERVATION_REFS_MISMATCH');
    if (input['proposedEffects']['accounting']['observedUsage'] !== undefined) addErr(errors, 'proposedEffects.accounting.observedUsage', 'Repository outcomes cannot contain provider usage', 'CROSS_BRANCH_FIELDS_FORBIDDEN');
  }
}

function checkProvider(input: Record<string, unknown>, context: AttemptOutcomeValidationContextV02 | undefined, errors: ValidationError[]): void {
  checkCommon(input, PROVIDER_KEYS, context, errors);
  if (input['subjectKind'] !== 'provider-request') addErr(errors, 'subjectKind', 'Invalid provider outcome subject', 'INVALID_SUBJECT_KIND');
  if (!context || context.trustedAdmission.subjectKind !== 'provider-request') { addErr(errors, 'trustedContext', 'Provider admission is required', 'TRUSTED_CONTEXT_REQUIRED'); return; }
  const admission = context.trustedAdmission as ProviderAdmissionContextV02;
  if (input['planApplicability'] !== admission.planApplicability) addErr(errors, 'planApplicability', 'Plan applicability mismatch', 'PLAN_APPLICABILITY_MISMATCH');
  if (input['providerRequestId'] !== admission.providerRequestId || input['requestContentDigest'] !== admission.requestContentDigest || input['role'] !== admission.role) addErr(errors, 'providerRequestId', 'Provider request content/role binding mismatch', 'PROVIDER_REQUEST_BINDING_MISMATCH');
  if (input['providerAdmissionReceiptRef'] !== admission.providerAdmissionReceipt.receiptId || input['providerAdmissionReceiptDigest'] !== admission.providerAdmissionReceipt.receiptDigest) addErr(errors, 'providerAdmissionReceiptRef', 'Provider admission receipt mismatch', 'PROVIDER_ADMISSION_BINDING_MISMATCH');
  if (input['requestReservationReceiptRef'] !== admission.requestReservationReceipt) addErr(errors, 'requestReservationReceiptRef', 'Provider request reservation receipt mismatch', 'REQUEST_RESERVATION_MISMATCH');
  if (!canonicalEqual(input['providerIdentity'], admission.providerIdentity)) addErr(errors, 'providerIdentity', 'Provider pricing/authority identity mismatch', 'PROVIDER_IDENTITY_MISMATCH');
  if (!canonicalEqual(input['budgetRefs'], admission.budgetRefs)) addErr(errors, 'budgetRefs', 'Provider budget refs mismatch', 'BUDGET_REFS_MISMATCH');
  if (admission.planApplicability === 'approved-plan') {
    if (input['planBindingDigest'] !== admission.planBindingDigest || input['planDecisionRef'] !== admission.planDecisionRef) addErr(errors, 'planBindingDigest', 'Approved plan binding mismatch', 'PLAN_BINDING_MISMATCH');
    for (const key of ['diagnosticPurpose', 'taskCriteriaDigest'] as const) if (Object.hasOwn(input, key) !== (admission[key] !== undefined) || input[key] !== admission[key]) addErr(errors, key, `Unexpected/mismatched ${key}`, 'PLAN_SCOPE_MISMATCH');
  } else {
    if (Object.hasOwn(input, 'planBindingDigest') || Object.hasOwn(input, 'planDecisionRef')) addErr(errors, 'planBindingDigest', 'Pre-plan receipt cannot fabricate a plan', 'FABRICATED_PLAN_FIELDS_FORBIDDEN');
    for (const key of ['diagnosticPurpose', 'taskCriteriaDigest'] as const) if (input[key] !== admission[key]) addErr(errors, key, `Pre-plan ${key} mismatch`, 'PLAN_SCOPE_MISMATCH');
  }
  if (input['observedUsage'] !== undefined) {
    const usage = validateProviderUsage(input['observedUsage']);
    if (!usage.ok) errors.push(...usage.errors);
  }
  if (input['outcome'] === 'observed' && input['observedUsage'] === undefined) addErr(errors, 'observedUsage', 'Observed provider outcomes require validated usage for settlement', 'OBSERVED_USAGE_REQUIRED');
  const effects = input['proposedEffects'];
  if (isPlainObject(effects) && isPlainObject(effects['accounting'])) {
    const settlement = effects['accounting'];
    if (!canonicalEqual(settlement['reservationRefs'], [admission.requestReservationReceipt, ...admission.budgetRefs])) addErr(errors, 'proposedEffects.accounting.reservationRefs', 'Settlement reservation refs mismatch', 'BUDGET_REFS_MISMATCH');
    if (input['observedUsage'] !== undefined && !canonicalEqual(settlement['observedUsage'], input['observedUsage'])) addErr(errors, 'proposedEffects.accounting.observedUsage', 'Usage accounting must match observed usage', 'USAGE_ACCOUNTING_MISMATCH');
  }
}

function validateRepositoryOutcomeImpl(input: unknown, context?: AttemptOutcomeValidationContextV02): ValidationResult<RepositoryActionOutcomeReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkRepository(input, context, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as RepositoryActionOutcomeReceiptV02 };
}

function validateProviderOutcomeImpl(input: unknown, context?: AttemptOutcomeValidationContextV02): ValidationResult<ProviderRequestOutcomeReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkProvider(input, context, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as ProviderRequestOutcomeReceiptV02 };
}

function validateAttemptOutcomeImpl(input: unknown, context?: AttemptOutcomeValidationContextV02): ValidationResult<AttemptOutcomeReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  return input['subjectKind'] === 'repository-action'
    ? validateRepositoryOutcomeImpl(input, context)
    : input['subjectKind'] === 'provider-request'
      ? validateProviderOutcomeImpl(input, context)
      : { ok: false, errors: [{ path: 'subjectKind', message: 'Invalid subjectKind', code: 'INVALID_SUBJECT_KIND' }] };
}

export const validateRepositoryActionOutcomeReceiptV02 = protectValidator(validateRepositoryOutcomeImpl);
export const validateProviderRequestOutcomeReceiptV02 = protectValidator(validateProviderOutcomeImpl);
export const validateAttemptOutcomeReceiptV02 = protectValidator(validateAttemptOutcomeImpl);
