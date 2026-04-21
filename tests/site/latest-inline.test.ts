// Tests for the build-time "latest preview" inliner — both the pure
// helpers in `scripts/lib/latestPreview.ts` and the end-to-end behavior
// of `buildSite()` producing a pre-filled `_site/index.html`.

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSite } from "../../scripts/build-site.js";
import {
  categoryCounts,
  escapeHtml,
  formatDateHuman,
  inlineLatestIntoHtml,
  pickTopPick,
  safeExternalHref,
  sourceLabel,
  type PreviewItem,
} from "../../scripts/lib/latestPreview.js";

interface Fixture {
  readonly root: string;
  readonly siteDir: string;
  readonly issuesDir: string;
  readonly outDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "latest-inline-"));
  const siteDir = path.join(root, "site");
  const issuesDir = path.join(root, "issues");
  const outDir = path.join(root, "_site");
  await mkdir(siteDir, { recursive: true });
  await mkdir(issuesDir, { recursive: true });
  return { root, siteDir, issuesDir, outDir };
}

const SKELETON_HTML = `<!doctype html>
<html>
  <body>
    <p class="latest__meta" data-latest-meta>loading the most recent issue…</p>
    <article>
      <div class="latest__skeleton" data-latest-skeleton>
        <div class="line"></div>
      </div>
      <div class="latest__content" data-latest-content hidden>
        <div class="top-pick">
          <p class="top-pick__label">today's top pick</p>
          <h3 class="top-pick__title">
            <a data-latest-toppick-link href="#" rel="noopener"></a>
          </h3>
          <p class="top-pick__source" data-latest-toppick-source></p>
          <p class="top-pick__desc" data-latest-toppick-desc></p>
        </div>
        <div class="categories">
          <h4 class="categories__heading">in this issue</h4>
          <ul class="categories__list" data-latest-categories></ul>
        </div>
        <div class="latest__cta">
          <a class="btn btn--secondary" data-latest-read-full href="#" rel="noopener">
            read the full issue →
          </a>
        </div>
      </div>
      <div class="latest__fallback" data-latest-fallback hidden>
        <p>unavailable</p>
      </div>
    </article>
  </body>
</html>`;

function sampleItems(): PreviewItem[] {
  return [
    {
      title: "Claude <Opus> 4.7 ships",
      url: "https://example.com/claude",
      description: "A step up on long-context tool use & eval scores.",
      source: "hn",
      category: "Model Releases",
      keep: true,
      relevanceScore: 0.98,
      score: 12,
    },
    {
      title: "New MCP server for Postgres",
      url: "https://example.com/mcp-pg",
      description: "Exposes tables as tools.",
      source: "github-trending",
      category: "Tools",
      keep: true,
      relevanceScore: 0.9,
      score: 40,
    },
    {
      title: "Unkept noise",
      url: "https://example.com/noise",
      description: "Should be ignored",
      source: "rss",
      category: "Tools",
      keep: false,
      relevanceScore: 0.99,
      score: 999,
    },
    {
      title: "LocalLLaMA fine-tune thread",
      url: "https://example.com/localllama",
      description: "Reddit discussion",
      source: "reddit",
      category: "Techniques",
      keep: true,
      relevanceScore: 0.6,
      score: 200,
      metadata: { subreddit: "LocalLLaMA" },
    },
  ];
}

async function seedStandardTree(fx: Fixture): Promise<void> {
  await writeFile(path.join(fx.siteDir, "index.html"), SKELETON_HTML);
  await writeFile(path.join(fx.siteDir, "app.js"), "// app");
  await writeFile(path.join(fx.siteDir, "styles.css"), "body{}");

  await writeFile(
    path.join(fx.issuesDir, "latest.json"),
    JSON.stringify({
      date: "2026-04-19",
      path: "issues/2026-04-19/",
      publishId: "em_test",
      publishedAt: "2026-04-19T21:29:11.716Z",
    }),
  );
  const issueDir = path.join(fx.issuesDir, "2026-04-19");
  await mkdir(issueDir, { recursive: true });
  await writeFile(
    path.join(issueDir, "items.json"),
    JSON.stringify({
      runDate: "2026-04-19",
      itemCount: { total: 10, kept: 3 },
      items: sampleItems(),
    }),
  );
  await writeFile(path.join(issueDir, "issue.md"), "# issue");
}

