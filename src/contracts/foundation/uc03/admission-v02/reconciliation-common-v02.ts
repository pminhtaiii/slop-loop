import { computeCanonicalSha256 } from '../identity.ts';
import type { AdmissionContextV02, AttemptOutcomeReceiptV02, AttemptVersionBindingsV02, ClaimReceiptV02, ExecutorIdentityV02, SafeReferenceV02 } from '../ports-v02.ts';
import type { ProviderUsage, ValidationError } from '../types.ts';
import { validateNonEmptyString, validateNonNegativeInteger, rejectUnknownKeys, isPlainObject } from '../validation/common.ts';
import { computeAdmissionDigest } from '../admission-v02.ts';
export interface TrustedFencingProofV02 {
  readonly fencedRecipientIdentity: ExecutorIdentityV02;
  readonly fencingGeneration: number;
  readonly proofRef: SafeReferenceV02;
}

export interface AttemptReconciliationValidationContextV02 {
  readonly trustedAdmission: AdmissionContextV02;
  readonly trustedClaim: ClaimReceiptV02;
  readonly currentClaimStatus: 'uncertain' | 'observed-unsettled';
  readonly predecessorJournalStatus: 'uncertain' | 'observed-unsettled';
  readonly trustedAttempt: {
    readonly attemptId: string;
    readonly claimId: string;
    readonly taskId: string;
    readonly executorIdentity: ExecutorIdentityV02;
    readonly preAttemptTaskStateVersion: number;
    readonly postBeginTaskStateVersion: number;
    readonly preAttemptControlVersion: number;
    readonly postBeginControlVersion: number;
    readonly epoch: number;
  };
  readonly trustedPredecessor: AttemptOutcomeReceiptV02;
  readonly predecessorReceiptDigest: string;
  readonly currentTaskStateVersion: number;
  readonly currentControlVersion: number;
  readonly currentEpoch: number;
  readonly trustedEvidenceRefs: readonly SafeReferenceV02[];
  readonly trustedObservedEffectRef?: SafeReferenceV02 | undefined;
  readonly trustedAccountingEvidenceRefs?: readonly SafeReferenceV02[] | undefined;
  readonly trustedObservedUsage?: ProviderUsage | undefined;
  readonly trustedAccountingIdentityDigest: string;
  readonly trustedFencingProof?: TrustedFencingProofV02 | undefined;
}

export const COMMON_KEYS = [
  'reconciliationId', 'reconciliationDigest', 'reconciliationKind', 'predecessorReceiptId', 'predecessorReceiptDigest',
  'admissionDigest', 'claimId', 'claimDigest', 'attemptId', 'executorIdentity', 'versions', 'evidenceRefs',
  'expectedCurrentTaskStateVersion', 'expectedCurrentControlVersion', 'expectedCurrentEpoch', 'accountingIdentityDigest',
  'subjectKind', 'planApplicability',
] as const;
export const REPO_BRANCH_KEYS = ['actionDigest', 'policyAuthorityRef', 'policyEvaluationReceiptRef', 'policyEvaluationReceiptDigest', 'freshnessContextDigest'] as const;
export const PROVIDER_BRANCH_KEYS = ['providerRequestId', 'requestContentDigest', 'role', 'providerAdmissionReceiptRef', 'providerAdmissionReceiptDigest', 'requestReservationReceiptRef', 'budgetRefs', 'providerIdentity'] as const;
export const REC_KEYS = ['diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest', 'planBindingDigest', 'planDecisionRef', 'actionDecisionReceiptRef', 'actionDecisionReceiptDigest'] as const;
const VERSION_KEYS = [
  'taskStateSchemaVersion', 'controlSchemaVersion', 'preClaimTaskStateVersion', 'postClaimTaskStateVersion',
  'postAttemptTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'postAttemptControlVersion', 'epoch',
] as const;
const REF_KEYS = ['reference', 'digest'] as const;
const sha256 = /^sha256:[0-9a-f]{64}$/;
const safeText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const addErr = (errors: ValidationError[], path: string, message: string, code: string): number => errors.push({ path, message, code });

export function canonicalEqual(left: unknown, right: unknown): boolean {
  try { return computeCanonicalSha256(left) === computeCanonicalSha256(right); } catch { return false; }
}

