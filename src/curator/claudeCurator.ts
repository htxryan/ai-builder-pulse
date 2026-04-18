// E4 ClaudeCurator — chunks, retries, and enforces the E-05 count invariant
// around a pluggable curation client. The client is a minimal interface so
// tests can swap in a deterministic mock without touching the network.

import { z } from "zod";
import { mapWithConcurrency } from "../collectors/concurrency.js";
import { log } from "../log.js";
import type { Curator, CuratorMetrics } from "./mockCurator.js";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";
import type { RawItem, ScoredItem } from "../types.js";
import { CategorySchema, ScoredItemSchema } from "../types.js";

export const CurationRecordSchema = z.object({
  id: z.string().min(1),
  category: CategorySchema,
  relevanceScore: z.number().min(0).max(1),
  keep: z.boolean(),
  description: z.string().min(1).max(600),
});
export type CurationRecord = z.infer<typeof CurationRecordSchema>;

export const CurationResponseSchema = z.object({
  items: z.array(CurationRecordSchema),
});
export type CurationResponse = z.infer<typeof CurationResponseSchema>;

export interface CurationCallResult {
  readonly records: readonly CurationRecord[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  // Optional cache telemetry. Only the real Anthropic client populates.
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

// The Curator calls this. Implementations enforce their own I/O policy;
// ClaudeCurator provides retry/merge/validation around the call.
export interface CurationClient {
  call(args: {
    systemPrompt: string;
    rawItems: readonly RawItem[];
  }): Promise<CurationCallResult>;
}

export interface ClaudeCuratorOptions {
  readonly client: CurationClient;
  readonly chunkThreshold?: number;
  readonly maxRetries?: number;
  // Per-1M-token cost in USD. Defaults are placeholders — update when the
  // prod model is pinned. Used for cost logging AND the cost-ceiling check.
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  // Hard cost ceiling in USD for a single `curate()` run. If ANY chunk's
  // estimated cost exceeds `maxUsd / chunkCount * 2` (a 2× budget-share
  // buffer), the run aborts with CostCeilingError. Total cost is also
  // checked against `maxUsd` after all chunks return. Prevents a prompt
  // regression or pricing change from silently doubling spend.
  readonly maxUsd?: number;
  // Cap on concurrent chunk calls. Defaults to 3 — protects against
  // Anthropic rate limits on large-batch days (HN spike). Ignored when
  // chunk count is lower.
  readonly maxChunkConcurrency?: number;
  // Override the system prompt (tests). Defaults to the versioned artifact.
  readonly systemPrompt?: string;
}

const DEFAULT_CHUNK_THRESHOLD = 50;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INPUT_COST = 3.0;
const DEFAULT_OUTPUT_COST = 15.0;
const DEFAULT_MAX_USD = 1.0;
const DEFAULT_MAX_CHUNK_CONCURRENCY = 3;

export class CountInvariantError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `E-05 count invariant violated: expected ${expected} records, got ${actual}`,
    );
    this.name = "CountInvariantError";
  }
}

export class CostCeilingError extends Error {
  constructor(
    public readonly estimatedUsd: number,
    public readonly maxUsd: number,
    public readonly scope: "chunk" | "total",
    public readonly chunkIdx?: number,
  ) {
    super(
      `Cost ceiling exceeded (${scope}${chunkIdx !== undefined ? ` idx=${chunkIdx}` : ""}): estimated $${estimatedUsd.toFixed(4)} > $${maxUsd.toFixed(4)}`,
    );
    this.name = "CostCeilingError";
  }
}

export class ClaudeCurator implements Curator {
  private readonly client: CurationClient;
  private readonly chunkThreshold: number;
  private readonly maxRetries: number;
  private readonly inputCostPerMTok: number;
  private readonly outputCostPerMTok: number;
  private readonly maxUsd: number;
  private readonly maxChunkConcurrency: number;
  private readonly systemPrompt: string;
  private _lastMetrics: CuratorMetrics | undefined;

