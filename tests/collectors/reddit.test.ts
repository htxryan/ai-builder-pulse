import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RedditCollector,
  normalizeRedditUrl,
  pickRedditMode,
} from "../../src/collectors/reddit.js";
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

// Failure-mode coverage (cycle-2 polish audit AC2): realistic upstream
// failures at the per-subreddit boundary must NOT block sibling subreddits
// from contributing. The collector's contract is "best-effort across sub-
// reddits", not "all-or-nothing".
describe("RedditCollector — per-subreddit failure isolation", () => {
  it("captures a 429 with Retry-After as a partialFailure (subreddit scope)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      const c = new RedditCollector({
        fetchImpl,
        resolveImpl: async (u) => ({ url: u }),
        subreddits: ["LocalLLaMA"],
      });
      const ctx = ctxWith({});
      const items = await c.fetch(ctx);
      expect(items).toEqual([]);
      expect(ctx.metrics.partialFailures).toHaveLength(1);
      expect(ctx.metrics.partialFailures[0]!.scope).toBe("LocalLLaMA");
      expect(ctx.metrics.partialFailures[0]!.error).toContain("429");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("captures a 404 bogus subreddit as a partialFailure (not an uncaught)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response("not found", { status: 404 });
      const c = new RedditCollector({
        fetchImpl,
        resolveImpl: async (u) => ({ url: u }),
        subreddits: ["DoesNotExistXYZ"],
      });
      const ctx = ctxWith({});
      const items = await c.fetch(ctx);
      expect(items).toEqual([]);
      expect(ctx.metrics.partialFailures).toHaveLength(1);
      expect(ctx.metrics.partialFailures[0]!.scope).toBe("DoesNotExistXYZ");
      expect(ctx.metrics.partialFailures[0]!.error).toContain("404");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("one subreddit succeeds while another fails (healthy sub still contributes)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async (u0) => {
        const u = String(u0);
        if (u.includes("/r/Broken/")) {
          return new Response("boom", { status: 503 });
        }
        return new Response(LISTING, { status: 200 });
      };
      const c = new RedditCollector({
        fetchImpl,
        resolveImpl: async (u) => ({ url: u }),
        subreddits: ["Broken", "LocalLLaMA"],
      });
      const ctx = ctxWith({});
      const items = await c.fetch(ctx);
      // Healthy sub contributes at least one non-stickied/non-self post
      // (the fixture has exactly one such post).
      expect(items.length).toBe(1);
      expect(items[0]!.metadata).toMatchObject({
        source: "reddit",
        subreddit: "LocalLLaMA",
      });
      // Failure from the other sub is captured, not swallowed.
      expect(ctx.metrics.partialFailures).toHaveLength(1);
      expect(ctx.metrics.partialFailures[0]!.scope).toBe("Broken");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// Regression: r/mlops (and others) occasionally return entries with
// relative/empty/protocol-less URLs. The top-level listing must not throw on
// those, and the collector should still yield RawItems for the well-formed
// entries in the same batch.
describe("normalizeRedditUrl", () => {
  it("prepends host to a relative /r/... URL", () => {
    expect(
      normalizeRedditUrl("/r/mlops/comments/abc/foo/", "/r/mlops/comments/abc/foo/"),
    ).toBe("https://www.reddit.com/r/mlops/comments/abc/foo/");
  });

  it("falls back to permalink when url is whitespace-only", () => {
    expect(normalizeRedditUrl("   ", "/r/mlops/comments/xyz/bar/")).toBe(
      "https://www.reddit.com/r/mlops/comments/xyz/bar/",
    );
  });

  it("adds https:// scheme to a protocol-less host", () => {
    expect(normalizeRedditUrl("reddit.com/r/mlops/comments/q/", "/r/mlops/comments/q/"))
      .toBe("https://reddit.com/r/mlops/comments/q/");
  });

  it("returns null when neither url nor permalink is usable", () => {
    expect(normalizeRedditUrl("", "")).toBeNull();
  });
});

describe("RedditCollector — malformed URL tolerance (r/mlops regression)", () => {
  const MALFORMED_LISTING = JSON.stringify({
    kind: "Listing",
    data: {
      after: null,
      children: [
        {
          kind: "t3",
          data: {
            id: "good1",
            title: "Valid post",
            url: "https://example.com/ok",
            permalink: "/r/mlops/comments/good1/valid/",
            score: 10,
            num_comments: 1,
            subreddit: "mlops",
            created_utc: 1744930800,
            is_self: false,
            stickied: false,
          },
        },
        {
          kind: "t3",
          data: {
            id: "rel1",
            title: "Relative URL post",
            url: "/r/mlops/comments/rel1/relative/",
            permalink: "/r/mlops/comments/rel1/relative/",
            score: 5,
            num_comments: 0,
            subreddit: "mlops",
            created_utc: 1744930800,
            is_self: false,
            stickied: false,
          },
        },
        {
          kind: "t3",
          data: {
            id: "empty1",
            title: "Empty URL post",
            url: "   ",
            permalink: "/r/mlops/comments/empty1/empty/",
            score: 3,
            num_comments: 0,
            subreddit: "mlops",
            created_utc: 1744930800,
            is_self: false,
            stickied: false,
          },
        },
        {
          kind: "t3",
          data: {
            id: "noproto1",
            title: "Protocol-less URL post",
            url: "reddit.com/r/mlops/comments/noproto1/",
            permalink: "/r/mlops/comments/noproto1/np/",
            score: 7,
            num_comments: 0,
            subreddit: "mlops",
            created_utc: 1744930800,
            is_self: false,
            stickied: false,
          },
        },
      ],
    },
  });

  it("emits valid RawItems for relative, empty, and protocol-less URL entries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response(MALFORMED_LISTING, { status: 200 });
      const c = new RedditCollector({
        fetchImpl,
        resolveImpl: async (u) => ({ url: u }),
        subreddits: ["mlops"],
      });
      const ctx = ctxWith({});
      const items = await c.fetch(ctx);
      // All four entries should survive; none should be dropped because of URL shape.
      expect(items.length).toBe(4);
      expect(items.map((i) => i.id).sort()).toEqual([
        "reddit-empty1",
        "reddit-good1",
        "reddit-noproto1",
        "reddit-rel1",
      ]);
      for (const it of items) {
        expect(() => new URL(it.url)).not.toThrow();
      }
      expect(ctx.metrics.partialFailures).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips only the malformed child, not the whole subreddit batch", async () => {
    // Listing where one child is structurally broken (missing required fields),
    // but others are fine. The broken one should be dropped silently; the rest
    // should still produce RawItems.
    const PARTIAL_BROKEN = JSON.stringify({
      kind: "Listing",
      data: {
        after: null,
        children: [
          { kind: "t3", data: { nope: true } }, // malformed — missing required fields
          {
            kind: "t3",
            data: {
              id: "ok1",
              title: "Fine post",
              url: "https://example.com/fine",
              permalink: "/r/mlops/comments/ok1/fine/",
              score: 10,
              num_comments: 0,
              subreddit: "mlops",
              created_utc: 1744930800,
              is_self: false,
              stickied: false,
            },
          },
        ],
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response(PARTIAL_BROKEN, { status: 200 });
      const c = new RedditCollector({
        fetchImpl,
        resolveImpl: async (u) => ({ url: u }),
        subreddits: ["mlops"],
      });
      const items = await c.fetch(ctxWith({}));
      expect(items.length).toBe(1);
      expect(items[0]!.id).toBe("reddit-ok1");
    } finally {
      warnSpy.mockRestore();
    }
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
