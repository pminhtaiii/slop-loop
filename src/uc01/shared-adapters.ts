import type { UC01AccountingAdapter } from '../persistence/adapters/uc01-adapter.ts';
import { computeCanonicalSha256, validateSourceEvidence } from '../contracts/foundation/uc03.ts';
import { isProtectedPayload } from '../foundation/telemetry.ts';
import type { Admission, OperationContext, ReserveCeiling } from './assess.ts';
import { sha256Text, validateLimits, type Failure, type Usage } from './contracts.ts';

export type AccountingBinding = Pick<OperationContext, 'taskId' | 'runId' | 'repositoryId' | 'workspaceId' | 'repositorySnapshotDigest'
  | 'configId' | 'configVersion' | 'policyId' | 'policyVersion' | 'accountingRef'>;
export interface AccountingProjection {
  readonly productionEligible: false;
  readonly limitations: readonly string[];
  reserve(context: OperationContext, admission: Admission, ceiling: ReserveCeiling): Promise<unknown>;
  settle(context: OperationContext, reservationRef: string, usage: Usage): Promise<unknown>;
}

const bindingKeys = ['taskId', 'runId', 'repositoryId', 'workspaceId', 'repositorySnapshotDigest', 'configId', 'configVersion',
  'policyId', 'policyVersion', 'accountingRef'] as const;
const contextKeys = [...bindingKeys, 'invocationId', 'operationId', 'requestId', 'deadlineEpochMs', 'limits'];
function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && 'value' in descriptor;
    });
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 512 && !isProtectedPayload(value);
}
function contextMatches(context: OperationContext, binding: AccountingBinding): boolean {
  return plain(context, contextKeys) && bindingKeys.every(key => context[key] === binding[key])
    && ['invocationId', 'operationId', 'requestId'].every(key => text(context[key as keyof OperationContext]))
    && validateLimits(context.limits).ok;
}
function failure(status: Failure, reasonCode: string): unknown {
  return { kind: 'failure', status, reasonCode, eventRef: 'uc04-accounting' };
}
const amountKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits'] as const;
function usageWithin(usage: Usage, ceiling: ReserveCeiling): boolean {
  return plain(usage, [...amountKeys, 'state', 'reservationRef']) && usage.state === 'settled'
    && amountKeys.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 && usage[key] <= ceiling[key])
    && usage.totalTokens === usage.inputTokens + usage.outputTokens;
}

