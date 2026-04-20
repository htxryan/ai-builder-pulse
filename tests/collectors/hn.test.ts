import { describe, it, expect, vi } from "vitest";
import { HnCollector } from "../../src/collectors/hn.js";
import type { CollectorContext } from "../../src/collectors/types.js";
import { makeCollectorMetrics } from "../../src/collectors/types.js";

function makeCtx(cutoffMs = 0): CollectorContext {
  return {
    runDate: "2026-04-18",
    cutoffMs,
    abortSignal: new AbortController().signal,
    env: {},
    metrics: makeCollectorMetrics(),
  };
}

const hitsFixture = {
  hits: [
    {
      objectID: "40000001",
      title: "Show HN: A new AI coding agent",
      url: "https://example.com/ai-agent",
      points: 120,
      num_comments: 30,
      author: "alice",
      created_at_i: 1_776_500_000,
    },
    {
      objectID: "40000002",
      title: null,
      story_title: "Claude API structured outputs GA",
      story_url: "https://example.com/claude-structured",
      points: 85,
      num_comments: 12,
      author: "bob",
      created_at_i: 1_776_500_100,
    },
    {
      objectID: "40000003",
      title: "Ask HN: Favorite local LLM setup?",
      url: null,
      points: 22,
      num_comments: 17,
      author: "carol",
      created_at_i: 1_776_500_200,
    },
  ],
};

describe("HnCollector", () => {
  it("maps algolia hits to RawItems with hn metadata", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(hitsFixture), { status: 200 });
    const resolveImpl = async (u: string) => ({ url: u });
    const c = new HnCollector({ fetchImpl, resolveImpl });
    const items = await c.fetch(makeCtx());
    // Ask HN (url: null) is dropped; 2 valid
    expect(items.length).toBe(2);
    const first = items.find((i) => i.id === "hn-40000001")!;
    expect(first.source).toBe("hn");
    expect(first.url).toBe("https://example.com/ai-agent");
    expect(first.metadata).toEqual({
      source: "hn",
      points: 120,
      numComments: 30,
      author: "alice",
    });
    const second = items.find((i) => i.id === "hn-40000002")!;
    expect(second.title).toBe("Claude API structured outputs GA");
  });

  it("uses numericFilters with the cutoff epoch", async () => {
    let captured = "";
    const fetchImpl: typeof fetch = async (u) => {
      captured = String(u);
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    };
    const c = new HnCollector({ fetchImpl, resolveImpl: async (u) => ({ url: u }) });
    await c.fetch(makeCtx(1_776_000_000_000));
    expect(captured).toContain("numericFilters=created_at_i%3E1776000000");
  });

  it("raises on non-200 http", async () => {
    const fetchImpl = async () => new Response("boom", { status: 503 });
    const c = new HnCollector({ fetchImpl, resolveImpl: async (u) => ({ url: u }) });
    await expect(c.fetch(makeCtx())).rejects.toThrow(/503/);
  });

  it("resolves redirects in parallel (bounded by concurrency)", async () => {
    const manyHits = Array.from({ length: 20 }, (_, i) => ({
      objectID: `obj-${i}`,
      title: `item ${i}`,
      url: `https://example.com/${i}`,
      points: i,
      num_comments: 0,
      author: "x",
      created_at_i: 1_776_500_000 + i,
    }));
    const fetchImpl = async () =>
      new Response(JSON.stringify({ hits: manyHits }), { status: 200 });
    let concurrent = 0;
    let peak = 0;
    const resolveImpl = async (u: string) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
      return { url: u };
    };
    const c = new HnCollector({ fetchImpl, resolveImpl, redirectConcurrency: 6 });
    const items = await c.fetch(makeCtx());
    expect(items.length).toBe(20);
    expect(peak).toBeGreaterThan(1); // ran in parallel
    expect(peak).toBeLessThanOrEqual(6); // respected limit
  });

  // Failure-mode coverage (cycle-2 polish audit AC1):
  // every upstream failure we actually see in production must return without
  // silently losing context. Each test asserts: no unhandled crash at the
  // collector boundary, metrics remain correct, and the failure is logged
  // exactly once with the request URL so an operator can reproduce.

  it("returns [] on an empty-hits response (quiet HN day)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = async () =>
        new Response(JSON.stringify({ hits: [] }), { status: 200 });
      const c = new HnCollector({ fetchImpl, resolveImpl: async (u) => ({ url: u }) });
      const ctx = makeCtx();
      const items = await c.fetch(ctx);
      expect(items).toEqual([]);
      expect(ctx.metrics.redirectFailures).toBe(0);
      expect(ctx.metrics.partialFailures).toEqual([]);
      // Empty-hits is NOT a failure — no warn annotation should fire.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws on 429 and logs once with URL + Retry-After", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" },
        });
      const c = new HnCollector({ fetchImpl, resolveImpl: async (u) => ({ url: u }) });
      const ctx = makeCtx();
      await expect(c.fetch(ctx)).rejects.toThrow(/429/);
      // Metrics unchanged — redirect/partial counters are for per-item issues.
      expect(ctx.metrics.redirectFailures).toBe(0);
      expect(ctx.metrics.partialFailures).toEqual([]);
      // Exactly one structured log line (pair of writes: annotation + json)
      // emitted by log.warn. It must carry the Algolia URL and the 429 code.
      const annotations = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((s) => s.startsWith("::warning::"));
      expect(annotations).toHaveLength(1);
      const payloads = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((s) => s.includes("\"msg\":\"hn algolia non-2xx\""));
      expect(payloads).toHaveLength(1);
      const payload = payloads[0]!;
      expect(payload).toContain("hn.algolia.com");
      expect(payload).toContain("\"status\":429");
      expect(payload).toContain("\"retryAfter\":\"60\"");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws on malformed JSON body and logs once with URL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response("<html>oops upstream proxy error</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const c = new HnCollector({ fetchImpl, resolveImpl: async (u) => ({ url: u }) });
      const ctx = makeCtx();
      await expect(c.fetch(ctx)).rejects.toThrow();
      expect(ctx.metrics.redirectFailures).toBe(0);
      expect(ctx.metrics.partialFailures).toEqual([]);
      const payloads = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((s) => s.includes("\"msg\":\"hn algolia malformed json body\""));
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!).toContain("hn.algolia.com");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("records a sourceUrl when the resolver redirects", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          hits: [hitsFixture.hits[0]],
        }),
        { status: 200 },
      );
    const resolveImpl = async (u: string) => ({
      url: "https://canonical.example.com/a",
      sourceUrl: u,
    });
    const c = new HnCollector({ fetchImpl, resolveImpl });
    const items = await c.fetch(makeCtx());
    expect(items[0]!.url).toBe("https://canonical.example.com/a");
    expect(items[0]!.sourceUrl).toBe("https://example.com/ai-agent");
  });
});
