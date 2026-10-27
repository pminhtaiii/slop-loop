import { computeCanonicalSha256 } from './identity.ts';
import { computeAdmissionDigest } from './admission-v02.ts';
import type {
  RepositoryAdmissionContextV02,
  RepositoryExecutionReceiptV02,
  AttemptOutcomeReceiptV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureReceiptV02,
  ExecutorIdentityV02,
} from './ports-v02.ts';
import type { ValidationError, ValidationResult } from './types.ts';
import {
  isPlainObject,
  rejectUnknownKeys,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validateStringArray,
} from './validation/common.ts';
import { protectValidator } from './admission-v02/snapshot.ts';
import {
  validateAttemptOutcomeReceiptV02,
  validateProviderRequestOutcomeReceiptV02,
  validateRepositoryActionOutcomeReceiptV02,
} from './admission-v02/attempt-outcome-v02.ts';
import { REPO_KEYS, canonicalEqual, validateVersionBindings, validateEffects, validateSafeRef, validateSafeRefArray, checkActionDecisionBinding, validateExecutorIdentityV02 } from './admission-v02/attempt-outcome-common-v02.ts';

export type VersionProgressionKindV02 = 'claim' | 'begin-attempt';
export interface VersionDomainSnapshotV02 { taskStateVersion: number; controlVersion: number; epoch: number; }
export interface VersionProgressionV02 { kind: VersionProgressionKindV02; pre: VersionDomainSnapshotV02; post: VersionDomainSnapshotV02; isRepairPatch?: boolean; }
export interface ClaimClosureValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; claim?: Record<string, unknown>; hasCommittedAttempt?: boolean; expectedAdapterIdentity?: string; expectedMinFencingGeneration?: number; expectedFencedExecutorIdentity?: ExecutorIdentityV02; }
export interface AttemptValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; expectedAttemptId?: string; expectedEpoch?: number; isRepairPatch?: boolean; }
export type { AttemptOutcomeValidationContextV02 } from './admission-v02/attempt-outcome-v02.ts';
export type CanonicalAttemptOutcomeReceiptV02 = AttemptOutcomeReceiptV02;
export type CanonicalAttemptReconciliationReceiptV02 = AttemptReconciliationReceiptV02;
export type { AttemptReconciliationValidationContextV02 } from './admission-v02/reconciliation-v02.ts';

const CLOSURE_KEYS = ['receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason', 'fencedExecutorIdentity', 'unconsumedReservations'] as const;
const ATT_KEYS = ['attemptId', 'claimId', 'taskId', 'executorIdentity', 'preAttemptTaskStateVersion', 'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion', 'epoch', 'status'] as const;

const addErr = (errs: ValidationError[], path: string, message: string, code: string) => {
  errs.push({ path, message, code });
};

const reqStrs = (o: Record<string, unknown>, keys: readonly string[], p: string, errs: ValidationError[]) => {
  for (const k of keys) validateNonEmptyString(o[k], p ? `${p}.${k}` : k, errs);
};

const matchProps = (o: Record<string, unknown>, t: Record<string, unknown> | undefined, m: Record<string, string>, errs: ValidationError[]) => {
  if (!t) return;
  for (const [k, exp] of Object.entries(m)) if (t[exp] !== undefined && o[k] !== t[exp]) addErr(errs, k, `${k} mismatch`, `${k.toUpperCase()}_MISMATCH`);
};

const stripDigest = (obj: unknown, f: string): string => {
  if (!isPlainObject(obj)) throw new Error('Requires object');
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== f) copy[k] = v;
  }
  return computeCanonicalSha256(copy);
};

export const computeClaimClosureDigest = (r: unknown): string => stripDigest(r, 'receiptDigest');
export const computeAttemptOutcomeDigest = (r: unknown): string => stripDigest(r, 'receiptDigest');

