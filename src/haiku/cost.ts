// Haiku cost rates. Defaults match `claude-haiku-4-5` published rates
// ($0.80/$4.00 per MTok). Configurable via env vars so an operator running
// through an alt-provider (e.g. OpenRouter) can plug in observed rates
// without a code change.
//
// Note: Haiku cost is intentionally tracked SEPARATELY from the Sonnet
// curator's `CURATOR_MAX_USD` ceiling. Counting Haiku spend against the
// Sonnet ceiling would penalize the very stage that exists to reduce
// Sonnet cost — see ai-builder-pulse-9li R18.

import { estimateUsd as sharedEstimateUsd } from "../curator/costModel.js";

export const DEFAULT_HAIKU_INPUT_COST_PER_MTOK = 0.8;
export const DEFAULT_HAIKU_OUTPUT_COST_PER_MTOK = 4.0;

export interface HaikuCostRates {
  readonly inputCostPerMTok: number;
  readonly outputCostPerMTok: number;
}

/**
 * Resolve cost rates from an env map. Falls back to Haiku defaults
 * ($0.80/$4.00 per MTok). Invalid (non-numeric / non-positive) overrides
 * silently fall back to the default — the orchestrator's run-summary will
 * still show whatever rate was actually used.
 */
export function resolveHaikuCostRates(
  env: NodeJS.ProcessEnv = process.env,
): HaikuCostRates {
  const parse = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  };
  return {
    inputCostPerMTok: parse(
      env["HAIKU_INPUT_COST_PER_MTOK"],
      DEFAULT_HAIKU_INPUT_COST_PER_MTOK,
    ),
    outputCostPerMTok: parse(
      env["HAIKU_OUTPUT_COST_PER_MTOK"],
      DEFAULT_HAIKU_OUTPUT_COST_PER_MTOK,
    ),
  };
}

export function estimateHaikuUsd(
  inputTokens: number,
  outputTokens: number,
  rates: HaikuCostRates,
): number {
  return sharedEstimateUsd(inputTokens, outputTokens, {
    inputCostPerMTok: rates.inputCostPerMTok,
    outputCostPerMTok: rates.outputCostPerMTok,
  });
}
