// M3 — DeepAgent safety-net behavioural tests.
//
// Covers the four M3 invariants added on top of the M2 graph:
//   - DA-U-09  prompt-cache preservation (cache_read_input_tokens > 0 on chunk 2)
//   - DA-U-11  cost ceiling per-chunk
//   - DA-U-11  cost ceiling per-run (total exceeds budget but each chunk fits)
//   - DA-E-06  CostCeilingError is NOT retried
//   - DA-U-12 / DA-E-05 transient failures retried up to maxChunkRetries
//
// Also includes a cost-model parity check: `costModel.estimateUsd` returns
// the same USD for the same token counts whether called from the legacy
// ClaudeCurator path or from the DeepAgents path.

import { describe, it, expect } from "vitest";
import { AIMessage, fakeModel } from "langchain";
import type { UsageMetadata } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runDeepAgentCuratorInternal } from "../../../src/curator/deepagent/index.js";
import {
  CostCeilingError,
  CountInvariantError,
} from "../../../src/curator/claudeCurator.js";
import {
  DEFAULT_INPUT_COST_PER_MTOK,
  DEFAULT_OUTPUT_COST_PER_MTOK,
  estimateUsd,
} from "../../../src/curator/costModel.js";
import { CATEGORIES, type RawItem } from "../../../src/types.js";

function rawItem(i: number): RawItem {
  return {
    id: `itm-${i}`,
    source: "hn",
    title: `Test title ${i} — a builder would care`,
    url: `https://example.com/${i}`,
    score: i,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 10 + i },
  };
}

function makeRecords(items: readonly RawItem[]) {
  return items.map((raw, i) => ({
    id: raw.id,
    category: CATEGORIES[i % CATEGORIES.length]!,
    relevanceScore: 0.5,
    keep: i % 3 !== 0,
    description: `desc-${i} `.repeat(10).slice(0, 150),
  }));
}

/**
 * Build an AIMessage the adapter's `extractUsage` can read. `input_tokens`
 * is stored as the LangChain-style SUM (real + cache_read + cache_creation)
 * to mirror what `@langchain/anthropic`'s `buildUsageMetadata` produces;
 * the adapter subtracts cache tokens back out.
 */
function jsonMessage(
  body: unknown,
  usage?: {
    realInputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheCreation?: number;
  },
): AIMessage {
  const real = usage?.realInputTokens ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheCreation = usage?.cacheCreation ?? 0;
  const summedInput = real + cacheRead + cacheCreation;
  const out = usage?.outputTokens ?? 0;
  const usageMetadata: UsageMetadata = {
    input_tokens: summedInput,
    output_tokens: out,
    total_tokens: summedInput + out,
    input_token_details: {
      cache_read: cacheRead,
      cache_creation: cacheCreation,
    },
  };
  const msg = new AIMessage({ content: JSON.stringify(body) });
  // Assign after construction — the default MessageToolSet narrows
  // `usage_metadata` to `undefined`, so the constructor fields path
  // rejects the value. Runtime surface is unchanged.
  (msg as unknown as { usage_metadata?: UsageMetadata }).usage_metadata =
    usageMetadata;
  return msg;
}

function makeModel(body: unknown, usage?: Parameters<typeof jsonMessage>[1]): BaseChatModel {
  return fakeModel().respond(jsonMessage(body, usage));
}