function validateProtocolVersionProgressionImpl(input: unknown): ValidationResult<VersionProgressionV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'progression', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const { kind, pre, post, isRepairPatch } = input;
  if (kind !== 'claim' && kind !== 'begin-attempt') {
    addErr(errs, 'kind', 'Invalid kind', 'INVALID_PROGRESSION_KIND');
    return { ok: false, errors: errs };
  }
  if (isRepairPatch !== undefined && typeof isRepairPatch !== 'boolean') addErr(errs, 'isRepairPatch', 'Must be a boolean', 'INVALID_REPAIR_PATCH_FLAG');
  if (!isPlainObject(pre) || !isPlainObject(post)) return { ok: false, errors: [{ path: 'pre/post', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const [pT, pC, pE] = ['taskStateVersion', 'controlVersion', 'epoch'].map((k) => validateNonNegativeInteger(pre[k], `pre.${k}`, errs));
  const [nT, nC, nE] = ['taskStateVersion', 'controlVersion', 'epoch'].map((k) => validateNonNegativeInteger(post[k], `post.${k}`, errs));
  if (pT === undefined || pC === undefined || pE === undefined || nT === undefined || nC === undefined || nE === undefined) return { ok: false, errors: errs };
  if (pE !== nE) addErr(errs, 'epoch', 'Epoch mismatch', 'EPOCH_MISMATCH');
  if (nC !== pC + 1) addErr(errs, 'controlVersion', 'Control must advance by 1', 'CONTROL_VERSION_PROGRESSION_INVALID');
  if (kind === 'claim' && nT !== pT) addErr(errs, 'taskStateVersion', 'Claim must preserve task version', 'TASK_VERSION_MUTATED_ON_CLAIM');
  if (kind === 'begin-attempt' && nT !== (isRepairPatch ? pT + 1 : pT)) {
    addErr(errs, 'taskStateVersion', isRepairPatch ? 'Repair must advance task version by 1' : 'Non-repair must preserve task version', isRepairPatch ? 'TASK_VERSION_PROGRESSION_INVALID' : 'TASK_VERSION_MUTATED_ON_NON_REPAIR');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as VersionProgressionV02 };
}

function validateAttemptReceiptImpl(input: unknown, ctx?: AttemptValidationContextV02): ValidationResult<AttemptReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  rejectUnknownKeys(input, ATT_KEYS, 'receipt', errs);
  reqStrs(input, ['attemptId', 'claimId', 'taskId'], '', errs);
  if (input['status'] !== 'attempting') addErr(errs, 'status', 'Invalid status', 'INVALID_STATUS');
  const [, pT, nT, pC, nC] = ['epoch', 'preAttemptTaskStateVersion', 'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion'].map((k) => validateNonNegativeInteger(input[k], k, errs));
  if (ctx?.isRepairPatch !== undefined && typeof ctx.isRepairPatch !== 'boolean') addErr(errs, 'trustedContext.isRepairPatch', 'Must be a boolean', 'INVALID_REPAIR_PATCH_FLAG');
  validateExecutorIdentityV02(input['executorIdentity'], 'executorIdentity', errs);
  if (pC !== undefined && nC !== undefined && nC !== pC + 1) addErr(errs, 'postBeginControlVersion', 'Control mismatch', 'CONTROL_VERSION_MISMATCH');
  if (pT !== undefined && nT !== undefined && nT !== (ctx?.isRepairPatch ? pT + 1 : pT)) {
    addErr(errs, 'postBeginTaskStateVersion', 'Task mismatch', 'TASK_VERSION_MISMATCH');
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { taskId: 'expectedTaskId', claimId: 'expectedClaimId', attemptId: 'expectedAttemptId', epoch: 'expectedEpoch' }, errs);
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as AttemptReceiptV02 };
}

