// ARCHIVES_FALLBACK (AC7). When the daily pipeline would otherwise silence a
// subscriber day (all collectors empty / source floor not met / kept items
// below the min publish threshold) AND the operator has opted in via the
// `ARCHIVES_FALLBACK=1` env flag, re-publish the most recent prior archive
// with a visible "From the archives" banner.
//
// This is deliberately off by default. The silence-SLA behavior is that the
// newsletter skips a day — never silently, always logged and surfaced in the
// job summary. Opting in trades strict freshness for continuity.
//
// Isolation: this module owns the fallback rendering + publish path. The
// orchestrator decides WHEN to call it; the caller still writes the daily
// sentinel on success so S-03 blocks re-runs the same way as a normal day.

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isValidRunDate } from "./runDate.js";
import { log } from "./log.js";
import { renderIssue, type RenderedIssue } from "./renderer/index.js";
import { ScoredItemSchema, type ScoredItem } from "./types.js";
import { archiveDir, itemsJsonPath, sentinelPath } from "./archivist/index.js";
import { writeFileAtomic } from "./fsAtomic.js";
import type { Publisher } from "./orchestrator.js";
import { ArchiveParseError } from "./errors.js";

const ItemsJsonSchema = z.object({
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ScoredItemSchema),
});

export interface ArchivesFallbackResult {
  readonly status: "published" | "dry_run" | "no_archive_available" | "failed";
  readonly sourceRunDate?: string;
  readonly itemCount?: number;
  readonly publishId?: string;
  readonly rendered?: RenderedIssue;
  readonly reason?: string;
}

// Latest prior day's archive dir that has a readable items.json. We scan the
// full `issues/` directory rather than taking `runDate - 1` so a weekend or
// holiday gap does not defeat the fallback.
export function findLatestArchive(
  repoRoot: string,
  currentRunDate: string,
): string | undefined {
  const issuesDir = path.join(repoRoot, "issues");
  if (!existsSync(issuesDir)) return undefined;
  const candidates: string[] = [];
  for (const entry of readdirSync(issuesDir)) {
    if (!isValidRunDate(entry)) continue;
    if (entry >= currentRunDate) continue;
    const itemsJson = itemsJsonPath(repoRoot, entry);
    if (!existsSync(itemsJson)) continue;
    candidates.push(entry);
  }
  candidates.sort();
  return candidates.at(-1);
}

interface FallbackBannerInput {
  readonly runDate: string;
  readonly sourceRunDate: string;
  readonly kept: readonly ScoredItem[];
}

// Prepends the banner to the rendered body so subscribers immediately see
// that today's issue is a re-share, not today's fresh content. Mirrored in
// the subject with a `[Archives]` prefix so inbox previews make this obvious.
function renderWithBanner(input: FallbackBannerInput): RenderedIssue {
  const base = renderIssue(input.runDate, input.kept);
  const banner =
    `> 🔁 **From the archives** — the pipeline found no new content for ${input.runDate}, so we're ` +
    `resharing the best items from [${input.sourceRunDate}](./issues/${input.sourceRunDate}/issue.md). ` +
    `No new sends were available today.\n\n`;
  return {
    subject: `[Archives] ${base.subject}`,
    body: banner + base.body,
  };
}

export interface RunArchivesFallbackOpts {
  readonly dryRun: boolean;
  readonly topN?: number;
  readonly publisher?: Publisher;
}

export async function runArchivesFallback(
  repoRoot: string,
  runDate: string,
  opts: RunArchivesFallbackOpts,
): Promise<ArchivesFallbackResult> {
  const sourceRunDate = findLatestArchive(repoRoot, runDate);
  if (!sourceRunDate) {
    log.warn("archives fallback: no prior archive available", { runDate });
    return {
      status: "no_archive_available",
      reason: "no_prior_archive",
    };
  }
  const p = itemsJsonPath(repoRoot, sourceRunDate);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (cause) {
    const err = new ArchiveParseError(
      `items.json parse failed for ${sourceRunDate}`,
      { filePath: p, stage: "render", cause },
    );
    log.error("archives fallback: prior archive items.json unreadable", {
      sourceRunDate,
      filePath: err.filePath,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return {
      status: "failed",
      sourceRunDate,
      reason: "archive_invalid",
    };
  }
  const parsed = ItemsJsonSchema.safeParse(raw);
  if (!parsed.success) {
    log.error("archives fallback: prior archive items.json invalid", {
      sourceRunDate,
      filePath: p,
      error: parsed.error.issues[0]?.message,
    });
    return {
      status: "failed",
      sourceRunDate,
      reason: "archive_invalid",
    };
  }
  const kept = parsed.data.items.filter((it) => it.keep).slice(0, opts.topN ?? 10);
  if (kept.length === 0) {
    log.warn("archives fallback: prior archive had no kept items", {
      sourceRunDate,
    });
    return {
      status: "no_archive_available",
      sourceRunDate,
      reason: "archive_empty",
    };
  }
  const rendered = renderWithBanner({ runDate, sourceRunDate, kept });
  if (opts.dryRun) {
    log.info("[DRY_RUN] would publish archives fallback", {
      runDate,
      sourceRunDate,
      itemCount: kept.length,
      subject: rendered.subject,
    });
    return {
      status: "dry_run",
      sourceRunDate,
      itemCount: kept.length,
      rendered,
    };
  }
  if (!opts.publisher) {
    log.error("archives fallback: no publisher provided", { runDate });
    return {
      status: "failed",
      sourceRunDate,
      reason: "no_publisher",
    };
  }
  try {
    const outcome = await opts.publisher.publish(rendered);
    // Write the daily sentinel so S-03 blocks any same-day rerun. No
    // items.json / issue.md is written — this is a re-share, not a new
    // archive entry; the source day remains the canonical archive. Create
    // the archive dir first; a re-share day won't have one otherwise.
    mkdirSync(archiveDir(repoRoot, runDate), { recursive: true });
    writeFileAtomic(sentinelPath(repoRoot, runDate), `${outcome.id}\n`);
    log.info("archives fallback: published", {
      runDate,
      sourceRunDate,
      publishId: outcome.id,
      attempts: outcome.attempts,
    });
    return {
      status: "published",
      sourceRunDate,
      itemCount: kept.length,
      publishId: outcome.id,
      rendered,
    };
  } catch (err) {
    log.error("archives fallback: publish failed", {
      runDate,
      sourceRunDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      sourceRunDate,
      reason: "publish_failed",
    };
  }
}
