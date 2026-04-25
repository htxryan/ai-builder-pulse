// Haiku pre-filter stage. Cheap binary keep/drop classifier inserted between
// the heuristic pre-filter and the (expensive) Sonnet curator. Chunked for
// throughput, concurrency-limited, and resilient at every layer:
//
//   - chunk-level fallback: any chunk whose response is missing/malformed
//     is treated as pass-through (all items kept). Other chunks continue.
//   - stage-level fallback: any uncaught throw inside the stage returns
//     `skipped=true` with all input items kept. The orchestrator MUST be
//     able to call this stage and rely on getting items back.
//   - DISABLED short-circuit: HAIKU_PREFILTER_DISABLED=1 bypasses everything
//     before client construction or API key resolution.
//
// Cost is tracked but NOT counted against the Sonnet `CURATOR_MAX_USD`
// ceiling — see docs/spec ai-builder-pulse-9li R18.

import { mapWithConcurrency } from "../collectors/concurrency.js";
import { log } from "../log.js";
import type { RawItem } from "../types.js";
import {
  buildDefaultHaikuClient,
  DEFAULT_HAIKU_MAX_TOKENS,
  type HaikuCallArgs,
  type HaikuCallResult,
  type HaikuClient,
} from "./haikuClient.js";
import {
  HAIKU_SYSTEM_PROMPT,
  resolveHaikuModel,
} from "./prompt.js";
import {
  estimateHaikuUsd,
  resolveHaikuCostRates,
} from "./cost.js";
import type { HaikuRecord } from "./haikuOutputFormat.js";

export type { HaikuClient, HaikuCallArgs, HaikuCallResult, HaikuRecord };
export { HAIKU_MODEL_PIN, resolveHaikuModel } from "./prompt.js";

const DEFAULT_CHUNK_THRESHOLD = 100;
const DEFAULT_CONCURRENCY = 3;

export interface HaikuPreFilterStats {
  readonly inputCount: number;
  readonly keptCount: number;
  readonly droppedCount: number;
  readonly chunkCount: number;
  readonly estimatedUsd: number;
  /**
   * True iff the stage was bypassed (DISABLED env var or stage-level throw).
   * Mirrors `HaikuPreFilterResult.skipped`; carried on stats so downstream
   * consumers (job summary, archive) don't need to plumb the full result.
   */
  readonly skipped: boolean;
}

export interface HaikuPreFilterResult {
  readonly kept: readonly RawItem[];
  readonly dropped: readonly RawItem[];
  readonly stats: HaikuPreFilterStats;
  /** True iff the stage was bypassed (DISABLED env var or stage-level throw). */
  readonly skipped: boolean;
}

export interface ApplyHaikuPreFilterOptions {
  /** Scoped env map. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injected client for tests. Production constructs `AnthropicHaikuClient`. */
  readonly client?: HaikuClient;
  /**
   * Test-only hook: forces the stage to throw before chunking. Used to
   * verify the AC-13 stage-level fallback path without contriving a real
   * synchronous failure. Production callers MUST NOT set this.
   */
  readonly __throwBeforeChunking?: boolean;
}

/**
 * Pre-filter `items` through `claude-haiku-4-5`. Returns a result containing
 * kept/dropped lists, stage stats, and a `skipped` flag.
 *
 * Failure handling:
 *   - DISABLED env var → immediate skip, all items kept, no API calls.
 *   - Per-chunk failure → that chunk's items pass through; other chunks run.
 *   - Stage-level throw → all items kept, `skipped=true`, warning logged.
 *
 * The stage NEVER throws to its caller; the orchestrator can wire it as a
 * non-fatal stage between heuristic pre-filter and Sonnet.
 */
