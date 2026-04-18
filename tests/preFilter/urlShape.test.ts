import { describe, it, expect } from "vitest";
import { validateUrlShape } from "../../src/preFilter/urlShape.js";

describe("validateUrlShape (Un-02)", () => {
  it("accepts a normal article URL", () => {
    expect(validateUrlShape("https://example.com/blog/post-1").ok).toBe(true);
  });

  it("accepts URLs with a meaningful query even if path is /", () => {
    expect(validateUrlShape("https://example.com/?id=42").ok).toBe(true);
  });

  it("rejects bare-domain URLs (no path, no query)", () => {
    const r = validateUrlShape("https://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bare_domain");
  });

  it("rejects bare-domain URLs with trailing slash only", () => {
    const r = validateUrlShape("https://example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bare_domain");
  });

  it("rejects scheme-invalid URLs", () => {
    const r = validateUrlShape("ftp://example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_invalid");
  });

  it("rejects unparseable strings as scheme_invalid", () => {
    const r = validateUrlShape("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_invalid");
  });

  it("rejects github.com user-profile URLs", () => {
    const a = validateUrlShape("https://github.com/torvalds");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("github_user_profile");

    const b = validateUrlShape("https://github.com/torvalds/");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("github_user_profile");
  });

  it("accepts github.com repo URLs", () => {
    expect(validateUrlShape("https://github.com/torvalds/linux").ok).toBe(true);
    expect(
      validateUrlShape("https://github.com/torvalds/linux/releases").ok,
    ).toBe(true);
  });

  it("rejects github.com/orgs/<org> as a profile-equivalent page", () => {
    const r = validateUrlShape("https://github.com/orgs/anthropics");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("github_user_profile");
  });

  it("accepts github.com/orgs/<org>/repositories style deep paths", () => {
    expect(
      validateUrlShape("https://github.com/orgs/anthropics/repositories").ok,
    ).toBe(true);
  });

  it("tags github navigation paths with github_non_article (not user_profile)", () => {
    for (const p of ["explore", "trending", "marketplace", "settings", "topics"]) {
      const r = validateUrlShape(`https://github.com/${p}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("github_non_article");
    }
  });
});
