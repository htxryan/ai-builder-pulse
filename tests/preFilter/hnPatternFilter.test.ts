import { describe, it, expect } from "vitest";
import {
  HARDCODED_HN_DROP_PATTERNS,
  matchesHnDropPattern,
} from "../../src/preFilter/hnPatternFilter.js";
import { applyPreFilter } from "../../src/preFilter/index.js";
import type { RawItem, Source, SourceSummary } from "../../src/types.js";

const runDate = "2026-04-18";

function item(
  source: Source,
  id: string,
  title: string,
  url = `https://example.com/${id}`,
): RawItem {
  const meta =
    source === "hn"
      ? { source: "hn" as const, points: 5, numComments: 2 }
      : source === "github-trending"
        ? { source: "github-trending" as const, repoFullName: "x/y" }
        : source === "reddit"
          ? {
              source: "reddit" as const,
              subreddit: "MachineLearning",
              upvotes: 5,
              numComments: 2,
            }
          : source === "rss"
            ? { source: "rss" as const, feedUrl: "https://example.com/feed" }
            : { source: "twitter" as const, handle: "x" };
  return {
    id,
    source,
    title,
    url,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: meta,
  };
}

const summary: SourceSummary = {
  hn: { count: 5, status: "ok" },
  reddit: { count: 5, status: "ok" },
};

describe("matchesHnDropPattern (pure matcher)", () => {
  it("returns true for HN item titled 'Ask HN: Who is Hiring? (April 2026)' (AC-1)", () => {
    expect(
      matchesHnDropPattern(
        item("hn", "1", "Ask HN: Who is Hiring? (April 2026)"),
      ),
    ).toBe(true);
  });

  it("returns true for HN item titled 'WHO IS HIRING in AI (2026)' — case-insensitive (AC-2)", () => {
    expect(
      matchesHnDropPattern(item("hn", "2", "WHO IS HIRING in AI (2026)")),
    ).toBe(true);
  });

  it("returns true for HN 'Who wants to be hired?' megathread", () => {
    expect(
      matchesHnDropPattern(
        item("hn", "3", "Ask HN: Who wants to be hired? (April 2026)"),
      ),
    ).toBe(true);
  });

  it("returns true for HN 'Seeking freelancer?' megathread", () => {
    expect(
      matchesHnDropPattern(
        item("hn", "4", "Ask HN: Freelancer? Seeking freelancer? (April 2026)"),
      ),
    ).toBe(true);
  });

  it("returns false for non-HN items even if title matches (AC-3 — Reddit)", () => {
    expect(
      matchesHnDropPattern(
        item("reddit", "r1", "Who is hiring AI engineers in 2026?"),
      ),
    ).toBe(false);
  });

  it("returns false for non-HN items even when source=rss/github-trending/twitter", () => {
    expect(
      matchesHnDropPattern(item("rss", "rss1", "Who is hiring this month")),
    ).toBe(false);
    expect(
      matchesHnDropPattern(
        item("github-trending", "gh1", "who is hiring repo"),
      ),
    ).toBe(false);
    expect(
      matchesHnDropPattern(item("twitter", "tw1", "Who is hiring")),
    ).toBe(false);
  });

  it("returns false for HN 'Show HN:' technical posts (no match)", () => {
    expect(
      matchesHnDropPattern(
        item("hn", "5", "Show HN: I built a GPU inference server"),
      ),
    ).toBe(false);
  });

  it("returns false for empty-titled-ish items (no match)", () => {
    expect(matchesHnDropPattern(item("hn", "6", "."))).toBe(false);
  });

  it("matches ANY hardcoded pattern as case-insensitive substring", () => {
    for (const pat of HARDCODED_HN_DROP_PATTERNS) {
      expect(
        matchesHnDropPattern(item("hn", `p-${pat}`, `Prefix ${pat} Suffix`)),
      ).toBe(true);
    }
  });

  it("HN_DROP_PATTERNS env var adds extra substrings (case-insensitive) (AC-6)", () => {
    const env = { HN_DROP_PATTERNS: "ShowOff Daily, beta launch" };
    expect(
      matchesHnDropPattern(
        item("hn", "x1", "Ask HN: SHOWOFF DAILY thread"),
        env,
      ),
    ).toBe(true);
    expect(
      matchesHnDropPattern(
        item("hn", "x2", "Ask HN: Beta Launch announcements"),
        env,
      ),
    ).toBe(true);
  });

  it("HN_DROP_PATTERNS empty / unset has no effect", () => {
    expect(
      matchesHnDropPattern(item("hn", "y1", "Some unrelated title"), {}),
    ).toBe(false);
    expect(
      matchesHnDropPattern(
        item("hn", "y2", "Some unrelated title"),
        { HN_DROP_PATTERNS: "" },
      ),
    ).toBe(false);
    expect(
      matchesHnDropPattern(
        item("hn", "y3", "Some unrelated title"),
        { HN_DROP_PATTERNS: "  ,  ,  " },
      ),
    ).toBe(false);
  });

  it("HN_DROP_PATTERNS still does not match for non-HN items", () => {
    const env = { HN_DROP_PATTERNS: "extrapattern" };
    expect(
      matchesHnDropPattern(
        item("reddit", "r2", "Title with extrapattern in it"),
        env,
      ),
    ).toBe(false);
  });

  it("trims whitespace around each comma-separated pattern", () => {
    const env = { HN_DROP_PATTERNS: "   foo   ,   bar   " };
    expect(
      matchesHnDropPattern(item("hn", "z1", "title FOO inside"), env),
    ).toBe(true);
    expect(
      matchesHnDropPattern(item("hn", "z2", "title BAR inside"), env),
    ).toBe(true);
  });
});

