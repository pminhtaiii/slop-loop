import { computeCanonicalSha256 } from '../identity.ts';
import type {
  AttemptReconciliationReceiptV02,
  ObservedOutcomeReconciliationReceiptV02,
  UncertainAttemptReconciliationReceiptV02,
} from '../ports-v02.ts';
import type { ValidationError, ValidationResult } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString } from '../validation/common.ts';
import { protectValidator } from './snapshot.ts';

export interface AttemptReconciliationValidationContextV02 {
  readonly predecessor?: Record<string, unknown>;
  readonly predecessorReceiptDigest?: string;
}

const BASE_KEYS = ['reconciliationId', 'reconciliationDigest', 'reconciliationKind', 'predecessorReceiptId', 'predecessorReceiptDigest', 'claimId', 'attemptId', 'subjectKind', 'planApplicability'] as const;
const addErr = (errors: ValidationError[], path: string, message: string, code: string) => errors.push({ path, message, code });

function stripDigest(obj: unknown): string {
  if (!isPlainObject(obj)) throw new Error('Requires object');
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) if (key !== 'reconciliationDigest') copy[key] = value;
  return computeCanonicalSha256(copy);
}

export const computeReconciliationDigest = (receipt: unknown): string => stripDigest(receipt);

function outcomeDigest(receipt: Record<string, unknown>): string {
  const copy = { ...receipt };
  delete copy['receiptDigest'];
  return computeCanonicalSha256(copy);
}

function checkCommon(
  input: Record<string, unknown>, allowed: readonly string[], kind: string,
  context: AttemptReconciliationValidationContextV02 | undefined, errors: ValidationError[],
): void {
  rejectUnknownKeys(input, allowed, 'receipt', errors);
  if (input['reconciliationKind'] !== kind) addErr(errors, 'reconciliationKind', 'Invalid reconciliation kind', 'INVALID_RECONCILIATION_KIND');
  for (const key of ['reconciliationId', 'reconciliationDigest', 'predecessorReceiptId', 'predecessorReceiptDigest', 'claimId', 'attemptId']) {
    validateNonEmptyString(input[key], key, errors);
  }
  if (input['subjectKind'] !== 'repository-action' && input['subjectKind'] !== 'provider-request') addErr(errors, 'subjectKind', 'Invalid subject kind', 'INVALID_SUBJECT_KIND');
  if (input['planApplicability'] !== 'pre-plan-diagnostic' && input['planApplicability'] !== 'approved-plan') addErr(errors, 'planApplicability', 'Invalid plan applicability', 'INVALID_PLAN_APPLICABILITY');

  const predecessor = context?.predecessor;
  const required = ['receiptId', 'receiptDigest', 'claimId', 'attemptId', 'subjectKind', 'planApplicability', 'outcome'];
  if (!context || !predecessor || !context.predecessorReceiptDigest || !required.every((key) => typeof predecessor[key] === 'string' && (predecessor[key] as string).length > 0)) {
    addErr(errors, 'trustedContext', 'Complete trusted predecessor receipt is required', 'TRUSTED_CONTEXT_REQUIRED');
    return;
  }
  if (input['predecessorReceiptId'] !== predecessor['receiptId']) addErr(errors, 'predecessorReceiptId', 'Predecessor receipt ID mismatch', 'PREDECESSOR_RECEIPT_MISMATCH');
  if (outcomeDigest(predecessor) !== predecessor['receiptDigest']) addErr(errors, 'trustedContext.predecessor.receiptDigest', 'Trusted predecessor digest is invalid', 'PREDECESSOR_DIGEST_INVALID');
  if (input['predecessorReceiptDigest'] !== context.predecessorReceiptDigest || input['predecessorReceiptDigest'] !== predecessor['receiptDigest']) {
    addErr(errors, 'predecessorReceiptDigest', 'Predecessor receipt digest mismatch', 'PREDECESSOR_DIGEST_MISMATCH');
  }
  for (const key of ['claimId', 'attemptId', 'subjectKind', 'planApplicability']) {
    if (input[key] !== predecessor[key]) addErr(errors, key, `${key} mismatch`, `${key.toUpperCase()}_MISMATCH`);
  }
}

function validateUncertainImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<UncertainAttemptReconciliationReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  checkCommon(input, [...BASE_KEYS, 'disposition'], 'uncertain-attempt', context, errors);
  if (input['disposition'] !== 'observed-and-accounted' && input['disposition'] !== 'proven-not-dispatched') addErr(errors, 'disposition', 'Invalid disposition', 'INVALID_DISPOSITION');
  if (context?.predecessor && context.predecessor['outcome'] !== 'uncertain') addErr(errors, 'predecessor.outcome', 'Predecessor must be uncertain', 'PREDECESSOR_NOT_UNCERTAIN');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as UncertainAttemptReconciliationReceiptV02 };
}

function validateObservedImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<ObservedOutcomeReconciliationReceiptV02> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  if (input['disposition'] !== undefined || input['outcome'] !== undefined) return { ok: false, errors: [{ path: 'disposition', message: 'Observed reconciliation cannot rewrite outcome', code: 'OUTCOME_REWRITE_FORBIDDEN' }] };
  checkCommon(input, BASE_KEYS, 'observed-unsettled', context, errors);
  if (context?.predecessor && context.predecessor['outcome'] !== 'observed') addErr(errors, 'predecessor.outcome', 'Predecessor must be observed', 'PREDECESSOR_NOT_OBSERVED');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ObservedOutcomeReconciliationReceiptV02 };
}

function validateReconciliationImpl(input: unknown, context?: AttemptReconciliationValidationContextV02): ValidationResult<AttemptReconciliationReceiptV02> {
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: 'receipt', message: 'Must be object', code: 'INVALID_TYPE' }] };
  return input['reconciliationKind'] === 'uncertain-attempt'
    ? validateUncertainImpl(input, context)
    : input['reconciliationKind'] === 'observed-unsettled'
      ? validateObservedImpl(input, context)
      : { ok: false, errors: [{ path: 'reconciliationKind', message: 'Invalid reconciliation kind', code: 'INVALID_RECONCILIATION_KIND' }] };
}

export const validateUncertainAttemptReconciliationReceiptV02 = protectValidator(validateUncertainImpl);
export const validateObservedOutcomeReconciliationReceiptV02 = protectValidator(validateObservedImpl);
export const validateAttemptReconciliationReceiptV02 = protectValidator(validateReconciliationImpl);