describe("scripts/lib/latestPreview — pure helpers", () => {
  it("pickTopPick matches app.js ranking (relevance desc, score tiebreaker)", () => {
    expect(pickTopPick([])).toBeNull();
    expect(pickTopPick([{ keep: false, relevanceScore: 0.99 }])).toBeNull();
    const items = sampleItems();
    const top = pickTopPick(items);
    expect(top?.title).toBe("Claude <Opus> 4.7 ships");
  });

  it("categoryCounts counts only kept items, sorted by count desc", () => {
    const counts = categoryCounts(sampleItems());
    // Kept items: Model Releases x1, Tools x1, Techniques x1
    expect(counts).toHaveLength(3);
    expect(counts.every(([, n]) => n === 1)).toBe(true);
  });

  it("sourceLabel mirrors app.js (including r/<sub>)", () => {
    expect(sourceLabel({ source: "hn" })).toBe("Hacker News");
    expect(sourceLabel({ source: "github-trending" })).toBe("GitHub Trending");
    expect(sourceLabel({ source: "reddit", metadata: { subreddit: "LocalLLaMA" } })).toBe(
      "r/LocalLLaMA",
    );
    expect(sourceLabel({ source: "reddit" })).toBe("Reddit");
    expect(sourceLabel({ source: "rss" })).toBe("RSS");
    expect(sourceLabel({})).toBe("");
  });

  it("formatDateHuman produces a stable en-US long-form date", () => {
    expect(formatDateHuman("2026-04-19")).toBe("Sunday, April 19, 2026");
  });

  it("safeExternalHref rejects non-http(s) URLs", () => {
    expect(safeExternalHref("https://x.com/y")).toBe("https://x.com/y");
    expect(safeExternalHref("javascript:alert(1)")).toBe("#");
    expect(safeExternalHref("")).toBe("#");
    expect(safeExternalHref(null)).toBe("#");
  });

  it("escapeHtml escapes the five dangerous characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("inlineLatestIntoHtml hides skeleton, unhides content, fills top pick + categories + CTA", () => {
    const html = inlineLatestIntoHtml(SKELETON_HTML, {
      pointer: {
        date: "2026-04-19",
        path: "issues/2026-04-19/",
        publishId: "em_test",
        publishedAt: "2026-04-19T21:29:11.716Z",
      },
      items: {
        itemCount: { total: 10, kept: 3 },
        items: sampleItems(),
      },
    });

    // Skeleton: gains a `hidden` attribute.
    expect(html).toMatch(/data-latest-skeleton[^>]*\bhidden\b/);
    // Content wrapper: loses its `hidden` attribute.
    expect(html).toMatch(/data-latest-content(?![^>]*\bhidden\b)[^>]*>/);
    // Top pick escaped properly (note the `<Opus>` in the title).
    expect(html).toContain("Claude &lt;Opus&gt; 4.7 ships");
    expect(html).toContain(`href="https://example.com/claude"`);
    expect(html).toContain(">Hacker News<");
    // Category list populated.
    expect(html).toMatch(/<li><span>Model Releases<\/span><span>1<\/span><\/li>/);
    expect(html).toMatch(/<li><span>Tools<\/span><span>1<\/span><\/li>/);
    expect(html).toMatch(/<li><span>Techniques<\/span><span>1<\/span><\/li>/);
    // CTA href is same-origin.
    expect(html).toContain(`href="/issues/2026-04-19/"`);
    expect(html).not.toContain("github.com/htxryan");
    // Meta text.
    expect(html).toContain("Sunday, April 19, 2026");
    expect(html).toContain("3 stories");
    expect(html).toContain("3 categories");
    // Fallback still hidden.
    expect(html).toMatch(/data-latest-fallback[^>]*\bhidden\b/);
  });

  it("inlineLatestIntoHtml is deterministic — identical input yields identical output", () => {
    const input = {
      pointer: {
        date: "2026-04-19",
        path: "issues/2026-04-19/",
        publishId: "em_test",
        publishedAt: "2026-04-19T21:29:11.716Z",
      },
      items: { items: sampleItems() },
    };
    const a = inlineLatestIntoHtml(SKELETON_HTML, input);
    const b = inlineLatestIntoHtml(SKELETON_HTML, input);
    expect(a).toBe(b);
  });

  it("inlineLatestIntoHtml with no kept items leaves empty slots (but hides skeleton)", () => {
    const html = inlineLatestIntoHtml(SKELETON_HTML, {
      pointer: {
        date: "2026-04-19",
        path: "issues/2026-04-19/",
        publishId: "em_test",
        publishedAt: "2026-04-19T21:29:11.716Z",
      },
      items: { items: [{ keep: false }] },
    });
    expect(html).toMatch(/data-latest-skeleton[^>]*\bhidden\b/);
    // Still same-origin CTA target even when empty.
    expect(html).toContain(`href="/issues/2026-04-19/"`);
    expect(html).toContain("0 stories");
    expect(html).toContain("0 categories");
  });
});

