import { computeCanonicalSha256 } from '../identity.ts';
import type {
  AdmissionContextV02,
  AttemptOutcomeStatusV02,
  AttemptVersionBindingsV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  SafeReferenceV02,
} from '../ports-v02.ts';
import type { ValidationError } from '../types.ts';
import { validateProviderUsage } from '../validation/provider/records.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validateStringArray } from '../validation/common.ts';
import { computeAdmissionDigest } from '../admission-v02.ts';

export interface AttemptOutcomeValidationContextV02 {
  /** Independently supplied admission already validated by the v0.2 admission boundary. */
  readonly trustedAdmission: AdmissionContextV02;
  /** Current durable claim and attempt records loaded by the state owner. */
  readonly trustedClaim: ClaimReceiptV02;
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
  readonly currentClaimStatus: 'attempting' | 'dispatched';
  readonly currentTaskStateVersion: number;
  readonly currentControlVersion: number;
  readonly currentEpoch: number;
}

export const BASE_KEYS = [
  'receiptId', 'receiptDigest', 'claimId', 'claimDigest', 'attemptId', 'executorIdentity',
  'admissionDigest', 'versions', 'resultRef', 'evidenceRefs', 'proposedEffects', 'outcome',
] as const;
export const REPO_KEYS = [
  ...BASE_KEYS, 'subjectKind', 'planApplicability', 'diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest',
  'planBindingDigest', 'planDecisionRef', 'actionDigest', 'repositoryOperation', 'policyAuthorityRef',
  'policyEvaluationReceiptRef', 'policyEvaluationReceiptDigest', 'freshnessContextDigest', 'observedResultRevisionDigest',
] as const;
export const PROVIDER_KEYS = [
  ...BASE_KEYS, 'subjectKind', 'planApplicability', 'diagnosticPurpose', 'taskCriteriaDigest',
  'planBindingDigest', 'planDecisionRef', 'providerRequestId', 'requestContentDigest', 'role',
  'providerAdmissionReceiptRef', 'providerAdmissionReceiptDigest', 'requestReservationReceiptRef', 'providerIdentity', 'budgetRefs', 'observedUsage',
] as const;
const VERSION_KEYS = [
  'taskStateSchemaVersion', 'controlSchemaVersion', 'preClaimTaskStateVersion', 'postClaimTaskStateVersion',
  'postAttemptTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'postAttemptControlVersion', 'epoch',
] as const;
const REF_KEYS = ['reference', 'digest'] as const;
const EFFECT_KEYS = ['taskTransition', 'revision', 'invalidatedEvidence', 'accounting'] as const;
const SETTLEMENT_KEYS = ['disposition', 'reservationRefs', 'observedUsage'] as const;
export const sha256 = /^sha256:[0-9a-f]{64}$/;
export const addErr = (errors: ValidationError[], path: string, message: string, code: string): number => errors.push({ path, message, code });
const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);

export function digestWithout(input: Record<string, unknown>, digestKey: string): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (key !== digestKey) copy[key] = value;
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

export function canonicalEqual(a: unknown, b: unknown): boolean {
  try { return computeCanonicalSha256(a) === computeCanonicalSha256(b); } catch { return false; }
}

function validateVersionBindings(input: unknown, admission: AdmissionContextV02, claim: ClaimReceiptV02, attempt: AttemptOutcomeValidationContextV02['trustedAttempt'], errors: ValidationError[]): void {
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
    if (value !== expected[key]) addErr(errors, `versions.${key}`, 'Version binding does not match trusted admission, claim, and attempt', 'VERSION_BINDING_MISMATCH');
  }
}

