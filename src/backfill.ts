// E-06 backfill. Re-publishes a prior day's archive when `issue.md` is
// present on disk but the `.published` sentinel is not — the symptom of
// either an in-process partial write (archivist died between issue.md and
// .published) or a runner that committed locally but failed to `git push`.
//
// Snowball protection: `maxAttempts` caps how many prior days we re-publish
// in one cron run. Default 1. If the cap is exceeded (e.g. the workflow was
// broken for multiple days) we emit a loud ::warning:: so an operator can
// investigate rather than slow-leaking catch-up sends over many days.
//
// Non-blocking: a backfill failure logs ::error:: but does NOT abort the
// current `runDate`. The orchestrator calls `runBackfill` inside its own
// try/catch, and the caller is expected to continue past the result.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isValidRunDate } from "./runDate.js";
import { log } from "./log.js";
import { renderIssue } from "./renderer/index.js";
import { writeFileAtomic } from "./fsAtomic.js";
import { sentinelPath, itemsJsonPath } from "./archivist/index.js";
import { ScoredItemSchema } from "./types.js";
import { ArchiveParseError } from "./errors.js";
// Type-only import breaks the circular between backfill.ts ⇄ orchestrator.ts
// (orchestrator owns `Publisher`; backfill needs its shape to call .publish).
import type { Publisher } from "./orchestrator.js";

export interface UnpublishedDay {
  runDate: string;
  dir: string;
}

/**
 * Scan `issues/` for prior-day dirs that have `issue.md` but no `.published`
 * sentinel — the symptom of a partial archive or a failed `git push`. Returns
 * the orphans sorted oldest-first.
 */
export function findUnpublished(
  repoRoot: string,
  currentRunDate: string,
): UnpublishedDay[] {
  const issuesDir = path.join(repoRoot, "issues");
  if (!existsSync(issuesDir)) return [];
  const out: UnpublishedDay[] = [];
  for (const entry of readdirSync(issuesDir)) {
    if (!isValidRunDate(entry)) continue;
    if (entry >= currentRunDate) continue;
    const dir = path.join(issuesDir, entry);
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(dir, { throwIfNoEntry: false });
    } catch (err) {
      // EACCES / EPERM on a single prior-day dir must not abort detection of
      // the other orphan days. Skip this entry with a loud warning so the
      // operator can fix permissions without the cron silently passing.
      log.warn("backfill: stat failed for prior day dir (skipping)", {
        runDate: entry,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!stat || !stat.isDirectory()) continue;
    const issueMd = path.join(dir, "issue.md");
    const published = path.join(dir, ".published");
    if (existsSync(issueMd) && !existsSync(published)) {
      out.push({ runDate: entry, dir });
    }
  }
  return out.sort((a, b) => a.runDate.localeCompare(b.runDate));
}

export interface BackfillResult {
  attempted: number;
  succeeded: number;
  failed: number;
  // Days detected as orphans but over the `maxAttempts` cap — surfaced so
  // the run summary can render a loud warning without the cap being silent.
  skippedOverCap: number;
  // runDates we actually touched (attempted, in order). Useful for the
  // run summary so operators can see which dates this cron recovered.
  attemptedDates: string[];
}

// Minimal load-bearing shape of `items.json`. We only need `items` here;
// other fields are ignored so the schema stays tolerant to additive changes
// in archivist payload.
const ItemsJsonSchema = z.object({
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ScoredItemSchema),
});

export interface RunBackfillOpts {
  readonly dryRun: boolean;
  // Default 1 — snowball protection. Set higher only deliberately (e.g. a
  // one-off catch-up workflow_dispatch with a higher ceiling).
  readonly maxAttempts?: number;
  // Absent under DRY_RUN (we never call publish there) and in the tiny
  // number of callsites that exercise detect-only behavior. When provided
  // and the day has a readable items.json with kept items, we call
  // publisher.publish() and write `.published` on success.
  readonly publisher?: Publisher;
}

