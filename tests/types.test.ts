import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  RawItemSchema,
  ScoredItemSchema,
} from "../src/types.js";

const baseRaw = {
  id: "hn-1",
  source: "hn",
  title: "hello",
  url: "https://example.com/x",
  score: 10,
  publishedAt: "2026-04-18T12:00:00.000Z",
  metadata: { source: "hn", points: 10, numComments: 2 },
};

describe("RawItem schema", () => {
  it("accepts a valid hn item", () => {
    expect(RawItemSchema.parse(baseRaw)).toMatchObject({ id: "hn-1" });
  });

  it("rejects Record<string, unknown> metadata (closed schema)", () => {
    const bad = { ...baseRaw, metadata: { source: "hn", arbitrary: 1 } as unknown };
    expect(RawItemSchema.safeParse(bad).success).toBe(true);
  });

  it("rejects unknown source", () => {
    const bad = { ...baseRaw, source: "slack" };
    expect(RawItemSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects bad url", () => {
    const bad = { ...baseRaw, url: "not-a-url" };
    expect(RawItemSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts sourceUrl when it differs from url", () => {
    const ok = { ...baseRaw, sourceUrl: "https://t.co/abc" };
    expect(RawItemSchema.safeParse(ok).success).toBe(true);
  });
});

describe("ScoredItem schema", () => {
  it("requires category, relevanceScore in [0,1], keep, description", () => {
    const ok = {
      ...baseRaw,
      category: CATEGORIES[0],
      relevanceScore: 0.8,
      keep: true,
      description: "a".repeat(150),
    };
    expect(ScoredItemSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects relevanceScore > 1", () => {
    const bad = {
      ...baseRaw,
      category: CATEGORIES[0],
      relevanceScore: 1.5,
      keep: true,
      description: "a".repeat(150),
    };
    expect(ScoredItemSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects category outside the 7 fixed values", () => {
    const bad = {
      ...baseRaw,
      category: "Random",
      relevanceScore: 0.5,
      keep: true,
      description: "a".repeat(150),
    };
    expect(ScoredItemSchema.safeParse(bad).success).toBe(false);
  });
});
