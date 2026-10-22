import { computeCanonicalSha256 } from './identity.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureReceiptV02,
  ExecutorIdentityV02,
  ObservedOutcomeReconciliationReceiptV02,
  ProviderRequestOutcomeReceiptV02,
  RepositoryActionOutcomeReceiptV02,
  SubjectKindV02,
  UncertainAttemptReconciliationReceiptV02,
} from './ports-v02.ts';
import type { ValidationError, ValidationResult } from './types.ts';
import {
  isPlainObject,
  rejectUnknownKeys,
  validateNonEmptyString,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStringArray,
} from './validation/common.ts';

export type VersionProgressionKindV02 = 'claim' | 'begin-attempt';
export interface VersionDomainSnapshotV02 { taskStateVersion: number; controlVersion: number; epoch: number; }
export interface VersionProgressionV02 { kind: VersionProgressionKindV02; pre: VersionDomainSnapshotV02; post: VersionDomainSnapshotV02; isRepairPatch?: boolean; }
export interface ClaimClosureValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; claim?: Record<string, unknown>; hasCommittedAttempt?: boolean; expectedAdapterIdentity?: string; expectedMinFencingGeneration?: number; }
export interface AttemptValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; expectedAttemptId?: string; expectedEpoch?: number; isRepairPatch?: boolean; }
export interface AttemptOutcomeValidationContextV02 { expectedClaimId?: string; expectedAttemptId?: string; expectedPlanApplicability?: string; expectedActionDigest?: string; expectedRequestContentDigest?: string; expectedProviderRequestId?: string; }
export interface AttemptReconciliationValidationContextV02 { predecessor: Record<string, unknown>; }
export type CanonicalAttemptOutcomeReceiptV02 = AttemptOutcomeReceiptV02;
export type CanonicalAttemptReconciliationReceiptV02 = AttemptReconciliationReceiptV02;

const EXEC_KEYS = ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest'] as const;
const CLOSURE_KEYS = ['receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason', 'fencedExecutorIdentity', 'unconsumedReservations'] as const;
const ATT_KEYS = ['attemptId', 'claimId', 'taskId', 'executorIdentity', 'preAttemptTaskStateVersion', 'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion', 'epoch', 'status'] as const;
const S_PLAN = ['planBindingDigest', 'planDecisionRef'] as const;
const BASE_OUT = ['receiptId', 'receiptDigest', 'claimId', 'attemptId', 'subjectKind', 'planApplicability', ...S_PLAN] as const;
const REPO_OUT_KEYS = [...BASE_OUT, 'actionDigest', 'outcome', 'observedResultRevisionDigest'] as const;
const PROV_OUT_KEYS = [...BASE_OUT, 'providerRequestId', 'requestContentDigest', 'role', 'outcome', 'observedUsage', 'providerAdmissionReceiptRef', 'admissionRef', 'budgetRefs'] as const;
const RECON_BASE_KEYS = ['reconciliationId', 'reconciliationDigest', 'reconciliationKind', 'predecessorReceiptId', 'claimId', 'attemptId', 'subjectKind', 'planApplicability'] as const;
const PROV_CROSS = ['providerRequestId', 'requestContentDigest', 'role', 'observedUsage', 'providerAdmissionReceiptRef', 'admissionRef', 'budgetRefs', 'providerIdentity'] as const;
const REPO_CROSS = ['actionDigest', 'observedResultRevisionDigest', 'commandView', 'action'] as const;

const addErr = (errs: ValidationError[], path: string, message: string, code: string) => {
  errs.push({ path, message, code });
};

const reqStrs = (o: Record<string, unknown>, keys: readonly string[], p: string, errs: ValidationError[]) => {
  for (const k of keys) validateNonEmptyString(o[k], p ? `${p}.${k}` : k, errs);
};

const chkCross = (o: Record<string, unknown>, keys: readonly string[], errs: ValidationError[]): boolean => {
  for (const k of keys) if (o[k] !== undefined) { addErr(errs, k, `Forbidden: ${k}`, 'CROSS_BRANCH_FIELDS_FORBIDDEN'); return false; }
  return true;
};

const matchProps = (o: Record<string, unknown>, t: Record<string, unknown> | undefined, m: Record<string, string>, errs: ValidationError[]) => {
  if (!t) return;
  for (const [k, exp] of Object.entries(m)) if (t[exp] !== undefined && o[k] !== t[exp]) addErr(errs, k, `${k} mismatch`, `${k.toUpperCase()}_MISMATCH`);
};

