import type { RawItem, Source } from "../types.js";
import { normalizeUrl } from "./url.js";

// Authority ranking for tie-breaks when two items share the same normalized
// URL and the same `score`. Higher = more authoritative. Justification:
//  - github-trending: deduplicates against the original repo source-of-truth
//  - rss: typically the publisher's own feed (canonical)
//  - hn: link aggregation; loses to the source it points at
//  - reddit: aggregation, often editorialized
//  - twitter: noisy
//  - mock: lowest by definition
const SOURCE_AUTHORITY: Readonly<Record<Source, number>> = {
  "github-trending": 5,
  rss: 4,
  hn: 3,
  reddit: 2,
  twitter: 1,
  mock: 0,
};

export interface DedupResult {
  readonly kept: RawItem[];
  readonly removed: RawItem[];
  // Items dropped because normalizeUrl() returned null. Tracked separately
  // from `removed` (which counts genuine duplicates) so stats don't conflate
  // normalization failures with duplicate-collapse events.
  readonly normFailed: RawItem[];
}

function preferLeft(a: RawItem, b: RawItem): boolean {
  if (a.score !== b.score) return a.score > b.score;
  const authA = SOURCE_AUTHORITY[a.source] ?? 0;
  const authB = SOURCE_AUTHORITY[b.source] ?? 0;
  if (authA !== authB) return authA > authB;
  // Final tie-breaker: strict id ordering keeps dedup deterministic across
  // runs. When ids are also equal, `<` returns false and the first-seen item
  // wins via the caller's iteration order.
  return a.id < b.id;
}

// Un-03: collapse items sharing the same normalized URL to the highest-score
// /most-authoritative survivor. Items whose URL fails to normalize are
// surfaced in `normFailed` (defense-in-depth for Un-02 if the shape gate is
// bypassed); they are NOT counted as duplicates.
export function dedupByUrl(items: readonly RawItem[]): DedupResult {
  const map = new Map<string, RawItem>();
  const removed: RawItem[] = [];
  const normFailed: RawItem[] = [];
  for (const item of items) {
    const norm = normalizeUrl(item.url);
    if (norm === null) {
      normFailed.push(item);
      continue;
    }
    const existing = map.get(norm);
    if (!existing) {
      map.set(norm, item);
      continue;
    }
    if (preferLeft(item, existing)) {
      removed.push(existing);
      map.set(norm, item);
    } else {
      removed.push(item);
    }
  }
  return { kept: [...map.values()], removed, normFailed };
}