/** Envelope compatibility alone does not supply durable reservation or restart admission. */
export function createUC04AccountingProjection(adapter: UC01AccountingAdapter, binding: AccountingBinding, now: () => number = Date.now): AccountingProjection {
  const selected = Object.fromEntries(bindingKeys.map(key => [key, binding[key]])) as AccountingBinding;
  if (bindingKeys.some(key => !text(selected[key])) || !/^[a-f0-9]{64}$/u.test(selected.repositorySnapshotDigest)) {
    throw new TypeError('Invalid accounting binding');
  }
  // These are invocation receipts, not a budget ledger. UC04 remains the accounting owner.
  const receipts = new Map<string, { digest: string; state: 'reserving' | 'reserved' | 'closed'; ceiling: ReserveCeiling }>();
  return { productionEligible: false, limitations: Object.freeze(['task-only-in-memory-accounting', 'no-atomic-durable-task-run-reservation']),
    async reserve(context, admission, ceiling): Promise<unknown> {
      if (!contextMatches(context, selected) || !plain(admission, ['kind', 'admissionRef', 'requestId', 'contextDigest'])
        || admission.kind !== 'admitted' || !text(admission.admissionRef) || admission.requestId !== context.requestId
        || admission.contextDigest !== computeCanonicalSha256(context).slice(7)) return failure('conflict', 'accounting-binding');
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(context.deadlineEpochMs)
        || context.deadlineEpochMs <= current) return failure('timeout', 'deadline-exceeded');
      if (!plain(ceiling, [...amountKeys, 'pricingId']) || !text(ceiling.pricingId)
        || !amountKeys.every(key => Number.isSafeInteger(ceiling[key]) && ceiling[key] > 0 && ceiling[key] <= context.limits[key])
        || ceiling.totalTokens !== ceiling.inputTokens + ceiling.outputTokens) return failure('invalid-input', 'invalid-reservation-profile');
      if (receipts.has(context.requestId)) return failure('conflict', 'reservation-binding');
      const receipt = { digest: admission.contextDigest, state: 'reserving' as 'reserving' | 'reserved' | 'closed', ceiling: Object.freeze({ ...ceiling }) };
      receipts.set(context.requestId, receipt);
      try {
        const result = await adapter.reserve(context, ceiling);
        if (result.ok === true && plain(result, ['ok', 'reservationRef', 'accountingRef'])
          && result.reservationRef === context.requestId && result.accountingRef === context.accountingRef) {
          receipt.state = 'reserved';
          return { kind: 'reserved', reservationRef: result.reservationRef, requestId: context.requestId };
        }
        receipt.state = 'closed';
        if (result.ok === false && plain(result, ['ok', 'accountingRef', 'reasonCode']) && result.accountingRef === context.accountingRef
          && result.reasonCode === 'call-budget-exhausted') {
          return failure('exhausted', 'call-budget-exhausted');
        }
        return failure('uncertain', 'reservation-uncertain');
      } catch {
        receipt.state = 'closed';
        return failure('uncertain', 'reservation-uncertain');
      }
    },
    async settle(context, reservationRef, usage): Promise<unknown> {
      const receipt = receipts.get(reservationRef);
      const usageRef: unknown = usage && typeof usage === 'object' ? Object.getOwnPropertyDescriptor(usage, 'reservationRef')?.value : undefined;
      if (!contextMatches(context, selected) || !receipt || receipt.state !== 'reserved' || context.requestId !== reservationRef
        || receipt.digest !== computeCanonicalSha256(context).slice(7) || usageRef !== undefined && usageRef !== reservationRef) {
        return failure('conflict', 'reservation-binding');
      }
      receipt.state = 'closed';
      const uncertain = !usageWithin(usage, receipt.ceiling);
      const charge: Usage = uncertain ? { inputTokens: receipt.ceiling.inputTokens, outputTokens: receipt.ceiling.outputTokens,
        totalTokens: receipt.ceiling.totalTokens, costUnits: receipt.ceiling.costUnits, state: 'uncertain', reservationRef } : usage;
      try {
        const result = await adapter.settle(context, reservationRef, charge);
        if (!plain(result, ['kind', 'accountingRef', 'consumedTokens', 'consumedCost']) || result.kind !== 'settled'
          || result.accountingRef !== selected.accountingRef || !Number.isFinite(result.consumedTokens) || result.consumedTokens < 0
          || !Number.isFinite(result.consumedCost) || result.consumedCost < 0) return failure('uncertain', 'settlement-uncertain');
        if (uncertain) return failure('uncertain', 'usage-uncertain');
        return { kind: 'settled', accountingRef: result.accountingRef };
      } catch { return failure('uncertain', 'settlement-uncertain'); }
    } };
}

/** SourceEvidence does not contain file digests or line spans; these must come from a trusted locator verifier. */
export function projectFoundationFinding(source: unknown, verifiedLocator: unknown,
  context: Pick<OperationContext, 'repositoryId' | 'repositorySnapshotDigest' | 'limits'>): unknown {
  const refused = { kind: 'failure', status: 'error', reasonCode: 'repository-locator-required', eventRef: 'foundation-evidence' };
  if (!plain(source, ['path', 'revisionDigest', 'boundedExcerpt', 'resultCount', 'truncated']) || !validateLimits(context.limits).ok
    || !text(context.repositoryId) || !/^[a-f0-9]{64}$/u.test(context.repositorySnapshotDigest)
    || !plain(verifiedLocator, ['location', 'safeExcerptRef', 'excerptDigest', 'provenance'])) return refused;
  const checked = validateSourceEvidence(source, { maxExcerptBytes: context.limits.inputBytes, maxResultCount: context.limits.searchResults });
  if (!checked.ok || checked.value.revisionDigest !== context.repositorySnapshotDigest || isProtectedPayload(checked.value)
    || !text(verifiedLocator.safeExcerptRef) || verifiedLocator.excerptDigest !== sha256Text(checked.value.boundedExcerpt)
    || !['real', 'mock'].includes(String(verifiedLocator.provenance))) return refused;
  const location = verifiedLocator.location;
  if (!plain(location, ['repositoryId', 'snapshotDigest', 'path', 'fileDigest', 'startLine', 'endLine'])
    || location.repositoryId !== context.repositoryId || location.snapshotDigest !== context.repositorySnapshotDigest
    || location.path !== checked.value.path || typeof location.fileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(location.fileDigest)
    || typeof location.startLine !== 'number' || typeof location.endLine !== 'number' || !Number.isSafeInteger(location.startLine)
    || !Number.isSafeInteger(location.endLine) || location.startLine <= 0 || location.endLine < location.startLine) return refused;
  return { source: { ...checked.value }, location: { ...location }, safeExcerptRef: verifiedLocator.safeExcerptRef,
    provenance: verifiedLocator.provenance };
}