function valExecId(raw: unknown, p: string, errs: ValidationError[]): ExecutorIdentityV02 | undefined {
  if (!isPlainObject(raw)) { addErr(errs, p, `${p} must be object`, 'INVALID_TYPE'); return; }
  rejectUnknownKeys(raw, EXEC_KEYS, p, errs);
  reqStrs(raw, ['adapterIdentity', 'processIncarnation', 'payloadDigest'], p, errs);
  return validatePositiveInteger(raw['fencingGeneration'], `${p}.fencingGeneration`, errs) !== undefined ? (raw as unknown as ExecutorIdentityV02) : undefined;
}

const stripDigest = (obj: unknown, f: string): string => {
  if (!isPlainObject(obj)) throw new Error('Requires object');
  const copy = { ...(obj as Record<string, unknown>) };
  delete copy[f];
  return computeCanonicalSha256(copy);
};

export const computeClaimClosureDigest = (r: unknown) => stripDigest(r, 'receiptDigest');
export const computeAttemptOutcomeDigest = computeClaimClosureDigest;
export const computeReconciliationDigest = (r: unknown) => stripDigest(r, 'reconciliationDigest');

const failClosed = <T>(errs: ValidationError[], path: string): ValidationResult<T> => {
  addErr(errs, path, 'T039_NEUTRAL_FAIL_CLOSED', 'SUT_NEUTRAL_FAIL_CLOSED');
  return { ok: false, errors: errs };
};

export function validateProtocolVersionProgressionV02(input: unknown): ValidationResult<VersionProgressionV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'progression', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const { kind, pre, post, isRepairPatch } = input;
  if (kind !== 'claim' && kind !== 'begin-attempt') {
    addErr(errs, 'kind', 'Invalid kind', 'INVALID_PROGRESSION_KIND');
    return { ok: false, errors: errs };
  }
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
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'progression');
}

export function validateAttemptReceiptV02(input: unknown, ctx?: AttemptValidationContextV02): ValidationResult<AttemptReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  rejectUnknownKeys(input, ATT_KEYS, 'receipt', errs);
  reqStrs(input, ['attemptId', 'claimId', 'taskId'], '', errs);
  if (input['status'] !== 'attempting') addErr(errs, 'status', 'Invalid status', 'INVALID_STATUS');
  const [, pT, nT, pC, nC] = ['epoch', 'preAttemptTaskStateVersion', 'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion'].map((k) => validateNonNegativeInteger(input[k], k, errs));
  valExecId(input['executorIdentity'], 'executorIdentity', errs);
  if (pC !== undefined && nC !== undefined && nC !== pC + 1) addErr(errs, 'postBeginControlVersion', 'Control mismatch', 'CONTROL_VERSION_MISMATCH');
  if (pT !== undefined && nT !== undefined && nT !== (ctx?.isRepairPatch ? pT + 1 : pT)) {
    addErr(errs, 'postBeginTaskStateVersion', 'Task mismatch', 'TASK_VERSION_MISMATCH');
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { taskId: 'expectedTaskId', claimId: 'expectedClaimId', attemptId: 'expectedAttemptId', epoch: 'expectedEpoch' }, errs);
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'receipt');
}

export function validateClaimClosureReceiptV02(input: unknown, ctx?: ClaimClosureValidationContextV02): ValidationResult<ClaimClosureReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  if (input['attemptId'] !== undefined) return { ok: false, errors: [{ path: 'attemptId', message: 'No attemptId allowed', code: 'CLAIM_CLOSURE_CANNOT_HAVE_ATTEMPT_ID' }] };
  if (['actionDigest', 'providerRequestId', 'outcome', 'disposition', 'reconciliationKind'].some((k) => input[k] !== undefined)) {
    return { ok: false, errors: [{ path: 'receipt', message: 'Forbidden', code: 'CROSS_BRANCH_FIELDS_FORBIDDEN' }] };
  }
  rejectUnknownKeys(input, CLOSURE_KEYS, 'receipt', errs);
  reqStrs(input, ['receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason'], '', errs);
  const f = valExecId(input['fencedExecutorIdentity'], 'fencedExecutorIdentity', errs);
  validateStringArray(input['unconsumedReservations'], 'unconsumedReservations', errs);
  if (ctx) {
    if (ctx.hasCommittedAttempt === true) addErr(errs, 'proofOfNoAttempt', 'Attempt committed', 'PROOF_OF_NO_ATTEMPT_VIOLATION');
    const c = ctx.claim as Record<string, unknown> | undefined;
    if (c) {
      if (c['status'] !== 'claimed') addErr(errs, 'claim.status', `Status is "${c['status']}"`, 'CLAIM_NOT_IN_CLAIMED_STATUS');
      if (c['hasCommittedAttempt'] === true || c['attemptId'] !== undefined) addErr(errs, 'claim', 'Committed attempt exists', 'CLAIM_ALREADY_COMMITTED_ATTEMPT');
      matchProps(input, c, { claimId: 'claimId', taskId: 'taskId' }, errs);
    }
    if (ctx.expectedAdapterIdentity !== undefined && f && f.adapterIdentity !== ctx.expectedAdapterIdentity) {
      addErr(errs, 'fencedExecutorIdentity.adapterIdentity', 'Adapter mismatch', 'ADAPTER_IDENTITY_MISMATCH');
    }
    if (ctx.expectedMinFencingGeneration !== undefined && f && f.fencingGeneration < ctx.expectedMinFencingGeneration) {
      addErr(errs, 'fencedExecutorIdentity.fencingGeneration', 'Generation too low', 'FENCING_GENERATION_TOO_LOW');
    }
  }
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'closure');
}

