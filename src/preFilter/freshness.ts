import { runDateMinusHours } from "../runDate.js";

// U-03 / S-01: drop items whose publishedAt is older than midnight(runDate) − 24h.
// Cutoff is anchored to UTC midnight of the runDate (not "now") so that the same
// runDate produces the same cutoff across retries and backfills.
export function freshnessCutoffMs(runDate: string, hours = 24): number {
  return runDateMinusHours(runDate, hours).getTime();
}

export type FreshnessVerdict = "fresh" | "stale" | "invalid_date";

export function freshnessVerdict(
  publishedAt: string,
  runDate: string,
  hours = 24,
): FreshnessVerdict {
  const pubMs = Date.parse(publishedAt);
  if (Number.isNaN(pubMs)) return "invalid_date";
  return pubMs >= freshnessCutoffMs(runDate, hours) ? "fresh" : "stale";
}

export function isFresh(
  publishedAt: string,
  runDate: string,
  hours = 24,
): boolean {
  return freshnessVerdict(publishedAt, runDate, hours) === "fresh";
}
