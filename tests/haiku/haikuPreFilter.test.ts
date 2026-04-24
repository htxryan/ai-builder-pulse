import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyHaikuPreFilter,
  type HaikuClient,
  type HaikuCallArgs,
  type HaikuCallResult,
  type HaikuRecord,
} from "../../src/haiku/index.js";
import {
  HAIKU_MODEL_PIN,
  resolveHaikuModel,
} from "../../src/haiku/prompt.js";
import type { RawItem } from "../../src/types.js";
import { log } from "../../src/log.js";

function raw(id: string, over: Partial<RawItem> = {}): RawItem {
  return {
    id,
    source: "hn",
    title: `title-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 10 },
    ...over,
  };
}

function items(n: number, prefix = "i"): RawItem[] {
  return Array.from({ length: n }, (_, i) => raw(`${prefix}${i}`));
}

interface CapturedCall {
  args: HaikuCallArgs;
  index: number;
}

function buildKeepAllClient(captured: CapturedCall[] = []): HaikuClient {
  let i = 0;
  return {
    model: HAIKU_MODEL_PIN,
    async call(args) {
      const idx = i;
      i += 1;
      captured.push({ args, index: idx });
      const records: HaikuRecord[] = args.rawItems.map((r) => ({
        id: r.id,
        keep: true,
      }));
      return {
        records,
        inputTokens: 1000,
        outputTokens: 500,
      } satisfies HaikuCallResult;
    },
  };
}

function buildKeepOddClient(): HaikuClient {
  // Drops every even-index item — the simplest "some pass, some drop" model.
  return {
    model: HAIKU_MODEL_PIN,
    async call(args) {
      const records: HaikuRecord[] = args.rawItems.map((r, i) => ({
        id: r.id,
        keep: i % 2 === 1,
      }));
      return { records, inputTokens: 100, outputTokens: 50 };
    },
  };
}

describe("applyHaikuPreFilter — happy path (AC-7)", () => {
  it("returns kept, dropped, stats, skipped=false on a single chunk", async () => {
    const input = items(10);
    const result = await applyHaikuPreFilter(input, {
      env: {},
      client: buildKeepOddClient(),
    });
    expect(result.skipped).toBe(false);
    expect(result.kept.length).toBe(5);
    expect(result.dropped.length).toBe(5);
    expect(result.stats.inputCount).toBe(10);
    expect(result.stats.keptCount).toBe(5);
    expect(result.stats.droppedCount).toBe(5);
    expect(result.stats.chunkCount).toBe(1);
    // kept order preserves original input order.
    expect(result.kept.map((x) => x.id)).toEqual(["i1", "i3", "i5", "i7", "i9"]);
  });

  it("empty input → 0 chunks, no API calls, skipped=false", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    const result = await applyHaikuPreFilter([], { env: {}, client });
    expect(result.skipped).toBe(false);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.stats.inputCount).toBe(0);
    expect(result.stats.chunkCount).toBe(0);
    expect(captured.length).toBe(0);
  });
});

describe("applyHaikuPreFilter — chunking (AC-8)", () => {
  it("101 items produces 2 chunks of 100 + 1", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    const input = items(101);
    const result = await applyHaikuPreFilter(input, { env: {}, client });
    expect(result.stats.chunkCount).toBe(2);
    expect(captured.length).toBe(2);
    const sizes = captured.map((c) => c.args.rawItems.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 100]);
  });

  it("99 items → 1 chunk", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    const result = await applyHaikuPreFilter(items(99), { env: {}, client });
    expect(result.stats.chunkCount).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]!.args.rawItems.length).toBe(99);
  });

  it("custom HAIKU_CHUNK_THRESHOLD via env splits accordingly", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    const result = await applyHaikuPreFilter(items(7), {
      env: { HAIKU_CHUNK_THRESHOLD: "3" },
      client,
    });
    expect(result.stats.chunkCount).toBe(3);
    const sizes = captured.map((c) => c.args.rawItems.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 3, 3]);
  });
});

describe("applyHaikuPreFilter — call args (AC-9)", () => {
  it("passes max_tokens=4000 and resolves model from HAIKU_MODEL_PIN by default", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    await applyHaikuPreFilter(items(2), { env: {}, client });
    expect(captured[0]!.args.maxTokens).toBe(4000);
    expect(captured[0]!.args.model).toBe(HAIKU_MODEL_PIN);
  });

  it("HAIKU_MODEL_OVERRIDE flows into the call args", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    await applyHaikuPreFilter(items(2), {
      env: { HAIKU_MODEL_OVERRIDE: "anthropic/claude-haiku-4-5" },
      client,
    });
    expect(captured[0]!.args.model).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("applyHaikuPreFilter — fallbacks (AC-10, AC-11)", () => {
  it("hallucinated id in chunk response → that chunk falls back to pass-through", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const client: HaikuClient = {
        model: HAIKU_MODEL_PIN,
        async call(args) {
          // Replace one valid id with a fake one.
          const records: HaikuRecord[] = args.rawItems.map((r) => ({
            id: r.id,
            keep: false,
          }));
          records[0] = { id: "hn-fake-9999", keep: false };
          return { records, inputTokens: 1, outputTokens: 1 };
        },
      };
      const input = items(3);
      const result = await applyHaikuPreFilter(input, { env: {}, client });
      // Whole chunk fell back: all 3 items kept, none dropped.
      expect(result.kept.length).toBe(3);
      expect(result.dropped.length).toBe(0);
      expect(result.skipped).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("more records than input count → chunk falls back to pass-through", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const client: HaikuClient = {
        model: HAIKU_MODEL_PIN,
        async call(args) {
          // Return 1 extra record (still all valid ids).
          const valid = args.rawItems.map((r) => ({ id: r.id, keep: false }));
          const extra = { id: args.rawItems[0]!.id, keep: false };
          return {
            records: [...valid, extra],
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      };
      const input = items(3);
      const result = await applyHaikuPreFilter(input, { env: {}, client });
      expect(result.kept.length).toBe(3);
      expect(result.dropped.length).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fewer records than input → chunk falls back to pass-through", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const client: HaikuClient = {
        model: HAIKU_MODEL_PIN,
        async call(args) {
          const records = args.rawItems
            .slice(0, -1)
            .map((r) => ({ id: r.id, keep: false }));
          return { records, inputTokens: 1, outputTokens: 1 };
        },
      };
      const input = items(3);
      const result = await applyHaikuPreFilter(input, { env: {}, client });
      expect(result.kept.length).toBe(3);
      expect(result.dropped.length).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("applyHaikuPreFilter — chunk-level error isolation (AC-12)", () => {
  it("API error on one chunk: that chunk passes through, other chunks continue", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      let chunkIdx = 0;
      const client: HaikuClient = {
        model: HAIKU_MODEL_PIN,
        async call(args) {
          const idx = chunkIdx;
          chunkIdx += 1;
          if (idx === 1) {
            throw new Error("simulated 402");
          }
          // Drop everything else
          return {
            records: args.rawItems.map((r) => ({ id: r.id, keep: false })),
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      };
      // 3 chunks of 2 each (chunkThreshold=2 via env).
      const input = items(6);
      const result = await applyHaikuPreFilter(input, {
        env: { HAIKU_CHUNK_THRESHOLD: "2", HAIKU_CONCURRENCY: "1" },
        client,
      });
      // Chunk 0: 2 dropped. Chunk 1: error → 2 kept (pass-through). Chunk 2: 2 dropped.
      expect(result.kept.length).toBe(2);
      expect(result.dropped.length).toBe(4);
      expect(result.skipped).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("applyHaikuPreFilter — stage-level error → skipped=true (AC-13)", () => {
  it("uncaught error in chunking returns skipped=true with all items kept", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const input = items(5);
      const result = await applyHaikuPreFilter(input, {
        // Negative chunk threshold triggers a chunkItems-internal exception.
        env: { HAIKU_CHUNK_THRESHOLD: "not-a-number-or-zero-bad" },
        client: buildKeepAllClient(),
        // Force a stage-level throw via injected hook.
        __throwBeforeChunking: true,
      });
      expect(result.skipped).toBe(true);
      expect(result.kept.length).toBe(5);
      expect(result.dropped.length).toBe(0);
      expect(result.stats.inputCount).toBe(5);
      expect(result.stats.keptCount).toBe(5);
      expect(result.stats.droppedCount).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("applyHaikuPreFilter — DISABLED short-circuit (AC-14)", () => {
  it("HAIKU_PREFILTER_DISABLED=1 → skipped=true, no API calls, no client construction needed", async () => {
    const captured: CapturedCall[] = [];
    const client = buildKeepAllClient(captured);
    const result = await applyHaikuPreFilter(items(5), {
      env: { HAIKU_PREFILTER_DISABLED: "1" },
      client,
    });
    expect(result.skipped).toBe(true);
    expect(result.kept.length).toBe(5);
    expect(result.dropped.length).toBe(0);
    expect(captured.length).toBe(0);
  });

  it("DISABLED path works without a client supplied (no ANTHROPIC_API_KEY needed)", async () => {
    const result = await applyHaikuPreFilter(items(3), {
      env: { HAIKU_PREFILTER_DISABLED: "1" },
      // No client, no api key — DISABLED must short-circuit before either is required.
    });
    expect(result.skipped).toBe(true);
    expect(result.kept.length).toBe(3);
  });
});

describe("applyHaikuPreFilter — concurrency probe (AC-15)", () => {
  it("HAIKU_CONCURRENCY=2 with 5 chunks → at most 2 in-flight simultaneously", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client: HaikuClient = {
      model: HAIKU_MODEL_PIN,
      async call(args) {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to scheduler so other tasks can interleave.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          records: args.rawItems.map((r) => ({ id: r.id, keep: true })),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    // 5 chunks × 2 items each = 10 total items at chunkThreshold=2.
    await applyHaikuPreFilter(items(10), {
      env: { HAIKU_CHUNK_THRESHOLD: "2", HAIKU_CONCURRENCY: "2" },
      client,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // And the limiter is actually exercised — at least 2 ran concurrently
    // (otherwise the test isn't testing what we think it is).
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

describe("applyHaikuPreFilter — log emission (AC-16)", () => {
  it("emits 'haiku-prefilter complete' at info with required fields on success", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      await applyHaikuPreFilter(items(3), {
        env: {},
        client: buildKeepOddClient(),
      });
      const completeCalls = infoSpy.mock.calls.filter(
        (call) => call[0] === "haiku-prefilter complete",
      );
      expect(completeCalls.length).toBe(1);
      const data = completeCalls[0]![1];
      expect(data).toMatchObject({
        inputCount: 3,
        keptCount: 1,
        droppedCount: 2,
        chunkCount: 1,
        skipped: false,
      });
      expect(data).toHaveProperty("estimatedUsd");
      expect(typeof (data as { estimatedUsd: unknown }).estimatedUsd).toBe(
        "number",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("emits 'haiku-prefilter complete' with skipped=true on DISABLED path", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      await applyHaikuPreFilter(items(2), {
        env: { HAIKU_PREFILTER_DISABLED: "1" },
      });
      const completeCalls = infoSpy.mock.calls.filter(
        (call) => call[0] === "haiku-prefilter complete",
      );
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0]![1]).toMatchObject({
        inputCount: 2,
        keptCount: 2,
        droppedCount: 0,
        chunkCount: 0,
        skipped: true,
        estimatedUsd: 0,
      });
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("applyHaikuPreFilter — cost model (AC-18)", () => {
  it("estimatedUsd uses $0.80/MTok input and $4.00/MTok output by default", async () => {
    const client: HaikuClient = {
      model: HAIKU_MODEL_PIN,
      async call(args) {
        return {
          records: args.rawItems.map((r) => ({ id: r.id, keep: true })),
          inputTokens: 1_000_000, // 1M input → $0.80
          outputTokens: 1_000_000, // 1M output → $4.00
        };
      },
    };
    const result = await applyHaikuPreFilter(items(1), { env: {}, client });
    // 0.80 + 4.00 = 4.80, allow rounding to 4 decimals.
    expect(result.stats.estimatedUsd).toBeCloseTo(4.8, 4);
  });

  it("HAIKU_INPUT_COST_PER_MTOK / HAIKU_OUTPUT_COST_PER_MTOK env vars override rates", async () => {
    const client: HaikuClient = {
      model: HAIKU_MODEL_PIN,
      async call(args) {
        return {
          records: args.rawItems.map((r) => ({ id: r.id, keep: true })),
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        };
      },
    };
    const result = await applyHaikuPreFilter(items(1), {
      env: {
        HAIKU_INPUT_COST_PER_MTOK: "1.00",
        HAIKU_OUTPUT_COST_PER_MTOK: "10.00",
      },
      client,
    });
    expect(result.stats.estimatedUsd).toBeCloseTo(11, 4);
  });

  it("DISABLED path reports estimatedUsd=0", async () => {
    const result = await applyHaikuPreFilter(items(5), {
      env: { HAIKU_PREFILTER_DISABLED: "1" },
    });
    expect(result.stats.estimatedUsd).toBe(0);
  });
});

describe("resolveHaikuModel", () => {
  it("returns HAIKU_MODEL_PIN by default", () => {
    expect(resolveHaikuModel({})).toBe(HAIKU_MODEL_PIN);
  });
  it("returns HAIKU_MODEL_OVERRIDE when set", () => {
    expect(resolveHaikuModel({ HAIKU_MODEL_OVERRIDE: "alt/haiku-1" })).toBe(
      "alt/haiku-1",
    );
  });
  it("ignores empty / whitespace HAIKU_MODEL_OVERRIDE", () => {
    expect(resolveHaikuModel({ HAIKU_MODEL_OVERRIDE: "   " })).toBe(
      HAIKU_MODEL_PIN,
    );
  });
});
