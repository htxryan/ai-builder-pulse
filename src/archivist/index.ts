// E6 Archivist. Persists a successfully-published run to the repo as three
// files written atomically to `issues/{runDate}/`:
//
//   issue.md     — the exact rendered body that was POSTed to Buttondown
//   items.json   — structured record of the run (kept items + sourceSummary)
//   .published   — C7 sentinel; presence alone signals "this runDate is done"
//
// Order matters for Un-06 recoverability: issue.md and items.json are written
// FIRST (so a failure after POST but before sentinel still leaves E-06
// detectable artifacts — see backfill.ts: "issue.md exists, .published does
// not → backfill candidate"). `.published` goes last and holds the publishId.
//
// This module does NOT invoke git — commit + push is the workflow's job
// (daily.yml). Writing to the filesystem is all the TS code can atomically
// guarantee; the workflow's gitleaks step and `git push` then carry the
// commit over the line. If that step fails after Buttondown 2xx, the next
// cron run's E-06 backfill scan (src/backfill.ts) picks it up.
//
// EARS: U-06 (three-file layout), U-10 (sourceSummary in items.json),
// C6 (archive path convention), C7 writer side (.published after 2xx only).

import { mkdirSync, renameSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { RenderedIssue } from "../renderer/renderer.js";
import type { ScoredItem, SourceSummary } from "../types.js";

export interface ArchiveInput {
  readonly runDate: string;
  readonly repoRoot: string;
  readonly rendered: RenderedIssue;
  readonly scored: readonly ScoredItem[];
  readonly summary: SourceSummary;
  readonly publishId: string;
  // ISO timestamp the publish response was confirmed. Stored alongside the
  // publishId so a maintainer can correlate the archive with the send.
  readonly publishedAt: string;
}

export interface ArchiveResult {
  readonly runDate: string;
  readonly dir: string;
  readonly issueMdPath: string;
  readonly itemsJsonPath: string;
  readonly sentinelPath: string;
}

export function archiveDir(repoRoot: string, runDate: string): string {
  return path.join(repoRoot, "issues", runDate);
}

export function sentinelPath(repoRoot: string, runDate: string): string {
  return path.join(archiveDir(repoRoot, runDate), ".published");
}

export function issueMdPath(repoRoot: string, runDate: string): string {
  return path.join(archiveDir(repoRoot, runDate), "issue.md");
}

export function itemsJsonPath(repoRoot: string, runDate: string): string {
  return path.join(archiveDir(repoRoot, runDate), "items.json");
}

// `kept: true` is the subset that shipped; we persist ALL scored items so a
// maintainer can audit why a candidate was dropped. keep=false items are
// stored with their category+relevanceScore+description intact.
interface ItemsJsonPayload {
  readonly runDate: string;
  readonly publishId: string;
  readonly publishedAt: string;
  readonly itemCount: { total: number; kept: number };
  readonly sourceSummary: SourceSummary;
  readonly items: readonly ScoredItem[];
}

// Write a file by dumping to a sibling `.tmp` then rename. Same-filesystem
// rename is atomic on POSIX, so a crash mid-write never leaves a partial
// committed file.
function writeAtomic(dest: string, contents: string): void {
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, dest);
}

// Guard the sentinel write: if something goes wrong we do NOT want a partial
// `.published` hanging around (it would short-circuit E-06). Remove the tmp
// if rename failed.
function writeSentinelAtomic(dest: string, publishId: string): void {
  const tmp = `${dest}.tmp`;
  try {
    writeFileSync(tmp, `${publishId}\n`);
    renameSync(tmp, dest);
  } catch (err) {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // swallow — we're already on the error path
      }
    }
    throw err;
  }
}

export function archiveRun(input: ArchiveInput): ArchiveResult {
  const dir = archiveDir(input.repoRoot, input.runDate);
  mkdirSync(dir, { recursive: true });

  const issueMd = issueMdPath(input.repoRoot, input.runDate);
  const itemsJson = itemsJsonPath(input.repoRoot, input.runDate);
  const sentinel = sentinelPath(input.repoRoot, input.runDate);

  const kept = input.scored.filter((s) => s.keep).length;
  const payload: ItemsJsonPayload = {
    runDate: input.runDate,
    publishId: input.publishId,
    publishedAt: input.publishedAt,
    itemCount: { total: input.scored.length, kept },
    sourceSummary: input.summary,
    items: input.scored,
  };

  // Order: body first, structured record second, sentinel LAST. If this
  // process dies between issue.md and .published, the next run's E-06 scan
  // (backfill) will still see the orphaned issue.md and flag it.
  writeAtomic(issueMd, input.rendered.body);
  writeAtomic(itemsJson, `${JSON.stringify(payload, null, 2)}\n`);
  writeSentinelAtomic(sentinel, input.publishId);

  return {
    runDate: input.runDate,
    dir,
    issueMdPath: issueMd,
    itemsJsonPath: itemsJson,
    sentinelPath: sentinel,
  };
}
