import { sha256Text, validateLimits, type Limits, type TrustedContext } from './contracts.ts';

export type Pricing = Readonly<{ pricingId: string; inputRate: number; outputRate: number; denominator: number }>;
export const bindingKeys = ['taskId', 'runId', 'repositoryId', 'workspaceId', 'repositorySnapshotDigest', 'configId',
  'configVersion', 'policyId', 'policyVersion', 'accountingRef'] as const;
export type ProductionBinding = Pick<TrustedContext, typeof bindingKeys[number]>;
export type ProductionProfile = Readonly<{ profileId: 'uc01-production-v1'; binding: ProductionBinding; catalogDigest: string; limits: Limits; pricing: Pricing }>;
const admitted = new WeakSet<ProductionProfile>();

/** Called by trusted composition only after delivery capabilities have been checked. */
export function admitProductionProfile(profile: ProductionProfile): ProductionProfile {
  if (!validateLimits(profile.limits).ok || bindingKeys.some(key => typeof profile.binding[key] !== 'string' || !profile.binding[key].trim())
    || !/^[a-f0-9]{64}$/u.test(profile.binding.repositorySnapshotDigest) || !/^[a-f0-9]{64}$/u.test(profile.catalogDigest)
    || typeof profile.pricing.pricingId !== 'string' || !profile.pricing.pricingId.trim()
    || [profile.pricing.inputRate, profile.pricing.outputRate, profile.pricing.denominator].some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('Invalid production profile');
  }
  const binding = Object.fromEntries(bindingKeys.map(key => [key, profile.binding[key]])) as ProductionBinding;
  const copy = Object.freeze({ ...profile, binding: Object.freeze(binding), limits: Object.freeze({ ...profile.limits }),
    pricing: Object.freeze({ ...profile.pricing }) });
  admitted.add(copy);
  return copy;
}

export function matchesProductionProfile(profile: ProductionProfile, context: TrustedContext): boolean {
  return admitted.has(profile) && bindingKeys.every(key => profile.binding[key] === context[key])
    && profile.catalogDigest === sha256Text(JSON.stringify(context.catalog))
    && Object.entries(profile.limits).every(([key, value]) => context.limits[key as keyof Limits] === value);
}

/** Integer cost units, rounded up once per request; no implicit token-equals-cost assumption. */
export function priceUsage(pricing: Pricing, inputTokens: number, outputTokens: number): number | undefined {
  const numerator = inputTokens * pricing.inputRate + outputTokens * pricing.outputRate;
  return Number.isSafeInteger(numerator) && numerator >= 0 ? Math.ceil(numerator / pricing.denominator) : undefined;
}
