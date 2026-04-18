// E-02 Weekly digest builder. Pure functions only: given the last N days'
// items.json payloads, select the best-of set and render a markdown digest.
// IO (file read, publish, commit) lives in index.ts so the core logic is
// unit-testable without a filesystem.

import {
  CATEGORIES,
  type Category,
  type ScoredItem,
  ScoredItemSchema,
} from "../types.js";
import { sourceBadge } from "../renderer/sourceBadge.js";
import { z } from "zod";

// Minimal shape we care about from `issues/YYYY-MM-DD/items.json`. We keep
// it loose deliberately: only `runDate` and `items` are load-bearing here,
// everything else is passed through for provenance.
export const ArchivedDaySchema = z.object({
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ScoredItemSchema),
});
export type ArchivedDay = z.infer<typeof ArchivedDaySchema>;

export interface WeeklyDigestInput {
  readonly weekId: string; // e.g. "2026-W16"
  readonly availableDays: readonly ArchivedDay[];
  readonly missingDays: readonly string[]; // YYYY-MM-DD of days with no items.json
  readonly topN?: number; // default 12 — total items that appear in the digest
  readonly topPerCategory?: number; // default 3 — cap items shown per category
}

export interface WeeklyDigest {
  readonly subject: string;
  readonly body: string;
  readonly itemCount: number;
}

