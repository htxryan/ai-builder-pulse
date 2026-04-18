import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isValidRunDate } from "./runDate.js";
import { log } from "./log.js";

export interface UnpublishedDay {
  runDate: string;
  dir: string;
}

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
    if (!statSync(dir).isDirectory()) continue;
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
}

export async function runBackfill(
  repoRoot: string,
  currentRunDate: string,
  opts: { dryRun: boolean; maxAttempts?: number } = { dryRun: false },
): Promise<BackfillResult> {
  const unpublished = findUnpublished(repoRoot, currentRunDate);
  const result: BackfillResult = { attempted: 0, succeeded: 0, failed: 0 };
  if (unpublished.length === 0) return result;
  log.warn("E-06 backfill: detected unpublished prior days", {
    count: unpublished.length,
    days: unpublished.map((d) => d.runDate),
  });
  const maxAttempts = opts.maxAttempts ?? 3;
  for (const day of unpublished.slice(0, maxAttempts)) {
    result.attempted++;
    if (opts.dryRun) {
      log.info("[DRY_RUN] would attempt backfill", { runDate: day.runDate });
      continue;
    }
    // In E1 we only detect + warn. Actual re-publish belongs to E5/E6.
    log.warn("backfill hook not yet wired to Publisher; skipping re-publish", {
      runDate: day.runDate,
    });
    result.failed++;
  }
  return result;
}