function validateTrustedContext(context: AttemptOutcomeValidationContextV02 | undefined, errors: ValidationError[]): context is AttemptOutcomeValidationContextV02 {
  if (!context || !isPlainObject(context)) { addErr(errors, 'trustedContext', 'Independent admission, current claim, attempt, and current versions are required', 'TRUSTED_CONTEXT_REQUIRED'); return false; }
  const { trustedAdmission: admission, trustedClaim: claim, trustedAttempt: attempt } = context;
  if (!isPlainObject(admission) || !isPlainObject(claim) || !isPlainObject(attempt)) { addErr(errors, 'trustedContext', 'Trusted records must be plain objects', 'INVALID_TRUSTED_CONTEXT'); return false; }
  if (context.currentClaimStatus !== 'attempting' && context.currentClaimStatus !== 'dispatched') addErr(errors, 'trustedContext.currentClaimStatus', 'Outcome requires a currently attempting or dispatched claim', 'INVALID_CLAIM_STATUS');
  for (const [key, value] of Object.entries({ currentTaskStateVersion: context.currentTaskStateVersion, currentControlVersion: context.currentControlVersion, currentEpoch: context.currentEpoch })) validateNonNegativeInteger(value, `trustedContext.${key}`, errors);
  if (context.currentTaskStateVersion < attempt.postBeginTaskStateVersion || context.currentControlVersion < attempt.postBeginControlVersion || context.currentEpoch !== admission.expectedEpoch) addErr(errors, 'trustedContext', 'Current versions/epoch are stale or cross-epoch', 'STALE_CURRENT_SNAPSHOT');
  if (claim.status !== 'claimed' || claim.taskId !== admission.taskId || claim.runId !== admission.runId || claim.subjectKind !== admission.subjectKind || claim.planApplicability !== admission.planApplicability || claim.epoch !== admission.expectedEpoch) addErr(errors, 'trustedContext.claim', 'Current claim does not match trusted admission', 'TRUSTED_CLAIM_MISMATCH');
  const admissionReservations = admission.subjectKind === 'repository-action' ? admission.reservationRefs : [admission.requestReservationReceipt, ...admission.budgetRefs];
  if (!canonicalEqual(claim.reservationRefs, admissionReservations)) addErr(errors, 'trustedContext.claim.reservationRefs', 'Claim reservations do not match the trusted admission', 'TRUSTED_CLAIM_RESERVATION_MISMATCH');
  if (attempt.claimId !== claim.claimId || attempt.taskId !== claim.taskId || attempt.epoch !== claim.epoch || attempt.preAttemptTaskStateVersion !== claim.preClaimTaskStateVersion || attempt.preAttemptControlVersion !== claim.postClaimControlVersion) addErr(errors, 'trustedContext.attempt', 'Current attempt does not descend from the trusted claim', 'TRUSTED_ATTEMPT_MISMATCH');
  const repairPatch = admission.subjectKind === 'repository-action' && admission.action.kind === 'apply_patch';
  if (attempt.postBeginTaskStateVersion !== attempt.preAttemptTaskStateVersion + (repairPatch ? 1 : 0) || attempt.postBeginControlVersion !== attempt.preAttemptControlVersion + 1) addErr(errors, 'trustedContext.attempt', 'Trusted attempt versions do not match the admitted branch progression', 'TRUSTED_ATTEMPT_VERSION_MISMATCH');
  const expectedDigest = computeAdmissionDigest(admission as unknown as Record<string, unknown>);
  if (admission.admissionDigest !== undefined && admission.admissionDigest !== expectedDigest) addErr(errors, 'trustedContext.admissionDigest', 'Trusted admission digest is invalid', 'TRUSTED_ADMISSION_DIGEST_INVALID');
  return true;
}

export function checkCommon(input: Record<string, unknown>, allowed: readonly string[], context: AttemptOutcomeValidationContextV02 | undefined, errors: ValidationError[]): void {
  rejectUnknownKeys(input, allowed, 'receipt', errors);
  for (const key of ['receiptId', 'receiptDigest', 'claimId', 'claimDigest', 'attemptId', 'admissionDigest']) validateNonEmptyString(input[key], key, errors);
  if (input['receiptDigest'] !== digestWithout(input, 'receiptDigest')) addErr(errors, 'receiptDigest', 'Outcome receipt digest mismatch', 'RECEIPT_DIGEST_MISMATCH');
  const trusted = validateTrustedContext(context, errors);
  if (!trusted) return;
  const { trustedAdmission: admission, trustedClaim: claim, trustedAttempt: attempt } = context;
  const digest = computeAdmissionDigest(admission as unknown as Record<string, unknown>);
  if (input['admissionDigest'] !== digest) addErr(errors, 'admissionDigest', 'Admission digest does not match independently trusted admission', 'ADMISSION_DIGEST_MISMATCH');
  if (input['claimId'] !== claim.claimId || input['claimDigest'] !== claim.claimDigest) addErr(errors, 'claimId', 'Claim identity/digest mismatch', 'CLAIM_BINDING_MISMATCH');
  if (input['attemptId'] !== attempt.attemptId || !canonicalEqual(input['executorIdentity'], attempt.executorIdentity)) addErr(errors, 'attemptId', 'Attempt identity/executor mismatch', 'ATTEMPT_BINDING_MISMATCH');
  validateVersionBindings(input['versions'], admission, claim, attempt, errors);
  validateSafeRef(input['resultRef'], 'resultRef', errors);
  validateSafeRefArray(input['evidenceRefs'], 'evidenceRefs', errors);
  if (input['outcome'] !== 'observed' && input['outcome'] !== 'proven-not-dispatched' && input['outcome'] !== 'uncertain') addErr(errors, 'outcome', 'Invalid outcome status', 'INVALID_OUTCOME');
  validateEffects(input['proposedEffects'], input['outcome'] as AttemptOutcomeStatusV02, admission, errors);
}

