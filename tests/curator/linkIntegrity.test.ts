import { describe, it, expect } from "vitest";
import { verifyLinkIntegrity } from "../../src/curator/linkIntegrity.js";
import type { RawItem, ScoredItem } from "../../src/types.js";

function raw(id: string, url: string, sourceUrl?: string): RawItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url,
    ...(sourceUrl ? { sourceUrl } : {}),
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" },
  };
}

function scored(
  id: string,
  url: string,
  description = "A helpful summary of this item that is long enough to pass schema.",
): ScoredItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" },
    category: "Tools & Launches",
    relevanceScore: 0.8,
    keep: true,
    description,
  };
}

describe("verifyLinkIntegrity (C4)", () => {
  it("passes when every scored url is in the raw set", () => {
    const raws = [raw("a", "https://example.com/post")];
    const scoreds = [scored("a", "https://example.com/post")];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.checkedCount).toBe(1);
  });

  it("fails when scored url is not in raw set (planted url)", () => {
    const raws = [raw("a", "https://example.com/post")];
    const scoreds = [scored("a", "https://evil.example.com/fabricated")];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]!.location).toBe("url");
    expect(r.violations[0]!.reason).toBe("not_in_raw_set");
    expect(r.violations[0]!.kind).toBe("not_in_raw_set");
  });

  it("classifies violations as dropped_by_pre_filter when preFilterRaw has the url", () => {
    // `raws` is the post-pre-filter set (empty); `preFilterRaw` simulates
    // the pre-filter collection that included the URL.
    const scoreds = [scored("a", "https://example.com/dropped")];
    const preFilter = [raw("a", "https://example.com/dropped")];
    const r = verifyLinkIntegrity(scoreds, [], [], { preFilterRaw: preFilter });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.kind).toBe("dropped_by_pre_filter");
    expect(r.violations[0]!.reason).toBe("not_in_raw_set"); // legacy field
  });

  it("falls back to not_in_raw_set when URL is absent from preFilterRaw too", () => {
    const scoreds = [scored("a", "https://evil.example.com/fabricated")];
    const preFilter = [raw("a", "https://example.com/unrelated")];
    const r = verifyLinkIntegrity(scoreds, [], [], { preFilterRaw: preFilter });
    expect(r.violations[0]!.kind).toBe("not_in_raw_set");
  });

  it("accepts sourceUrl as an alias of url", () => {
    // raw url is canonical post-redirect; scored output references the
    // pre-redirect sourceUrl — still valid.
    const raws = [
      raw("a", "https://example.com/canonical", "https://t.co/abc"),
    ];
    const scoreds = [scored("a", "https://t.co/abc")];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(true);
  });

  it("canonicalizes before comparison (UTM stripped)", () => {
    const raws = [raw("a", "https://example.com/post")];
    const scoreds = [scored("a", "https://example.com/post?utm_source=hn")];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(true);
  });

  it("detects fabricated urls embedded in description markdown", () => {
    const raws = [raw("a", "https://example.com/post")];
    const desc =
      "See [fabricated](https://evil.example.com/leak) for more details on the topic at hand and then some.";
    const scoreds = [scored("a", "https://example.com/post", desc)];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.location === "description");
    expect(v).toBeDefined();
    expect(v!.url).toBe("https://evil.example.com/leak");
  });

  it("detects bare urls embedded in description text", () => {
    const raws = [raw("a", "https://example.com/post")];
    const desc =
      "See https://evil.example.com/bare for more info on this important topic from today.";
    const scoreds = [scored("a", "https://example.com/post", desc)];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.location === "description");
    expect(v).toBeDefined();
  });

  it("allowlist exempts template URLs from the check", () => {
    const raws = [raw("a", "https://example.com/post")];
    const desc =
      "To unsubscribe visit https://buttondown.com/ai-builder-pulse/unsubscribe anytime you wish.";
    const scoreds = [scored("a", "https://example.com/post", desc)];
    const allow = [/^https:\/\/buttondown\.com\//];
    const r = verifyLinkIntegrity(scoreds, raws, allow);
    expect(r.ok).toBe(true);
  });

  it("flags unparseable urls", () => {
    const raws = [raw("a", "https://example.com/post")];
    const scoreds = [scored("a", "not-a-url")];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.reason).toBe("unparseable");
    expect(r.violations[0]!.kind).toBe("unparseable");
  });

  it("handles many scored items efficiently", () => {
    const raws = Array.from({ length: 100 }, (_, i) =>
      raw(`i${i}`, `https://example.com/p${i}`),
    );
    const scoreds = Array.from({ length: 100 }, (_, i) =>
      scored(`i${i}`, `https://example.com/p${i}`),
    );
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(true);
    expect(r.checkedCount).toBe(100);
  });
});