  constructor(opts: ClaudeCuratorOptions) {
    this.client = opts.client;
    this.chunkThreshold = opts.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.inputCostPerMTok = opts.inputCostPerMTok ?? DEFAULT_INPUT_COST;
    this.outputCostPerMTok = opts.outputCostPerMTok ?? DEFAULT_OUTPUT_COST;
    this.maxUsd = opts.maxUsd ?? DEFAULT_MAX_USD;
    this.maxChunkConcurrency =
      opts.maxChunkConcurrency ?? DEFAULT_MAX_CHUNK_CONCURRENCY;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
    if (!Number.isInteger(this.chunkThreshold) || this.chunkThreshold < 1) {
      throw new Error(
        `ClaudeCurator: chunkThreshold must be positive integer, got ${this.chunkThreshold}`,
      );
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 1) {
      throw new Error(
        `ClaudeCurator: maxRetries must be positive integer, got ${this.maxRetries}`,
      );
    }
    if (!(this.maxUsd > 0)) {
      throw new Error(
        `ClaudeCurator: maxUsd must be > 0, got ${this.maxUsd}`,
      );
    }
    if (
      !Number.isInteger(this.maxChunkConcurrency) ||
      this.maxChunkConcurrency < 1
    ) {
      throw new Error(
        `ClaudeCurator: maxChunkConcurrency must be positive integer, got ${this.maxChunkConcurrency}`,
      );
    }
  }

  async curate(items: RawItem[]): Promise<ScoredItem[]> {
    if (items.length === 0) return [];

    const chunks = chunkItems(items, this.chunkThreshold);
    const concurrency = Math.min(chunks.length, this.maxChunkConcurrency);
    // Per-chunk budget share × 2 — a single chunk that's >2× its fair share
    // of the total budget is a red flag (prompt doubled, context leak, etc.)
    // and the run should abort before merging.
    const perChunkCeiling = (this.maxUsd / chunks.length) * 2;
    log.info("curator start", {
      totalItems: items.length,
      chunkCount: chunks.length,
      chunkThreshold: this.chunkThreshold,
      concurrency,
      maxUsd: this.maxUsd,
      perChunkCeilingUsd: Number(perChunkCeiling.toFixed(4)),
      promptVersion: PROMPT_VERSION,
    });

    const results = await mapWithConcurrency(chunks, concurrency, (chunk, idx) =>
      this.callWithRetry(chunk, idx, perChunkCeiling),
    );

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;
    let sawCacheTelemetry = false;
    const recordsById = new Map<string, CurationRecord>();
    for (const r of results) {
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      if (r.cacheReadInputTokens !== undefined) {
        sawCacheTelemetry = true;
        totalCacheRead += r.cacheReadInputTokens;
      }
      if (r.cacheCreationInputTokens !== undefined) {
        sawCacheTelemetry = true;
        totalCacheCreation += r.cacheCreationInputTokens;
      }
      for (const rec of r.records) {
        if (recordsById.has(rec.id)) {
          throw new Error(
            `ClaudeCurator merge conflict: duplicate id "${rec.id}" across chunks`,
          );
        }
        recordsById.set(rec.id, rec);
      }
    }

    // Total cost check — catches the case where individual chunks all slip
    // under the per-chunk ceiling but their sum still exceeds the run budget.
    const totalEstUsd = this.estimateUsd(totalInput, totalOutput);
    if (totalEstUsd > this.maxUsd) {
      log.error("cost ceiling exceeded (total)", {
        estimatedUsd: totalEstUsd,
        maxUsd: this.maxUsd,
      });
      throw new CostCeilingError(totalEstUsd, this.maxUsd, "total");
    }

    if (recordsById.size !== items.length) {
      throw new CountInvariantError(items.length, recordsById.size);
    }

    const scored: ScoredItem[] = [];
    for (const raw of items) {
      const rec = recordsById.get(raw.id);
      if (!rec) {
        throw new CountInvariantError(items.length, recordsById.size);
      }
      scored.push(
        ScoredItemSchema.parse({
          ...raw,
          category: rec.category,
          relevanceScore: rec.relevanceScore,
          keep: rec.keep,
          description: rec.description,
        }),
      );
    }

    this._lastMetrics = {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      estimatedUsd: totalEstUsd,
      ...(sawCacheTelemetry
        ? {
            cacheReadInputTokens: totalCacheRead,
            cacheCreationInputTokens: totalCacheCreation,
          }
        : {}),
    };
    log.info("curator done", {
      totalItems: items.length,
      chunkCount: chunks.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadInputTokens: sawCacheTelemetry ? totalCacheRead : undefined,
      cacheCreationInputTokens: sawCacheTelemetry
        ? totalCacheCreation
        : undefined,
      estimatedUsd: totalEstUsd,
      maxUsd: this.maxUsd,
      promptVersion: PROMPT_VERSION,
    });

    return scored;
  }

