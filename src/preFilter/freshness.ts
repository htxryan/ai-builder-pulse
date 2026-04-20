import { runDateMinusHours } from "../runDate.js";

// U-03 / S-01: drop items whose publishedAt is older than midnight(runDate) − 24h.
// Cutoff is anchored to UTC midnight of the runDate (not "now") so that the same
// runDate produces the same cutoff across retries and backfills.
export function freshnessCutoffMs(runDate: string, hours = 24): number {
  return runDateMinusHours(runDate, hours).getTime();
}

export type FreshnessVerdict = "fresh" | "stale" | "invalid_date" | "future";

// Allow 1h of forward clock skew — a source timestamp "ahead of now" by a few
// minutes is common when an upstream server is on a slightly fast clock; only
// meaningfully-future timestamps (tomorrow-dated) are treated as invalid.
const FUTURE_SKEW_MS = 60 * 60 * 1000;

export function freshnessVerdict(
  publishedAt: string,
  runDate: string,
  hours = 24,
  now: Date = new Date(),
): FreshnessVerdict {
  const pubMs = Date.parse(publishedAt);
  if (Number.isNaN(pubMs)) return "invalid_date";
  if (pubMs > now.getTime() + FUTURE_SKEW_MS) return "future";
  return pubMs >= freshnessCutoffMs(runDate, hours) ? "fresh" : "stale";
}

export function isFresh(
  publishedAt: string,
  runDate: string,
  hours = 24,
  now: Date = new Date(),
): boolean {
  return freshnessVerdict(publishedAt, runDate, hours, now) === "fresh";
}