function validateClaimClosureReceiptImpl(input: unknown, ctx?: ClaimClosureValidationContextV02): ValidationResult<ClaimClosureReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  if (input['attemptId'] !== undefined) return { ok: false, errors: [{ path: 'attemptId', message: 'No attemptId allowed', code: 'CLAIM_CLOSURE_CANNOT_HAVE_ATTEMPT_ID' }] };
  if (['actionDigest', 'providerRequestId', 'outcome', 'disposition', 'reconciliationKind'].some((k) => input[k] !== undefined)) {
    return { ok: false, errors: [{ path: 'receipt', message: 'Forbidden', code: 'CROSS_BRANCH_FIELDS_FORBIDDEN' }] };
  }
  rejectUnknownKeys(input, CLOSURE_KEYS, 'receipt', errs);
  reqStrs(input, ['receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason'], '', errs);
  if (input['receiptDigest'] !== computeClaimClosureDigest(input)) {
    addErr(errs, 'receiptDigest', 'Claim closure digest mismatch', 'RECEIPT_DIGEST_MISMATCH');
  }
  const f = validateExecutorIdentityV02(input['fencedExecutorIdentity'], 'fencedExecutorIdentity', errs);
  validateStringArray(input['unconsumedReservations'], 'unconsumedReservations', errs);
  const unconsumedReservations = input['unconsumedReservations'];
  const c = ctx?.claim;
  const expectedFence = ctx?.expectedFencedExecutorIdentity;
  if (!ctx || !ctx.expectedTaskId || !ctx.expectedClaimId || !ctx.claim || ctx.hasCommittedAttempt !== false || !expectedFence) {
    addErr(errs, 'trustedContext', 'Complete no-attempt and fenced-recipient proof is required', 'TRUSTED_CONTEXT_REQUIRED');
  }
  if (ctx?.hasCommittedAttempt !== false) addErr(errs, 'proofOfNoAttempt', 'Trusted proof must establish no committed attempt', 'PROOF_OF_NO_ATTEMPT_VIOLATION');
  if (!c || typeof c['claimId'] !== 'string' || typeof c['taskId'] !== 'string' || typeof c['claimDigest'] !== 'string' ||
    c['status'] !== 'claimed' || c['hasCommittedAttempt'] !== false || c['attemptId'] !== undefined) {
    addErr(errs, 'claim', 'Trusted claim must prove an unattempted claimed state', 'INCOMPLETE_CLAIM_PROOF');
  } else {
    matchProps(input, c, { claimId: 'claimId', taskId: 'taskId' }, errs);
    if (ctx?.expectedClaimId !== c['claimId'] || ctx?.expectedTaskId !== c['taskId']) addErr(errs, 'trustedContext.claim', 'Expected claim identity does not match proof', 'CLAIM_IDENTITY_MISMATCH');
    const reservationRefs = c['reservationRefs'];
    if (!Array.isArray(reservationRefs) || !Array.isArray(unconsumedReservations) ||
      reservationRefs.length !== unconsumedReservations.length ||
      reservationRefs.some((ref, index) => ref !== unconsumedReservations[index])) {
      addErr(errs, 'unconsumedReservations', 'Reservations must exactly match the trusted claim', 'RESERVATION_REFS_MISMATCH');
    }
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { claimId: 'expectedClaimId', taskId: 'expectedTaskId' }, errs);
  if (ctx?.expectedAdapterIdentity !== undefined && f && f.adapterIdentity !== ctx.expectedAdapterIdentity) addErr(errs, 'fencedExecutorIdentity.adapterIdentity', 'Adapter mismatch', 'ADAPTER_IDENTITY_MISMATCH');
  if (ctx?.expectedMinFencingGeneration !== undefined && f && f.fencingGeneration < ctx.expectedMinFencingGeneration) addErr(errs, 'fencedExecutorIdentity.fencingGeneration', 'Generation too low', 'FENCING_GENERATION_TOO_LOW');
  if (f && expectedFence && ['adapterIdentity', 'processIncarnation', 'payloadDigest', 'fencingGeneration'].some((key) => f[key as keyof ExecutorIdentityV02] !== expectedFence[key as keyof ExecutorIdentityV02])) {
    addErr(errs, 'fencedExecutorIdentity', 'Fenced recipient does not match trusted identity and generation', 'FENCED_EXECUTOR_MISMATCH');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as ClaimClosureReceiptV02 };
}

export const validateProtocolVersionProgressionV02 = protectValidator(validateProtocolVersionProgressionImpl);
export const validateAttemptReceiptV02 = protectValidator(validateAttemptReceiptImpl);
export const validateClaimClosureReceiptV02 = protectValidator(validateClaimClosureReceiptImpl);
export {
  validateRepositoryActionOutcomeReceiptV02,
  validateProviderRequestOutcomeReceiptV02,
  validateAttemptOutcomeReceiptV02,
};
export {
  computeReconciliationDigest,
  validateUncertainAttemptReconciliationReceiptV02,
  validateObservedOutcomeReconciliationReceiptV02,
  validateAttemptReconciliationReceiptV02,
} from './admission-v02/reconciliation-v02.ts';

