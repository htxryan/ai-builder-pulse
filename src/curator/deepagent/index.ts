// DeepAgents curator — public surface (DC2a).
//
// M2 wired `runDeepAgentCurator` to the LangGraph + @langchain/anthropic
// adapter. M3 adds the safety-net orchestration around it: chunking, the
// chunk-retry loop, per-run cost aggregation, and `CuratorMetrics`
// population. The public surface (function signature + `DeepAgentCurator`
// class) is the "low volatility" contract per advisor P1-8; LangChain
// churn is contained in `./adapter.ts`.
//
// Invariants in force here:
//   - Version guard (DA-Un-05) runs at module init — importing this file
//     asserts the pinned versions before any curator call can happen.
//   - DA-U-11 / DA-E-06 : cost ceiling — per-chunk ceiling is passed to the
//                         adapter; per-run ceiling is re-checked after all
//                         chunks aggregate. `CostCeilingError` is NOT
//                         retried in either path.
//   - DA-U-12 / DA-E-05 : chunk retry — transient failures (LangGraph
//                         recursion errors, schema/count drift) retry up
//                         to `maxChunkRetries` before surfacing. The retry
//                         whitelist explicitly EXCLUDES `CostCeilingError`.
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
import type { RawItem, ScoredItem, Source } from "../../types.js";
import { parseBoolFlag, parsePositiveInt, parsePositiveNumber } from "../../env.js";
import { log } from "../../log.js";
import {
  CostCeilingError,
  chunkItems,
} from "../claudeCurator.js";
import { PROMPT_VERSION, resolveCuratorModel } from "../prompt.js";
import {
  estimateUsd,
  DEFAULT_INPUT_COST_PER_MTOK,
  DEFAULT_OUTPUT_COST_PER_MTOK,
} from "../costModel.js";
import type { BuildAgentOptions, ChunkUsage } from "./adapter.js";
import { DEFAULT_TOOL_BUDGET } from "./adapter.js";
import {
  assertPinnedVersions,
  VersionDriftError,
} from "./version-guard.js";

export { VersionDriftError, assertPinnedVersions } from "./version-guard.js";

// Module-init version check. Any importer of this module gets DA-Un-05
// enforcement for free; there is no opt-out path short of not importing.
assertPinnedVersions();

/**
 * DA-Un-08 / DA-O-03 — LangSmith opt-in gate.
 *
 * LangChain's `isTracingEnabled()` (see `@langchain/core/utils/callbacks`) ORs
 * four env vars: `LANGSMITH_TRACING_V2`, `LANGCHAIN_TRACING_V2`,
 * `LANGSMITH_TRACING`, `LANGCHAIN_TRACING`. All four must be handled or the
 * gate is trivially bypassable.
 *
 * Rules:
 *   - `enableLangsmith=true` → emit an operator-visible ::warning:: making the
 *     data-egress explicit, then set `LANGSMITH_TRACING=true` +
 *     `LANGCHAIN_TRACING_V2=true` so the single opt-in flag activates tracing
 *     without a separate operator action. If `LANGSMITH_API_KEY` is missing,
 *     warn again — LangChain will silently no-op uploads otherwise.
 *   - `enableLangsmith=false` → force all four tracing flags to `"false"` so
 *     the presence of `LANGSMITH_API_KEY` alone cannot auto-activate cloud
 *     tracing. Silent by design.
 *
 * Mutates the supplied `env` object so the scrub takes effect before the
 * adapter imports `@langchain/*`. Callers pass `process.env` in production;
 * tests inject a detached object so assertions don't leak across files.
 */
export function applyLangsmithGate(
  cfg: Pick<DeepAgentConfig, "enableLangsmith">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cfg.enableLangsmith) {
    log.warn(
      "LangSmith tracing enabled — pre-publication content sent to LangSmith cloud",
      { optIn: "DEEPAGENT_ENABLE_LANGSMITH=1" },
    );
    env.LANGSMITH_TRACING = "true";
    env.LANGCHAIN_TRACING_V2 = "true";
    if (!env.LANGSMITH_API_KEY) {
      log.warn(
        "LangSmith opt-in requested but LANGSMITH_API_KEY is unset — tracing will no-op",
        { optIn: "DEEPAGENT_ENABLE_LANGSMITH=1" },
      );
    }
    return;
  }
  env.LANGSMITH_TRACING = "false";
  env.LANGSMITH_TRACING_V2 = "false";
  env.LANGCHAIN_TRACING = "false";
  env.LANGCHAIN_TRACING_V2 = "false";
}

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
  /** Chunk size for curation batches. Shared default with legacy curator. */
  readonly chunkThreshold: number;
  /** DA-U-11 — per-run USD ceiling. Per-chunk is `maxUsd / chunkCount * 2`. */
  readonly maxUsd: number;
  /** Claude input cost per 1M tokens. */
  readonly inputCostPerMTok: number;
  /** Claude output cost per 1M tokens. */
  readonly outputCostPerMTok: number;
}