  lastMetrics(): CuratorMetrics | undefined {
    return this._lastMetrics;
  }

  private estimateUsd(inputTokens: number, outputTokens: number): number {
    return Number(
      (
        (inputTokens / 1_000_000) * this.inputCostPerMTok +
        (outputTokens / 1_000_000) * this.outputCostPerMTok
      ).toFixed(4),
    );
  }

  private async callWithRetry(
    chunk: readonly RawItem[],
    chunkIdx: number,
    perChunkCeiling: number,
  ): Promise<CurationCallResult> {
    const expected = chunk.length;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.client.call({
          systemPrompt: this.systemPrompt,
          rawItems: chunk,
        });
        // Validate record shape defensively; the real client already runs
        // Zod parse via structured output, but a mock may not.
        const records = result.records.map((r) =>
          CurationRecordSchema.parse(r),
        );
        // E-05 per-chunk enforcement — we MUST see exactly the ids we sent,
        // with no extras and no drops, before merging.
        assertChunkIds(chunk, records);
        // Cost ceiling — a single chunk that > 2× its fair share of the
        // total budget signals a regression (prompt drift, cost spike) and
        // must fail loudly instead of silently compounding across chunks.
        const chunkUsd = this.estimateUsd(
          result.inputTokens,
          result.outputTokens,
        );
        if (chunkUsd > perChunkCeiling) {
          log.error("cost ceiling exceeded (chunk)", {
            chunkIdx,
            estimatedUsd: chunkUsd,
            perChunkCeilingUsd: Number(perChunkCeiling.toFixed(4)),
            maxUsd: this.maxUsd,
          });
          throw new CostCeilingError(
            chunkUsd,
            perChunkCeiling,
            "chunk",
            chunkIdx,
          );
        }
        return { ...result, records };
      } catch (err) {
        // CostCeilingError is a hard-fail — do not retry. Retrying a cost
        // overrun just burns more budget on the same regression.
        if (err instanceof CostCeilingError) throw err;
        lastErr = err;
        log.warn("curator chunk attempt failed", {
          chunkIdx,
          attempt,
          maxRetries: this.maxRetries,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt >= this.maxRetries) break;
      }
    }
    log.error("curator chunk exhausted retries (Un-05)", {
      chunkIdx,
      attempts: this.maxRetries,
      expected,
    });
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`curator chunk ${chunkIdx} failed after retries`);
  }
}

export function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (items.length <= size) return [items.slice() as T[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}

function assertChunkIds(
  chunk: readonly RawItem[],
  records: readonly CurationRecord[],
): void {
  if (records.length !== chunk.length) {
    throw new CountInvariantError(chunk.length, records.length);
  }
  const want = new Set(chunk.map((x) => x.id));
  const seen = new Set<string>();
  for (const r of records) {
    if (!want.has(r.id)) {
      throw new Error(
        `curator response contained unexpected id "${r.id}" not in chunk input`,
      );
    }
    if (seen.has(r.id)) {
      throw new Error(`curator response contained duplicate id "${r.id}"`);
    }
    seen.add(r.id);
  }
}