export function digestWithout(record: Record<string, unknown>, digestKey: string): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (key !== digestKey) copy[key] = value;
  return computeCanonicalSha256(copy);
}

export function validateSafeRef(input: unknown, path: string, errors: ValidationError[]): input is SafeReferenceV02 {
  if (!isPlainObject(input)) { addErr(errors, path, 'Safe reference must be an object', 'INVALID_TYPE'); return false; }
  rejectUnknownKeys(input, REF_KEYS, path, errors);
  if (!safeText(input['reference']) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(String(input['reference']))) addErr(errors, `${path}.reference`, 'Reference must be a safe opaque identifier', 'INVALID_SAFE_REFERENCE');
  if (typeof input['digest'] !== 'string' || !sha256.test(input['digest'])) addErr(errors, `${path}.digest`, 'Reference digest must be canonical sha256', 'INVALID_DIGEST');
  return true;
}

export function validateSafeRefArray(input: unknown, path: string, errors: ValidationError[]): void {
  if (!Array.isArray(input)) { addErr(errors, path, 'Must be an array of safe references', 'INVALID_TYPE'); return; }
  const seen = new Set<string>();
  input.forEach((item, index) => {
    validateSafeRef(item, `${path}[${index}]`, errors);
    if (isPlainObject(item) && typeof item['reference'] === 'string') {
      if (seen.has(item['reference'])) addErr(errors, `${path}[${index}].reference`, 'Duplicate safe reference', 'DUPLICATE_REFERENCE');
      seen.add(item['reference']);
    }
  });
}

function validateVersionBindings(input: unknown, admission: AdmissionContextV02, claim: ClaimReceiptV02, attempt: AttemptReconciliationValidationContextV02['trustedAttempt'], errors: ValidationError[]): void {
  if (!isPlainObject(input)) { addErr(errors, 'versions', 'Version bindings are required', 'INVALID_TYPE'); return; }
  rejectUnknownKeys(input, VERSION_KEYS, 'versions', errors);
  const expected: AttemptVersionBindingsV02 = {
    taskStateSchemaVersion: admission.taskStateSchemaVersion,
    controlSchemaVersion: admission.controlSchemaVersion,
    preClaimTaskStateVersion: claim.preClaimTaskStateVersion,
    postClaimTaskStateVersion: claim.preClaimTaskStateVersion,
    postAttemptTaskStateVersion: attempt.postBeginTaskStateVersion,
    preClaimControlVersion: claim.preClaimControlVersion,
    postClaimControlVersion: claim.postClaimControlVersion,
    postAttemptControlVersion: attempt.postBeginControlVersion,
    epoch: admission.expectedEpoch,
  };
  for (const key of VERSION_KEYS) {
    const value = input[key];
    if (key === 'taskStateSchemaVersion' || key === 'controlSchemaVersion') validateNonEmptyString(value, `versions.${key}`, errors);
    else validateNonNegativeInteger(value, `versions.${key}`, errors);
    if (value !== expected[key]) addErr(errors, `versions.${key}`, 'Version binding mismatch', 'VERSION_BINDING_MISMATCH');
  }
}