export const DEEPAGENT_DEFAULTS: DeepAgentConfig = {
  maxIterations: 6,
  toolBudget: DEFAULT_TOOL_BUDGET,
  maxChunkRetries: 3,
  maxConcurrentChunks: 1,
  enableLangsmith: false,
  auditToFile: false,
  chunkThreshold: 50,
  maxUsd: 1.0,
  inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
  outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
};

/**
 * Parse DEEPAGENT_* env vars into a validated config. Throws on malformed
 * values so an operator typo can't silently bypass a safety limit.
 *
 * `chunkThreshold` and `maxUsd` share the `CURATOR_CHUNK_THRESHOLD` /
 * `CURATOR_MAX_USD` env vars with the legacy ClaudeCurator path — an
 * operator's existing runbooks keep working when they flip the backend.
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
    chunkThreshold: parsePositiveInt(
      env.CURATOR_CHUNK_THRESHOLD,
      DEEPAGENT_DEFAULTS.chunkThreshold,
      "CURATOR_CHUNK_THRESHOLD",
    ),
    maxUsd: parsePositiveNumber(
      env.CURATOR_MAX_USD,
      DEEPAGENT_DEFAULTS.maxUsd,
      "CURATOR_MAX_USD",
    ),
    inputCostPerMTok: DEEPAGENT_DEFAULTS.inputCostPerMTok,
    outputCostPerMTok: DEEPAGENT_DEFAULTS.outputCostPerMTok,
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
  /**
   * Tests may inject a factory that returns a *fresh* model per chunk —
   * needed for the multi-chunk cache-preservation test where each chunk
   * consumes a different queued response. Production ignores this.
   */
  readonly modelFactory?: (chunkIdx: number) => BuildAgentOptions["model"];
}

/**
 * Decide whether a caught error is safe to retry. DA-E-06 is explicit that
 * `CostCeilingError` is NEVER retried — retrying a cost overrun just burns
 * more budget on the same regression. Everything else is treated as
 * transient (LangGraph recursion-limit, zod drift, count-invariant flutter)
 * and eligible for the next attempt, modulo `maxChunkRetries`.
 */
function isRetryableChunkError(err: unknown): boolean {
  if (err instanceof CostCeilingError) return false;
  return true;
}

/**
 * Public API (DC2a) — stable across LangChain churn. Internals live in
 * `./adapter.ts` + this module's chunk/retry driver. The dynamic import
 * keeps the LangChain module graph out of the factory's fast path;
 * `selectCurator` already gates this module behind
 * `CURATOR_BACKEND=deepagents`, so the extra indirection is cheap.
 *
 * Returns only the merged `ScoredItem[]` — the stable M2 public surface.
 * `DeepAgentCurator.curate()` uses the sibling `runDeepAgentCuratorInternal`
 * to access the per-run `CuratorMetrics` for `lastMetrics()`.
 */
export async function runDeepAgentCurator(
  items: readonly RawItem[],
  ctx: RunDeepAgentCuratorContext,
): Promise<ScoredItem[]> {
  const { scored } = await runDeepAgentCuratorInternal(items, ctx);
  return scored;
}

/**
 * Internal variant that additionally returns `CuratorMetrics` and the
 * merge-time deadletter. Exported (not just module-private) so the
 * `DeepAgentCurator` class and the M3 test file can read the extra data
 * without the public `ScoredItem[]` signature changing. The signature here
 * is NOT a stability contract — callers outside this module should bind to
 * `runDeepAgentCurator` or `DeepAgentCurator.curate` + `lastMetrics()`.
 */
