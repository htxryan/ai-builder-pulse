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
  ) + 0;
  // Pre-2000 sanity: the formula above returns week-of-year starting from the
  // Monday of the week containing Jan 4. We need +1 because we zero-indexed
  // the offset from Monday of week 1.
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

function renderItem(item: ScoredItem): string {
  const header = `### [${escapeLinkLabel(item.title)}](${escapeLinkUrl(item.url)})`;
  return `${header}\n\n${item.description}\n`;
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
  const selected = selectTop(input.availableDays, topN);
  const subject = `AI Builder Pulse Weekly — ${input.weekId}`;

  const sections: string[] = [];
  sections.push(`# AI Builder Pulse Weekly — ${input.weekId}`);
  sections.push("");

  const daysCovered = input.availableDays.length;
  sections.push(
    `Best of the last ${daysCovered} day${daysCovered === 1 ? "" : "s"}: ${selected.length} item${selected.length === 1 ? "" : "s"} re-ranked by relevance across the week.`,
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
    const groups = groupByCategory(selected);
    for (const category of CATEGORIES) {
      const bucket = groups.get(category) ?? [];
      if (bucket.length === 0) continue;
      sections.push(`## ${category}`);
      sections.push("");
      sections.push(bucket.map(renderItem).join("\n").replace(/\n+$/, ""));
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
