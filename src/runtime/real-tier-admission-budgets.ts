/**
 * Shared token-fitting and budget-admission utilities for the real tier.
 *
 * Sizes provider token reservations to fit remaining task and run budgets,
 * respecting directional transport ceilings.
 */

export interface TokenReservationSplit {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
}

/**
 * Sizes input and output token reservations from the remaining task and run
 * billable-token room, split between input and output and capped by directional limits.
 * Refuses (returns undefined) when no positive split fits.
 */
export function fitTokenReservation(remainingTokens: number, maxInputCeiling: number, maxOutputCeiling: number): TokenReservationSplit | undefined {
  if (
    !Number.isSafeInteger(remainingTokens) ||
    !Number.isSafeInteger(maxInputCeiling) ||
    !Number.isSafeInteger(maxOutputCeiling) ||
    maxInputCeiling <= 0 ||
    maxOutputCeiling <= 0 ||
    remainingTokens < 2
  ) {
    return undefined;
  }
  const availableRoom = Math.min(remainingTokens, maxInputCeiling + maxOutputCeiling);
  if (availableRoom < 2) return undefined;

  let inputTokens = Math.floor(availableRoom / 2);
  let outputTokens = availableRoom - inputTokens;

  if (inputTokens > maxInputCeiling) {
    inputTokens = maxInputCeiling;
    outputTokens = availableRoom - inputTokens;
  } else if (outputTokens > maxOutputCeiling) {
    outputTokens = maxOutputCeiling;
    inputTokens = availableRoom - outputTokens;
  }

  if (inputTokens <= 0 || outputTokens <= 0 || inputTokens > maxInputCeiling || outputTokens > maxOutputCeiling) {
    return undefined;
  }
  return {
    maxInputTokens: inputTokens,
    maxOutputTokens: outputTokens,
    maxBillableTokens: inputTokens + outputTokens,
  };
}