export async function runDeepAgentCuratorInternal(
  items: readonly RawItem[],
  ctx: RunDeepAgentCuratorContext,
): Promise<{
  scored: ScoredItem[];
  metrics: CuratorMetrics | undefined;
  skipped: readonly SkippedItemRecord[];
}> {
  const cfg = ctx.config ?? DEEPAGENT_DEFAULTS;
  if (items.length === 0) {
    return { scored: [], metrics: undefined, skipped: [] };
  }

  // DA-Un-08 — apply the opt-in gate BEFORE the adapter pulls @langchain/*.
  // Scrubbing `LANGSMITH_TRACING` after LangChain's tracer initializes is
  // too late; doing it here closes the window.
  applyLangsmithGate(cfg);

  const { runAdapterChunk } = await import("./adapter.js");
  const chunks = chunkItems(items as RawItem[], cfg.chunkThreshold);
  // Per-chunk budget share × 2 — mirrors ClaudeCurator so the same
  // operator-facing CURATOR_MAX_USD knob behaves identically across backends.
  const perChunkCeilingUsd = (cfg.maxUsd / chunks.length) * 2;
  const costRates = {
    inputCostPerMTok: cfg.inputCostPerMTok,
    outputCostPerMTok: cfg.outputCostPerMTok,
  };

  log.info("deepagent curator start", {
    runId: ctx.runId,
    runDate: ctx.runDate,
    totalItems: items.length,
    chunkCount: chunks.length,
    chunkThreshold: cfg.chunkThreshold,
    maxUsd: cfg.maxUsd,
    perChunkCeilingUsd: Number(perChunkCeilingUsd.toFixed(4)),
    maxChunkRetries: cfg.maxChunkRetries,
    promptVersion: PROMPT_VERSION,
  });

  // Per-source apportionment. Same approximation as ClaudeCurator: weight
  // per-chunk usage by the item-count fraction each source contributed.
  const inputTokensPerSource: Partial<Record<Source, number>> = {};
  const outputTokensPerSource: Partial<Record<Source, number>> = {};

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  const allScored: ScoredItem[] = [];
  const allSkipped: SkippedItemRecord[] = [];

  // DA-O-02: default maxConcurrentChunks=1 for M3 — prompt caching prefers
  // sequential chunks (cache creates on chunk 0, reads on chunks 1..N).
  // Running chunks in parallel would multi-create the same cache prefix and
  // defeat DA-U-09. M4 can revisit once tool calls make the per-chunk
  // latency dominant over cache-creation cost.
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const chunkIdx = i;
    const { scored, usage, skipped } = await runChunkWithRetry(
      chunk,
      chunkIdx,
      cfg,
      ctx,
      perChunkCeilingUsd,
      costRates,
      runAdapterChunk,
    );

    totalInput += usage.inputTokens;
    totalOutput += usage.outputTokens;
    totalCacheRead += usage.cacheReadInputTokens;
    totalCacheCreation += usage.cacheCreationInputTokens;
    if (skipped.length > 0) allSkipped.push(...skipped);

    // Apportion per-source.
    const srcCounts: Partial<Record<Source, number>> = {};
    for (const item of chunk) {
      srcCounts[item.source] = (srcCounts[item.source] ?? 0) + 1;
    }
    for (const [src, count] of Object.entries(srcCounts) as [
      Source,
      number,
    ][]) {
      const share = count / chunk.length;
      inputTokensPerSource[src] =
        (inputTokensPerSource[src] ?? 0) + usage.inputTokens * share;
      outputTokensPerSource[src] =
        (outputTokensPerSource[src] ?? 0) + usage.outputTokens * share;
    }

    allScored.push(...scored);
  }

  // DA-U-11 — per-run cost re-check. The per-chunk ceiling (maxUsd/n*2) is a
  // 2× buffer; a sum of chunks each at 1.5× their share still exceeds the
  // run budget and must fail loudly even though no single chunk tripped.
  const totalEstUsd = estimateUsd(totalInput, totalOutput, costRates);
  if (totalEstUsd > cfg.maxUsd) {
    log.error("deepagent cost ceiling exceeded (total)", {
      estimatedUsd: totalEstUsd,
      maxUsd: cfg.maxUsd,
    });
    throw new CostCeilingError(totalEstUsd, cfg.maxUsd, "total");
  }

  const tokensPerSource: Partial<Record<Source, number>> = {};
  const costPerSource: Partial<Record<Source, number>> = {};
  for (const src of Object.keys(inputTokensPerSource) as Source[]) {
    const inTok = inputTokensPerSource[src] ?? 0;
    const outTok = outputTokensPerSource[src] ?? 0;
    tokensPerSource[src] = Math.round(inTok + outTok);
    costPerSource[src] = estimateUsd(inTok, outTok, costRates);
  }

  const sawCacheTelemetry = totalCacheRead > 0 || totalCacheCreation > 0;
  const metrics: CuratorMetrics = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    estimatedUsd: totalEstUsd,
    ...(sawCacheTelemetry
      ? {
          cacheReadInputTokens: totalCacheRead,
          cacheCreationInputTokens: totalCacheCreation,
        }
      : {}),
    ...(Object.keys(tokensPerSource).length > 0
      ? { tokensPerSource, costPerSource }
      : {}),
    model: resolveCuratorModel(),
    promptVersion: PROMPT_VERSION,
    chunkCount: chunks.length,
    maxUsd: cfg.maxUsd,
  };

  log.info("deepagent curator done", {
    runId: ctx.runId,
    totalItems: items.length,
    chunkCount: chunks.length,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadInputTokens: sawCacheTelemetry ? totalCacheRead : undefined,
    cacheCreationInputTokens: sawCacheTelemetry ? totalCacheCreation : undefined,
    estimatedUsd: totalEstUsd,
    maxUsd: cfg.maxUsd,
    promptVersion: PROMPT_VERSION,
  });

  return { scored: allScored, metrics, skipped: allSkipped };
}