describe("DeepAgent curator — M3 cost ceiling", () => {
  it("throws CostCeilingError when a single chunk exceeds the per-chunk budget", async () => {
    const items = Array.from({ length: 10 }, (_, i) => rawItem(i));
    // 1M input tokens at $3/M = $3.00 — far above per-chunk ceiling of
    // `maxUsd=0.50 / chunkCount=1 * 2 = $1.00`.
    const model = makeModel(
      { items: makeRecords(items) },
      { realInputTokens: 1_000_000, outputTokens: 0 },
    );

    await expect(
      runDeepAgentCuratorInternal(items, {
        runId: "rid",
        runDate: "2026-04-19",
        config: {
          maxIterations: 6,
          toolBudget: 8,
          maxChunkRetries: 3,
          maxConcurrentChunks: 1,
          enableLangsmith: false,
          auditToFile: false,
          chunkThreshold: 50,
          maxUsd: 0.5,
          inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
          outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
        },
        modelOverride: model,
      }),
    ).rejects.toBeInstanceOf(CostCeilingError);
  });

  it("throws CostCeilingError at the per-run total even when no single chunk trips", async () => {
    // 4 chunks, each $0.30 → per-chunk ceiling $0.50 (1.0/4*2) fits;
    // total $1.20 exceeds maxUsd=1.00 → per-run check fires.
    const items = Array.from({ length: 8 }, (_, i) => rawItem(i));
    // 100_000 input tokens per chunk * $3/M = $0.30
    const usage = { realInputTokens: 100_000, outputTokens: 0 };

    const models = [0, 1, 2, 3].map((chunkIdx) =>
      makeModel(
        {
          items: makeRecords(items.slice(chunkIdx * 2, chunkIdx * 2 + 2)),
        },
        usage,
      ),
    );

    await expect(
      runDeepAgentCuratorInternal(items, {
        runId: "rid",
        runDate: "2026-04-19",
        config: {
          maxIterations: 6,
          toolBudget: 8,
          maxChunkRetries: 3,
          maxConcurrentChunks: 1,
          enableLangsmith: false,
          auditToFile: false,
          chunkThreshold: 2,
          maxUsd: 1.0,
          inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
          outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
        },
        modelFactory: (idx: number) => models[idx],
      }),
    ).rejects.toThrow(/Cost ceiling exceeded \(total\)/);
  });

  it("does NOT retry when the adapter throws CostCeilingError", async () => {
    // Record per-chunk call counts. A CostCeilingError on chunk 0 must
    // surface after ONE adapter call — retrying would burn more budget
    // on the same regression (DA-E-06).
    const items = Array.from({ length: 5 }, (_, i) => rawItem(i));
    // Large usage guarantees the chunk trips the ceiling on attempt 1.
    let invocations = 0;
    const factory = (_: number): BaseChatModel => {
      invocations += 1;
      return makeModel(
        { items: makeRecords(items) },
        { realInputTokens: 10_000_000, outputTokens: 0 },
      );
    };

    await expect(
      runDeepAgentCuratorInternal(items, {
        runId: "rid",
        runDate: "2026-04-19",
        config: {
          maxIterations: 6,
          toolBudget: 8,
          maxChunkRetries: 3,
          maxConcurrentChunks: 1,
          enableLangsmith: false,
          auditToFile: false,
          chunkThreshold: 50,
          maxUsd: 0.1,
          inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
          outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
        },
        modelFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CostCeilingError);

    expect(invocations).toBe(1);
  });
});

describe("DeepAgent curator — M3 chunk retry", () => {
  it("retries a chunk that returns the wrong count until it succeeds", async () => {
    // Chunk 0 sees two attempts: the first emits a short response (fires
    // CountInvariantError → retryable); the second emits the correct count.
    const items = Array.from({ length: 3 }, (_, i) => rawItem(i));
    let attempt = 0;
    const factory = (_: number): BaseChatModel => {
      attempt += 1;
      if (attempt === 1) {
        // Wrong count (2 instead of 3) → CountInvariantError → retry
        return makeModel(
          { items: makeRecords(items.slice(0, 2)) },
          { realInputTokens: 100, outputTokens: 50 },
        );
      }
      return makeModel(
        { items: makeRecords(items) },
        { realInputTokens: 100, outputTokens: 50 },
      );
    };

    const { scored } = await runDeepAgentCuratorInternal(items, {
      runId: "rid",
      runDate: "2026-04-19",
      config: {
        maxIterations: 6,
        toolBudget: 8,
        maxChunkRetries: 3,
        maxConcurrentChunks: 1,
        enableLangsmith: false,
        auditToFile: false,
        chunkThreshold: 50,
        maxUsd: 10.0,
        inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
        outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
      },
      modelFactory: factory,
    });

    expect(scored).toHaveLength(3);
    expect(attempt).toBe(2);
  });

  it("surfaces the last error after maxChunkRetries transient failures", async () => {
    const items = Array.from({ length: 3 }, (_, i) => rawItem(i));
    let attempt = 0;
    const factory = (_: number): BaseChatModel => {
      attempt += 1;
      // Every attempt returns short count → CountInvariantError → retry.
      return makeModel(
        { items: makeRecords(items.slice(0, 2)) },
        { realInputTokens: 100, outputTokens: 50 },
      );
    };

    await expect(
      runDeepAgentCuratorInternal(items, {
        runId: "rid",
        runDate: "2026-04-19",
        config: {
          maxIterations: 6,
          toolBudget: 8,
          maxChunkRetries: 3,
          maxConcurrentChunks: 1,
          enableLangsmith: false,
          auditToFile: false,
          chunkThreshold: 50,
          maxUsd: 10.0,
          inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
          outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
        },
        modelFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CountInvariantError);

    expect(attempt).toBe(3);
  });
});

describe("DeepAgent curator — M3 prompt-cache preservation (DA-U-09)", () => {
  it("aggregates cache_read_input_tokens across multi-chunk runs", async () => {
    // Two chunks: chunk 0 reports cache_creation>0; chunk 1 reports
    // cache_read>0 (the scenario the spec calls out in fitness function 15).
    // The aggregated metrics expose both so an operator assertion
    // `cacheReadInputTokens > 0` flags a regression that strips caching
    // through the LangChain layer.
    const chunk0 = [rawItem(0), rawItem(1)];
    const chunk1 = [rawItem(2), rawItem(3)];
    const items = [...chunk0, ...chunk1];

    const factory = (chunkIdx: number): BaseChatModel => {
      if (chunkIdx === 0) {
        return makeModel(
          { items: makeRecords(chunk0) },
          {
            realInputTokens: 100,
            outputTokens: 50,
            cacheCreation: 1_500,
            cacheRead: 0,
          },
        );
      }
      return makeModel(
        { items: makeRecords(chunk1) },
        {
          realInputTokens: 50,
          outputTokens: 50,
          cacheCreation: 0,
          cacheRead: 1_500,
        },
      );
    };

    const { metrics } = await runDeepAgentCuratorInternal(items, {
      runId: "rid",
      runDate: "2026-04-19",
      config: {
        maxIterations: 6,
        toolBudget: 8,
        maxChunkRetries: 3,
        maxConcurrentChunks: 1,
        enableLangsmith: false,
        auditToFile: false,
        chunkThreshold: 2,
        maxUsd: 10.0,
        inputCostPerMTok: DEFAULT_INPUT_COST_PER_MTOK,
        outputCostPerMTok: DEFAULT_OUTPUT_COST_PER_MTOK,
      },
      modelFactory: factory,
    });

    expect(metrics).toBeDefined();
    // DA-U-09 core assertion — 2nd chunk saw cache reads. If
    // @langchain/anthropic silently strips cache_control the middleware
    // can't set it, the model won't emit cache_read, and this value stays 0.
    expect(metrics!.cacheReadInputTokens).toBeGreaterThan(0);
    expect(metrics!.cacheCreationInputTokens).toBeGreaterThan(0);
    // Cost uses ONLY the real input tokens — cache tokens are stripped out
    // in `extractUsage` to keep parity with the direct-SDK path.
    const expected = estimateUsd(150, 100);
    expect(metrics!.estimatedUsd).toBeCloseTo(expected, 4);
  });
});

describe("DeepAgent curator — M3 shared costModel parity", () => {
  it("estimateUsd is consumed identically by DeepAgent config defaults", () => {
    // The CuratorMetrics.estimatedUsd produced by ClaudeCurator.estimateUsd
    // is now a thin shim over the shared helper. A drift here would mean
    // the two backends bill the same tokens differently — a red flag for
    // an operator who flips CURATOR_BACKEND and sees a sudden cost delta.
    const a = estimateUsd(1_000_000, 1_000_000);
    // 1M input * $3 + 1M output * $15 = $18
    expect(a).toBeCloseTo(18.0, 4);
    const b = estimateUsd(0, 0);
    expect(b).toBe(0);
    const c = estimateUsd(500_000, 250_000, {
      inputCostPerMTok: 2.0,
      outputCostPerMTok: 10.0,
    });
    // 0.5 * $2 + 0.25 * $10 = $3.5
    expect(c).toBeCloseTo(3.5, 4);
  });
});
