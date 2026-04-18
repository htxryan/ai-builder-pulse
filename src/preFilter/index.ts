import { log } from "../log.js";
import type { RawItem, Source, SourceSummary } from "../types.js";
import { freshnessVerdict } from "./freshness.js";
import { validateUrlShape } from "./urlShape.js";
import { dedupByUrl } from "./dedup.js";

export { normalizeUrl } from "./url.js";
export { isFresh, freshnessCutoffMs, freshnessVerdict } from "./freshness.js";
export type { FreshnessVerdict } from "./freshness.js";
export { validateUrlShape } from "./urlShape.js";
export type { UrlShapeRejectReason, UrlShapeResult } from "./urlShape.js";
export { dedupByUrl } from "./dedup.js";
export type { DedupResult } from "./dedup.js";

export interface PreFilterStats {
  readonly inputCount: number;
  readonly freshnessDropped: number;
  readonly invalidDateDropped: number;
  readonly shapeDropped: number;
  readonly duplicateDropped: number;
  readonly outputCount: number;
}

export interface PreFilterOptions {
  readonly freshnessHours?: number;
}

export interface PreFilterResult {
  readonly items: RawItem[];
  readonly stats: PreFilterStats;
  readonly summary: SourceSummary;
}

// E3 entry point. Stateless, deterministic. Idempotent: applying the result
// items back through `applyPreFilter` with the same runDate produces the same
// items and an updated stats object with all `*Dropped` counts at zero.
export function applyPreFilter(
  items: readonly RawItem[],
  runDate: string,
  collectorSummary: SourceSummary,
  opts: PreFilterOptions = {},
): PreFilterResult {
  const hours = opts.freshnessHours;

  const fresh: RawItem[] = [];
  let freshnessDropped = 0;
  let invalidDateDropped = 0;
  for (const item of items) {
    const verdict =
      hours === undefined
        ? freshnessVerdict(item.publishedAt, runDate)
        : freshnessVerdict(item.publishedAt, runDate, hours);
    if (verdict === "fresh") {
      fresh.push(item);
    } else if (verdict === "invalid_date") {
      invalidDateDropped += 1;
      log.warn("pre-filter dropped item with unparseable publishedAt", {
        id: item.id,
        source: item.source,
      });
    } else {
      freshnessDropped += 1;
    }
  }

  const shapeOk: RawItem[] = [];
  let shapeDropped = 0;
  for (const item of fresh) {
    if (validateUrlShape(item.url).ok) {
      shapeOk.push(item);
    } else {
      shapeDropped += 1;
    }
  }

  const { kept, removed } = dedupByUrl(shapeOk);
  const duplicateDropped = removed.length;

  const stats: PreFilterStats = {
    inputCount: items.length,
    freshnessDropped,
    invalidDateDropped,
    shapeDropped,
    duplicateDropped,
    outputCount: kept.length,
  };

  const summary = annotateSummary(collectorSummary, kept);
  return { items: kept, stats, summary };
}

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
