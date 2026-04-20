// E4 ClaudeCurator — chunks, retries, and enforces the E-05 count invariant
// around a pluggable curation client. The client is a minimal interface so
// tests can swap in a deterministic mock without touching the network.

import { z } from "zod";
import { mapWithConcurrency } from "../collectors/concurrency.js";
import { OrchestratorStageError } from "../errors.js";
import { log } from "../log.js";
import type { Curator, CuratorMetrics } from "./mockCurator.js";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";
import {
  DEFAULT_INPUT_COST_PER_MTOK,
  DEFAULT_OUTPUT_COST_PER_MTOK,
  estimateUsd as sharedEstimateUsd,
} from "./costModel.js";
import type { RawItem, ScoredItem, Source } from "../types.js";
import { CategorySchema, ScoredItemSchema } from "../types.js";
import type { SkippedItemRecord } from "./deadletter.js";

// If you change any constraint here (min/max/length), mirror it in
// `src/curator/curationOutputFormat.ts` — the hand-authored JSON Schema
// sent over the wire is asserted against these in
// `tests/curator/curationOutputFormat.test.ts`.
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
    // Retry-mitigation hints populated by ClaudeCurator.callWithRetry when a
    // prior attempt produced an UnexpectedRecordIdError on this chunk. Real
    // clients MUST honor these on the next attempt; mocks may safely ignore.
    //
    // disableCache=true ⇒ drop `cache_control` on the system prompt for this
    // call. Why: the prod 2026-04-19 hallucination pattern (chunk 9 returning
    // `hn-47821814` on all 3 retries) is consistent with prompt-cache bleed
    // where a prior chunk's ids leak into the current response.
    //
    // extraUserMessage ⇒ appended as a trailing user-turn line that
    // re-enumerates the valid id set verbatim. Why: forces the model to
    // re-ground on the input set instead of copying from cached context.
    readonly disableCache?: boolean;
    readonly extraUserMessage?: string;
  }): Promise<CurationCallResult>;
  // Optional — identifies the pinned model this client targets. Surfaced
  // through `CuratorMetrics.model` so the operator job summary can show what
  // actually ran. Tests with a hand-rolled client may omit it.
  readonly model?: string;
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
const DEFAULT_MAX_USD = 1.0;
const DEFAULT_MAX_CHUNK_CONCURRENCY = 3;

export class CountInvariantError extends OrchestratorStageError {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `E-05 count invariant violated: expected ${expected} records, got ${actual}`,
      { stage: "curate", retryable: false },
    );
    this.name = "CountInvariantError";
  }
}

// Model returned a record whose id is not in the chunk's input set. Thrown
// by `assertChunkIds` and caught by `callWithRetry` — the retry loop branches
// on this class to apply mitigation (see CurationClient.disableCache /
// extraUserMessage) instead of burning a naive retry on an identical prompt.
// The 2026-04-19 prod incident (chunk 9 reproducibly returned `hn-47821814`
// on all 3 retries) is the canonical case this class exists to remediate.
export class UnexpectedRecordIdError extends OrchestratorStageError {
  constructor(
    public readonly unexpectedId: string,
    public readonly chunkIdx?: number,
  ) {
    super(
      `curator response contained unexpected id "${unexpectedId}" not in chunk input`,
      { stage: "curate", retryable: true },
    );
    this.name = "UnexpectedRecordIdError";
  }
}

// Fail-fast terminal state for a chunk whose model response keeps returning
// the SAME hallucinated id across consecutive mitigated retries. Distinct
// from a plain retry exhaustion so the operator can tell "model is broken
// on this chunk" apart from "transient network/JSON error." The acceptance
// criteria on ai-builder-pulse-gwv explicitly call this out.
export class CuratorHallucinationCircuitBreakerError extends OrchestratorStageError {
  constructor(
    public readonly unexpectedId: string,
    public readonly chunkIdx: number,
    public readonly attempts: number,
  ) {
    super(
      `curator hallucination circuit breaker tripped: id "${unexpectedId}" repeated on chunk ${chunkIdx} across ${attempts} attempts — aborting to save budget`,
      { stage: "curate", retryable: false },
    );
    this.name = "CuratorHallucinationCircuitBreakerError";
  }
}

