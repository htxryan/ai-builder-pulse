import type { RawItem } from "../types.js";

// Conservative floors: drop only the dead tail. An item passes if it clears
// EITHER signal (points/upvotes OR comments), so items with any real
// engagement on at least one axis survive. Setting a threshold to 0 disables
// that signal (the "< 0" comparison is never true).
//
// Note on field names: the spec text refers to Reddit "score" but the actual
// `RawItemMetadataSchema` field for Reddit is `upvotes` (the collector at
// `src/collectors/reddit.ts:231` writes `upvotes: post.score`). The
// operator-facing env var preserves `REDDIT_MIN_SCORE` for clarity.
export interface EngagementThresholds {
  readonly hnMinPoints: number;
  readonly hnMinComments: number;
  readonly redditMinScore: number;
  readonly redditMinComments: number;
}

export const ENGAGEMENT_FLOOR_DEFAULTS: EngagementThresholds = {
  hnMinPoints: 2,
  hnMinComments: 1,
  redditMinScore: 2,
  redditMinComments: 1,
};

function parseThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

export function resolveEngagementThresholds(
  env: NodeJS.ProcessEnv,
): EngagementThresholds {
  return {
    hnMinPoints: parseThreshold(
      env.HN_MIN_POINTS,
      ENGAGEMENT_FLOOR_DEFAULTS.hnMinPoints,
    ),
    hnMinComments: parseThreshold(
      env.HN_MIN_COMMENTS,
      ENGAGEMENT_FLOOR_DEFAULTS.hnMinComments,
    ),
    redditMinScore: parseThreshold(
      env.REDDIT_MIN_SCORE,
      ENGAGEMENT_FLOOR_DEFAULTS.redditMinScore,
    ),
    redditMinComments: parseThreshold(
      env.REDDIT_MIN_COMMENTS,
      ENGAGEMENT_FLOOR_DEFAULTS.redditMinComments,
    ),
  };
}

/** Engagement values used in the threshold comparison; emitted alongside the warn log when an item is dropped. */
export interface EngagementValues {
  readonly points: number;
  readonly numComments: number;
}

/** Pure: returns the {points, comments} pair the filter uses for `item`, or null for sources the filter does not apply to. */
export function engagementValues(item: RawItem): EngagementValues | null {
  if (item.source === "hn" && item.metadata.source === "hn") {
    return {
      points: item.metadata.points ?? 0,
      numComments: item.metadata.numComments ?? 0,
    };
  }
  if (item.source === "reddit" && item.metadata.source === "reddit") {
    return {
      points: item.metadata.upvotes ?? 0,
      numComments: item.metadata.numComments ?? 0,
    };
  }
  return null;
}

/**
 * Pure matcher: returns true iff `item` is HN/Reddit AND its engagement is
 * below BOTH the points and comments floors for that source. Items from
 * other sources, or items that clear EITHER signal, return false.
 */
export function matchesEngagementFloorDrop(
  item: RawItem,
  thresholds: EngagementThresholds,
): boolean {
  const v = engagementValues(item);
  if (v === null) return false;
  if (item.source === "hn") {
    return (
      v.points < thresholds.hnMinPoints &&
      v.numComments < thresholds.hnMinComments
    );
  }
  if (item.source === "reddit") {
    return (
      v.points < thresholds.redditMinScore &&
      v.numComments < thresholds.redditMinComments
    );
  }
  return false;
}
