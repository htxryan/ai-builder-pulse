// DeepAgents curator — public surface (DC2a).
//
// M2 wires `runDeepAgentCurator` to the LangGraph + @langchain/anthropic
// adapter. The public surface (function signature + `DeepAgentCurator`
// class) is the "low volatility" contract per advisor P1-8; the LangChain
// churn is contained in `./adapter.ts`.
//
// Invariants in force here:
//   - Version guard (DA-Un-05) runs at module init — importing this file
//     asserts the pinned versions before any curator call can happen.
//   - No side effects beyond the version check.
//
// This file intentionally imports `./adapter.ts` lazily (inside
// `runDeepAgentCurator`) so a consumer that only wants the env-parsing
// helpers or the `VersionDriftError` type doesn't drag the full LangChain
// module graph into the require tree. The factory (`../index.ts`) already
// gates import of this module behind `CURATOR_BACKEND=deepagents`, which
// satisfies DA-S-02 / DA-S-03.

import type { Curator, CuratorMetrics } from "../mockCurator.js";
import type { SkippedItemRecord } from "../deadletter.js";
import type { RawItem, ScoredItem } from "../../types.js";
import { parseBoolFlag, parsePositiveInt } from "../../env.js";
import type { BuildAgentOptions } from "./adapter.js";
import {
  assertPinnedVersions,
  VersionDriftError,
} from "./version-guard.js";

export { VersionDriftError, assertPinnedVersions } from "./version-guard.js";

// Module-init version check. Any importer of this module gets DA-Un-05
// enforcement for free; there is no opt-out path short of not importing.
assertPinnedVersions();

/**
 * Kept for backwards compatibility with M1 callers that imported this from
 * the scaffolded stub. Throwing this is no longer the happy path —
 * `runDeepAgentCurator` now delegates to the M2 adapter — but the class is
 * retained so any external code that matches against it still type-checks.
 *
 * @deprecated Will be removed with the 14-day legacy sunset (M5).
 */
export class NotYetImplementedError extends Error {
  constructor() {
    super(
      "runDeepAgentCurator is scaffolded but not wired to LangGraph yet. " +
        "See docs/specs/deepagents-migration-decomposition.md §3 M2. " +
        "Fallback: unset CURATOR_BACKEND or set CURATOR_BACKEND=legacy.",
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
  /**
   * Tests inject a mock ChatModel here to exercise the full LangGraph
   * pipeline without touching the Anthropic API. Production never sets
   * this — `adapter.ts` binds `ChatAnthropic` to `MODEL_PIN`. Typed via
   * `BuildAgentOptions["model"]` (BaseChatModel) so a prod caller can't
   * accidentally pass an arbitrary object past the type checker.
   */
  readonly modelOverride?: BuildAgentOptions["model"];
}

/**
 * Public API (DC2a) — stable across LangChain churn. Internals live in
 * `./adapter.ts`. The dynamic import keeps the LangChain module graph
 * out of the factory's fast path; `selectCurator` already gates this
 * module behind `CURATOR_BACKEND=deepagents`, so the extra indirection is
 * cheap.
 */
export async function runDeepAgentCurator(
  items: readonly RawItem[],
  ctx: RunDeepAgentCuratorContext,
): Promise<ScoredItem[]> {
  const cfg = ctx.config ?? DEEPAGENT_DEFAULTS;
  const { runAdapter } = await import("./adapter.js");
  return runAdapter(
    items,
    {
      runId: ctx.runId,
      runDate: ctx.runDate,
      maxIterations: cfg.maxIterations,
    },
    // Test-injection escape hatch. `modelOverride` is typed as
    // `BuildAgentOptions["model"]` (BaseChatModel) so the adapter sees a
    // properly-typed value; in prod this stays undefined.
    ctx.modelOverride
      ? { model: ctx.modelOverride }
      : {},
  );
}

/**
 * Thin class wrapper so the curator factory can hand back an object
 * satisfying the `Curator` interface. `lastMetrics` / `lastSkipped` are
 * wired in M3/M4; in M2 they return the empty defaults.
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