function expectedBranch(admission: AdmissionContextV02): Record<string, unknown> {
  if (admission.subjectKind === 'repository-action') {
    return {
      subjectKind: admission.subjectKind,
      planApplicability: admission.planApplicability,
      actionDigest: admission.actionDigest,
      policyAuthorityRef: admission.policyAuthorityRef,
      policyEvaluationReceiptRef: admission.policyEvaluationReceipt.receiptId,
      policyEvaluationReceiptDigest: admission.policyEvaluationReceipt.receiptDigest,
      freshnessContextDigest: admission.policyEvaluationReceipt.freshnessContextDigest,
      ...(admission.policyEvaluationReceipt.result === 'APPROVAL_REQUIRED' && admission.actionDecisionReceipt ? { actionDecisionReceiptRef: admission.actionDecisionReceipt.decisionId, actionDecisionReceiptDigest: admission.actionDecisionReceipt.decisionDigest } : {}),
      ...(admission.planApplicability === 'approved-plan'
        ? { planBindingDigest: admission.planBindingDigest, planDecisionRef: admission.planDecisionRef, ...(admission.diagnosticPurpose !== undefined ? { diagnosticPurpose: admission.diagnosticPurpose } : {}), ...(admission.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: admission.taskCriteriaDigest } : {}), ...(admission.checkSetDigest !== undefined ? { checkSetDigest: admission.checkSetDigest } : {}) }
        : { diagnosticPurpose: admission.diagnosticPurpose, taskCriteriaDigest: admission.taskCriteriaDigest, checkSetDigest: admission.checkSetDigest }),
    };
  }
  return {
    subjectKind: admission.subjectKind,
    planApplicability: admission.planApplicability,
    providerRequestId: admission.providerRequestId,
    requestContentDigest: admission.requestContentDigest,
    role: admission.role,
    providerAdmissionReceiptRef: admission.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: admission.providerAdmissionReceipt.receiptDigest,
    requestReservationReceiptRef: admission.requestReservationReceipt,
    budgetRefs: admission.budgetRefs,
    providerIdentity: admission.providerIdentity,
    ...(admission.planApplicability === 'approved-plan'
      ? { planBindingDigest: admission.planBindingDigest, planDecisionRef: admission.planDecisionRef, ...(admission.diagnosticPurpose !== undefined ? { diagnosticPurpose: admission.diagnosticPurpose } : {}), ...(admission.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: admission.taskCriteriaDigest } : {}) }
      : { diagnosticPurpose: admission.diagnosticPurpose, taskCriteriaDigest: admission.taskCriteriaDigest }),
  };
}

