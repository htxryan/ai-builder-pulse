// Source-aware badge line rendered beneath an item's title. Pure: derived
// entirely from the ScoredItem's metadata discriminated union.
//
// Shapes (examples):
//   HN:     "Hacker News · 234 points"
//   GH:     "GitHub Trending · +412★ today · Python"
//   Reddit: "r/LocalLLaMA · 891 upvotes"
//   RSS:    "RSS"
//   TW:     "@handle"
//   Mock:   "Mock"
//
// Missing optional signals are elided — `Hacker News` alone is valid when a
// story has no `points` yet (early Algolia scrape).

import type { ScoredItem } from "../types.js";

export function sourceBadge(item: ScoredItem): string {
  const meta = item.metadata;
  switch (meta.source) {
    case "hn": {
      if (meta.points !== undefined) {
        return `Hacker News · ${meta.points} point${meta.points === 1 ? "" : "s"}`;
      }
      return "Hacker News";
    }
    case "github-trending": {
      const parts: string[] = ["GitHub Trending"];
      if (meta.starsToday !== undefined && meta.starsToday > 0) {
        parts.push(`+${meta.starsToday}★ today`);
      }
      if (meta.language) parts.push(meta.language);
      return parts.join(" · ");
    }
    case "reddit": {
      const sub = meta.subreddit.startsWith("r/")
        ? meta.subreddit
        : `r/${meta.subreddit}`;
      if (meta.upvotes !== undefined && meta.upvotes >= 0) {
        return `${sub} · ${meta.upvotes} upvote${meta.upvotes === 1 ? "" : "s"}`;
      }
      return sub;
    }
    case "rss":
      return "RSS";
    case "twitter":
      return `@${meta.handle.replace(/^@/, "")}`;
    case "mock":
      return "Mock";
  }
}
