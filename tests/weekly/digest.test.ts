import { describe, it, expect } from "vitest";
import {
  buildWeeklyDigest,
  isoWeekId,
  priorSevenDays,
  type ArchivedDay,
} from "../../src/weekly/digest.js";
import type { ScoredItem } from "../../src/types.js";

const scored = (over: Partial<ScoredItem> & Pick<ScoredItem, "id">): ScoredItem => ({
  source: "hn",
  title: `t-${over.id}`,
  url: `https://example.com/${over.id}`,
  score: 1,
  publishedAt: "2026-04-18T01:00:00.000Z",
  metadata: { source: "hn", points: 1 },
  category: "Tools & Launches",
  relevanceScore: 0.5,
  keep: true,
  description: `desc ${over.id}`,
  ...over,
});

describe("isoWeekId", () => {
  it("matches `date +%G-W%V` for known dates", () => {
    // 2026-04-18 is Saturday; ISO week = 2026-W16
    expect(isoWeekId(new Date("2026-04-18T12:00:00Z"))).toBe("2026-W16");
    // 2024-12-30 is Monday; ISO week = 2025-W01 (year boundary)
    expect(isoWeekId(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01");
  });
});

describe("priorSevenDays", () => {
  it("returns 7 ascending YYYY-MM-DD strings ending at endDate", () => {
    const out = priorSevenDays("2026-04-18");
    expect(out).toEqual([
      "2026-04-12",
      "2026-04-13",
      "2026-04-14",
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
      "2026-04-18",
    ]);
  });
});

describe("buildWeeklyDigest", () => {
  const mkDay = (runDate: string, items: ScoredItem[]): ArchivedDay => ({
    runDate,
    items,
  });

  it("selects top-N across days by relevanceScore DESC", () => {
    const days = [
      mkDay("2026-04-17", [
        scored({ id: "alpha", relevanceScore: 0.9 }),
        scored({ id: "beta", relevanceScore: 0.3 }),
      ]),
      mkDay("2026-04-18", [scored({ id: "gamma", relevanceScore: 0.7 })]),
    ];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: days,
      missingDays: [],
      topN: 2,
    });
    expect(digest.itemCount).toBe(2);
    expect(digest.body).toContain("/alpha");
    expect(digest.body).toContain("/gamma");
    expect(digest.body).not.toContain("/beta");
  });

  it("dedups items appearing on multiple days by id, keeping highest score", () => {
    const days = [
      mkDay("2026-04-17", [scored({ id: "dup", relevanceScore: 0.5 })]),
      mkDay("2026-04-18", [scored({ id: "dup", relevanceScore: 0.95 })]),
    ];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: days,
      missingDays: [],
      topN: 5,
    });
    expect(digest.itemCount).toBe(1);
  });

  it("ignores keep:false items", () => {
    const days = [
      mkDay("2026-04-18", [
        scored({ id: "alpha", keep: true, relevanceScore: 0.5 }),
        scored({ id: "beta", keep: false, relevanceScore: 0.99 }),
      ]),
    ];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: days,
      missingDays: [],
    });
    expect(digest.itemCount).toBe(1);
    expect(digest.body).toContain("/alpha");
    expect(digest.body).not.toContain("/beta");
  });

  it("annotates missing days (E-02 tolerant-to-<7)", () => {
    const days = [
      mkDay("2026-04-18", [scored({ id: "a", relevanceScore: 0.5 })]),
    ];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: days,
      missingDays: ["2026-04-12", "2026-04-13"],
    });
    expect(digest.body).toContain("2 days missing");
    expect(digest.body).toContain("2026-04-12");
  });

  it("handles zero selected items gracefully", () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: [mkDay("2026-04-18", [scored({ id: "a", keep: false })])],
      missingDays: [],
    });
    expect(digest.itemCount).toBe(0);
    expect(digest.body).toContain("No items met the relevance threshold");
  });

  it("subject matches AI Builder Pulse Weekly — {weekId}", () => {
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: [],
      missingDays: [],
    });
    expect(digest.subject).toBe("AI Builder Pulse Weekly — 2026-W16");
  });

  it("groups items by category in declared order", () => {
    const days = [
      mkDay("2026-04-18", [
        scored({ id: "a", category: "News in Brief", relevanceScore: 0.9 }),
        scored({ id: "b", category: "Tools & Launches", relevanceScore: 0.8 }),
      ]),
    ];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays: days,
      missingDays: [],
    });
    // Tools & Launches header appears BEFORE News in Brief header in the body.
    const toolsIdx = digest.body.indexOf("## Tools & Launches");
    const newsIdx = digest.body.indexOf("## News in Brief");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(newsIdx).toBeGreaterThan(toolsIdx);
  });
});
