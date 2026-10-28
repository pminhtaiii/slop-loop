import { computeCanonicalSha256 } from '../../foundation/uc03.ts';
import { isRecord } from '../v01/validation.ts';

function stripDigestProperty(obj: unknown, prop: string): Record<string, unknown> {
  if (!isRecord(obj)) throw new Error('Requires record');
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== prop) copy[k] = v;
  }
  return copy;
}

export function computePolicyEvaluationReceiptDigest(receipt: unknown): string {
  return computeCanonicalSha256(stripDigestProperty(receipt, 'receiptDigest'));
}

export function computeActionDecisionReceiptDigest(receipt: unknown): string {
  return computeCanonicalSha256(stripDigestProperty(receipt, 'decisionDigest'));
}

export function computeProviderAdmissionReceiptDigest(receipt: unknown): string {
  return computeCanonicalSha256(stripDigestProperty(receipt, 'receiptDigest'));
}

export function computeClaimClosureReceiptDigest(receipt: unknown): string {
  return computeCanonicalSha256(stripDigestProperty(receipt, 'receiptDigest'));
}

export const computeClaimClosureDigest = computeClaimClosureReceiptDigest;

export function computeDispatchClaimDigestV02(claim: unknown): string {
  return computeCanonicalSha256(stripDigestProperty(claim, 'claimDigest'));
}
