// Golden-file snapshot for the weekly digest. Covers the trending-this-week
// badge, day-coverage breadcrumb, and per-category top-N cap.

import { describe, it, expect } from "vitest";
import {
  buildWeeklyDigest,
  type ArchivedDay,
} from "../../src/weekly/digest.js";
import type { ScoredItem } from "../../src/types.js";

const item = (over: Partial<ScoredItem> & Pick<ScoredItem, "id">): ScoredItem => ({
  source: "hn",
  title: `t-${over.id}`,
  url: `https://example.com/${over.id}`,
  score: 1,
  publishedAt: "2026-04-18T01:00:00.000Z",
  metadata: { source: "hn", points: 100 },
  category: "Tools & Launches",
  relevanceScore: 0.5,
  keep: true,
  description: `A sufficiently descriptive summary for item ${over.id}.`,
  ...over,
});

// Week with 6 days available (1 missing), a trending item (appears on 3 days)
// and enough per-category items to exercise the per-category cap.
const DAYS: ArchivedDay[] = [
  {
    runDate: "2026-04-13",
    items: [
      item({ id: "trending", title: "Trending Agent Framework", relevanceScore: 0.9 }),
      item({
        id: "mon-extra",
        title: "Monday extra",
        category: "Model Releases",
        relevanceScore: 0.6,
      }),
    ],
  },
  {
    runDate: "2026-04-14",
    items: [
      item({ id: "trending", title: "Trending Agent Framework", relevanceScore: 0.92 }),
      item({ id: "tue-1", title: "Tuesday one", relevanceScore: 0.7 }),
    ],
  },
  {
    runDate: "2026-04-15",
    items: [
      item({ id: "trending", title: "Trending Agent Framework", relevanceScore: 0.88 }),
      item({
        id: "wed-reddit",
        title: "Wed reddit pick",
        source: "reddit",
        metadata: { source: "reddit", subreddit: "LocalLLaMA", upvotes: 501 },
        category: "Notable Discussions",
        relevanceScore: 0.66,
      }),
    ],
  },
  {
    runDate: "2026-04-16",
    items: [
      item({
        id: "thu-gh",
        title: "Thursday GH launch",
        source: "github-trending",
        metadata: {
          source: "github-trending",
          repoFullName: "acme/foo",
          stars: 1200,
          starsToday: 300,
          language: "Rust",
        },
        relevanceScore: 0.8,
      }),
    ],
  },
  {
    runDate: "2026-04-17",
    items: [
      item({
        id: "fri-tool-a",
        title: "Friday tool A",
        category: "Tools & Launches",
        relevanceScore: 0.75,
      }),
      item({
        id: "fri-tool-b",
        title: "Friday tool B",
        category: "Tools & Launches",
        relevanceScore: 0.74,
      }),
      item({
        id: "fri-tool-c",
        title: "Friday tool C (should be capped out)",
        category: "Tools & Launches",
        relevanceScore: 0.72,
      }),
    ],
  },
  {
    runDate: "2026-04-18",
    items: [
      item({
        id: "sat-rss",
        title: "Saturday RSS analysis",
        source: "rss",
        metadata: {
          source: "rss",
          feedUrl: "https://example.com/blog/atom.xml",
          author: "Jane Doe",
        },
        category: "Think Pieces & Analysis",
        relevanceScore: 0.67,
      }),
    ],
  },
];

describe("weekly digest golden snapshot", () => {
  it("matches fixtures/rendered/sample-weekly.md byte-for-byte", async () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: DAYS,
      missingDays: ["2026-04-12"],
      topN: 12,
    });
    await expect(digest.body).toMatchFileSnapshot(
      "../../fixtures/rendered/sample-weekly.md",
    );
  });

  it("shows day-coverage breadcrumb (X of 7 days)", () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: DAYS,
      missingDays: ["2026-04-12"],
    });
    expect(digest.body).toContain("6 of 7 days");
  });

  it("marks an item appearing on 2+ days as trending this week", () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: DAYS,
      missingDays: ["2026-04-12"],
    });
    expect(digest.body).toContain("trending this week (3 days)");
  });

  it("caps items per category at topPerCategory (default 3)", () => {
    // Tools & Launches fixture has 5 distinct ids: trending, mon-extra-no (wait:
    // mon-extra is Model Releases), tue-1, fri-tool-a, fri-tool-b, fri-tool-c.
    // trending + tue-1 + fri-tool-a/b/c = 5 Tools & Launches items. Cap = 3.
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: DAYS,
      missingDays: ["2026-04-12"],
      topN: 20,
      topPerCategory: 3,
    });
    // The two lowest-score Tools items must be excluded.
    expect(digest.body).not.toContain("Friday tool C (should be capped out)");
  });

  it("single-day rollup shows 1 of 1 days when no missingDays provided", () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: [DAYS[0]!],
      missingDays: [],
    });
    expect(digest.body).toContain("1 of 1 days");
  });
});
