import { computeCanonicalSha256 } from './identity.ts';
import type {
  AttemptOutcomeReceiptV02,
  AttemptReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureReceiptV02,
  ExecutorIdentityV02,
  ProviderRequestOutcomeReceiptV02,
  RepositoryActionOutcomeReceiptV02,
  SubjectKindV02,
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
import { validateProviderUsage } from './validation/provider/records.ts';
import { protectValidator } from './admission-v02/snapshot.ts';

export type VersionProgressionKindV02 = 'claim' | 'begin-attempt';
export interface VersionDomainSnapshotV02 { taskStateVersion: number; controlVersion: number; epoch: number; }
export interface VersionProgressionV02 { kind: VersionProgressionKindV02; pre: VersionDomainSnapshotV02; post: VersionDomainSnapshotV02; isRepairPatch?: boolean; }
export interface ClaimClosureValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; claim?: Record<string, unknown>; hasCommittedAttempt?: boolean; expectedAdapterIdentity?: string; expectedMinFencingGeneration?: number; expectedFencedExecutorIdentity?: ExecutorIdentityV02; }
export interface AttemptValidationContextV02 { expectedTaskId?: string; expectedClaimId?: string; expectedAttemptId?: string; expectedEpoch?: number; isRepairPatch?: boolean; }
export interface AttemptOutcomeValidationContextV02 { expectedClaimId?: string; expectedAttemptId?: string; expectedPlanApplicability?: string; expectedActionDigest?: string; expectedRequestContentDigest?: string; expectedProviderRequestId?: string; expectedRole?: 'coder' | 'reviewer'; expectedProviderAdmissionReceiptRef?: string; expectedBudgetRefs?: readonly string[]; }
export type CanonicalAttemptOutcomeReceiptV02 = AttemptOutcomeReceiptV02;
export type CanonicalAttemptReconciliationReceiptV02 = AttemptReconciliationReceiptV02;
export type { AttemptReconciliationValidationContextV02 } from './admission-v02/reconciliation-v02.ts';

const EXEC_KEYS = ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest'] as const;
const CLOSURE_KEYS = ['receiptId', 'receiptDigest', 'claimId', 'taskId', 'reason', 'fencedExecutorIdentity', 'unconsumedReservations'] as const;
const ATT_KEYS = ['attemptId', 'claimId', 'taskId', 'executorIdentity', 'preAttemptTaskStateVersion', 'postBeginTaskStateVersion', 'preAttemptControlVersion', 'postBeginControlVersion', 'epoch', 'status'] as const;
const S_PLAN = ['planBindingDigest', 'planDecisionRef'] as const;
const BASE_OUT = ['receiptId', 'receiptDigest', 'claimId', 'attemptId', 'subjectKind', 'planApplicability', ...S_PLAN] as const;
const REPO_OUT_KEYS = [...BASE_OUT, 'actionDigest', 'outcome', 'observedResultRevisionDigest'] as const;
const PROV_OUT_KEYS = [...BASE_OUT, 'providerRequestId', 'requestContentDigest', 'role', 'outcome', 'observedUsage', 'providerAdmissionReceiptRef', 'budgetRefs'] as const;
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
  valExecId(input['executorIdentity'], 'executorIdentity', errs);
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
  const f = valExecId(input['fencedExecutorIdentity'], 'fencedExecutorIdentity', errs);
  validateStringArray(input['unconsumedReservations'], 'unconsumedReservations', errs);
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
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { claimId: 'expectedClaimId', taskId: 'expectedTaskId' }, errs);
  if (ctx?.expectedAdapterIdentity !== undefined && f && f.adapterIdentity !== ctx.expectedAdapterIdentity) addErr(errs, 'fencedExecutorIdentity.adapterIdentity', 'Adapter mismatch', 'ADAPTER_IDENTITY_MISMATCH');
  if (ctx?.expectedMinFencingGeneration !== undefined && f && f.fencingGeneration < ctx.expectedMinFencingGeneration) addErr(errs, 'fencedExecutorIdentity.fencingGeneration', 'Generation too low', 'FENCING_GENERATION_TOO_LOW');
  if (f && expectedFence && ['adapterIdentity', 'processIncarnation', 'payloadDigest', 'fencingGeneration'].some((key) => f[key as keyof ExecutorIdentityV02] !== expectedFence[key as keyof ExecutorIdentityV02])) {
    addErr(errs, 'fencedExecutorIdentity', 'Fenced recipient does not match trusted identity and generation', 'FENCED_EXECUTOR_MISMATCH');
  }
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as ClaimClosureReceiptV02 };
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