/** Post-settlement binding checks only; does not assert current durable journal state. */
export const validateRepositoryExecutionReceiptV02 = protectValidator(function (
  input: unknown,
  admission?: RepositoryAdmissionContextV02,
): ValidationResult<RepositoryExecutionReceiptV02> {
  const errors: ValidationError[] = [];
  const fail = (): ValidationResult<RepositoryExecutionReceiptV02> => ({ ok: false, errors: [{ path: 'executionReceipt', message: 'Invalid settled repository handoff', code: 'INVALID_EXECUTION_RECEIPT' }, ...errors] });
  if (!admission || !isPlainObject(input)) return fail();
  rejectUnknownKeys(input, ['claim', 'attempt', 'outcome', 'settlement'], 'executionReceipt', errors);
  const claim = input['claim'];
  if (!isPlainObject(claim)) return fail();
  const claimKeys = ['claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability', 'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'epoch', 'status', 'reservationRefs'];
  rejectUnknownKeys(claim, claimKeys, 'claim', errors);
  reqStrs(claim, ['claimId', 'claimDigest'], 'claim', errors);
  const expectedClaim = {
    taskId: admission.taskId, runId: admission.runId, subjectKind: admission.subjectKind,
    planApplicability: admission.planApplicability, preClaimTaskStateVersion: admission.expectedTaskStateVersion,
    preClaimControlVersion: admission.expectedControlVersion, postClaimControlVersion: admission.expectedControlVersion + 1,
    epoch: admission.expectedEpoch, status: 'claimed', reservationRefs: admission.reservationRefs,
  };
  if (Object.entries(expectedClaim).some(([key, value]) => !canonicalEqual(claim[key], value)) ||
    claim['claimDigest'] !== computeCanonicalSha256({ ...claim, claimDigest: undefined })) return fail();
  const attemptResult = validateAttemptReceiptV02(input['attempt'], {
    expectedTaskId: admission.taskId, expectedClaimId: String(claim['claimId']), expectedEpoch: admission.expectedEpoch,
    isRepairPatch: admission.action.kind === 'apply_patch' && admission.planApplicability === 'approved-plan',
  });
  if (!attemptResult.ok) return fail();
  const attempt = attemptResult.value;
  if (attempt.preAttemptTaskStateVersion !== claim['preClaimTaskStateVersion'] ||
    attempt.preAttemptControlVersion !== claim['postClaimControlVersion'] ||
    attempt.executorIdentity.payloadDigest !== admission.actionDigest) return fail();
  const outcome = input['outcome'];
  const settlement = input['settlement'];
  if (!isPlainObject(outcome) || !isPlainObject(settlement)) return fail();
  rejectUnknownKeys(outcome, REPO_KEYS, 'outcome', errors);
  rejectUnknownKeys(settlement, ['outcome', 'receiptId'], 'settlement', errors);
  reqStrs(outcome, ['receiptId', 'receiptDigest'], 'outcome', errors);
  if (outcome['receiptDigest'] !== computeAttemptOutcomeDigest(outcome) || outcome['outcome'] !== 'observed' ||
    settlement['outcome'] !== 'settled' || settlement['receiptId'] !== outcome['receiptId']) return fail();
  const expectedOutcome = {
    claimId: claim['claimId'], claimDigest: claim['claimDigest'], attemptId: attempt.attemptId,
    executorIdentity: attempt.executorIdentity, admissionDigest: computeAdmissionDigest(admission),
    subjectKind: 'repository-action', actionDigest: admission.actionDigest, planApplicability: admission.planApplicability,
    repositoryOperation: admission.action.kind === 'apply_patch' ? 'apply-patch' : 'run-command',
    policyAuthorityRef: admission.policyAuthorityRef, policyEvaluationReceiptRef: admission.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: admission.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: admission.policyEvaluationReceipt.freshnessContextDigest,
  };
  if (Object.entries(expectedOutcome).some(([key, value]) => !canonicalEqual(outcome[key], value))) return fail();
  for (const key of ['planBindingDigest', 'planDecisionRef', 'diagnosticPurpose', 'taskCriteriaDigest', 'checkSetDigest'] as const) {
    if (Object.hasOwn(outcome, key) !== (admission[key] !== undefined) || outcome[key] !== admission[key]) return fail();
  }
  checkActionDecisionBinding(outcome, admission, errors);
  // Claim shape and admission bindings were checked above, without pretending it is still current.
  const trustedClaim = claim as unknown as RepositoryExecutionReceiptV02['claim'];
  validateVersionBindings(outcome['versions'], admission, trustedClaim, attempt, errors);
  validateSafeRef(outcome['resultRef'], 'resultRef', errors);
  validateSafeRefArray(outcome['evidenceRefs'], 'evidenceRefs', errors);
  validateEffects(outcome['proposedEffects'], 'observed', admission, errors);
  const effects = outcome['proposedEffects'];
  if (!isPlainObject(effects) || !isPlainObject(effects['accounting']) ||
    !canonicalEqual(effects['accounting']['reservationRefs'], admission.reservationRefs) ||
    Object.hasOwn(effects['accounting'], 'observedUsage') || !isPlainObject(effects['revision'])) return fail();
  const expectedTransition = admission.action.kind === 'apply_patch' && admission.planApplicability === 'approved-plan'
    ? { kind: 'transition', fromNode: 'Patch', toNode: 'Verify' }
    : { kind: 'none' };
  // Admission grants no named evidence invalidation; owners invalidate revision-bound state at settlement.
  if (!canonicalEqual(effects['taskTransition'], expectedTransition) ||
    !canonicalEqual(effects['invalidatedEvidence'], [])) return fail();
  if (admission.action.kind === 'apply_patch') {
    if (typeof outcome['observedResultRevisionDigest'] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(outcome['observedResultRevisionDigest']) ||
      effects['revision']['kind'] !== 'advance' || effects['revision']['revisionDigest'] !== outcome['observedResultRevisionDigest']) return fail();
  } else if (Object.hasOwn(outcome, 'observedResultRevisionDigest') || effects['revision']['kind'] !== 'preserve') return fail();
  return errors.length ? fail() : { ok: true, value: input as unknown as RepositoryExecutionReceiptV02 };
});
