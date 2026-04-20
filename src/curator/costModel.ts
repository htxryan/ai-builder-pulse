// Shared token-to-USD cost estimator.
//
// Consumed by both `claudeCurator.ts` (the preserved direct-SDK path) and
// `deepagent/adapter.ts` (the LangGraph path). Keeping one copy ensures both
// curators produce identical cost estimates for the same usage counts — so
// a CURATOR_MAX_USD ceiling enforced in one backend behaves exactly the same
// in the other when the operator swaps `CURATOR_BACKEND`.
//
// Defaults are placeholders. Override via ClaudeCurator/DeepAgent config.

export const DEFAULT_INPUT_COST_PER_MTOK = 3.0;
export const DEFAULT_OUTPUT_COST_PER_MTOK = 15.0;

export interface CostRates {
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
}

/**
 * Convert per-1M-token rates + raw token counts into a USD estimate,
 * rounded to 4 decimal places (sub-cent precision is noise).
 *
 * Returned value is a `number`, not a string — upstream callers aggregate
 * across chunks, so the rounding happens on the per-call basis and the sum
 * is accurate to the per-call rounding error (bounded).
 */
export function estimateUsd(
  inputTokens: number,
  outputTokens: number,
  rates: CostRates = {},
): number {
  const inCost = rates.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_MTOK;
  const outCost = rates.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_MTOK;
  return Number(
    (
      (inputTokens / 1_000_000) * inCost +
      (outputTokens / 1_000_000) * outCost
    ).toFixed(4),
  );
}
