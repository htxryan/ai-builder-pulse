// P3 deadletter: RawItems that the curator could not score are written here
// with the zod issue path (if zod-rooted) so they never vanish silently. Read
// by `src/orchestrator.ts` at the end of the curate stage; surfaced in the
// run summary so an operator sees the count without tailing the log pane.
//
// Written to `issues/{runDate}/.skipped-items.json` alongside the other
// archive files (leading dot keeps it out of the default renderer glob). The
// file is best-effort — a write failure does NOT abort the run. The whole
// point is audit trail, not gated correctness.

import path from "node:path";
import { mkdirSync } from "node:fs";
import type { RawItem } from "../types.js";
import { writeFileAtomic } from "../fsAtomic.js";
import { archiveDir } from "../archivist/index.js";
import { log } from "../log.js";

export interface SkippedItemRecord {
  readonly rawItem: RawItem;
  // zod's dot-notation issue path when the skip came from a schema violation,
  // e.g. "items.3.relevanceScore". Empty string when the skip came from a
  // non-zod failure mode (network, retry exhaustion with no structured error).
  readonly zodPath: string;
  // Single-line reason for triage. Mirrors the failure log line so an
  // operator can cross-reference without reading the raw log JSON.
  readonly reason: string;
}

export function skippedItemsPath(repoRoot: string, runDate: string): string {
  return path.join(archiveDir(repoRoot, runDate), ".skipped-items.json");
}

interface SkippedItemsPayload {
  readonly runDate: string;
  readonly skippedCount: number;
  readonly skipped: readonly SkippedItemRecord[];
}

// Writes the deadletter file if `skipped` is non-empty. Returns true if the
// write happened (used by the run summary to know whether to render a link).
// Swallows I/O errors: a broken disk should not poison the post-curation path
// any more than the curator catch block already does.
export function writeSkippedItemsJson(
  repoRoot: string,
  runDate: string,
  skipped: readonly SkippedItemRecord[],
): boolean {
  if (skipped.length === 0) return false;
  try {
    const dir = archiveDir(repoRoot, runDate);
    mkdirSync(dir, { recursive: true });
    const payload: SkippedItemsPayload = {
      runDate,
      skippedCount: skipped.length,
      skipped,
    };
    writeFileAtomic(
      skippedItemsPath(repoRoot, runDate),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    return true;
  } catch (err) {
    log.error("deadletter write failed (non-blocking)", {
      runDate,
      skippedCount: skipped.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
