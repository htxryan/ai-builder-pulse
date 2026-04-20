import type { RawItem, RunContext } from "../types.js";

// Mutable metrics bag shared between the collector and `fetchAll`. Collectors
// increment counters here instead of silently swallowing partial failures in
// `catch {}`. The bag is intentionally per-collector so failures from HN are
// not conflated with failures from Reddit.
export interface PartialFailure {
  // Sub-scope identifier — the subreddit for reddit, the feed URL for rss,
  // or "batch" for single-call collectors like HN's Algolia search.
  readonly scope: string;
  // Single-line error summary, never the full stack. Sanitized via the
  // shared log.ts secret redaction pipeline when emitted.
  readonly error: string;
  // Coarse error class (timeout/tls/http_5xx/etc.) so the run summary can
  // group partial failures without re-parsing the raw message.
  readonly errClass: string;
}

export interface CollectorMetrics {
  redirectFailures: number;
  // Sub-scope failures captured *without* aborting the collector (a single
  // subreddit 403 should not blank the whole Reddit source).
  partialFailures: PartialFailure[];
}

export function makeCollectorMetrics(): CollectorMetrics {
  return { redirectFailures: 0, partialFailures: [] };
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