function validateTrustedContext(context: AttemptReconciliationValidationContextV02 | undefined, errors: ValidationError[]): context is AttemptReconciliationValidationContextV02 {
  if (!context || !isPlainObject(context)) { addErr(errors, 'trustedContext', 'Independent admission, claim, attempt, journal predecessor, current snapshot, accounting and evidence facts are required', 'TRUSTED_CONTEXT_REQUIRED'); return false; }
  const { trustedAdmission: admission, trustedClaim: claim, trustedAttempt: attempt, trustedPredecessor: predecessor } = context;
  if (!isPlainObject(admission) || !isPlainObject(claim) || !isPlainObject(attempt) || !isPlainObject(predecessor)) { addErr(errors, 'trustedContext', 'Trusted records must be plain data', 'INVALID_TRUSTED_CONTEXT'); return false; }
  if (context.currentClaimStatus !== context.predecessorJournalStatus) addErr(errors, 'trustedContext.predecessorJournalStatus', 'Predecessor is not the exact current journal status', 'PREDECESSOR_STATUS_MISMATCH');
  for (const [name, value] of Object.entries({ currentTaskStateVersion: context.currentTaskStateVersion, currentControlVersion: context.currentControlVersion, currentEpoch: context.currentEpoch })) validateNonNegativeInteger(value, `trustedContext.${name}`, errors);
  if (context.currentTaskStateVersion !== attempt.postBeginTaskStateVersion || context.currentControlVersion < attempt.postBeginControlVersion || context.currentEpoch !== admission.expectedEpoch) addErr(errors, 'trustedContext', 'Current snapshot is stale or cross-epoch', 'STALE_CURRENT_SNAPSHOT');
  if (claim.status !== 'claimed' || claim.taskId !== admission.taskId || claim.runId !== admission.runId || claim.subjectKind !== admission.subjectKind || claim.planApplicability !== admission.planApplicability || claim.epoch !== admission.expectedEpoch) addErr(errors, 'trustedContext.claim', 'Current claim does not match admission', 'TRUSTED_CLAIM_MISMATCH');
  const reservations = admission.subjectKind === 'repository-action' ? admission.reservationRefs : [admission.requestReservationReceipt, ...admission.budgetRefs];
  if (!canonicalEqual(claim.reservationRefs, reservations)) addErr(errors, 'trustedContext.claim.reservationRefs', 'Claim reservations do not match admission', 'TRUSTED_CLAIM_RESERVATION_MISMATCH');
  if (attempt.claimId !== claim.claimId || attempt.taskId !== claim.taskId || attempt.epoch !== claim.epoch || attempt.preAttemptTaskStateVersion !== claim.preClaimTaskStateVersion || attempt.preAttemptControlVersion !== claim.postClaimControlVersion) addErr(errors, 'trustedContext.attempt', 'Attempt does not descend from current claim', 'TRUSTED_ATTEMPT_MISMATCH');
  const repair = admission.subjectKind === 'repository-action' && admission.planApplicability === 'approved-plan' && admission.action.kind === 'apply_patch';
  if (attempt.postBeginTaskStateVersion !== attempt.preAttemptTaskStateVersion + Number(repair) || attempt.postBeginControlVersion !== attempt.preAttemptControlVersion + 1) addErr(errors, 'trustedContext.attempt', 'Attempt version mismatch', 'TRUSTED_ATTEMPT_VERSION_MISMATCH');
  const admissionDigest = computeAdmissionDigest(admission as unknown as Record<string, unknown>);
  if (admission.admissionDigest !== undefined && admission.admissionDigest !== admissionDigest) addErr(errors, 'trustedContext.admissionDigest', 'Trusted admission digest is invalid', 'TRUSTED_ADMISSION_DIGEST_INVALID');
  if (predecessor.receiptDigest !== context.predecessorReceiptDigest || digestWithout(predecessor as unknown as Record<string, unknown>, 'receiptDigest') !== predecessor.receiptDigest) addErr(errors, 'trustedContext.predecessorReceiptDigest', 'Trusted immutable predecessor digest is invalid', 'PREDECESSOR_DIGEST_INVALID');
  if (predecessor.claimId !== claim.claimId || predecessor.claimDigest !== claim.claimDigest || predecessor.attemptId !== attempt.attemptId || !canonicalEqual(predecessor.executorIdentity, attempt.executorIdentity) || predecessor.admissionDigest !== admissionDigest || predecessor.subjectKind !== admission.subjectKind || predecessor.planApplicability !== admission.planApplicability) addErr(errors, 'trustedContext.predecessor', 'Predecessor identity/branch mismatch', 'PREDECESSOR_BINDING_MISMATCH');
  if (!canonicalEqual(expectedBranch(admission), branchIdentity(predecessor as unknown as Record<string, unknown>, admission.subjectKind))) addErr(errors, 'trustedContext.predecessor', 'Predecessor branch identity does not match the admission', 'PREDECESSOR_BRANCH_MISMATCH');
  if (!safeText(context.trustedAccountingIdentityDigest) || !sha256.test(context.trustedAccountingIdentityDigest)) addErr(errors, 'trustedContext.trustedAccountingIdentityDigest', 'Trusted accounting identity digest is required', 'INVALID_ACCOUNTING_IDENTITY');
  validateSafeRefArray(context.trustedEvidenceRefs, 'trustedContext.trustedEvidenceRefs', errors);
  if (!Array.isArray(context.trustedEvidenceRefs) || context.trustedEvidenceRefs.length === 0) addErr(errors, 'trustedContext.trustedEvidenceRefs', 'Reconciliation requires independently trusted evidence references', 'TRUSTED_EVIDENCE_REQUIRED');
  return true;
}

function branchIdentity(record: Record<string, unknown>, subjectKind: string): Record<string, unknown> {
  const keys = subjectKind === 'repository-action'
    ? ['subjectKind', 'planApplicability', 'actionDigest', 'policyAuthorityRef', 'policyEvaluationReceiptRef', 'policyEvaluationReceiptDigest', 'freshnessContextDigest', ...REC_KEYS]
    : ['subjectKind', 'planApplicability', 'providerRequestId', 'requestContentDigest', 'role', 'providerAdmissionReceiptRef', 'providerAdmissionReceiptDigest', 'requestReservationReceiptRef', 'budgetRefs', 'providerIdentity', ...REC_KEYS];
  const output: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) output[key] = record[key];
  return output;
}

function validateBranchIdentity(input: Record<string, unknown>, context: AttemptReconciliationValidationContextV02, errors: ValidationError[]): void {
  const admission = context.trustedAdmission;
  const expected = expectedBranch(admission);
  for (const [key, value] of Object.entries(expected)) if (!canonicalEqual(input[key], value)) addErr(errors, key, `Branch field ${key} does not match independent admission`, 'BRANCH_IDENTITY_MISMATCH');
  for (const key of REC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key) !== Object.prototype.hasOwnProperty.call(expected, key)) addErr(errors, key, 'Plan field presence does not match the trusted applicability branch', 'PLAN_FIELD_PRESENCE_MISMATCH');
  }
}