describe("buildSite — latest preview inlining (AC-4, AC-10)", () => {
  it("writes an index.html pre-filled with the top pick and a same-origin CTA", async () => {
    const fx = await makeFixture();
    try {
      await seedStandardTree(fx);
      await buildSite({
        repoRoot: fx.root,
        outDir: fx.outDir,
        siteDir: fx.siteDir,
        issuesDir: fx.issuesDir,
      });
      const out = await readFile(path.join(fx.outDir, "index.html"), "utf8");
      // AC-4: top pick inlined
      expect(out).toContain("Claude &lt;Opus&gt; 4.7 ships");
      // AC-4: category counts inlined
      expect(out).toMatch(/Model Releases<\/span><span>1<\/span>/);
      // AC-10: read-the-full CTA is same-origin
      expect(out).toContain(`href="/issues/2026-04-19/"`);
      expect(out).not.toContain("github.com/htxryan");
      // Skeleton hidden, content shown.
      expect(out).toMatch(/data-latest-skeleton[^>]*\bhidden\b/);
      expect(out).toMatch(/data-latest-content(?![^>]*\bhidden\b)[^>]*>/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("falls back to the skeleton and warns when issues/latest.json is missing", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), SKELETON_HTML);
      await writeFile(path.join(fx.siteDir, "app.js"), "// app");
      // No latest.json, no per-day items.json.
      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        await buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        });
      } finally {
        console.warn = origWarn;
      }
      const out = await readFile(path.join(fx.outDir, "index.html"), "utf8");
      // Build did not fail.
      expect(out).toContain("data-latest-skeleton");
      // Skeleton is still the unfilled version (no top-pick title).
      expect(out).not.toContain("Claude");
      // At least one warning about the missing pointer.
      expect(
        warnings.some(
          (w) =>
            w.includes("latest pointer unavailable") ||
            w.includes("latest.json is missing"),
        ),
      ).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("falls back to the skeleton and warns when items.json is missing", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), SKELETON_HTML);
      await writeFile(path.join(fx.siteDir, "app.js"), "// app");
      // Pointer present but per-day items.json missing.
      await writeFile(
        path.join(fx.issuesDir, "latest.json"),
        JSON.stringify({
          date: "2026-04-19",
          path: "issues/2026-04-19/",
          publishId: "em_test",
          publishedAt: "2026-04-19T21:29:11.716Z",
        }),
      );
      await mkdir(path.join(fx.issuesDir, "2026-04-19"), { recursive: true });
      // Do NOT create items.json.

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (msg: unknown) => {
        warnings.push(String(msg));
      };
      try {
        await buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        });
      } finally {
        console.warn = origWarn;
      }
      const out = await readFile(path.join(fx.outDir, "index.html"), "utf8");
      expect(out).toContain("data-latest-skeleton");
      expect(out).not.toContain("Claude");
      expect(
        warnings.some((w) => w.includes("items.json for 2026-04-19 unavailable")),
      ).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("falls back to the skeleton when items.json is invalid JSON", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), SKELETON_HTML);
      await writeFile(path.join(fx.siteDir, "app.js"), "// app");
      await writeFile(
        path.join(fx.issuesDir, "latest.json"),
        JSON.stringify({
          date: "2026-04-19",
          path: "issues/2026-04-19/",
          publishId: "em_test",
          publishedAt: "2026-04-19T21:29:11.716Z",
        }),
      );
      const issueDir = path.join(fx.issuesDir, "2026-04-19");
      await mkdir(issueDir, { recursive: true });
      await writeFile(path.join(issueDir, "items.json"), "{not json");

      const origWarn = console.warn;
      console.warn = () => {};
      try {
        await buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        });
      } finally {
        console.warn = origWarn;
      }

      const out = await readFile(path.join(fx.outDir, "index.html"), "utf8");
      // Skeleton preserved; no hidden attribute added (untouched).
      expect(out).toContain("data-latest-skeleton");
      expect(out).not.toContain("Claude");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