function validateRepositoryActionOutcomeReceiptImpl(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<RepositoryActionOutcomeReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkOutcomeCommon(input, REPO_OUT_KEYS, PROV_CROSS, 'repository-action', ctx, errs);
  validateNonEmptyString(input['actionDigest'], 'actionDigest', errs);
  if (ctx?.expectedActionDigest !== undefined && input['actionDigest'] !== ctx.expectedActionDigest) {
    addErr(errs, 'actionDigest', 'actionDigest mismatch', 'ACTION_DIGEST_MISMATCH');
  }
  if (input['observedResultRevisionDigest'] !== undefined) validateNonEmptyString(input['observedResultRevisionDigest'], 'observedResultRevisionDigest', errs);
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as RepositoryActionOutcomeReceiptV02 };
}

function validateProviderRequestOutcomeReceiptImpl(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<ProviderRequestOutcomeReceiptV02> {
  const errs: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkOutcomeCommon(input, PROV_OUT_KEYS, REPO_CROSS, 'provider-request', ctx, errs);
  const role = input['role'];
  if (role !== 'coder' && role !== 'reviewer') addErr(errs, 'role', 'role must be coder/reviewer', 'INVALID_ROLE');
  else if (ctx?.expectedRole !== undefined && role !== ctx.expectedRole) addErr(errs, 'role', 'role mismatch', 'ROLE_MISMATCH');
  reqStrs(input, ['providerRequestId', 'requestContentDigest'], '', errs);
  const adm = validateNonEmptyString(input['providerAdmissionReceiptRef'], 'providerAdmissionReceiptRef', errs);
  if (input['budgetRefs'] === undefined) addErr(errs, 'budgetRefs', 'Budget references are required', 'MISSING_BUDGET_REFS');
  else validateStringArray(input['budgetRefs'], 'budgetRefs', errs);
  if (!ctx?.expectedProviderAdmissionReceiptRef || !ctx.expectedBudgetRefs || ctx.expectedBudgetRefs.length === 0) {
    addErr(errs, 'trustedContext', 'Trusted provider admission and budget references are required', 'TRUSTED_CONTEXT_REQUIRED');
  } else {
    if (new Set(ctx.expectedBudgetRefs).size !== ctx.expectedBudgetRefs.length) addErr(errs, 'trustedContext.expectedBudgetRefs', 'Trusted budget references must be unique', 'INVALID_TRUSTED_CONTEXT');
    if (adm !== ctx.expectedProviderAdmissionReceiptRef) addErr(errs, 'providerAdmissionReceiptRef', 'Admission receipt reference mismatch', 'PROVIDER_ADMISSION_REF_MISMATCH');
    if (!Array.isArray(input['budgetRefs']) || input['budgetRefs'].length !== ctx.expectedBudgetRefs.length || !input['budgetRefs'].every((ref, i) => ref === ctx.expectedBudgetRefs?.[i])) {
      addErr(errs, 'budgetRefs', 'Budget references mismatch', 'BUDGET_REFS_MISMATCH');
    }
  }
  if (input['observedUsage'] !== undefined) {
    const usage = validateProviderUsage(input['observedUsage']);
    if (!usage.ok) errs.push(...usage.errors);
  }
  matchProps(input, ctx as Record<string, unknown> | undefined, { providerRequestId: 'expectedProviderRequestId', requestContentDigest: 'expectedRequestContentDigest' }, errs);
  return errs.length > 0 ? { ok: false, errors: errs } : { ok: true, value: input as unknown as ProviderRequestOutcomeReceiptV02 };
}

function validateAttemptOutcomeReceiptImpl(input: unknown, ctx?: AttemptOutcomeValidationContextV02): ValidationResult<AttemptOutcomeReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  const k = input['subjectKind'];
  return k === 'repository-action' ? validateRepositoryActionOutcomeReceiptImpl(input, ctx) : k === 'provider-request' ? validateProviderRequestOutcomeReceiptImpl(input, ctx) : { ok: false, errors: [{ path: 'subjectKind', message: 'Invalid subjectKind', code: 'INVALID_SUBJECT_KIND' }] };
}

export const validateProtocolVersionProgressionV02 = protectValidator(validateProtocolVersionProgressionImpl);
export const validateAttemptReceiptV02 = protectValidator(validateAttemptReceiptImpl);
export const validateClaimClosureReceiptV02 = protectValidator(validateClaimClosureReceiptImpl);
export const validateRepositoryActionOutcomeReceiptV02 = protectValidator(validateRepositoryActionOutcomeReceiptImpl);
export const validateProviderRequestOutcomeReceiptV02 = protectValidator(validateProviderRequestOutcomeReceiptImpl);
export const validateAttemptOutcomeReceiptV02 = protectValidator(validateAttemptOutcomeReceiptImpl);
export {
  computeReconciliationDigest,
  validateUncertainAttemptReconciliationReceiptV02,
  validateObservedOutcomeReconciliationReceiptV02,
  validateAttemptReconciliationReceiptV02,
} from './admission-v02/reconciliation-v02.ts';