function checkOutcomeCommon(input: Record<string, unknown>, allowed: readonly string[], cross: readonly string[], expKind: SubjectKindV02, ctx: AttemptOutcomeValidationContextV02 | undefined, errs: ValidationError[]): boolean {
  if (!chkCross(input, cross, errs)) return false;
  rejectUnknownKeys(input, allowed, 'receipt', errs);
  if (input['subjectKind'] !== expKind) addErr(errs, 'subjectKind', `Must be "${expKind}"`, 'INVALID_SUBJECT_KIND');
  const app = input['planApplicability'];
  if (app !== 'pre-plan-diagnostic' && app !== 'approved-plan') addErr(errs, 'planApplicability', 'Invalid planApplicability', 'INVALID_PLAN_APPLICABILITY');
  const outcome = input['outcome'];
  if (outcome !== 'observed' && outcome !== 'proven-not-dispatched' && outcome !== 'uncertain') addErr(errs, 'outcome', 'Invalid outcome', 'INVALID_OUTCOME');
  reqStrs(input, ['receiptId', 'receiptDigest', 'claimId', 'attemptId'], '', errs);
  if (app === 'approved-plan') reqStrs(input, S_PLAN, '', errs);
  else if (app === 'pre-plan-diagnostic' && (input['planBindingDigest'] !== undefined || input['planDecisionRef'] !== undefined)) {
    addErr(errs, 'planApplicability', 'Pre-plan cannot have plan fields', 'FABRICATED_PLAN_FIELDS_FORBIDDEN');
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { claimId: 'expectedClaimId', attemptId: 'expectedAttemptId', planApplicability: 'expectedPlanApplicability' }, errs);
  return errs.length === 0;
}

export function validateRepositoryActionOutcomeReceiptV02(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<RepositoryActionOutcomeReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkOutcomeCommon(input, REPO_OUT_KEYS, PROV_CROSS, 'repository-action', ctx, errs);
  validateNonEmptyString(input['actionDigest'], 'actionDigest', errs);
  if (ctx?.expectedActionDigest !== undefined && input['actionDigest'] !== ctx.expectedActionDigest) {
    addErr(errs, 'actionDigest', 'actionDigest mismatch', 'ACTION_DIGEST_MISMATCH');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'outcome');
}

export function validateProviderRequestOutcomeReceiptV02(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<ProviderRequestOutcomeReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkOutcomeCommon(input, PROV_OUT_KEYS, REPO_CROSS, 'provider-request', ctx, errs);
  const role = input['role'];
  if (role !== 'coder' && role !== 'reviewer') addErr(errs, 'role', 'role must be coder/reviewer', 'INVALID_ROLE');
  reqStrs(input, ['providerRequestId', 'requestContentDigest'], '', errs);
  const adm = input['providerAdmissionReceiptRef'] ?? input['admissionRef'];
  if (typeof adm !== 'string' || adm.trim().length === 0) addErr(errs, 'providerAdmissionReceiptRef', 'Missing admission ref', 'REQUIRED_FIELD');
  if (input['budgetRefs'] !== undefined) validateStringArray(input['budgetRefs'], 'budgetRefs', errs);
  matchProps(input, ctx as Record<string, unknown> | undefined, { providerRequestId: 'expectedProviderRequestId', requestContentDigest: 'expectedRequestContentDigest' }, errs);
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'outcome');
}

