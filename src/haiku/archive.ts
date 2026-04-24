// Persist Haiku pre-filter stats alongside the daily archive (OQ2 / AC-20).
// Written to `issues/{runDate}/.haiku-stats.json` so operators can compare
// kept/dropped/estimatedUsd across runs without tailing the log pane.
//
// Best-effort: a write failure logs a warning but does NOT abort the run.
// The file is audit trail, not gated correctness — Haiku cost is independent
// from `CURATOR_MAX_USD` (R18) and the .published sentinel is the only
// idempotency anchor.
//
// Skipped stages MUST NOT write this file; presence vs. absence is how
// operators distinguish "Haiku ran" from "Haiku was bypassed (DISABLED, no
// API key, or stage-level fallback)". The caller (orchestrator) gates the
// call on `result.skipped === false`.

import path from "node:path";
import { mkdirSync } from "node:fs";
import { archiveDir } from "../archivist/index.js";
import { writeFileAtomic } from "../fsAtomic.js";
import { log } from "../log.js";
import type { HaikuPreFilterStats } from "./index.js";

export function haikuStatsPath(repoRoot: string, runDate: string): string {
  return path.join(archiveDir(repoRoot, runDate), ".haiku-stats.json");
}

interface HaikuStatsPayload {
  readonly runDate: string;
  readonly inputCount: number;
  readonly keptCount: number;
  readonly droppedCount: number;
  readonly chunkCount: number;
  readonly estimatedUsd: number;
}

/**
 * Write the Haiku stage stats to `issues/{runDate}/.haiku-stats.json`.
 * Returns true on success, false on any I/O error (logged at warn level).
 */
export function writeHaikuStatsJson(
  repoRoot: string,
  runDate: string,
  stats: HaikuPreFilterStats,
): boolean {
  try {
    const dir = archiveDir(repoRoot, runDate);
    mkdirSync(dir, { recursive: true });
    const payload: HaikuStatsPayload = {
      runDate,
      inputCount: stats.inputCount,
      keptCount: stats.keptCount,
      droppedCount: stats.droppedCount,
      chunkCount: stats.chunkCount,
      estimatedUsd: stats.estimatedUsd,
    };
    writeFileAtomic(
      haikuStatsPath(repoRoot, runDate),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    return true;
  } catch (err) {
    log.warn("haiku stats write failed (non-blocking)", {
      runDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