/**
 * DA-E-05 / DA-U-12 — retry a single chunk up to `maxChunkRetries` times.
 * `CostCeilingError` short-circuits the loop (never retried); every other
 * thrown error is treated as transient and re-attempted until the budget
 * is exhausted. The final surfaced error is the last attempt's error —
 * preserving the orchestrator's existing "what failed last" log surface.
 */
async function runChunkWithRetry(
  chunk: readonly RawItem[],
  chunkIdx: number,
  cfg: DeepAgentConfig,
  ctx: RunDeepAgentCuratorContext,
  perChunkCeilingUsd: number,
  costRates: { inputCostPerMTok: number; outputCostPerMTok: number },
  runAdapterChunk: (typeof import("./adapter.js"))["runAdapterChunk"],
): Promise<{
  scored: readonly ScoredItem[];
  usage: ChunkUsage;
  skipped: readonly SkippedItemRecord[];
}> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxChunkRetries; attempt += 1) {
    try {
      const factoryModel = ctx.modelFactory
        ? ctx.modelFactory(chunkIdx)
        : undefined;
      const modelForChunk = factoryModel ?? ctx.modelOverride;
      const overrides: BuildAgentOptions = modelForChunk
        ? { model: modelForChunk }
        : {};
      const result = await runAdapterChunk(
        chunk,
        {
          runId: ctx.runId,
          runDate: ctx.runDate,
          chunkIdx,
          maxIterations: cfg.maxIterations,
          perChunkCeilingUsd,
          costRates,
          toolBudget: cfg.toolBudget,
          auditToFile: cfg.auditToFile,
        },
        overrides,
      );
      return {
        scored: result.scored,
        usage: result.usage,
        skipped: result.skipped,
      };
    } catch (err) {
      if (!isRetryableChunkError(err)) throw err;
      lastErr = err;
      log.warn("deepagent chunk attempt failed", {
        chunkIdx,
        attempt,
        maxChunkRetries: cfg.maxChunkRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt >= cfg.maxChunkRetries) break;
    }
  }
  log.error("deepagent chunk exhausted retries (DA-E-05)", {
    chunkIdx,
    attempts: cfg.maxChunkRetries,
  });
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`deepagent chunk ${chunkIdx} failed after retries`);
}

/**
 * Thin class wrapper so the curator factory can hand back an object
 * satisfying the `Curator` interface. M3 populates `lastMetrics` and
 * `lastSkipped` (the merge-time deadletter — items that the count-invariant
 * accepted but `ScoredItemSchema` rejected at merge time, mirroring
 * `ClaudeCurator`).
 */
export class DeepAgentCurator implements Curator {
  private _lastMetrics: CuratorMetrics | undefined;
  private _lastSkipped: readonly SkippedItemRecord[] = [];

  constructor(
    private readonly runCtx: RunDeepAgentCuratorContext,
  ) {}

  async curate(items: RawItem[]): Promise<ScoredItem[]> {
    const { scored, metrics, skipped } = await runDeepAgentCuratorInternal(
      items,
      this.runCtx,
    );
    this._lastMetrics = metrics;
    this._lastSkipped = skipped;
    return scored;
  }

  lastMetrics(): CuratorMetrics | undefined {
    return this._lastMetrics;
  }

  lastSkipped(): readonly SkippedItemRecord[] {
    return this._lastSkipped;
  }
}
