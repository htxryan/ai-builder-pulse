// C5 Renderer. Produces `{subject, body}` from kept ScoredItems. Pure &
// deterministic: same input → same output (no date math beyond the runDate
// string, no IO, no randomness).
//
// Ordering (U-05):
//   - Categories appear in CATEGORIES declaration order
//   - Within each category: relevanceScore DESC, then id ASC for stability
//   - Empty categories are omitted
//
// Craft layer:
//   - Intro line names a top pick (first ~100 chars become Gmail preview).
//   - If the highest-relevance kept item scores ≥ TOP_PICK_THRESHOLD, a
//     `## Today's Top Pick` block is rendered above category sections. The
//     item still appears in its category below.
//   - With ≥ TOC_MIN_ITEMS kept items, a compact category TOC is emitted
//     after the intro.
//   - Each item carries a metadata-aware source badge (e.g.
//     `*Hacker News · 234 points*`).
//
// The body includes template URLs (newsletter home, archive, unsubscribe) that
// are governed by the Renderer-owned allowlist in allowlist.ts. Pass those
// patterns to `verifyLinkIntegrity(scored, raw, patterns)` so Un-01 treats
// them as exempt.

import { CATEGORIES, type Category, type ScoredItem } from "../types.js";
import {
  CANONICAL_ARCHIVE_URL,
  CANONICAL_HOME_URL,
} from "./allowlist.js";
import { sourceBadge } from "./sourceBadge.js";

export interface RenderedIssue {
  readonly subject: string;
  readonly body: string;
}

const SUBJECT_PREFIX = "AI Builder Pulse";
const TOP_PICK_THRESHOLD = 0.85;
const TOC_MIN_ITEMS = 10;

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

// GitHub-flavored-markdown style slug: lowercase, drop non-alphanum except
// spaces/hyphens, collapse spaces to hyphens. `&` vanishes, producing the
// familiar `tools--launches` double-hyphen seen in GFM. Kept here (not a
// shared util) because the only anchor target the renderer cares about is a
// category name — no reason to generalize.
function slugifyCategory(category: string): string {
  // Order matters: replace spaces with hyphens FIRST, then strip other
  // punctuation. This preserves the GFM `tools--launches` double-hyphen you
  // get when an `&` (surrounded by spaces) is dropped.
  return category
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "");
}

function renderItem(item: ScoredItem): string {
  const header = `### [${escapeLinkLabel(item.title)}](${escapeLinkUrl(item.url)})`;
  const meta = `*${sourceBadge(item)}*`;
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

function renderIntro(
  kept: readonly ScoredItem[],
  topPick: ScoredItem | null,
  categoryCount: number,
): string {
  if (kept.length === 0) {
    return "Today: no items met the relevance bar.";
  }
  const stories = `${kept.length} stor${kept.length === 1 ? "y" : "ies"}`;
  const cats = `${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}`;
  const base = `Today: ${stories} across ${cats}`;
  if (topPick) {
    // Strip brackets from the quoted title so Gmail's preview doesn't show
    // raw markdown escapes. The H3 rendering below still escapes for link
    // safety; this is preview-only text.
    const cleanTitle = topPick.title.replace(/[\[\]]/g, "");
    return `${base} — top pick, "${cleanTitle}", from ${sourceBadge(topPick)}.`;
  }
  return `${base}.`;
}

function renderTOC(groups: ReadonlyMap<Category, ScoredItem[]>): string {
  const lines: string[] = ["**In this issue:**", ""];
  for (const category of CATEGORIES) {
    const bucket = groups.get(category) ?? [];
    if (bucket.length === 0) continue;
    const slug = slugifyCategory(category);
    lines.push(`- [${category} (${bucket.length})](#${slug})`);
  }
  return lines.join("\n");
}

function renderTopPick(item: ScoredItem): string {
  const header = `### [${escapeLinkLabel(item.title)}](${escapeLinkUrl(item.url)})`;
  const meta = `*${sourceBadge(item)}*`;
  return `## Today's Top Pick\n\n${header}\n${meta}\n\n${item.description}`;
}

function renderFooter(): string {
  // `{{unsubscribe_url}}` is a Buttondown Django template variable that is
  // substituted at send time with a per-subscriber URL. The literal variable
  // is not a URL per the URL-extraction regex, so it bypasses Un-01 without
  // needing an allowlist entry.
  return [
    "---",
    "",
    `[AI Builder Pulse](${CANONICAL_HOME_URL}) — daily briefing for engineers building with AI.`,
    `Browse the [archive](${CANONICAL_ARCHIVE_URL}) or [unsubscribe]({{unsubscribe_url}}).`,
    "",
  ].join("\n");
}

function pickTopItem(kept: readonly ScoredItem[]): ScoredItem | null {
  if (kept.length === 0) return null;
  // Use the same ordering as within-category so the choice is stable.
  const sorted = [...kept].sort(sortWithinCategory);
  const candidate = sorted[0];
  if (!candidate) return null;
  return candidate.relevanceScore >= TOP_PICK_THRESHOLD ? candidate : null;
}

/**
 * C5 renderer. Build the Buttondown-ready `{subject, body}` from kept
 * ScoredItems. Pure, deterministic: same input → same output, no I/O.
 * Honors U-05 ordering (category → relevance DESC → id ASC).
 */
export function renderIssue(
  runDate: string,
  kept: readonly ScoredItem[],
): RenderedIssue {
  const subject = `${SUBJECT_PREFIX} — ${runDate}`;
  const groups = groupByCategory(kept);
  const nonEmptyCategories = CATEGORIES.filter(
    (c) => (groups.get(c)?.length ?? 0) > 0,
  );
  const topPick = pickTopItem(kept);

  const sections: string[] = [];
  sections.push(`# ${SUBJECT_PREFIX} — ${runDate}`);
  sections.push("");
  sections.push(renderIntro(kept, topPick, nonEmptyCategories.length));
  sections.push("");

  if (kept.length >= TOC_MIN_ITEMS) {
    sections.push(renderTOC(groups));
    sections.push("");
  }

  if (topPick) {
    sections.push(renderTopPick(topPick));
    sections.push("");
  }

  for (const category of CATEGORIES) {
    const bucket = groups.get(category) ?? [];
    if (bucket.length === 0) continue;
    sections.push(renderCategorySection(category, bucket));
    sections.push("");
  }

  sections.push(renderFooter());

  return { subject, body: sections.join("\n") };
}
