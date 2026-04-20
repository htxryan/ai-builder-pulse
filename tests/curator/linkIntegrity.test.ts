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

// DC5 — hardened C4 coverage added for M5. Each case is a negative assertion:
// the renderer/curator-adjacent guard must reject even "plausible" fabrications.
describe("verifyLinkIntegrity — DC5 hardened negative cases (M5)", () => {
  it("rejects a url whose substring matches a title fragment (title text is not a whitelist)", () => {
    // Agent emits a URL whose path happens to contain a word from the raw
    // title. C4 ignores titles entirely — membership is strictly against the
    // raw URL set — so the fabrication is caught.
    const raws = [raw("a", "https://example.com/post")];
    const scoreds = [
      {
        ...scored("a", "https://attacker.example/post"),
        title: "helpful post about things",
      },
    ];
    const r = verifyLinkIntegrity(scoreds as ScoredItem[], raws);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.kind).toBe("not_in_raw_set");
    expect(r.violations[0]!.location).toBe("url");
  });

  it("rejects a fabricated markdown link whose label matches a real title", () => {
    // The label text of `[label](url)` must not grant the url legitimacy —
    // extraction pulls the URL, which is then checked against the raw set.
    const raws = [raw("a", "https://example.com/post")];
    const desc =
      "Discussion: [real post title used as label](https://evil.example.com/fabricated-link) — worth a look today.";
    const scoreds = [scored("a", "https://example.com/post", desc)];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.location === "description");
    expect(v).toBeDefined();
    expect(v!.url).toBe("https://evil.example.com/fabricated-link");
    expect(v!.kind).toBe("not_in_raw_set");
  });

  it("one valid in-set url does not whitewash a second hallucinated url in the same description", () => {
    // Even when the description mixes a verified in-set url with a fabricated
    // one, C4 checks every extracted url independently. The "tool validated
    // url A" state MUST NOT cause trust to leak onto url B.
    const raws = [raw("a", "https://example.com/real-post")];
    const desc =
      "See [the real one](https://example.com/real-post) and also [bonus](https://evil.example.com/leak) for context, both valuable additions.";
    const scoreds = [scored("a", "https://example.com/real-post", desc)];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.url).toBe("https://evil.example.com/leak");
  });

  it("rejects a fabricated url embedded between two valid urls", () => {
    const raws = [
      raw("a", "https://example.com/first"),
      raw("b", "https://example.com/second"),
    ];
    const desc =
      "Read https://example.com/first then maybe https://evil.example.com/in-between and finally https://example.com/second for the full picture.";
    const scoreds = [scored("a", "https://example.com/first", desc)];
    const r = verifyLinkIntegrity(scoreds, raws);
    expect(r.ok).toBe(false);
    const fabricated = r.violations.find(
      (v) => v.url === "https://evil.example.com/in-between",
    );
    expect(fabricated).toBeDefined();
    expect(fabricated!.kind).toBe("not_in_raw_set");
  });
});