// ISO-8601 week-of-year. Matches GNU `date +%G-W%V`. The ISO week year can
// differ from the calendar year at the ends (e.g. 2026-01-01 may be in
// "2025-W53") so we compute both together and never split them.
export function isoWeekId(d: Date): string {
  // Copy to a UTC noon to avoid DST/timezone drift.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday in the current ISO week decides the ISO year.
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = Math.ceil(
    ((t.getTime() - jan4.getTime()) / 86_400_000 + ((jan4.getUTCDay() || 7) - 1)) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

// Compute the 7 YYYY-MM-DD strings ending at (and including) `endDate`.
export function priorSevenDays(endDate: string): string[] {
  const [y, m, d] = endDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid endDate: ${endDate}`);
  const base = new Date(Date.UTC(y, m - 1, d));
  const out: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(base.getTime() - i * 86_400_000);
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}

// Count distinct days each item id appeared on (keep:true only). Same id
// across multiple archive days = "trending this week" signal. Items
// appearing on 2+ days get a visual badge in the rendered digest.
function buildDayAppearance(
  days: readonly ArchivedDay[],
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const day of days) {
    for (const it of day.items) {
      if (!it.keep) continue;
      let set = seen.get(it.id);
      if (!set) {
        set = new Set<string>();
        seen.set(it.id, set);
      }
      set.add(day.runDate);
    }
  }
  const out = new Map<string, number>();
  for (const [id, set] of seen.entries()) out.set(id, set.size);
  return out;
}

// Select the cross-day best-of. Strategy: flatten all `keep:true` items from
// every available day, sort by relevanceScore DESC (id ASC as stable
// tiebreak, matching the daily renderer), then take top N. We DO NOT re-run
// Claude for ranking — the per-day relevance score is the system of record.
function selectTop(
  days: readonly ArchivedDay[],
  topN: number,
): ScoredItem[] {
  const pool: ScoredItem[] = [];
  // De-dup across days by id. Same URL across different days (e.g. an
  // article that trended on both Monday and Wednesday) collapses to whichever
  // copy had the higher relevanceScore.
  const byId = new Map<string, ScoredItem>();
  for (const day of days) {
    for (const it of day.items) {
      if (!it.keep) continue;
      const existing = byId.get(it.id);
      if (!existing || it.relevanceScore > existing.relevanceScore) {
        byId.set(it.id, it);
      }
    }
  }
  for (const it of byId.values()) pool.push(it);
  pool.sort((a, b) => {
    if (a.relevanceScore !== b.relevanceScore) {
      return b.relevanceScore - a.relevanceScore;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return pool.slice(0, topN);
}

function escapeLinkLabel(text: string): string {
  return text.replace(/[\[\]]/g, (c) => (c === "[" ? "\\[" : "\\]"));
}

function escapeLinkUrl(url: string): string {
  return url.replace(/\)/g, "%29");
}

function renderItem(
  item: ScoredItem,
  appearedOnDays: number,
): string {
  const header = `### [${escapeLinkLabel(item.title)}](${escapeLinkUrl(item.url)})`;
  const trendingSuffix =
    appearedOnDays >= 2 ? ` · trending this week (${appearedOnDays} days)` : "";
  const meta = `*${sourceBadge(item)}${trendingSuffix}*`;
  return `${header}\n${meta}\n\n${item.description}\n`;
}

function groupByCategory(items: readonly ScoredItem[]): Map<Category, ScoredItem[]> {
  const groups = new Map<Category, ScoredItem[]>();
  for (const c of CATEGORIES) groups.set(c, []);
  for (const it of items) {
    const bucket = groups.get(it.category);
    if (bucket) bucket.push(it);
  }
  return groups;
}

export function buildWeeklyDigest(input: WeeklyDigestInput): WeeklyDigest {
  const topN = input.topN ?? 12;
  const topPerCategory = input.topPerCategory ?? 3;
  const dayAppearance = buildDayAppearance(input.availableDays);
  const subject = `AI Builder Pulse Weekly — ${input.weekId}`;

  // Select top-N overall, then apply per-category cap. We re-flatten post-cap
  // so `selected` (and `itemCount`) reflects what subscribers actually see —
  // otherwise the intro's "N items" would over-count what gets rendered.
  const selectedPool = selectTop(input.availableDays, topN);
  const perCategoryGroups = groupByCategory(selectedPool);
  const selected: ScoredItem[] = [];
  for (const category of CATEGORIES) {
    const bucket = perCategoryGroups.get(category) ?? [];
    for (const it of bucket.slice(0, topPerCategory)) selected.push(it);
  }

  const sections: string[] = [];
  sections.push(`# AI Builder Pulse Weekly — ${input.weekId}`);
  sections.push("");

  const daysCovered = input.availableDays.length;
  const totalWindow = daysCovered + input.missingDays.length;
  // Day-coverage breadcrumb: "7 of 7 days" when complete, or the ratio when
  // the rollup is partial. We always show the ratio so subscribers can tell
  // at a glance whether the week was fully captured.
  const coverage =
    totalWindow > 0 ? `${daysCovered} of ${totalWindow} days` : `${daysCovered} days`;
  sections.push(
    `Best of the week (${coverage}): ${selected.length} item${selected.length === 1 ? "" : "s"} re-ranked by relevance.`,
  );
  sections.push("");

  // E-02 tolerance: annotate missing days so subscribers see when the weekly
  // isn't a full 7-day rollup (e.g. a new deploy, or an outage).
  if (input.missingDays.length > 0) {
    sections.push(
      `_Note: ${input.missingDays.length} day${input.missingDays.length === 1 ? "" : "s"} missing from this rollup (${input.missingDays.join(", ")})._`,
    );
    sections.push("");
  }

  if (selected.length === 0) {
    sections.push("_No items met the relevance threshold this week._");
    sections.push("");
  } else {
    for (const category of CATEGORIES) {
      const bucket = perCategoryGroups.get(category) ?? [];
      if (bucket.length === 0) continue;
      const capped = bucket.slice(0, topPerCategory);
      sections.push(`## ${category}`);
      sections.push("");
      sections.push(
        capped
          .map((it) => renderItem(it, dayAppearance.get(it.id) ?? 1))
          .join("\n")
          .replace(/\n+$/, ""),
      );
      sections.push("");
    }
  }

  sections.push("---");
  sections.push("");
  sections.push(
    "Weekly digest compiled from the daily archive. See [the archive](https://buttondown.com/ai-builder-pulse/archive) for full daily issues.",
  );
  sections.push("");

  return { subject, body: sections.join("\n"), itemCount: selected.length };
}
