import { describe, it, expect } from "vitest";
import { deriveRunDate, isValidRunDate, runDateMinusHours } from "../src/runDate.js";

describe("deriveRunDate", () => {
  it("returns canonical UTC YYYY-MM-DD", () => {
    const d = deriveRunDate(new Date("2026-04-18T09:15:00Z"));
    expect(d).toBe("2026-04-18");
  });

  it("is stable when called repeatedly with same instant", () => {
    const instant = new Date("2026-04-18T23:58:00Z");
    const a = deriveRunDate(instant);
    const b = deriveRunDate(instant);
    const c = deriveRunDate(instant);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("2026-04-18");
  });

  it("handles day-boundary at 23:58 UTC without off-by-one", () => {
    const d = deriveRunDate(new Date("2026-04-18T23:58:00Z"));
    expect(d).toBe("2026-04-18");
  });

  it("crosses to next day at 00:00 UTC", () => {
    const d = deriveRunDate(new Date("2026-04-19T00:00:00Z"));
    expect(d).toBe("2026-04-19");
  });

  it("uses UTC regardless of host timezone input", () => {
    // 06:00 UTC = 02:00 America/New_York but runDate must still be UTC date
    const d = deriveRunDate(new Date("2026-04-18T06:00:00Z"));
    expect(d).toBe("2026-04-18");
  });
});

describe("isValidRunDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(isValidRunDate("2026-04-18")).toBe(true);
  });
  it("rejects invalid formats", () => {
    expect(isValidRunDate("2026/04/18")).toBe(false);
    expect(isValidRunDate("26-4-18")).toBe(false);
    expect(isValidRunDate("")).toBe(false);
  });
});

describe("runDateMinusHours", () => {
  it("produces runDate - 24h at UTC midnight", () => {
    const d = runDateMinusHours("2026-04-18", 24);
    expect(d.toISOString()).toBe("2026-04-17T00:00:00.000Z");
  });
  it("throws on invalid input", () => {
    expect(() => runDateMinusHours("bad", 24)).toThrow();
  });
});