export function validateAttemptOutcomeReceiptV02(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<AttemptOutcomeReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const k = input['subjectKind'];
  return k === 'repository-action' ? validateRepositoryActionOutcomeReceiptV02(input, ctx) : k === 'provider-request' ? validateProviderRequestOutcomeReceiptV02(input, ctx) : { ok: false, errors: [{ path: 'subjectKind', message: 'Invalid subjectKind', code: 'INVALID_SUBJECT_KIND' }] };
}

function checkReconCommon(input: Record<string, unknown>, allowed: readonly string[], expKind: string, ctx: AttemptReconciliationValidationContextV02 | undefined, errs: ValidationError[]): boolean {
  rejectUnknownKeys(input, allowed, 'receipt', errs);
  if (input['reconciliationKind'] !== expKind) addErr(errs, 'reconciliationKind', `Must be "${expKind}"`, 'INVALID_RECONCILIATION_KIND');
  reqStrs(input, ['reconciliationId', 'reconciliationDigest', 'predecessorReceiptId', 'claimId', 'attemptId'], '', errs);
  const sKind = input['subjectKind'], app = input['planApplicability'];
  if (sKind !== 'repository-action' && sKind !== 'provider-request') addErr(errs, 'subjectKind', 'Invalid subjectKind', 'INVALID_SUBJECT_KIND');
  if (app !== 'pre-plan-diagnostic' && app !== 'approved-plan') addErr(errs, 'planApplicability', 'Invalid planApplicability', 'INVALID_PLAN_APPLICABILITY');
  const p = ctx?.predecessor as Record<string, unknown> | undefined;
  if (p) {
    if (input['predecessorReceiptId'] !== p['receiptId']) addErr(errs, 'predecessorReceiptId', 'predecessorReceiptId mismatch', 'PREDECESSORRECEIPTID_MISMATCH');
    for (const k of ['claimId', 'attemptId', 'subjectKind', 'planApplicability']) {
      if (p[k] !== undefined && input[k] !== p[k]) addErr(errs, k, `${k} mismatch`, `${k.toUpperCase()}_MISMATCH`);
    }
  }
  return errs.length === 0;
}

export function validateUncertainAttemptReconciliationReceiptV02(input: unknown, ctx?: AttemptReconciliationValidationContextV02): ValidationResult<UncertainAttemptReconciliationReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkReconCommon(input, [...RECON_BASE_KEYS, 'disposition'], 'uncertain-attempt', ctx, errs);
  const disp = input['disposition'];
  if (disp !== 'observed-and-accounted' && disp !== 'proven-not-dispatched') addErr(errs, 'disposition', 'Invalid disposition', 'INVALID_DISPOSITION');
  const p = ctx?.predecessor as Record<string, unknown> | undefined;
  if (p && p['outcome'] !== 'uncertain') {
    addErr(errs, 'predecessor.outcome', `Predecessor is "${p['outcome']}"; accepted only for "uncertain"`, 'PREDECESSOR_NOT_UNCERTAIN');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'reconciliation');
}

export function validateObservedOutcomeReconciliationReceiptV02(input: unknown, ctx?: AttemptReconciliationValidationContextV02): ValidationResult<ObservedOutcomeReconciliationReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  if (input['disposition'] !== undefined || input['outcome'] !== undefined) {
    return { ok: false, errors: [{ path: 'disposition', message: 'Observed reconciliation cannot rewrite outcome', code: 'OUTCOME_REWRITE_FORBIDDEN' }] };
  }
  checkReconCommon(input, RECON_BASE_KEYS, 'observed-unsettled', ctx, errs);
  const p = ctx?.predecessor as Record<string, unknown> | undefined;
  if (p && p['outcome'] !== 'observed') {
    addErr(errs, 'predecessor.outcome', `Predecessor is "${p['outcome']}"; accepted only for "observed"`, 'PREDECESSOR_NOT_OBSERVED');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : failClosed(errs, 'reconciliation');
}

export function validateAttemptReconciliationReceiptV02(input: unknown, ctx?: AttemptReconciliationValidationContextV02): ValidationResult<AttemptReconciliationReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const k = input['reconciliationKind'];
  return k === 'uncertain-attempt' ? validateUncertainAttemptReconciliationReceiptV02(input, ctx) : k === 'observed-unsettled' ? validateObservedOutcomeReconciliationReceiptV02(input, ctx) : { ok: false, errors: [{ path: 'reconciliationKind', message: 'Invalid reconciliationKind', code: 'INVALID_RECONCILIATION_KIND' }] };
}