function validateEffects(input: unknown, outcome: AttemptOutcomeStatusV02, admission: AdmissionContextV02, errors: ValidationError[]): void {
  if (!isPlainObject(input)) { addErr(errors, 'proposedEffects', 'Proposed settlement effects are required', 'INVALID_TYPE'); return; }
  rejectUnknownKeys(input, EFFECT_KEYS, 'proposedEffects', errors);
  const transition = input['taskTransition'];
  if (!isPlainObject(transition)) addErr(errors, 'proposedEffects.taskTransition', 'Task transition is required', 'INVALID_TYPE');
  else if (transition['kind'] === 'none') rejectUnknownKeys(transition, ['kind'], 'proposedEffects.taskTransition', errors);
  else if (transition['kind'] === 'transition') {
    rejectUnknownKeys(transition, ['kind', 'fromNode', 'toNode'], 'proposedEffects.taskTransition', errors);
    validateNonEmptyString(transition['fromNode'], 'proposedEffects.taskTransition.fromNode', errors);
    validateNonEmptyString(transition['toNode'], 'proposedEffects.taskTransition.toNode', errors);
    const expectedFromNode = admission.subjectKind === 'repository-action' && admission.action.kind === 'apply_patch' && admission.runnableNode === 'Repair' ? 'Patch' : admission.runnableNode;
    if (transition['fromNode'] !== expectedFromNode) addErr(errors, 'proposedEffects.taskTransition.fromNode', 'Transition source does not match the admitted node/attempt boundary', 'TASK_TRANSITION_SOURCE_MISMATCH');
  } else addErr(errors, 'proposedEffects.taskTransition.kind', 'Invalid task transition kind', 'INVALID_TASK_TRANSITION');
  const revision = input['revision'];
  if (!isPlainObject(revision)) addErr(errors, 'proposedEffects.revision', 'Revision effect is required', 'INVALID_TYPE');
  else {
    const kind = revision['kind'];
    if (kind === 'advance') {
      rejectUnknownKeys(revision, ['kind', 'revisionDigest'], 'proposedEffects.revision', errors);
      if (typeof revision['revisionDigest'] !== 'string' || !sha256.test(revision['revisionDigest'])) addErr(errors, 'proposedEffects.revision.revisionDigest', 'Revision digest must be canonical sha256', 'INVALID_DIGEST');
    } else if (kind === 'preserve' || kind === 'not-applicable') rejectUnknownKeys(revision, ['kind'], 'proposedEffects.revision', errors);
    else addErr(errors, 'proposedEffects.revision.kind', 'Invalid revision effect', 'INVALID_REVISION_EFFECT');
  }
  validateSafeRefArray(input['invalidatedEvidence'], 'proposedEffects.invalidatedEvidence', errors);
  const accounting = input['accounting'];
  if (!isPlainObject(accounting)) { addErr(errors, 'proposedEffects.accounting', 'Accounting settlement is required', 'INVALID_TYPE'); return; }
  rejectUnknownKeys(accounting, SETTLEMENT_KEYS, 'proposedEffects.accounting', errors);
  if (!['settle', 'hold', 'release-unused', 'none'].includes(String(accounting['disposition']))) addErr(errors, 'proposedEffects.accounting.disposition', 'Invalid accounting disposition', 'INVALID_ACCOUNTING_DISPOSITION');
  if (accounting['reservationRefs'] === undefined) addErr(errors, 'proposedEffects.accounting.reservationRefs', 'Reservation refs are required', 'MISSING_RESERVATIONS');
  else validateStringArray(accounting['reservationRefs'], 'proposedEffects.accounting.reservationRefs', errors);
  if (accounting['observedUsage'] !== undefined) {
    const usage = validateProviderUsage(accounting['observedUsage']);
    if (!usage.ok) errors.push(...usage.errors.map((error) => ({ ...error, path: `proposedEffects.accounting.${error.path}` })));
  }
  if (outcome === 'observed' && accounting['disposition'] !== 'settle') addErr(errors, 'proposedEffects.accounting.disposition', 'Observed outcomes require one settlement decision', 'ACCOUNTING_DISPOSITION_MISMATCH');
  if (outcome === 'uncertain' && accounting['disposition'] !== 'hold') addErr(errors, 'proposedEffects.accounting.disposition', 'Uncertain outcomes must retain reservations', 'ACCOUNTING_DISPOSITION_MISMATCH');
  if (outcome === 'proven-not-dispatched' && accounting['disposition'] !== 'release-unused') addErr(errors, 'proposedEffects.accounting.disposition', 'Non-dispatch outcomes may release only unused reservations', 'ACCOUNTING_DISPOSITION_MISMATCH');
  if (outcome !== 'observed' && isPlainObject(transition) && transition['kind'] !== 'none') addErr(errors, 'proposedEffects.taskTransition', 'Unobserved outcomes cannot propose a task transition', 'UNOBSERVED_EFFECT_FORBIDDEN');
  if (outcome !== 'observed' && isPlainObject(revision) && revision['kind'] === 'advance') addErr(errors, 'proposedEffects.revision', 'Unobserved outcomes cannot advance a revision', 'UNOBSERVED_EFFECT_FORBIDDEN');
}