export class CostCeilingError extends OrchestratorStageError {
  constructor(
    public readonly estimatedUsd: number,
    public readonly maxUsd: number,
    public readonly scope: "chunk" | "total",
    public readonly chunkIdx?: number,
  ) {
    super(
      `Cost ceiling exceeded (${scope}${chunkIdx !== undefined ? ` idx=${chunkIdx}` : ""}): estimated $${estimatedUsd.toFixed(4)} > $${maxUsd.toFixed(4)}`,
      { stage: "curate", retryable: false },
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
  private _lastSkipped: SkippedItemRecord[] = [];

  constructor(opts: ClaudeCuratorOptions) {
    this.client = opts.client;
    this.chunkThreshold = opts.chunkThreshold ?? DEFAULT_CHUNK_THRESHOLD;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.inputCostPerMTok = opts.inputCostPerMTok ?? DEFAULT_INPUT_COST_PER_MTOK;
    this.outputCostPerMTok =
      opts.outputCostPerMTok ?? DEFAULT_OUTPUT_COST_PER_MTOK;
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
    this._lastSkipped = [];
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
    // Per-source apportionment. For each chunk we weight input/output tokens
    // by the share of the chunk's items that came from each source. The
    // approximation loses fidelity when items have very different body sizes
    // but is accurate enough for "which source is driving cost" triage.
    const tokensPerSource: Partial<Record<Source, number>> = {};
    const inputTokensPerSource: Partial<Record<Source, number>> = {};
    const outputTokensPerSource: Partial<Record<Source, number>> = {};
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i]!;
      const chunk = chunks[i]!;
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
      // Source composition of this chunk.
      const srcCounts: Partial<Record<Source, number>> = {};
      for (const item of chunk) {
        srcCounts[item.source] = (srcCounts[item.source] ?? 0) + 1;
      }
      const chunkSize = chunk.length;
      if (chunkSize > 0) {
        for (const [src, count] of Object.entries(srcCounts) as [
          Source,
          number,
        ][]) {
          const share = count / chunkSize;
          const inShare = r.inputTokens * share;
          const outShare = r.outputTokens * share;
          inputTokensPerSource[src] = (inputTokensPerSource[src] ?? 0) + inShare;
          outputTokensPerSource[src] =
            (outputTokensPerSource[src] ?? 0) + outShare;
          tokensPerSource[src] =
            (tokensPerSource[src] ?? 0) + inShare + outShare;
        }
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
    const costPerSource: Partial<Record<Source, number>> = {};
    for (const src of Object.keys(tokensPerSource) as Source[]) {
      const inTok = inputTokensPerSource[src] ?? 0;
      const outTok = outputTokensPerSource[src] ?? 0;
      costPerSource[src] = this.estimateUsd(inTok, outTok);
      // Round total tokens to an integer — the apportioned float has no
      // business precision beyond whole tokens.
      tokensPerSource[src] = Math.round(tokensPerSource[src] ?? 0);
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
      // Final merge: if ScoredItemSchema rejects a valid CurationRecord glued
      // onto a RawItem (e.g. category/score drift past the schema bounds), we
      // treat the item as skipped rather than aborting the whole run. The
      // orchestrator writes the deadletter and the remaining items ship.
      const parsed = ScoredItemSchema.safeParse({
        ...raw,
        category: rec.category,
        relevanceScore: rec.relevanceScore,
        keep: rec.keep,
        description: rec.description,
      });
      if (parsed.success) {
        scored.push(parsed.data);
      } else {
        const issue = parsed.error.issues[0];
        this._lastSkipped.push({
          rawItem: raw,
          zodPath: issue?.path.join(".") ?? "",
          reason: issue?.message ?? "ScoredItemSchema validation failed",
        });
        log.warn("curator skipped item (zod merge failure)", {
          id: raw.id,
          zodPath: issue?.path.join("."),
          reason: issue?.message,
        });
      }
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
      ...(Object.keys(tokensPerSource).length > 0
        ? { tokensPerSource, costPerSource }
        : {}),
      ...(this.client.model !== undefined ? { model: this.client.model } : {}),
      promptVersion: PROMPT_VERSION,
      chunkCount: chunks.length,
      maxUsd: this.maxUsd,
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

  lastSkipped(): readonly SkippedItemRecord[] {
    return this._lastSkipped;
  }

  private estimateUsd(inputTokens: number, outputTokens: number): number {
    return sharedEstimateUsd(inputTokens, outputTokens, {
      inputCostPerMTok: this.inputCostPerMTok,
      outputCostPerMTok: this.outputCostPerMTok,
    });
  }

  private async callWithRetry(
    chunk: readonly RawItem[],
    chunkIdx: number,
    perChunkCeiling: number,
  ): Promise<CurationCallResult> {
    const expected = chunk.length;
    let lastErr: unknown;
    // Hallucination mitigation state carried across attempts. Populated when
    // an attempt throws UnexpectedRecordIdError; consumed on the NEXT attempt.
    let lastUnexpectedId: string | undefined;
    let workingChunk: readonly RawItem[] = chunk;
    let disableCache = false;
    let extraUserMessage: string | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.client.call({
          systemPrompt: this.systemPrompt,
          rawItems: workingChunk,
          ...(disableCache ? { disableCache: true } : {}),
          ...(extraUserMessage !== undefined ? { extraUserMessage } : {}),
        });
        // Validate record shape defensively; the real client already runs
        // Zod parse via structured output, but a mock may not.
        const records = result.records.map((r) =>
          CurationRecordSchema.parse(r),
        );
        // E-05 per-chunk enforcement — we MUST see exactly the ids we sent,
        // with no extras and no drops, before merging.
        assertChunkIds(workingChunk, records, chunkIdx);
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

        // Hallucination-specific branch. A repeated unexpected id across two
        // consecutive attempts on the same chunk is strong evidence that
        // naive retries will not recover (prompt-cache bleed, deterministic
        // model quirk, or provider-side cache). Trip the circuit breaker so
        // the run fails fast with a distinct status instead of burning the
        // full retry budget.
        if (err instanceof UnexpectedRecordIdError) {
          if (lastUnexpectedId === err.unexpectedId) {
            log.error("curator hallucination circuit breaker tripped", {
              chunkIdx,
              unexpectedId: err.unexpectedId,
              attempts: attempt,
            });
            throw new CuratorHallucinationCircuitBreakerError(
              err.unexpectedId,
              chunkIdx,
              attempt,
            );
          }
          lastUnexpectedId = err.unexpectedId;
          // Prepare mitigation for the next attempt: shuffle the payload
          // (defeats prompt-cache and positional biases), disable system-
          // prompt caching, and append a trailing user-turn reminder that
          // enumerates the valid id set.
          workingChunk = shuffle(chunk);
          disableCache = true;
          extraUserMessage = buildReinjectionMessage(workingChunk);
          log.warn("curator chunk hallucinated id — applying mitigation on retry", {
            chunkIdx,
            attempt,
            unexpectedId: err.unexpectedId,
            mitigation: "shuffle+disableCache+reinjectIds",
          });
        } else {
          // Reset the repeat-id tracker for non-hallucination errors so an
          // earlier hallucination followed by a JSON error then another
          // identical hallucination doesn't prematurely trip the breaker.
          lastUnexpectedId = undefined;
        }

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
  chunkIdx?: number,
): void {
  if (records.length !== chunk.length) {
    throw new CountInvariantError(chunk.length, records.length);
  }
  const want = new Set(chunk.map((x) => x.id));
  const seen = new Set<string>();
  for (const r of records) {
    if (!want.has(r.id)) {
      throw new UnexpectedRecordIdError(r.id, chunkIdx);
    }
    if (seen.has(r.id)) {
      throw new Error(`curator response contained duplicate id "${r.id}"`);
    }
    seen.add(r.id);
  }
}

// Fisher–Yates. Seeded off `Math.random()` is fine — the only invariant we
// rely on is that the shuffled order is (with near certainty) different from
// the prior attempt's order, so the model can't re-use a cached response
// keyed on the exact payload bytes.
function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function buildReinjectionMessage(chunk: readonly RawItem[]): string {
  const ids = chunk.map((i) => i.id).join(", ");
  return `CRITICAL REMINDER: each record's "id" MUST be copied verbatim from the input. The valid id set for this chunk is exactly: ${ids}. Do not invent, abbreviate, or substitute ids — unknown ids will be rejected.`;
}
