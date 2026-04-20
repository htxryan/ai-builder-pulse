import { describe, it, expect } from "vitest";
import { MockCurator } from "../src/curator/mockCurator.js";
import type { RawItem } from "../src/types.js";

function mkRaw(id: string): RawItem {
  return {
    id,
    source: "hn",
    title: `title-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T10:00:00.000Z",
    metadata: { source: "hn", points: 1 },
  };
}

describe("MockCurator", () => {
  it("satisfies E-05 count invariant for 1 item", async () => {
    const cur = new MockCurator();
    const out = await cur.curate([mkRaw("a")]);
    expect(out.length).toBe(1);
  });

  it("satisfies E-05 count invariant for 50 items", async () => {
    const cur = new MockCurator();
    const input = Array.from({ length: 50 }, (_, i) => mkRaw(`i${i}`));
    const out = await cur.curate(input);
    expect(out.length).toBe(50);
  });

  it("produces Zod-valid ScoredItems", async () => {
    const cur = new MockCurator();
    const out = await cur.curate([mkRaw("a"), mkRaw("b")]);
    for (const s of out) {
      expect(s.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(s.relevanceScore).toBeLessThanOrEqual(1);
      expect(typeof s.keep).toBe("boolean");
      expect(s.description.length).toBeGreaterThanOrEqual(1);
      expect(s.description.length).toBeLessThanOrEqual(600);
    }
  });

  it("accepts empty input and returns empty output", async () => {
    const cur = new MockCurator();
    const out = await cur.curate([]);
    expect(out).toEqual([]);
  });
});
