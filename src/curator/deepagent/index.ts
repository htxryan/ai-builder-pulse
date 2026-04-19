// DeepAgents curator — public surface (DC2a).
//
// M1 scaffolds the module layout; the graph + tool + retry logic lands in
// M2-M4. Calling `runDeepAgentCurator` today throws `NotYetImplementedError`
// with a pointer to the decomposition doc so a misconfigured environment
// fails loudly rather than silently returning empty results.
//
// Invariants already in force:
//   - Version guard (DA-Un-05) runs at module init — importing this file
//     asserts the pinned versions.
//   - No side effects beyond the version check.
//
// This file intentionally imports nothing from `@langchain/*` or
// `deepagents`. The adapter (M2) will, but the public surface should stay
// narrow so the factory can import it cheaply.

import type { Curator, CuratorMetrics } from "../mockCurator.js";
import type { SkippedItemRecord } from "../deadletter.js";
import type { RawItem, ScoredItem } from "../../types.js";
import {
  assertPinnedVersions,
  VersionDriftError,
} from "./version-guard.js";

export { VersionDriftError, assertPinnedVersions } from "./version-guard.js";

// Module-init version check. Any importer of this module gets DA-Un-05
// enforcement for free; there is no opt-out path short of not importing.
assertPinnedVersions();

export class NotYetImplementedError extends Error {
  constructor() {
    super(
      "runDeepAgentCurator is scaffolded (M1) but not wired to LangGraph yet. " +
        "See docs/specs/deepagents-migration-decomposition.md §3 M2 for the " +
        "graph-binding epic. To unblock locally, set CURATOR_BACKEND=legacy.",
    );
    this.name = "NotYetImplementedError";
  }
}

/**
 * Env-parsed knobs for the DeepAgents curator. All values are NaN-guarded
 * (see `parsePositiveInt` / `parsePositiveNumber`) so a malformed env throws
 * at config-parse time rather than producing a silent `NaN` mid-chunk.
 *
 * Defaults are authoritative here — the spec's §3 EARS requirements quote
 * these values directly.
 */
export interface DeepAgentConfig {
  /** DA-S-01 — LangGraph recursion limit per chunk. */
  readonly maxIterations: number;
  /** DA-E-04 — tool-call budget per chunk. */
  readonly toolBudget: number;
  /** DA-E-05 / DA-U-12 — chunk-level retry count on transient failure. */
  readonly maxChunkRetries: number;
  /** DA-O-02 — concurrent chunk execution cap. */
  readonly maxConcurrentChunks: number;
  /** DA-Un-08 — LangSmith opt-in toggle (no auto-wire from LANGSMITH_API_KEY). */
  readonly enableLangsmith: boolean;
  /** DA-O-01 — write per-chunk JSONL audit trace. */
  readonly auditToFile: boolean;
}

export const DEEPAGENT_DEFAULTS: DeepAgentConfig = {
  maxIterations: 6,
  toolBudget: 8,
  maxChunkRetries: 3,
  maxConcurrentChunks: 1,
  enableLangsmith: false,
  auditToFile: false,
};

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid env ${name}=${raw} (expected positive integer)`,
    );
  }
  return n;
}

function parseBoolFlag(raw: string | undefined): boolean {
  // Match the rest of the codebase: "1" turns it on. Anything else is off.
  return raw === "1";
}

/**
 * Parse DEEPAGENT_* env vars into a validated config. Throws on malformed
 * values so an operator typo can't silently bypass a safety limit.
 */
export function parseDeepAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeepAgentConfig {
  return {
    maxIterations: parsePositiveInt(
      env.DEEPAGENT_MAX_ITERATIONS,
      DEEPAGENT_DEFAULTS.maxIterations,
      "DEEPAGENT_MAX_ITERATIONS",
    ),
    toolBudget: parsePositiveInt(
      env.DEEPAGENT_TOOL_BUDGET,
      DEEPAGENT_DEFAULTS.toolBudget,
      "DEEPAGENT_TOOL_BUDGET",
    ),
    maxChunkRetries: parsePositiveInt(
      env.DEEPAGENT_MAX_CHUNK_RETRIES,
      DEEPAGENT_DEFAULTS.maxChunkRetries,
      "DEEPAGENT_MAX_CHUNK_RETRIES",
    ),
    maxConcurrentChunks: parsePositiveInt(
      env.DEEPAGENT_MAX_CONCURRENT_CHUNKS,
      DEEPAGENT_DEFAULTS.maxConcurrentChunks,
      "DEEPAGENT_MAX_CONCURRENT_CHUNKS",
    ),
    enableLangsmith: parseBoolFlag(env.DEEPAGENT_ENABLE_LANGSMITH),
    auditToFile: parseBoolFlag(env.DEEPAGENT_AUDIT_TO_FILE),
  };
}

export interface RunDeepAgentCuratorContext {
  readonly runId: string;
  readonly runDate: string;
  readonly config?: DeepAgentConfig;
}

/**
 * Public API (DC2a). Will land the DeepAgents-backed implementation in M2.
 * Today: throws `NotYetImplementedError` so a misrouted run fails fast.
 */
export async function runDeepAgentCurator(
  _items: readonly RawItem[],
  _ctx: RunDeepAgentCuratorContext,
): Promise<ScoredItem[]> {
  throw new NotYetImplementedError();
}

/**
 * Thin class wrapper so the curator factory can hand back an object
 * satisfying the `Curator` interface without exposing the free-function
 * shape. `lastMetrics` / `lastSkipped` are wired in M3/M4.
 */
export class DeepAgentCurator implements Curator {
  constructor(
    private readonly runCtx: RunDeepAgentCuratorContext,
  ) {}

  async curate(items: RawItem[]): Promise<ScoredItem[]> {
    return runDeepAgentCurator(items, this.runCtx);
  }

  lastMetrics(): CuratorMetrics | undefined {
    return undefined;
  }

  lastSkipped(): readonly SkippedItemRecord[] {
    return [];
  }
}
