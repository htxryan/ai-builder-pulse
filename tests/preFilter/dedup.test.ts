import { describe, it, expect } from "vitest";
import { dedupByUrl } from "../../src/preFilter/dedup.js";
import type { RawItem } from "../../src/types.js";

function hn(id: string, url: string, score = 1): RawItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url,
    score,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" },
  };
}

function rss(id: string, url: string, score = 1): RawItem {
  return {
    id,
    source: "rss",
    title: `t-${id}`,
    url,
    score,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "rss", feedUrl: "https://feed.example/rss.xml" },
  };
}

describe("dedupByUrl (Un-03)", () => {
  it("keeps a single instance when there is one", () => {
    const r = dedupByUrl([hn("a", "https://example.com/post-1")]);
    expect(r.kept).toHaveLength(1);
    expect(r.removed).toHaveLength(0);
  });

  it("collapses two items that differ only in tracking params to one", () => {
    const items = [
      hn("a", "https://example.com/post-1?utm_source=hn"),
      hn("b", "https://example.com/post-1?utm_source=other"),
    ];
    const r = dedupByUrl(items);
    expect(r.kept).toHaveLength(1);
    expect(r.removed).toHaveLength(1);
  });

  it("keeps the higher-score item on score tiebreak", () => {
    const lo = hn("lo", "https://example.com/x", 1);
    const hi = hn("hi", "https://example.com/x", 5);
    const r = dedupByUrl([lo, hi]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.id).toBe("hi");
  });

  it("breaks score ties by source authority (rss > hn)", () => {
    const a = hn("h", "https://example.com/x", 5);
    const b = rss("r", "https://example.com/x", 5);
    const r = dedupByUrl([a, b]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.id).toBe("r");
  });

  it("drops items whose URL fails to normalize", () => {
    const bad: RawItem = {
      ...hn("bad", "https://example.com/x"),
      url: "javascript:alert(1)" as unknown as string,
    };
    const good = hn("ok", "https://example.com/y");
    const r = dedupByUrl([bad, good]);
    expect(r.kept.map((i) => i.id)).toEqual(["ok"]);
    expect(r.removed.map((i) => i.id)).toEqual(["bad"]);
  });

  it("is order-stable for repeated runs (same input → same kept set)", () => {
    const items = [
      hn("a", "https://example.com/post-1?utm_source=hn"),
      hn("b", "https://example.com/post-1?utm_source=other"),
      rss("c", "https://example.com/post-2"),
    ];
    const a = dedupByUrl(items).kept.map((i) => i.id).sort();
    const b = dedupByUrl(items).kept.map((i) => i.id).sort();
    expect(a).toEqual(b);
  });
});
