import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RedditCollector } from "../../src/collectors/reddit.js";
import type { CollectorContext } from "../../src/collectors/types.js";
import { makeCollectorMetrics } from "../../src/collectors/types.js";

const LISTING = readFileSync(
  path.join(process.cwd(), "fixtures", "reddit-localllama.json"),
  "utf8",
);

function ctxWith(env: NodeJS.ProcessEnv, cutoffMs = 0): CollectorContext {
  return {
    runDate: "2026-04-18",
    cutoffMs,
    abortSignal: new AbortController().signal,
    env,
    metrics: makeCollectorMetrics(),
  };
}

describe("RedditCollector — per-subreddit partial failures", () => {
  it("captures the failing subreddit in partialFailures; healthy subs still contribute items", async () => {
    const fetchImpl: typeof fetch = async (u) => {
      const url = String(u);
      if (url.includes("/r/BrokenSub/")) {
        throw new Error("reddit BrokenSub http 503");
      }
      return new Response(LISTING, { status: 200 });
    };
    const resolveImpl = async (u: string) => ({ url: u });
    const ctx = ctxWith({});
    const c = new RedditCollector({
      fetchImpl,
      resolveImpl,
      subreddits: ["LocalLLaMA", "BrokenSub"],
    });
    const items = await c.fetch(ctx);
    // Healthy sub still returns its 1 fresh item
    expect(items.length).toBe(1);
    expect(ctx.metrics.partialFailures.length).toBe(1);
    expect(ctx.metrics.partialFailures[0]!.scope).toBe("BrokenSub");
    expect(ctx.metrics.partialFailures[0]!.errClass).toBe("http_5xx");
  });
});
