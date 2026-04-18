// C5 Renderer. Produces `{subject, body}` from kept ScoredItems. Pure &
// deterministic: same input → same output (no date math beyond the runDate
// string, no IO, no randomness).
//
// Ordering (U-05):
//   - Categories appear in CATEGORIES declaration order
//   - Within each category: relevanceScore DESC, then id ASC for stability
//   - Empty categories are omitted
//
// The body includes template URLs (newsletter home, archive, unsubscribe) that
// are governed by the Renderer-owned allowlist in allowlist.ts. Pass those
// patterns to `verifyLinkIntegrity(scored, raw, patterns)` so Un-01 treats
// them as exempt.

import { CATEGORIES, type Category, type ScoredItem } from "../types.js";
import {
  NEWSLETTER_ARCHIVE_URL,
  NEWSLETTER_HOME_URL,
} from "./allowlist.js";

export interface RenderedIssue {
  readonly subject: string;
  readonly body: string;
}

const SUBJECT_PREFIX = "AI Builder Pulse";

function sortWithinCategory(a: ScoredItem, b: ScoredItem): number {
  if (a.relevanceScore !== b.relevanceScore) {
    return b.relevanceScore - a.relevanceScore; // DESC
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function groupByCategory(items: readonly ScoredItem[]): Map<Category, ScoredItem[]> {
  const groups = new Map<Category, ScoredItem[]>();
  for (const c of CATEGORIES) groups.set(c, []);
  for (const it of items) {
    const bucket = groups.get(it.category);
    if (bucket) bucket.push(it);
  }
  for (const bucket of groups.values()) bucket.sort(sortWithinCategory);
  return groups;
}

function sourceLabel(item: ScoredItem): string {
  switch (item.source) {
    case "hn":
      return "Hacker News";
    case "github-trending":
      return "GitHub Trending";
    case "reddit":
      return "Reddit";
    case "rss":
      return "RSS";
    case "twitter":
      return "Twitter";
    case "mock":
      return "Mock";
  }
}

// Titles from HN/Reddit/RSS frequently contain `[` and `]` (e.g. `"[PDF] Foo"`,
// `"React [beta]"`). Inside a markdown link label, an unescaped `]` terminates
// the label early and the trailing text becomes orphaned/garbled. Escape both
// brackets so CommonMark renders the literal title.
function escapeLinkLabel(text: string): string {
  return text.replace(/[\[\]]/g, (c) => (c === "[" ? "\\[" : "\\]"));
}

// URL fragment guard: a literal `)` in a URL would close the markdown link's
// destination. Percent-encode it. We do not touch other URL chars — collectors
// are expected to deliver canonicalized URLs already.
function escapeLinkUrl(url: string): string {
  return url.replace(/\)/g, "%29");
}

function renderItem(item: ScoredItem): string {
  const header = `### [${escapeLinkLabel(item.title)}](${escapeLinkUrl(item.url)})`;
  const meta = `*${sourceLabel(item)}*`;
  return `${header}\n${meta}\n\n${item.description}\n`;
}

function renderCategorySection(
  category: Category,
  items: readonly ScoredItem[],
): string {
  // Each `renderItem` already ends with `\n`. Trim trailing newlines on the
  // joined block so the section + later `sections.push("")` produces exactly
  // one blank line between sections, not two-or-three (cosmetic in some
  // markdown clients).
  const rendered = items.map(renderItem).join("\n").replace(/\n+$/, "");
  return `## ${category}\n\n${rendered}`;
}

function renderFooter(): string {
  // `{{unsubscribe_url}}` is a Buttondown Django template variable that is
  // substituted at send time with a per-subscriber URL. The literal variable
  // is not a URL per the URL-extraction regex, so it bypasses Un-01 without
  // needing an allowlist entry.
  return [
    "---",
    "",
    `[AI Builder Pulse](${NEWSLETTER_HOME_URL}) — daily briefing for engineers building with AI.`,
    `Browse the [archive](${NEWSLETTER_ARCHIVE_URL}) or [unsubscribe]({{unsubscribe_url}}).`,
    "",
  ].join("\n");
}

export function renderIssue(
  runDate: string,
  kept: readonly ScoredItem[],
): RenderedIssue {
  const subject = `${SUBJECT_PREFIX} — ${runDate}`;
  const groups = groupByCategory(kept);

  const sections: string[] = [];
  sections.push(`# ${SUBJECT_PREFIX} — ${runDate}`);
  sections.push("");
  sections.push(
    `Today's briefing: ${kept.length} item${kept.length === 1 ? "" : "s"} curated for AI builders.`,
  );
  sections.push("");

  for (const category of CATEGORIES) {
    const bucket = groups.get(category) ?? [];
    if (bucket.length === 0) continue;
    sections.push(renderCategorySection(category, bucket));
    sections.push("");
  }

  sections.push(renderFooter());

  return { subject, body: sections.join("\n") };
}
