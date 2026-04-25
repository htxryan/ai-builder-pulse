import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  matchesEngagementFloorDrop,
  resolveEngagementThresholds,
  ENGAGEMENT_FLOOR_DEFAULTS,
} from "../../src/preFilter/engagementFloor.js";
import { applyPreFilter } from "../../src/preFilter/index.js";
import type { RawItem, SourceSummary } from "../../src/types.js";
import { log } from "../../src/log.js";

const runDate = "2026-04-25";
const futureDate = "2026-04-25T05:00:00.000Z";

function hn(
  id: string,
  points: number | undefined,
  numComments: number | undefined,
): RawItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: futureDate,
    metadata: {
      source: "hn",
      ...(points !== undefined ? { points } : {}),
      ...(numComments !== undefined ? { numComments } : {}),
    },
  };
}

function reddit(
  id: string,
  upvotes: number | undefined,
  numComments: number | undefined,
): RawItem {
  return {
    id,
    source: "reddit",
    title: `t-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: futureDate,
    metadata: {
      source: "reddit",
      subreddit: "MachineLearning",
      ...(upvotes !== undefined ? { upvotes } : {}),
      ...(numComments !== undefined ? { numComments } : {}),
    },
  };
}

function rss(id: string): RawItem {
  return {
    id,
    source: "rss",
    title: `t-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: futureDate,
    metadata: { source: "rss", feedUrl: "https://example.com/feed" },
  };
}

function ght(id: string): RawItem {
  return {
    id,
    source: "github-trending",
    title: `t-${id}`,
    url: `https://github.com/owner/${id}`,
    score: 1,
    publishedAt: futureDate,
    metadata: { source: "github-trending", repoFullName: `owner/${id}` },
  };
}

const summary: SourceSummary = {
  hn: { count: 10, status: "ok" },
  reddit: { count: 10, status: "ok" },
  rss: { count: 10, status: "ok" },
  "github-trending": { count: 10, status: "ok" },
};

describe("resolveEngagementThresholds (AC-12)", () => {
  it("returns defaults when env vars unset", () => {
    expect(resolveEngagementThresholds({})).toEqual({
      hnMinPoints: 2,
      hnMinComments: 1,
      redditMinScore: 2,
      redditMinComments: 1,
    });
  });

  it("default constants match the spec values", () => {
    expect(ENGAGEMENT_FLOOR_DEFAULTS).toEqual({
      hnMinPoints: 2,
      hnMinComments: 1,
      redditMinScore: 2,
      redditMinComments: 1,
    });
  });

  it("respects env-var overrides", () => {
    expect(
      resolveEngagementThresholds({
        HN_MIN_POINTS: "5",
        HN_MIN_COMMENTS: "3",
        REDDIT_MIN_SCORE: "10",
        REDDIT_MIN_COMMENTS: "4",
      }),
    ).toEqual({
      hnMinPoints: 5,
      hnMinComments: 3,
      redditMinScore: 10,
      redditMinComments: 4,
    });
  });

  it("treats non-numeric or negative env values as defaults (defensive)", () => {
    expect(
      resolveEngagementThresholds({
        HN_MIN_POINTS: "garbage",
        REDDIT_MIN_SCORE: "-1",
      }),
    ).toEqual({
      hnMinPoints: 2,
      hnMinComments: 1,
      redditMinScore: 2,
      redditMinComments: 1,
    });
  });
});