export function validateCommon(input: Record<string, unknown>, kind: 'uncertain-attempt' | 'observed-unsettled', context: AttemptReconciliationValidationContextV02 | undefined, errors: ValidationError[]): context is AttemptReconciliationValidationContextV02 {
  if (input['reconciliationKind'] !== kind) addErr(errors, 'reconciliationKind', 'Invalid reconciliation kind', 'INVALID_RECONCILIATION_KIND');
  for (const key of ['reconciliationId', 'reconciliationDigest', 'predecessorReceiptId', 'predecessorReceiptDigest', 'admissionDigest', 'claimId', 'claimDigest', 'attemptId', 'accountingIdentityDigest']) validateNonEmptyString(input[key], key, errors);
  if (input['reconciliationDigest'] !== digestWithout(input, 'reconciliationDigest')) addErr(errors, 'reconciliationDigest', 'Reconciliation digest mismatch', 'RECONCILIATION_DIGEST_MISMATCH');
  const trusted = validateTrustedContext(context, errors);
  if (!trusted) return false;
  validateBranchIdentity(input, context, errors);
  const admission = context.trustedAdmission;
  const claim = context.trustedClaim;
  const attempt = context.trustedAttempt;
  const predecessor = context.trustedPredecessor;
  const admissionDigest = computeAdmissionDigest(admission as unknown as Record<string, unknown>);
  if (input['predecessorReceiptId'] !== predecessor.receiptId || input['predecessorReceiptDigest'] !== context.predecessorReceiptDigest) addErr(errors, 'predecessorReceiptId', 'Predecessor receipt ID/digest mismatch', 'PREDECESSOR_RECEIPT_MISMATCH');
  if (input['admissionDigest'] !== admissionDigest || input['claimId'] !== claim.claimId || input['claimDigest'] !== claim.claimDigest || input['attemptId'] !== attempt.attemptId || !canonicalEqual(input['executorIdentity'], attempt.executorIdentity)) addErr(errors, 'claimId', 'Current claim/attempt/admission identity mismatch', 'CURRENT_IDENTITY_MISMATCH');
  if (input['accountingIdentityDigest'] !== context.trustedAccountingIdentityDigest) addErr(errors, 'accountingIdentityDigest', 'Immutable accounting identity mismatch', 'ACCOUNTING_IDENTITY_MISMATCH');
  validateVersionBindings(input['versions'], admission, claim, attempt, errors);
  validateSafeRefArray(input['evidenceRefs'], 'evidenceRefs', errors);
  for (const [key, expected] of Object.entries({ expectedCurrentTaskStateVersion: context.currentTaskStateVersion, expectedCurrentControlVersion: context.currentControlVersion, expectedCurrentEpoch: context.currentEpoch })) {
    validateNonNegativeInteger(input[key], key, errors);
    if (input[key] !== expected) addErr(errors, key, 'Expected current snapshot does not match trusted current task/control/epoch', 'CURRENT_SNAPSHOT_MISMATCH');
  }
  if (kind === 'uncertain-attempt') {
    if (context.currentClaimStatus !== 'uncertain' || context.predecessorJournalStatus !== 'uncertain' || predecessor.outcome !== 'uncertain') addErr(errors, 'trustedContext.predecessorJournalStatus', 'Uncertain reconciliation requires the exact current uncertain predecessor', 'PREDECESSOR_NOT_UNCERTAIN');
  } else if (context.currentClaimStatus !== 'observed-unsettled' || context.predecessorJournalStatus !== 'observed-unsettled' || predecessor.outcome !== 'observed') {
    addErr(errors, 'trustedContext.predecessorJournalStatus', 'Observed reconciliation requires the exact current observed-unsettled predecessor', 'PREDECESSOR_NOT_OBSERVED_UNSETTLED');
  }
  return true;
}

export function checkTrustedEvidence(inputRefs: unknown, expectedRefs: readonly SafeReferenceV02[], path: string, errors: ValidationError[]): void {
  validateSafeRefArray(inputRefs, path, errors);
  if (!canonicalEqual(inputRefs, expectedRefs)) addErr(errors, path, 'Evidence references do not match independently trusted evidence', 'EVIDENCE_BINDING_MISMATCH');
}
