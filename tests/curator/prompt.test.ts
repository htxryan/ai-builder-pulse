import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "../../src/curator/prompt.js";
import { CATEGORIES } from "../../src/types.js";

describe("SYSTEM_PROMPT", () => {
  it("is a non-empty string with a versioned tag", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(400);
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(SYSTEM_PROMPT).toContain(`Prompt version: ${PROMPT_VERSION}`);
  });

  it("enumerates all seven categories verbatim", () => {
    for (const cat of CATEGORIES) {
      expect(SYSTEM_PROMPT).toContain(cat);
    }
  });

  it("declares the E-05 count invariant in plain language", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("exactly one record");
    expect(SYSTEM_PROMPT).toContain("keep");
  });
});
