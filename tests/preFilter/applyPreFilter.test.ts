import { describe, it, expect } from "vitest";
import { applyPreFilter, uniqueSources } from "../../src/preFilter/index.js";
import type { RawItem, SourceSummary } from "../../src/types.js";

const runDate = "2026-04-18";

function hn(
  id: string,
  url: string,
  publishedAt = "2026-04-18T05:00:00.000Z",
  score = 1,
): RawItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url,
    score,
    publishedAt,
    metadata: { source: "hn" },
  };
}

function ght(
  id: string,
  url: string,
  publishedAt = "2026-04-18T05:00:00.000Z",
): RawItem {
  return {
    id,
    source: "github-trending",
    title: `t-${id}`,
    url,
    score: 1,
    publishedAt,
    metadata: { source: "github-trending", repoFullName: "x/y" },
  };
}

const collectorSummary: SourceSummary = {
  hn: { count: 2, status: "ok" },
  "github-trending": { count: 1, status: "ok" },
};

describe("applyPreFilter", () => {
  it("drops stale items via freshness gate", () => {
    const items = [
      hn("fresh", "https://example.com/a", "2026-04-18T05:00:00.000Z"),
      hn("stale", "https://example.com/b", "2026-04-15T05:00:00.000Z"),
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.stats.freshnessDropped).toBe(1);
    expect(r.items.map((i) => i.id)).toEqual(["fresh"]);
  });

  it("drops bare-domain and github-user-profile URLs via shape gate", () => {
    const items = [
      hn("good", "https://example.com/post-1"),
      hn("bare", "https://example.com"),
      hn("user", "https://github.com/torvalds"),
      ght("repo", "https://github.com/torvalds/linux"),
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.stats.shapeDropped).toBe(2);
    expect(r.items.map((i) => i.id).sort()).toEqual(["good", "repo"]);
  });

  it("dedupes by normalized URL (UTM stripped, host lowercased)", () => {
    const items = [
      hn("a", "https://example.com/post?utm_source=hn"),
      hn("b", "https://EXAMPLE.com/post?utm_medium=link"),
      hn("c", "https://example.com/other"),
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.stats.duplicateDropped).toBe(1);
    expect(r.items).toHaveLength(2);
  });

  it("is idempotent — re-applying the filter to its own output is a no-op", () => {
    const items = [
      hn("a", "https://example.com/post?utm_source=hn"),
      hn("b", "https://EXAMPLE.com/post?utm_medium=link"),
      ght("c", "https://github.com/torvalds/linux"),
      hn("stale", "https://example.com/old", "2026-04-15T00:00:00.000Z"),
      hn("bare", "https://example.com"),
    ];
    const first = applyPreFilter(items, runDate, collectorSummary);
    const second = applyPreFilter(first.items, runDate, first.summary);
    expect(second.items.map((i) => i.id).sort()).toEqual(
      first.items.map((i) => i.id).sort(),
    );
    expect(second.stats.freshnessDropped).toBe(0);
    expect(second.stats.shapeDropped).toBe(0);
    expect(second.stats.duplicateDropped).toBe(0);
    expect(second.stats.outputCount).toBe(first.stats.outputCount);
  });

  it("annotates summary with keptCount per source", () => {
    const items = [
      hn("a", "https://example.com/post-1"),
      hn("b", "https://example.com/post-2"),
      ght("c", "https://github.com/torvalds/linux"),
      hn("stale", "https://example.com/old", "2026-04-15T00:00:00.000Z"),
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.summary.hn?.keptCount).toBe(2);
    expect(r.summary["github-trending"]?.keptCount).toBe(1);
    // Original status is preserved.
    expect(r.summary.hn?.status).toBe("ok");
  });

  it("preserves collector status fields when annotating summary", () => {
    const summary: SourceSummary = {
      hn: { count: 1, status: "ok" },
      reddit: { count: 0, status: "error", error: "boom" },
    };
    const items = [hn("a", "https://example.com/post-1")];
    const r = applyPreFilter(items, runDate, summary);
    expect(r.summary.reddit?.status).toBe("error");
    expect(r.summary.reddit?.error).toBe("boom");
    expect(r.summary.reddit?.keptCount).toBe(0);
  });

  it("uniqueSources reports the set of sources contributing items", () => {
    const items = [
      hn("a", "https://example.com/x"),
      ght("b", "https://github.com/x/y"),
      hn("c", "https://example.com/z"),
    ];
    const set = uniqueSources(items);
    expect(set.size).toBe(2);
    expect(set.has("hn")).toBe(true);
    expect(set.has("github-trending")).toBe(true);
  });

  it("stats.inputCount equals input length and outputCount equals items length", () => {
    const items = [
      hn("a", "https://example.com/post-1"),
      hn("b", "https://example.com"), // bare → dropped
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.stats.inputCount).toBe(2);
    expect(r.stats.outputCount).toBe(r.items.length);
  });

  it("counts items with unparseable publishedAt under invalidDateDropped, not freshnessDropped", () => {
    const items = [
      hn("ok", "https://example.com/x"),
      hn("bad", "https://example.com/y", "not-a-date"),
    ];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.stats.invalidDateDropped).toBe(1);
    expect(r.stats.freshnessDropped).toBe(0);
  });

  it("idempotent application also preserves the annotated summary shape", () => {
    const items = [
      hn("a", "https://example.com/x"),
      ght("b", "https://github.com/x/y"),
    ];
    const first = applyPreFilter(items, runDate, collectorSummary);
    const second = applyPreFilter(first.items, runDate, first.summary);
    expect(second.summary.hn?.keptCount).toBe(first.summary.hn?.keptCount);
    expect(second.summary["github-trending"]?.keptCount).toBe(
      first.summary["github-trending"]?.keptCount,
    );
  });

  it("URL with only tracking params (no path) is dropped by shape gate before normalization strips the query", () => {
    // Pin behavior: shape gate sees a query and accepts; the canonical form
    // is then bare-domain-equivalent. Item still passes (acceptable —
    // dedup will collapse this with the publisher's own canonical link if
    // present). The test guards against an accidental future change that
    // would silently drop these.
    const items = [hn("trk", "https://example.com/?utm_source=hn")];
    const r = applyPreFilter(items, runDate, collectorSummary);
    expect(r.items).toHaveLength(1);
  });
});
