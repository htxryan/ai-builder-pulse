import { describe, it, expect } from "vitest";
import { resolveRedirects, MAX_REDIRECT_HOPS } from "../../src/collectors/redirect.js";

function mkFetch(script: Array<{ status: number; location?: string }>): typeof fetch {
  let i = 0;
  const impl: typeof fetch = async () => {
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return new Response(null, {
      status: step.status,
      headers: step.location ? { location: step.location } : {},
    });
  };
  return impl;
}

describe("resolveRedirects (O-06)", () => {
  it("returns the input url when no redirect", async () => {
    const fetchImpl = mkFetch([{ status: 200 }]);
    const r = await resolveRedirects("https://a.com/x", { fetchImpl });
    expect(r.url).toBe("https://a.com/x");
    expect(r.sourceUrl).toBeUndefined();
  });

  it("follows a single 301 and stores original as sourceUrl", async () => {
    const fetchImpl = mkFetch([
      { status: 301, location: "https://b.com/y" },
      { status: 200 },
    ]);
    const r = await resolveRedirects("https://a.com/x", { fetchImpl });
    expect(r.url).toBe("https://b.com/y");
    expect(r.sourceUrl).toBe("https://a.com/x");
  });

  it("caps at MAX_REDIRECT_HOPS", async () => {
    const script: Array<{ status: number; location?: string }> = [];
    for (let i = 0; i < MAX_REDIRECT_HOPS + 2; i += 1) {
      script.push({ status: 302, location: `https://x.com/hop${i + 1}` });
    }
    const fetchImpl = mkFetch(script);
    const r = await resolveRedirects("https://x.com/start", { fetchImpl });
    expect(r.url).toBe(`https://x.com/hop${MAX_REDIRECT_HOPS}`);
    expect(r.sourceUrl).toBe("https://x.com/start");
  });

  it("resolves relative Location headers", async () => {
    const fetchImpl = mkFetch([
      { status: 302, location: "/other" },
      { status: 200 },
    ]);
    const r = await resolveRedirects("https://a.com/start", { fetchImpl });
    expect(r.url).toBe("https://a.com/other");
  });

  it("survives fetch errors by returning the last known url", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network");
    };
    const r = await resolveRedirects("https://a.com/x", { fetchImpl });
    expect(r.url).toBe("https://a.com/x");
  });
});
