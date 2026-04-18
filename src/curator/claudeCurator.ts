// E4 ClaudeCurator — chunks, retries, and enforces the E-05 count invariant
// around a pluggable curation client. The client is a minimal interface so
// tests can swap in a deterministic mock without touching the network.

import { z } from "zod";
import { log } from "../log.js";
import type { Curator } from "./mockCurator.js";
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
  // prod model is pinned. Used only for cost logging; does not affect the
  // curation outcome.
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  // Override the system prompt (tests). Defaults to the versioned artifact.
  readonly systemPrompt?: string;
}

const DEFAULT_CHUNK_THRESHOLD = 50;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INPUT_COST = 3.0;
const DEFAULT_OUTPUT_COST = 15.0;

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

export class ClaudeCurator implements Curator {
  private readonly client: CurationClient;
  private readonly chunkThreshold: number;
  private readonly maxRetries: number;
  private readonly inputCostPerMTok: number;
  private readonly outputCostPerMTok: number;
  private readonly systemPrompt: string;

  constructor(opts: ClaudeCuratorOptions) {
    this.client = opts.client;
    this.chunkThreshold = opts.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.inputCostPerMTok = opts.inputCostPerMTok ?? DEFAULT_INPUT_COST;
    this.outputCostPerMTok = opts.outputCostPerMTok ?? DEFAULT_OUTPUT_COST;
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
  }

  async curate(items: RawItem[]): Promise<ScoredItem[]> {
    if (items.length === 0) return [];

    const chunks = chunkItems(items, this.chunkThreshold);
    log.info("curator start", {
      totalItems: items.length,
      chunkCount: chunks.length,
      chunkThreshold: this.chunkThreshold,
      promptVersion: PROMPT_VERSION,
    });

    const results = await Promise.all(
      chunks.map((chunk, idx) => this.callWithRetry(chunk, idx)),
    );

    let totalInput = 0;
    let totalOutput = 0;
    const recordsById = new Map<string, CurationRecord>();
    for (const r of results) {
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      for (const rec of r.records) {
        if (recordsById.has(rec.id)) {
          throw new Error(
            `ClaudeCurator merge conflict: duplicate id "${rec.id}" across chunks`,
          );
        }
        recordsById.set(rec.id, rec);
      }
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

    const estUsd =
      (totalInput / 1_000_000) * this.inputCostPerMTok +
      (totalOutput / 1_000_000) * this.outputCostPerMTok;
    log.info("curator done", {
      totalItems: items.length,
      chunkCount: chunks.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      estimatedUsd: Number(estUsd.toFixed(4)),
      promptVersion: PROMPT_VERSION,
    });

    return scored;
  }

  private async callWithRetry(
    chunk: readonly RawItem[],
    chunkIdx: number,
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
        return { ...result, records };
      } catch (err) {
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
