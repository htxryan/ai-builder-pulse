import type { RawItem, RunContext } from "../types.js";

// Mutable metrics bag shared between the collector and `fetchAll`. Collectors
// increment counters here instead of silently swallowing partial failures in
// `catch {}`. The bag is intentionally per-collector so failures from HN are
// not conflated with failures from Reddit.
export interface CollectorMetrics {
  redirectFailures: number;
}

export function makeCollectorMetrics(): CollectorMetrics {
  return { redirectFailures: 0 };
}

export interface CollectorContext {
  readonly runDate: string;
  readonly cutoffMs: number;
  readonly abortSignal: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
  readonly metrics: CollectorMetrics;
}

export interface Collector {
  readonly source: string;
  fetch(ctx: CollectorContext): Promise<RawItem[]>;
}

// Cutoff = midnight(runDate) − 24h. For a backfill or retried run later in
// the UTC day this window can exceed 24 hours (up to ~48h). The deliberate
// choice favors backfill determinism over strict rolling-24h semantics: a
// rolling `now - 24h` would silently drop content on any delayed/backfill run
// whose runDate is in the past. The CLAUDE.md "last 24 hours" constraint is
// enforced tightly only for on-time midnight runs.
export function cutoffForRunDate(runDate: string): number {
  const midnight = Date.parse(`${runDate}T00:00:00.000Z`);
  return midnight - 24 * 60 * 60 * 1000;
}

export function makeCollectorContext(
  parent: RunContext,
  abortSignal: AbortSignal,
  env: NodeJS.ProcessEnv,
): CollectorContext {
  return {
    runDate: parent.runDate,
    cutoffMs: cutoffForRunDate(parent.runDate),
    abortSignal,
    env,
    metrics: makeCollectorMetrics(),
  };
}