describe("matchesEngagementFloorDrop (pure matcher)", () => {
  const t = ENGAGEMENT_FLOOR_DEFAULTS;

  it("AC-1: HN points=1, comments=0 → dropped (default thresholds)", () => {
    expect(matchesEngagementFloorDrop(hn("a", 1, 0), t)).toBe(true);
  });

  it("AC-2: HN points=2, comments=0 → KEPT (meets points floor)", () => {
    expect(matchesEngagementFloorDrop(hn("a", 2, 0), t)).toBe(false);
  });

  it("AC-3: HN points=0, comments=1 → KEPT (meets comments floor)", () => {
    expect(matchesEngagementFloorDrop(hn("a", 0, 1), t)).toBe(false);
  });

  it("AC-4: Reddit upvotes=1, comments=0 → dropped", () => {
    expect(matchesEngagementFloorDrop(reddit("a", 1, 0), t)).toBe(true);
  });

  it("AC-5: RSS item → KEPT (filter does not apply)", () => {
    expect(matchesEngagementFloorDrop(rss("a"), t)).toBe(false);
  });

  it("AC-6: github-trending item → KEPT regardless of metadata", () => {
    expect(matchesEngagementFloorDrop(ght("a"), t)).toBe(false);
  });

  it("AC-7: HN_MIN_POINTS=0 → HN item with points=0, comments=0 still passes", () => {
    const tt = { ...t, hnMinPoints: 0 };
    expect(matchesEngagementFloorDrop(hn("a", 0, 0), tt)).toBe(false);
  });

  it("AC-8: HN with no metadata.points → treated as 0, dropped at default if comments also 0", () => {
    expect(matchesEngagementFloorDrop(hn("a", undefined, 0), t)).toBe(true);
    expect(matchesEngagementFloorDrop(hn("b", undefined, undefined), t)).toBe(
      true,
    );
  });

  it("Reddit with undefined upvotes → treated as 0 (R10 sanity)", () => {
    expect(matchesEngagementFloorDrop(reddit("a", undefined, 0), t)).toBe(true);
  });

  it("Reddit with REDDIT_MIN_COMMENTS=0 → never drops on comments signal", () => {
    const tt = { ...t, redditMinComments: 0 };
    expect(matchesEngagementFloorDrop(reddit("a", 0, 0), tt)).toBe(false);
  });
});

describe("applyPreFilter — engagement floor integration", () => {
  let envBak: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBak = { ...process.env };
    delete process.env.HN_MIN_POINTS;
    delete process.env.HN_MIN_COMMENTS;
    delete process.env.REDDIT_MIN_SCORE;
    delete process.env.REDDIT_MIN_COMMENTS;
  });

  afterEach(() => {
    process.env = envBak;
  });

  it("AC-9: 5 droppable HN items → engagementFloorDropped === 5", () => {
    const items: RawItem[] = [];
    for (let i = 0; i < 5; i++) items.push(hn(`drop-${i}`, 0, 0));
    items.push(hn("keep-1", 5, 5));
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.engagementFloorDropped).toBe(5);
    expect(r.items.map((i) => i.id)).toEqual(["keep-1"]);
  });

  it("AC-13: dropped item emits warn with id, source, and engagement values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      applyPreFilter([hn("drop-x", 1, 0)], runDate, summary);
      const matched = warnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes("engagement"),
      );
      expect(matched).toBeDefined();
      const ctx = matched?.[1] as Record<string, unknown> | undefined;
      expect(ctx).toMatchObject({
        id: "drop-x",
        source: "hn",
        points: 1,
        numComments: 0,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("AC-7 (env): HN_MIN_POINTS=0 disables points signal — dead HN items pass", () => {
    process.env.HN_MIN_POINTS = "0";
    process.env.HN_MIN_COMMENTS = "0";
    const items = [hn("a", 0, 0), hn("b", 0, 0)];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.engagementFloorDropped).toBe(0);
    expect(r.items).toHaveLength(2);
  });

  it("does not affect rss / github-trending / twitter", () => {
    const items = [rss("a"), ght("b"), hn("dead", 0, 0)];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.engagementFloorDropped).toBe(1);
    expect(r.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("PreFilterStats includes engagementFloorDropped field", () => {
    const r = applyPreFilter(
      [hn("a", 5, 5)],
      runDate,
      summary,
    );
    expect(r.stats).toMatchObject({
      engagementFloorDropped: expect.any(Number),
    });
  });

  it("drops Reddit items below floor; keeps engaged ones (AC-4)", () => {
    const items = [
      reddit("dead-1", 1, 0),
      reddit("dead-2", 0, 0),
      reddit("alive-1", 5, 0),
      reddit("alive-2", 0, 3),
    ];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.engagementFloorDropped).toBe(2);
    expect(r.items.map((i) => i.id).sort()).toEqual(["alive-1", "alive-2"]);
  });
});
