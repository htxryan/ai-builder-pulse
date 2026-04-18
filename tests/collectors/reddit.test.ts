import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RedditCollector,
  pickRedditMode,
} from "../../src/collectors/reddit.js";
import type { CollectorContext } from "../../src/collectors/types.js";

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
  };
}

describe("pickRedditMode", () => {
  it("oauth when both credentials present", () => {
    expect(
      pickRedditMode({
        REDDIT_CLIENT_ID: "x",
        REDDIT_CLIENT_SECRET: "y",
      }),
    ).toBe("oauth");
  });

  it("public fallback when creds missing (S-04)", () => {
    expect(pickRedditMode({})).toBe("public");
  });

  it("skip when REDDIT_DISABLED=1", () => {
    expect(pickRedditMode({ REDDIT_DISABLED: "1" })).toBe("skip");
  });

  it("skip when REDDIT_FALLBACK_PUBLIC=0 and no oauth", () => {
    expect(pickRedditMode({ REDDIT_FALLBACK_PUBLIC: "0" })).toBe("skip");
  });
});

describe("RedditCollector (public fallback)", () => {
  it("fetches listings via public .json and filters stickied/self posts", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (u) => {
      urls.push(String(u));
      return new Response(LISTING, { status: 200 });
    };
    const resolveImpl = async (u: string) => ({ url: u });
    const c = new RedditCollector({
      fetchImpl,
      resolveImpl,
      subreddits: ["LocalLLaMA"],
    });
    const items = await c.fetch(ctxWith({}));
    expect(urls.every((u) => u.includes("www.reddit.com"))).toBe(true);
    // stickied post filtered out, 1 remains
    expect(items.length).toBe(1);
    expect(items[0]!.metadata).toMatchObject({
      source: "reddit",
      subreddit: "LocalLLaMA",
    });
  });

  it("returns empty when mode=skip without throwing", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    const c = new RedditCollector({ fetchImpl });
    const out = await c.fetch(ctxWith({ REDDIT_DISABLED: "1" }));
    expect(out).toEqual([]);
  });

  it("applies cutoffMs freshness filter", async () => {
    const fetchImpl: typeof fetch = async () => new Response(LISTING, { status: 200 });
    const c = new RedditCollector({
      fetchImpl,
      resolveImpl: async (u) => ({ url: u }),
      subreddits: ["LocalLLaMA"],
    });
    // cutoff well in the future → everything filtered
    const out = await c.fetch(ctxWith({}, Date.parse("2030-01-01")));
    expect(out).toEqual([]);
  });
});

describe("RedditCollector (oauth)", () => {
  it("acquires bearer token and hits oauth.reddit.com", async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (u, init) => {
      const url = String(u);
      captured.push({ url, init });
      if (url.includes("access_token")) {
        return new Response(JSON.stringify({ access_token: "bearer-xyz" }), {
          status: 200,
        });
      }
      return new Response(LISTING, { status: 200 });
    };
    const c = new RedditCollector({
      fetchImpl,
      resolveImpl: async (u) => ({ url: u }),
      subreddits: ["LocalLLaMA"],
    });
    const items = await c.fetch(
      ctxWith({ REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" }),
    );
    expect(captured[0]!.url).toContain("access_token");
    expect(captured[1]!.url).toContain("oauth.reddit.com");
    const bearer = (captured[1]!.init?.headers as Record<string, string>)
      ?.authorization;
    expect(bearer).toBe("Bearer bearer-xyz");
    expect(items.length).toBeGreaterThan(0);
  });
});