export async function applyHaikuPreFilter(
  items: readonly RawItem[],
  opts: ApplyHaikuPreFilterOptions = {},
): Promise<HaikuPreFilterResult> {
  const env = opts.env ?? process.env;

  // AC-14: DISABLED short-circuit. MUST happen before client construction so
  // the path doesn't require ANTHROPIC_API_KEY.
  if (env["HAIKU_PREFILTER_DISABLED"] === "1") {
    const result = passThrough(items, { skipped: true, chunkCount: 0 });
    log.info("haiku-prefilter complete", {
      inputCount: result.stats.inputCount,
      keptCount: result.stats.keptCount,
      droppedCount: result.stats.droppedCount,
      chunkCount: result.stats.chunkCount,
      estimatedUsd: result.stats.estimatedUsd,
      skipped: true,
      reason: "HAIKU_PREFILTER_DISABLED",
    });
    return result;
  }

  // AC-13: stage-level fallback. Wrap EVERYTHING that could throw — chunking,
  // concurrency, aggregation — in a single try/catch. If anything escapes,
  // pass everything through unmodified so the orchestrator's downstream
  // stages still see the heuristic pre-filter's items.
  try {
    if (opts.__throwBeforeChunking === true) {
      throw new Error("test hook: forced stage-level throw");
    }

    if (items.length === 0) {
      const result = passThrough(items, { skipped: false, chunkCount: 0 });
      log.info("haiku-prefilter complete", {
        inputCount: 0,
        keptCount: 0,
        droppedCount: 0,
        chunkCount: 0,
        estimatedUsd: 0,
        skipped: false,
      });
      return result;
    }

    const chunkThreshold = readPositiveInt(
      env["HAIKU_CHUNK_THRESHOLD"],
      DEFAULT_CHUNK_THRESHOLD,
    );
    const concurrency = readPositiveInt(
      env["HAIKU_CONCURRENCY"],
      DEFAULT_CONCURRENCY,
    );
    const model = resolveHaikuModel(env);
    const rates = resolveHaikuCostRates(env);

    const chunks = chunkItems(items, chunkThreshold);
    const effectiveConcurrency = Math.min(chunks.length, concurrency);

    log.info("haiku-prefilter start", {
      inputCount: items.length,
      chunkCount: chunks.length,
      chunkThreshold,
      concurrency: effectiveConcurrency,
      model,
    });

    // Lazily build the default client only when we know we'll call it.
    // The DISABLED branch above already short-circuited; here we still
    // want to defer to keep the no-items path API-key-free.
    const client = opts.client ?? buildDefaultHaikuClient(env);

    type ChunkOutcome = {
      readonly kept: readonly RawItem[];
      readonly dropped: readonly RawItem[];
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

    const outcomes = await mapWithConcurrency(
      chunks,
      effectiveConcurrency,
      async (chunk, idx): Promise<ChunkOutcome> => {
        try {
          const callResult = await client.call({
            model,
            maxTokens: DEFAULT_HAIKU_MAX_TOKENS,
            systemPrompt: HAIKU_SYSTEM_PROMPT,
            rawItems: chunk,
          });
          const validated = validateChunkResponse(chunk, callResult.records);
          if (validated.kind === "fallback") {
            log.warn("haiku-prefilter chunk fallback (validation)", {
              chunkIdx: idx,
              chunkSize: chunk.length,
              reason: validated.reason,
              ...(validated.unexpectedId !== undefined
                ? { unexpectedId: validated.unexpectedId }
                : {}),
            });
            return {
              kept: chunk,
              dropped: [],
              inputTokens: callResult.inputTokens,
              outputTokens: callResult.outputTokens,
            };
          }
          // validated.kind === "ok": apply keep/drop decisions in input order.
          const kept: RawItem[] = [];
          const dropped: RawItem[] = [];
          for (const item of chunk) {
            const decision = validated.decisions.get(item.id);
            if (decision === false) dropped.push(item);
            else kept.push(item);
          }
          return {
            kept,
            dropped,
            inputTokens: callResult.inputTokens,
            outputTokens: callResult.outputTokens,
          };
        } catch (err) {
          log.warn("haiku-prefilter chunk fallback (api error)", {
            chunkIdx: idx,
            chunkSize: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            kept: chunk,
            dropped: [],
            inputTokens: 0,
            outputTokens: 0,
          };
        }
      },
    );

    const kept: RawItem[] = [];
    const dropped: RawItem[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    for (const outcome of outcomes) {
      kept.push(...outcome.kept);
      dropped.push(...outcome.dropped);
      totalInput += outcome.inputTokens;
      totalOutput += outcome.outputTokens;
    }

    const estimatedUsd = estimateHaikuUsd(totalInput, totalOutput, rates);

    const stats: HaikuPreFilterStats = {
      inputCount: items.length,
      keptCount: kept.length,
      droppedCount: dropped.length,
      chunkCount: chunks.length,
      estimatedUsd,
      skipped: false,
    };

    log.info("haiku-prefilter complete", {
      inputCount: stats.inputCount,
      keptCount: stats.keptCount,
      droppedCount: stats.droppedCount,
      chunkCount: stats.chunkCount,
      estimatedUsd: stats.estimatedUsd,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      model,
      skipped: false,
    });

    return { kept, dropped, stats, skipped: false };
  } catch (err) {
    log.warn("haiku-prefilter stage error — falling back to pass-through", {
      error: err instanceof Error ? err.message : String(err),
      inputCount: items.length,
    });
    const result = passThrough(items, { skipped: true, chunkCount: 0 });
    log.info("haiku-prefilter complete", {
      inputCount: result.stats.inputCount,
      keptCount: result.stats.keptCount,
      droppedCount: result.stats.droppedCount,
      chunkCount: result.stats.chunkCount,
      estimatedUsd: result.stats.estimatedUsd,
      skipped: true,
      reason: "stage-error",
    });
    return result;
  }
}

function passThrough(
  items: readonly RawItem[],
  opts: { readonly skipped: boolean; readonly chunkCount: number },
): HaikuPreFilterResult {
  return {
    kept: items.slice(),
    dropped: [],
    stats: {
      inputCount: items.length,
      keptCount: items.length,
      droppedCount: 0,
      chunkCount: opts.chunkCount,
      estimatedUsd: 0,
      skipped: opts.skipped,
    },
    skipped: opts.skipped,
  };
}

type ChunkValidation =
  | { readonly kind: "ok"; readonly decisions: Map<string, boolean> }
  | {
      readonly kind: "fallback";
      readonly reason: string;
      readonly unexpectedId?: string;
    };

function validateChunkResponse(
  chunk: readonly RawItem[],
  records: readonly HaikuRecord[],
): ChunkValidation {
  // AC-11: too many records. Strict equality keeps the fallback path simple
  // and matches the spec scenario S7 (150 records for 100 input).
  if (records.length !== chunk.length) {
    return {
      kind: "fallback",
      reason: `record count mismatch (expected ${chunk.length}, got ${records.length})`,
    };
  }
  const want = new Set(chunk.map((x) => x.id));
  const decisions = new Map<string, boolean>();
  for (const r of records) {
    // AC-10: hallucinated id.
    if (!want.has(r.id)) {
      return {
        kind: "fallback",
        reason: "unexpected id in chunk response",
        unexpectedId: r.id,
      };
    }
    if (decisions.has(r.id)) {
      return {
        kind: "fallback",
        reason: `duplicate id "${r.id}" in chunk response`,
      };
    }
    decisions.set(r.id, r.keep);
  }
  return { kind: "ok", decisions };
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (size < 1) {
    // Defensive — readPositiveInt should have already coerced this.
    throw new Error(`chunkItems: size must be >= 1, got ${size}`);
  }
  if (items.length <= size) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}
