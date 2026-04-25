import { log } from "../log.js";
import type { RawItem, Source, SourceSummary } from "../types.js";
import { freshnessVerdict } from "./freshness.js";
import { validateUrlShape } from "./urlShape.js";
import { dedupByUrl } from "./dedup.js";
import { matchesHnDropPattern } from "./hnPatternFilter.js";
import {
  engagementValues,
  matchesEngagementFloorDrop,
  resolveEngagementThresholds,
} from "./engagementFloor.js";

export { normalizeUrl } from "./url.js";
export { isFresh, freshnessCutoffMs, freshnessVerdict } from "./freshness.js";
export type { FreshnessVerdict } from "./freshness.js";
export { validateUrlShape } from "./urlShape.js";
export type { UrlShapeRejectReason, UrlShapeResult } from "./urlShape.js";
export { dedupByUrl } from "./dedup.js";
export type { DedupResult } from "./dedup.js";
export {
  HARDCODED_HN_DROP_PATTERNS,
  matchesHnDropPattern,
} from "./hnPatternFilter.js";
export {
  ENGAGEMENT_FLOOR_DEFAULTS,
  engagementValues,
  matchesEngagementFloorDrop,
  resolveEngagementThresholds,
} from "./engagementFloor.js";
export type {
  EngagementThresholds,
  EngagementValues,
} from "./engagementFloor.js";

export interface PreFilterStats {
  readonly inputCount: number;
  readonly freshnessDropped: number;
  readonly invalidDateDropped: number;
  readonly futureDropped: number;
  readonly shapeDropped: number;
  readonly duplicateDropped: number;
  readonly normFailDropped: number;
  readonly hnPatternDropped: number;
  readonly engagementFloorDropped: number;
  readonly outputCount: number;
}

export interface PreFilterOptions {
  readonly freshnessHours?: number;
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PreFilterResult {
  readonly items: RawItem[];
  readonly stats: PreFilterStats;
  readonly summary: SourceSummary;
}

/**
 * E3 entry point. Filter RawItems by freshness (24h window), URL shape, and
 * normalized-URL dedup. Stateless, deterministic, idempotent: re-applying to
 * the result yields the same items with all `*Dropped` counts at zero.
 */
export function applyPreFilter(
  items: readonly RawItem[],
  runDate: string,
  collectorSummary: SourceSummary,
  opts: PreFilterOptions = {},
): PreFilterResult {
  const hours = opts.freshnessHours;
  const now = opts.now ?? new Date();

  const fresh: RawItem[] = [];
  let freshnessDropped = 0;
  let invalidDateDropped = 0;
  let futureDropped = 0;
  for (const item of items) {
    const verdict =
      hours === undefined
        ? freshnessVerdict(item.publishedAt, runDate, 24, now)
        : freshnessVerdict(item.publishedAt, runDate, hours, now);
    if (verdict === "fresh") {
      fresh.push(item);
    } else if (verdict === "invalid_date") {
      invalidDateDropped += 1;
      log.warn("pre-filter dropped item with unparseable publishedAt", {
        id: item.id,
        source: item.source,
      });
    } else if (verdict === "future") {
      futureDropped += 1;
      log.warn("pre-filter dropped future-dated item", {
        id: item.id,
        source: item.source,
        publishedAt: item.publishedAt,
      });
    } else {
      freshnessDropped += 1;
    }
  }

  const shapeOk: RawItem[] = [];
  let shapeDropped = 0;
  for (const item of fresh) {
    const verdict = validateUrlShape(item.url);
    if (verdict.ok) {
      shapeOk.push(item);
    } else {
      shapeDropped += 1;
      log.warn("pre-filter dropped item by URL shape", {
        id: item.id,
        source: item.source,
        reason: verdict.reason,
      });
    }
  }

  const { kept: dedupKept, removed, normFailed } = dedupByUrl(shapeOk);
  const duplicateDropped = removed.length;
  const normFailDropped = normFailed.length;

  // HN megathread filter — runs AFTER dedup so duplicates are not double-
  // counted under hnPatternDropped. Only HN-source items are considered.
  const env = opts.env ?? process.env;
  const afterPattern: RawItem[] = [];
  let hnPatternDropped = 0;
  for (const item of dedupKept) {
    if (matchesHnDropPattern(item, env)) {
      hnPatternDropped += 1;
      log.warn("pre-filter dropped HN megathread by title pattern", {
        id: item.id,
        source: item.source,
        title: item.title,
      });
    } else {
      afterPattern.push(item);
    }
  }

  // Engagement-floor filter — drops the dead tail of HN/Reddit items that
  // have neither upvotes nor comments. Items from other sources pass through.
  const thresholds = resolveEngagementThresholds(env);
  const kept: RawItem[] = [];
  let engagementFloorDropped = 0;
  for (const item of afterPattern) {
    if (matchesEngagementFloorDrop(item, thresholds)) {
      engagementFloorDropped += 1;
      const v = engagementValues(item);
      log.warn("pre-filter dropped item by engagement floor", {
        id: item.id,
        source: item.source,
        points: v?.points ?? 0,
        numComments: v?.numComments ?? 0,
      });
    } else {
      kept.push(item);
    }
  }

  const stats: PreFilterStats = {
    inputCount: items.length,
    freshnessDropped,
    invalidDateDropped,
    futureDropped,
    shapeDropped,
    duplicateDropped,
    normFailDropped,
    hnPatternDropped,
    engagementFloorDropped,
    outputCount: kept.length,
  };

  const summary = annotateSummary(collectorSummary, kept);
  return { items: kept, stats, summary };
}

/** Set of distinct sources represented in `items`. Used by the S-05 floor check. */
export function uniqueSources(items: readonly RawItem[]): Set<Source> {
  const out = new Set<Source>();
  for (const it of items) out.add(it.source);
  return out;
}

function annotateSummary(
  collectorSummary: SourceSummary,
  kept: readonly RawItem[],
): SourceSummary {
  const keptCounts: Partial<Record<Source, number>> = {};
  for (const it of kept) {
    keptCounts[it.source] = (keptCounts[it.source] ?? 0) + 1;
  }
  const out: SourceSummary = {};
  for (const [src, val] of Object.entries(collectorSummary)) {
    if (!val) continue;
    out[src as Source] = {
      ...val,
      keptCount: keptCounts[src as Source] ?? 0,
    };
  }
  // Surface sources that appear in the kept set but somehow not in the
  // collector summary (defensive — should not happen in practice).
  for (const src of Object.keys(keptCounts) as Source[]) {
    if (!out[src]) {
      out[src] = {
        count: keptCounts[src] ?? 0,
        status: "ok",
        keptCount: keptCounts[src] ?? 0,
      };
    }
  }
  return out;
}
