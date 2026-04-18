import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GithubTrendingCollector,
  parseTrendingHtml,
} from "../../src/collectors/githubTrending.js";
import type { CollectorContext } from "../../src/collectors/types.js";
import { makeCollectorMetrics } from "../../src/collectors/types.js";

const HTML = readFileSync(
  path.join(process.cwd(), "fixtures", "github-trending.html"),
  "utf8",
);

function makeCtx(): CollectorContext {
  return {
    runDate: "2026-04-18",
    cutoffMs: 0,
    abortSignal: new AbortController().signal,
    env: {},
    metrics: makeCollectorMetrics(),
  };
}

describe("parseTrendingHtml", () => {
  it("extracts owner/repo rows and skips user-profile rows", () => {
    const repos = parseTrendingHtml(HTML);
    const names = repos.map((r) => r.fullName);
    expect(names).toContain("acme/ai-agent");
    expect(names).toContain("llmco/prompt-lab");
    expect(names).not.toContain("soloperson");
  });

  it("parses stars and starsToday", () => {
    const repos = parseTrendingHtml(HTML);
    const first = repos.find((r) => r.fullName === "acme/ai-agent")!;
    expect(first.stars).toBe(1234);
    expect(first.starsToday).toBe(200);
    expect(first.language).toBe("TypeScript");
  });
});

describe("GithubTrendingCollector", () => {
  it("returns RawItems with github-trending metadata", async () => {
    const fetchImpl = async () => new Response(HTML, { status: 200 });
    const c = new GithubTrendingCollector({ fetchImpl });
    const items = await c.fetch(makeCtx());
    expect(items.length).toBe(2);
    const acme = items.find((i) => i.id === "ght-acme-ai-agent")!;
    expect(acme.source).toBe("github-trending");
    expect(acme.url).toBe("https://github.com/acme/ai-agent");
    expect(acme.metadata).toMatchObject({
      source: "github-trending",
      repoFullName: "acme/ai-agent",
      stars: 1234,
      starsToday: 200,
      language: "TypeScript",
    });
  });

  it("propagates http errors", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    const c = new GithubTrendingCollector({ fetchImpl });
    await expect(c.fetch(makeCtx())).rejects.toThrow(/500/);
  });
});
