import type { Validation } from '../uc01/contracts.ts';
import { isAdmittedEvaluationProfile } from './evaluation-profile-admission.ts';
import type { EvaluationProfile, ExposureDerivation } from './evaluation-profile-types.ts';

function safeProduct(left: number, right: number): number | undefined {
  const product = left * right;
  return Number.isSafeInteger(product) ? product : undefined;
}

/**
 * Integer micro-USD ceiling for every permitted coder and reviewer call at the conservative
 * per-call billable bound, including cache and per-request overhead, rounded upward per call.
 * There is no user monetary cap and no sentinel: overflow or a non-admitted profile denies.
 */
export function deriveExposureCeiling(profile: EvaluationProfile): Validation<ExposureDerivation> {
  if (!isAdmittedEvaluationProfile(profile)) return { ok: false, status: 'invalid-input', reasonCode: 'NOT_ADMITTED', path: '$.profile' };
  const { pricingId, inputRate, outputRate, cacheRate, overheadRate, denominator } = profile.pricing;
  const { totalModelCalls, inputTokensPerRequest, outputTokensPerRequest } = profile.limits;
  const inputCost = safeProduct(inputTokensPerRequest, inputRate);
  const outputCost = safeProduct(outputTokensPerRequest, outputRate);
  const cacheCost = safeProduct(inputTokensPerRequest, cacheRate);
  if (inputCost === undefined || outputCost === undefined || cacheCost === undefined) {
    return { ok: false, status: 'invalid-input', reasonCode: 'EXPOSURE_OVERFLOW', path: '$.pricing' };
  }
  const numeratorPerCall = inputCost + outputCost + cacheCost + overheadRate;
  if (!Number.isSafeInteger(numeratorPerCall)) return { ok: false, status: 'invalid-input', reasonCode: 'EXPOSURE_OVERFLOW', path: '$.pricing' };
  const perCallMicroUsd = Math.ceil(numeratorPerCall / denominator);
  const ceilingMicroUsd = safeProduct(perCallMicroUsd, totalModelCalls);
  if (ceilingMicroUsd === undefined) return { ok: false, status: 'invalid-input', reasonCode: 'EXPOSURE_OVERFLOW', path: '$.limits.totalModelCalls' };
  return {
    ok: true,
    value: Object.freeze({
      spendPolicy: 'derived-exposure',
      pricingId,
      calls: totalModelCalls,
      maxInputTokens: inputTokensPerRequest,
      maxOutputTokens: outputTokensPerRequest,
      maxCacheTokens: inputTokensPerRequest,
      numeratorPerCall,
      perCallMicroUsd,
      ceilingMicroUsd,
    }),
  };
}
