import type { RawItem, RunContext, SourceSummary } from "../types.js";

export async function mockFetchAll(ctx: RunContext): Promise<{
  items: RawItem[];
  summary: SourceSummary;
}> {
  const items: RawItem[] = [
    {
      id: "mock-hn-1",
      source: "hn",
      title: "Example AI tooling article on HN",
      url: "https://example.com/ai-tool-1",
      score: 120,
      publishedAt: `${ctx.runDate}T05:30:00.000Z`,
      metadata: { source: "hn", points: 120, numComments: 30, author: "someone" },
    },
    {
      id: "mock-ght-1",
      source: "github-trending",
      title: "trending/repo — a new AI tool",
      url: "https://github.com/trending/repo",
      score: 500,
      publishedAt: `${ctx.runDate}T05:00:00.000Z`,
      metadata: {
        source: "github-trending",
        repoFullName: "trending/repo",
        stars: 500,
        starsToday: 50,
        language: "TypeScript",
      },
    },
    {
      id: "mock-reddit-1",
      source: "reddit",
      title: "r/LocalLLaMA: running 70B locally",
      url: "https://reddit.com/r/LocalLLaMA/abc",
      score: 320,
      publishedAt: `${ctx.runDate}T04:30:00.000Z`,
      metadata: { source: "reddit", subreddit: "LocalLLaMA", upvotes: 320, numComments: 45 },
    },
    {
      id: "mock-rss-1",
      source: "rss",
      title: "Simon Willison: structured outputs GA",
      url: "https://simonwillison.net/2026/Apr/18/structured-outputs/",
      score: 1,
      publishedAt: `${ctx.runDate}T04:00:00.000Z`,
      metadata: {
        source: "rss",
        feedUrl: "https://simonwillison.net/atom/everything/",
        author: "simonw",
      },
    },
    {
      id: "mock-hn-2",
      source: "hn",
      title: "Another HN story about AI infra",
      url: "https://example.com/infra-1",
      score: 85,
      publishedAt: `${ctx.runDate}T03:30:00.000Z`,
      metadata: { source: "hn", points: 85, numComments: 12 },
    },
  ];
  const summary: SourceSummary = {
    hn: { count: 2, status: "ok" },
    "github-trending": { count: 1, status: "ok" },
    reddit: { count: 1, status: "ok" },
    rss: { count: 1, status: "ok" },
  };
  return { items, summary };
}
