// E6 Archivist. Persists a successfully-published run to the repo as three
// files written atomically to `issues/{runDate}/`:
//
//   issue.md     — the exact rendered body that was POSTed to Buttondown
//   items.json   — structured record of the run (kept items + sourceSummary)
//   .published   — C7 sentinel; presence alone signals "this runDate is done"
//
// Order matters for partial-failure detectability: issue.md and items.json
// are written FIRST. If this process dies between issue.md and .published
// (e.g. disk full after two writes), the next run's E-06 backfill scan
// (backfill.ts) observes "issue.md exists, .published does not" and flags it.
//
// This module does NOT invoke git — commit + push is the workflow's job
// (daily.yml). Writing to the filesystem is all the TS code can atomically
// guarantee.
//
// Un-06 LIMITATION (be explicit): if the Buttondown POST succeeds AND the
// archivist writes all three files AND the workflow's `git push` then fails,
// the next cron starts from a clean checkout. None of these files exist on
// the fresh runner, so the backfill scan finds nothing — the orchestrator
// runs normally and issues a DUPLICATE send to subscribers. E-06 recovery
// genuinely protects only the in-process partial-write case (files landed
// on disk, process died before committing). A proper remote-side guard
// (sentinel pushed separately, or remote-marker precheck) would close that
// gap; it is not implemented in this revision.
//
// EARS: U-06 (three-file layout), U-10 (sourceSummary in items.json),
// C6 (archive path convention), C7 writer side (.published after 2xx only).

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RenderedIssue } from "../renderer/renderer.js";
import type { ScoredItem, SourceSummary } from "../types.js";
import { writeFileAtomic } from "../fsAtomic.js";

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

// Sentinel write uses the shared atomic helper (cleans up `.tmp` on
// failure). We do NOT want a partial `.published` hanging around — it
// would short-circuit E-06 detection.
function writeSentinelAtomic(dest: string, publishId: string): void {
  writeFileAtomic(dest, `${publishId}\n`);
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
  writeFileAtomic(issueMd, input.rendered.body);
  writeFileAtomic(itemsJson, `${JSON.stringify(payload, null, 2)}\n`);
  writeSentinelAtomic(sentinel, input.publishId);

  return {
    runDate: input.runDate,
    dir,
    issueMdPath: issueMd,
    itemsJsonPath: itemsJson,
    sentinelPath: sentinel,
  };
}
