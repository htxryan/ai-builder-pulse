import { describe, it, expect } from "vitest";
import {
  freshnessCutoffMs,
  freshnessVerdict,
  isFresh,
} from "../../src/preFilter/freshness.js";

describe("freshness gate (U-03 / S-01)", () => {
  const runDate = "2026-04-18";
  // Cutoff is midnight(2026-04-18) − 24h = 2026-04-17T00:00:00Z
  const cutoffIso = "2026-04-17T00:00:00.000Z";

  it("computes the cutoff as midnight(runDate) − 24h", () => {
    expect(freshnessCutoffMs(runDate)).toBe(Date.parse(cutoffIso));
  });

  it("keeps an item exactly at the cutoff (>= boundary)", () => {
    expect(isFresh(cutoffIso, runDate)).toBe(true);
  });

  it("drops an item dated 25h before runDate-midnight", () => {
    expect(isFresh("2026-04-16T23:00:00.000Z", runDate)).toBe(false);
  });

  it("keeps an item dated 23h before runDate-midnight", () => {
    expect(isFresh("2026-04-17T01:00:00.000Z", runDate)).toBe(true);
  });

  it("keeps a same-day item", () => {
    expect(isFresh("2026-04-18T05:00:00.000Z", runDate)).toBe(true);
  });

  it("returns false for an unparseable timestamp", () => {
    expect(isFresh("not-a-date", runDate)).toBe(false);
  });

  it("respects a custom hours window", () => {
    // 48h cutoff: midnight(2026-04-18) − 48h = 2026-04-16T00:00:00Z
    expect(isFresh("2026-04-16T01:00:00.000Z", runDate, 48)).toBe(true);
    expect(isFresh("2026-04-15T23:00:00.000Z", runDate, 48)).toBe(false);
  });

  it("freshnessVerdict separates stale from invalid_date", () => {
    expect(freshnessVerdict("2026-04-18T05:00:00.000Z", runDate)).toBe("fresh");
    expect(freshnessVerdict("2026-04-15T05:00:00.000Z", runDate)).toBe("stale");
    expect(freshnessVerdict("not-a-date", runDate)).toBe("invalid_date");
  });

  it("flags clearly future-dated items as 'future' (past 1h skew tolerance)", () => {
    const now = new Date("2026-04-18T12:00:00.000Z");
    // 2 hours ahead — well past skew allowance.
    expect(
      freshnessVerdict("2026-04-18T14:00:00.000Z", runDate, 24, now),
    ).toBe("future");
    // Tomorrow-dated — clearly future.
    expect(
      freshnessVerdict("2026-04-19T12:00:00.000Z", runDate, 24, now),
    ).toBe("future");
  });

  it("tolerates 1h of forward clock skew (not marked future)", () => {
    const now = new Date("2026-04-18T12:00:00.000Z");
    // 30 min ahead — within skew.
    expect(
      freshnessVerdict("2026-04-18T12:30:00.000Z", runDate, 24, now),
    ).toBe("fresh");
  });
});