describe("applyPreFilter integration with HN pattern filter", () => {
  it("drops matching HN items and counts them as hnPatternDropped (AC-1, AC-4)", () => {
    const items = [
      item("hn", "h1", "Ask HN: Who is Hiring? (April 2026)"),
      item("hn", "h2", "Show HN: cool tool"),
      item("hn", "h3", "Ask HN: Who wants to be hired? (April 2026)"),
      item("reddit", "r1", "Who is hiring at OpenAI"), // not HN — keep
    ];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.hnPatternDropped).toBe(2);
    const ids = r.items.map((i) => i.id).sort();
    expect(ids).toEqual(["h2", "r1"]);
  });

  it("counts exactly 10 matching HN items as hnPatternDropped=10 (AC-4)", () => {
    const items: RawItem[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(
        item(
          "hn",
          `hire-${i}`,
          `Ask HN: Who is Hiring? (Month ${i})`,
          `https://example.com/hire-${i}`,
        ),
      );
    }
    items.push(item("hn", "keep1", "Show HN: my project"));
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.hnPatternDropped).toBe(10);
    expect(r.items).toHaveLength(1);
  });

  it("reddit items with 'who is hiring' in title are NOT dropped (AC-3)", () => {
    const items = [
      item("reddit", "r1", "Who is hiring in MLOps right now?"),
      item("reddit", "r2", "WHO IS HIRING — monthly thread"),
    ];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.hnPatternDropped).toBe(0);
    expect(r.items).toHaveLength(2);
  });

  it("hnPatternDropped is 0 when no items match", () => {
    const items = [
      item("hn", "h1", "Show HN: cool tool"),
      item("reddit", "r1", "Some discussion"),
    ];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats.hnPatternDropped).toBe(0);
  });

  it("stats include all existing fields plus hnPatternDropped (no field removal)", () => {
    const items = [item("hn", "h1", "Ask HN: Who is Hiring? (April 2026)")];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.stats).toMatchObject({
      inputCount: expect.any(Number),
      freshnessDropped: expect.any(Number),
      invalidDateDropped: expect.any(Number),
      futureDropped: expect.any(Number),
      shapeDropped: expect.any(Number),
      duplicateDropped: expect.any(Number),
      normFailDropped: expect.any(Number),
      hnPatternDropped: expect.any(Number),
      engagementFloorDropped: expect.any(Number),
      outputCount: expect.any(Number),
    });
  });
});
