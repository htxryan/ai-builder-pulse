import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RssCollector, parseFeedXml } from "../../src/collectors/rss.js";
import type { CollectorContext } from "../../src/collectors/types.js";

const ATOM = readFileSync(path.join(process.cwd(), "fixtures", "rss-atom.xml"), "utf8");
const RSS20 = readFileSync(path.join(process.cwd(), "fixtures", "rss-20.xml"), "utf8");

function makeCtx(cutoffMs = 0): CollectorContext {
  return {
    runDate: "2026-04-18",
    cutoffMs,
    abortSignal: new AbortController().signal,
    env: {},
  };
}

describe("parseFeedXml", () => {
  it("parses Atom entries with link/published/author", () => {
    const entries = parseFeedXml(ATOM, "https://simonwillison.net/atom/everything/");
    expect(entries.length).toBe(2);
    const first = entries[0]!;
    expect(first.title).toBe("Claude structured outputs GA");
    expect(first.url).toBe("https://simonwillison.net/2026/Apr/18/structured-outputs/");
    expect(first.author).toBe("Simon Willison");
    expect(first.publishedMs).toBe(Date.parse("2026-04-18T09:30:00Z"));
  });

  it("parses RSS 2.0 items", () => {
    const entries = parseFeedXml(RSS20, "https://example.com/feed.xml");
    expect(entries.length).toBe(1);
    expect(entries[0]!.title).toBe("New agent framework released");
    expect(entries[0]!.url).toBe("https://example.com/agent-framework");
    expect(entries[0]!.author).toBe("Example Author");
  });

  it("returns [] on malformed input", () => {
    expect(parseFeedXml("<<not-xml>>", "https://x")).toEqual([]);
  });
});

describe("RssCollector", () => {
  it("fetches, parses, and filters by cutoffMs", async () => {
    const fetchImpl: typeof fetch = async (u0) => {
      const u = String(u0);
      if (u.includes("atom")) return new Response(ATOM, { status: 200 });
      return new Response(RSS20, { status: 200 });
    };
    const resolveImpl = async (u: string) => ({ url: u });
    const c = new RssCollector({
      fetchImpl,
      resolveImpl,
      feeds: [
        "https://simonwillison.net/atom/everything/",
        "https://example.com/feed.xml",
      ],
    });
    // cutoff: 24h before 2026-04-18T00:00Z → 2026-04-17T00:00Z
    const cutoff = Date.parse("2026-04-17T00:00:00Z");
    const items = await c.fetch(makeCtx(cutoff));
    // Atom entry 1 is within window; Atom entry 2 is 2026-04-16 (filtered);
    // RSS 2.0 entry is 2026-04-18 (kept)
    expect(items.length).toBe(2);
    const atomItem = items.find((i) =>
      i.metadata.source === "rss" && i.metadata.feedUrl.includes("simonwillison"),
    );
    expect(atomItem?.title).toBe("Claude structured outputs GA");
  });

  it("tolerates one feed failing and still returns others", async () => {
    const fetchImpl: typeof fetch = async (u0) => {
      const u = String(u0);
      if (u.includes("broken")) throw new Error("network");
      return new Response(RSS20, { status: 200 });
    };
    const c = new RssCollector({
      fetchImpl,
      resolveImpl: async (u) => ({ url: u }),
      feeds: ["https://broken.example/feed", "https://example.com/feed.xml"],
    });
    const items = await c.fetch(makeCtx(Date.parse("2026-04-17T00:00:00Z")));
    expect(items.length).toBe(1);
  });
});
