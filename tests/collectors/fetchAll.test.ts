import { describe, it, expect } from "vitest";
import { fetchAll } from "../../src/collectors/index.js";
import type {
  Collector,
  CollectorContext,
} from "../../src/collectors/types.js";
import type { RawItem, RunContext } from "../../src/types.js";

function mkRunCtx(): RunContext {
  return {
    runDate: "2026-04-18",
    dryRun: true,
    repoRoot: "/tmp",
    minItemsToPublish: 1,
    minSources: 1,
  };
}

function fakeItem(source: "hn" | "rss", id: string): RawItem {
  const base: RawItem = {
    id: `${source}-${id}`,
    source,
    title: `t ${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata:
      source === "hn"
        ? { source: "hn" }
        : { source: "rss", feedUrl: "https://example.com/feed.xml" },
  };
  return base;
}

class OkCollector implements Collector {
  constructor(public readonly source: string, private readonly items: RawItem[]) {}
  async fetch(_ctx: CollectorContext): Promise<RawItem[]> {
    return this.items;
  }
}

class FailingCollector implements Collector {
  readonly source = "github-trending";
  async fetch(): Promise<RawItem[]> {
    throw new Error("boom");
  }
}

class TimeoutCollector implements Collector {
  readonly source = "reddit";
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    return await new Promise<RawItem[]>((_resolve, reject) => {
      ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason));
    });
  }
}

describe("fetchAll", () => {
  it("combines items and records a per-source summary", async () => {
    const out = await fetchAll(mkRunCtx(), {
      env: {},
      collectors: [
        new OkCollector("hn", [fakeItem("hn", "1"), fakeItem("hn", "2")]),
        new OkCollector("rss", [fakeItem("rss", "a")]),
      ],
    });
    expect(out.items.length).toBe(3);
    expect(out.summary.hn).toEqual({ count: 2, status: "ok" });
    expect(out.summary.rss).toEqual({ count: 1, status: "ok" });
  });

  it("records error status without aborting siblings", async () => {
    const out = await fetchAll(mkRunCtx(), {
      env: {},
      collectors: [
        new OkCollector("hn", [fakeItem("hn", "1")]),
        new FailingCollector(),
      ],
    });
    expect(out.items.length).toBe(1);
    expect(out.summary["github-trending"]!.status).toBe("error");
    expect(out.summary["github-trending"]!.error).toMatch(/boom/);
  });

  it("records timeout status when a collector exceeds the deadline", async () => {
    const out = await fetchAll(mkRunCtx(), {
      env: {},
      timeoutMs: 30,
      collectors: [new TimeoutCollector()],
    });
    expect(out.summary.reddit!.status).toBe("timeout");
  });

  it("records skipped for twitter when ENABLE_TWITTER not set", async () => {
    const out = await fetchAll(mkRunCtx(), {
      env: {},
      collectors: [
        // Using OkCollector with source=twitter would still be skipped because
        // the fetchAll composite enforces the env gate before invoking .fetch.
        new OkCollector("twitter", [fakeItem("hn", "should-not-appear")]),
      ],
    });
    expect(out.items.length).toBe(0);
    expect(out.summary.twitter!.status).toBe("skipped");
  });

  it("records skipped for reddit when REDDIT_DISABLED=1", async () => {
    const out = await fetchAll(mkRunCtx(), {
      env: { REDDIT_DISABLED: "1" },
      collectors: [
        new OkCollector("reddit", [fakeItem("hn", "should-not-appear")]),
      ],
    });
    expect(out.summary.reddit!.status).toBe("skipped");
  });
});