/**
 * E-06 backfill. Re-publishes up to `maxAttempts` prior-day orphans (default 1)
 * using the supplied publisher. Non-blocking: failures log `::error::` but do
 * not abort today's run. DRY_RUN causes a detect-and-log-only pass.
 */
export async function runBackfill(
  repoRoot: string,
  currentRunDate: string,
  opts: RunBackfillOpts = { dryRun: false },
): Promise<BackfillResult> {
  const unpublished = findUnpublished(repoRoot, currentRunDate);
  const result: BackfillResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skippedOverCap: 0,
    attemptedDates: [],
  };
  if (unpublished.length === 0) return result;

  const maxAttempts = opts.maxAttempts ?? 1;
  log.warn("E-06 backfill: detected unpublished prior days", {
    count: unpublished.length,
    days: unpublished.map((d) => d.runDate),
    cap: maxAttempts,
  });

  if (unpublished.length > maxAttempts) {
    const overCap = unpublished.slice(maxAttempts).map((d) => d.runDate);
    log.warn(
      "E-06 backfill: more unpublished days than cap; deferring extras to next run",
      { cap: maxAttempts, skipped: overCap },
    );
    result.skippedOverCap = overCap.length;
  }

  for (const day of unpublished.slice(0, maxAttempts)) {
    result.attempted++;
    result.attemptedDates.push(day.runDate);
    if (opts.dryRun) {
      log.info("[DRY_RUN] would backfill prior day", { runDate: day.runDate });
      continue;
    }
    if (!opts.publisher) {
      log.error("backfill: no publisher provided; cannot re-publish", {
        runDate: day.runDate,
      });
      result.failed++;
      continue;
    }
    try {
      await backfillOneDay(repoRoot, day.runDate, opts.publisher);
      result.succeeded++;
    } catch (err) {
      result.failed++;
      log.error("backfill failed for prior day (non-blocking)", {
        runDate: day.runDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

async function backfillOneDay(
  repoRoot: string,
  runDate: string,
  publisher: Publisher,
): Promise<void> {
  const itemsJsonAbs = itemsJsonPath(repoRoot, runDate);
  if (!existsSync(itemsJsonAbs)) {
    // issue.md without items.json means the archivist died between the first
    // and second write. We cannot faithfully reconstruct the payload, so we
    // refuse to re-publish a half-known issue — operator must intervene.
    throw new Error(
      `items.json missing for ${runDate}; cannot reconstruct kept items for re-publish`,
    );
  }
  // Syntactic JSON errors and zod shape errors are both surfaced as
  // ArchiveParseError so the file path survives the rethrow (operator needs
  // it to locate the corrupt archive).
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(itemsJsonAbs, "utf8"));
  } catch (cause) {
    throw new ArchiveParseError(
      `items.json parse failed for ${runDate}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { filePath: itemsJsonAbs, stage: "backfill", cause },
    );
  }
  const parsed = ItemsJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArchiveParseError(
      `items.json shape invalid for ${runDate}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      { filePath: itemsJsonAbs, stage: "backfill", cause: parsed.error },
    );
  }
  const kept = parsed.data.items.filter((it) => it.keep);
  if (kept.length === 0) {
    throw new Error(`no kept items in items.json for ${runDate}`);
  }
  const rendered = renderIssue(runDate, kept);
  log.info("backfill: re-publishing prior day", {
    runDate,
    itemCount: kept.length,
    subjectLength: rendered.subject.length,
    bodyLength: rendered.body.length,
  });
  const outcome = await publisher.publish(rendered);
  // Sentinel is the last write. Atomic helper cleans up `.tmp` on rename
  // failure so we never leave a partial `.published` that would short-circuit
  // the NEXT run's detection.
  writeFileAtomic(sentinelPath(repoRoot, runDate), `${outcome.id}\n`);
  log.info("backfill: re-publish ok", {
    runDate,
    publishId: outcome.id,
    attempts: outcome.attempts,
  });
}
