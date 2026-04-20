// Tests for the brochure site at `site/`. These stay zero-dep: no jsdom
// and no YAML library. DOM-level assertions are done by reading the HTML
// string and grepping for structural invariants (form `action`, required
// IDs, required meta tags). Pure helpers in `site/app.js` are imported
// and tested directly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// Path relative to the repo root; vitest runs with cwd=repoRoot.
import {
  LatestPointerSchema,
  latestJsonPath,
} from "../../src/archivist/index.js";

const repoRoot = process.cwd();
const sitePath = (p: string) => path.join(repoRoot, "site", p);
const readSite = (p: string) => readFileSync(sitePath(p), "utf8");

const BUTTONDOWN_EMBED_URL =
  "https://buttondown.com/api/emails/embed-subscribe/ai-builder-pulse";

describe("brochure site — HTML structure (AC-9, AC-12, AC-17)", () => {
  const html = readSite("index.html");

  it("has the required meta tags for SEO / social", () => {
    // AC-17 — head metadata for sharing.
    expect(html).toMatch(/<title>[^<]*AI Builder Pulse[^<]*<\/title>/i);
    expect(html).toMatch(/<meta\s+name="description"/i);
    expect(html).toMatch(/property="og:title"/);
    expect(html).toMatch(/property="og:description"/);
    expect(html).toMatch(/property="og:image"/);
    expect(html).toMatch(/name="twitter:card"/);
    expect(html).toMatch(/name="twitter:image"/);
  });

  it("declares viewport and a dark color scheme", () => {
    expect(html).toMatch(/<meta\s+name="viewport"\s+content="width=device-width[^"]*"/i);
    expect(html).toMatch(/<meta\s+name="color-scheme"\s+content="dark"/i);
  });

  it("exposes the expected data hooks for the app script", () => {
    // Essential hooks the app.js relies on — if these rename without
    // updating the script, the preview silently breaks.
    for (const hook of [
      "data-latest-skeleton",
      "data-latest-content",
      "data-latest-fallback",
      "data-latest-meta",
      "data-latest-toppick-link",
      "data-latest-toppick-source",
      "data-latest-toppick-desc",
      "data-latest-categories",
      "data-latest-read-full",
      "data-signup-success",
    ]) {
      expect(html, `missing hook: ${hook}`).toContain(hook);
    }
  });

  it("has at least two Buttondown-embed signup forms (AC-12)", () => {
    const matches = html.match(new RegExp(BUTTONDOWN_EMBED_URL, "g")) || [];
    // Hero form + bottom form = two form actions (other matches in comments
    // are tolerated but we expect >= 2).
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("each signup form submits POST to the Buttondown embed URL with an `email` input (AC-9)", () => {
    // Count <form ...> blocks that include the embed URL and an email input.
    const formRe = /<form\b[^>]*action="([^"]+)"[^>]*method="post"[\s\S]*?<\/form>/gi;
    let found = 0;
    for (const m of html.matchAll(formRe)) {
      const block = m[0];
      const action = m[1];
      if (action !== BUTTONDOWN_EMBED_URL) continue;
      expect(block).toMatch(/name="email"/);
      expect(block).toMatch(/type="email"/);
      expect(block).toMatch(/target="popupwindow"/);
      found += 1;
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });
});

describe("brochure site — CSS craft (AC-13, AC-15)", () => {
  const css = readSite("styles.css");

  it("contains the synthwave horizon primitives (AC-13)", () => {
    // Perspective-grid horizon: a 3D rotateX on .hero__grid-floor.
    expect(css).toMatch(/\.hero__grid-floor[\s\S]*?perspective\(/);
    // Chrome wordmark via background-clip: text.
    expect(css).toMatch(/background-clip:\s*text/);
    // No external image/CDN URLs (no url(http...) references).
    expect(css).not.toMatch(/url\(\s*https?:/i);
  });

  it("respects prefers-reduced-motion by disabling the grid animation (AC-15)", () => {
    // The @media (prefers-reduced-motion: reduce) block must exist and
    // explicitly null out the grid floor's animation.
    const rmRe = /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\}\s*\}/;
    const m = css.match(rmRe);
    expect(m, "missing prefers-reduced-motion block").not.toBeNull();
    expect(m![0]).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(m![0]).toMatch(/\.hero__grid-floor\s*\{\s*animation:\s*none/);
  });
});

describe("brochure site — pure helpers (AC-1..AC-4)", () => {
  // app.js exports a `__test` namespace with the pure helpers. Vitest can
  // import ES modules directly so we consume it as a normal module.
  it("parsePointer accepts a valid pointer and rejects invalid shapes", async () => {
    const mod = await import("../../site/app.js");
    const { parsePointer } = mod.__test as {
      parsePointer: (o: unknown) => unknown;
    };
    expect(
      parsePointer({
        date: "2026-04-19",
        path: "issues/2026-04-19/",
        publishId: "em_abc",
        publishedAt: "2026-04-19T21:29:11.716Z",
      }),
    ).toEqual({
      date: "2026-04-19",
      path: "issues/2026-04-19/",
      publishId: "em_abc",
      publishedAt: "2026-04-19T21:29:11.716Z",
    });
    expect(parsePointer(null)).toBeNull();
    expect(parsePointer({})).toBeNull();
    expect(parsePointer({ date: "bad", path: "issues/x/", publishId: "a", publishedAt: "t" })).toBeNull();
    expect(parsePointer({ date: "2026-04-19", path: "not-issues/", publishId: "a", publishedAt: "t" })).toBeNull();
  });

  it("pickTopPick selects the highest relevanceScore among kept items, breaking ties by score", async () => {
    const mod = await import("../../site/app.js");
    const { pickTopPick } = mod.__test as { pickTopPick: (a: unknown[]) => unknown };

    // Kept-only: a relevance=0.99 item that is NOT kept must be ignored.
    const unkept = pickTopPick([
      { keep: false, relevanceScore: 0.99, title: "dropped" },
      { keep: true, relevanceScore: 0.4, title: "only-kept" },
    ]) as { title: string };
    expect(unkept.title).toBe("only-kept");

    // Highest relevance wins outright.
    const byRel = pickTopPick([
      { keep: true, relevanceScore: 0.7, title: "lower" },
      { keep: true, relevanceScore: 0.95, title: "higher" },
    ]) as { title: string };
    expect(byRel.title).toBe("higher");

    // Ties in relevance break by score descending.
    const tie = pickTopPick([
      { keep: true, relevanceScore: 0.9, score: 10, title: "tie-low" },
      { keep: true, relevanceScore: 0.9, score: 99, title: "tie-high" },
    ]) as { title: string };
    expect(tie.title).toBe("tie-high");
  });

  it("categoryCounts groups kept items by category, highest first", async () => {
    const mod = await import("../../site/app.js");
    const { categoryCounts } = mod.__test as {
      categoryCounts: (a: unknown[]) => Array<[string, number]>;
    };
    const counts = categoryCounts([
      { keep: true, category: "Tools" },
      { keep: true, category: "Tools" },
      { keep: true, category: "Model Releases" },
      { keep: false, category: "Tools" },
      { keep: true, category: "Model Releases" },
      { keep: true, category: "Techniques" },
    ]);
    expect(counts[0]).toEqual(["Tools", 2]);
    expect(counts).toContainEqual(["Model Releases", 2]);
    expect(counts).toContainEqual(["Techniques", 1]);
  });

  it("sourceLabel maps source ids to human strings (including r/<sub>)", async () => {
    const mod = await import("../../site/app.js");
    const { sourceLabel } = mod.__test as {
      sourceLabel: (i: { source?: string; metadata?: { subreddit?: string } }) => string;
    };
    expect(sourceLabel({ source: "hn" })).toBe("Hacker News");
    expect(sourceLabel({ source: "github-trending" })).toBe("GitHub Trending");
    expect(sourceLabel({ source: "reddit", metadata: { subreddit: "LocalLLaMA" } })).toBe("r/LocalLLaMA");
    expect(sourceLabel({ source: "reddit" })).toBe("Reddit");
    expect(sourceLabel({ source: "rss" })).toBe("RSS");
  });

  it("cache TTL is 15 minutes, cache key is versioned", async () => {
    const mod = await import("../../site/app.js");
    const { CACHE_KEY, CACHE_TTL_MS } = mod.__test as {
      CACHE_KEY: string;
      CACHE_TTL_MS: number;
    };
    expect(CACHE_KEY).toBe("abp:latest:v1");
    expect(CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("brochure site — latest.json roundtrip (AC-5)", () => {
  it("the archivist pointer schema matches what app.js expects", () => {
    const sample = {
      date: "2026-04-19",
      path: "issues/2026-04-19/",
      publishId: "em_roundtrip",
      publishedAt: "2026-04-19T21:29:11.716Z",
    };
    // Archivist-side parse
    expect(() => LatestPointerSchema.parse(sample)).not.toThrow();
  });

  it("latestJsonPath resolves to issues/latest.json under any repo root", () => {
    expect(latestJsonPath("/tmp/x")).toBe(path.join("/tmp/x", "issues", "latest.json"));
  });
});

describe(".github/workflows/pages.yml (AC-18..AC-21)", () => {
  const yml = readFileSync(path.join(repoRoot, ".github", "workflows", "pages.yml"), "utf8");

  it("pins the official Pages actions (AC-18)", () => {
    expect(yml).toMatch(/actions\/configure-pages@v5/);
    expect(yml).toMatch(/actions\/upload-pages-artifact@v3/);
    expect(yml).toMatch(/actions\/deploy-pages@v4/);
  });

  it("triggers on pushes that touch site/, issues/, or the workflow itself (AC-19)", () => {
    // Path filter block under `on.push.paths`.
    expect(yml).toMatch(/paths:\s*\n\s*-\s*"site\/\*\*"/);
    expect(yml).toMatch(/-\s*"issues\/\*\*"/);
    expect(yml).toMatch(/-\s*"\.github\/workflows\/pages\.yml"/);
    expect(yml).toMatch(/branches:\s*\[main\]/);
  });

  it("serializes deploys on the `pages` concurrency group without cancelling in-progress", () => {
    expect(yml).toMatch(/concurrency:\s*\n\s*group:\s*pages/);
    expect(yml).toMatch(/cancel-in-progress:\s*false/);
  });

  it("has the Pages-required permissions triad (AC-18)", () => {
    expect(yml).toMatch(/permissions:[\s\S]*?contents:\s*read/);
    expect(yml).toMatch(/permissions:[\s\S]*?pages:\s*write/);
    expect(yml).toMatch(/permissions:[\s\S]*?id-token:\s*write/);
  });

  it("assembles site/ and issues/ into the artifact root (AC-20)", () => {
    // Artifact path matches the assembly directory.
    expect(yml).toMatch(/path:\s*_site/);
    expect(yml).toMatch(/cp\s+-R\s+site\/\.\s+_site\//);
    expect(yml).toMatch(/issues\/latest\.json/);
  });

  it("does NOT execute the newsletter pipeline (AC-21)", () => {
    // Strip comment-only lines (documentation may reference `pnpm start`
    // for contrast) then assert no executable line runs the pipeline.
    const executable = yml
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(executable).not.toMatch(/pnpm\s+start/);
    expect(executable).not.toMatch(/pnpm\s+run\s+start/);
    expect(executable).not.toMatch(/node\s+--import\s+tsx\s+src\/index\.ts/);
  });
});
