// Unit tests for `scripts/build-site.ts` — the Pages artifact assembler.
//
// These exercise the importable `buildSite` function against a tmpdir
// fixture (so there's no dependency on the real repo's `site/` and
// `issues/` trees), and cover:
//   - correct output layout when both `site/` and `issues/` exist,
//   - idempotence (two runs produce the same tree),
//   - the `latest.json` lift-to-root behaviour and the missing-pointer
//     warning path,
//   - loud failure when `site/` is missing (AC-3 surface).
//
// Also spawns the script end-to-end via `tsx` to assert the process
// exits non-zero on a missing `site/`, which is the contract the
// workflow relies on.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildSite, parseArgs } from "../../scripts/build-site.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "build-site.ts");

interface Fixture {
  readonly root: string;
  readonly siteDir: string;
  readonly issuesDir: string;
  readonly outDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "build-site-"));
  const siteDir = path.join(root, "site");
  const issuesDir = path.join(root, "issues");
  const outDir = path.join(root, "_site");
  await mkdir(siteDir, { recursive: true });
  await mkdir(issuesDir, { recursive: true });
  return { root, siteDir, issuesDir, outDir };
}

async function seedStandardTree(fx: Fixture): Promise<void> {
  // Minimal brochure layout.
  await writeFile(path.join(fx.siteDir, "index.html"), "<!doctype html><title>x</title>");
  await writeFile(path.join(fx.siteDir, "app.js"), "// app");
  await writeFile(path.join(fx.siteDir, "styles.css"), "body{}");
  await writeFile(path.join(fx.siteDir, "CNAME"), "pulse.example.dev\n");

  // Minimal issues archive.
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
  // Empty-but-valid items payload keeps the build-site inliner quiet (the
  // shape is what the latest-preview pure helper expects). Inlining
  // behaviour itself is covered by `latest-inline.test.ts`.
  await writeFile(
    path.join(issueDir, "items.json"),
    JSON.stringify({ items: [], itemCount: { total: 0, kept: 0 } }),
  );
  await writeFile(path.join(issueDir, "issue.md"), "# issue");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("parseArgs", () => {
  it("defaults outDir to _site", () => {
    expect(parseArgs([])).toEqual({ outDir: "_site" });
  });

  it("accepts --out <dir>", () => {
    expect(parseArgs(["--out", "dist-site"])).toEqual({ outDir: "dist-site" });
  });

  it("accepts --out=<dir>", () => {
    expect(parseArgs(["--out=dist-site"])).toEqual({ outDir: "dist-site" });
  });

  it("rejects --out with no value", () => {
    expect(() => parseArgs(["--out"])).toThrow(/requires a directory/);
  });

  it("rejects --out followed by another flag", () => {
    expect(() => parseArgs(["--out", "--other"])).toThrow(/requires a directory/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/unknown argument/);
  });
});

describe("buildSite — happy path", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
    await seedStandardTree(fx);
  });

  afterEach(async () => {
    await rm(fx.root, { recursive: true, force: true });
  });

  it("copies site/* to the artifact root (including CNAME)", async () => {
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    expect(await exists(path.join(fx.outDir, "index.html"))).toBe(true);
    expect(await exists(path.join(fx.outDir, "app.js"))).toBe(true);
    expect(await exists(path.join(fx.outDir, "styles.css"))).toBe(true);
    expect(await exists(path.join(fx.outDir, "CNAME"))).toBe(true);
  });

  it("lifts issues/latest.json to the artifact root", async () => {
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    const lifted = await readFile(path.join(fx.outDir, "latest.json"), "utf8");
    const original = await readFile(path.join(fx.issuesDir, "latest.json"), "utf8");
    expect(lifted).toBe(original);
  });

  it("copies issues/ under <out>/issues/ excluding the top-level latest.json", async () => {
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    expect(await exists(path.join(fx.outDir, "issues", "2026-04-19", "items.json"))).toBe(true);
    expect(await exists(path.join(fx.outDir, "issues", "2026-04-19", "issue.md"))).toBe(true);
    // Top-level latest.json must NOT be duplicated under <out>/issues/.
    expect(await exists(path.join(fx.outDir, "issues", "latest.json"))).toBe(false);
  });

  it("does not mutate the source issues/ tree (AC-17)", async () => {
    const beforeLatest = await readFile(path.join(fx.issuesDir, "latest.json"), "utf8");
    const beforeItems = await readFile(path.join(fx.issuesDir, "2026-04-19", "items.json"), "utf8");
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    expect(await readFile(path.join(fx.issuesDir, "latest.json"), "utf8")).toBe(beforeLatest);
    expect(await readFile(path.join(fx.issuesDir, "2026-04-19", "items.json"), "utf8")).toBe(beforeItems);
  });

  it("is idempotent — two runs produce the same tree", async () => {
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    const firstLatest = await readFile(path.join(fx.outDir, "latest.json"), "utf8");
    const firstItems = await readFile(path.join(fx.outDir, "issues", "2026-04-19", "items.json"), "utf8");

    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    expect(await readFile(path.join(fx.outDir, "latest.json"), "utf8")).toBe(firstLatest);
    expect(await readFile(path.join(fx.outDir, "issues", "2026-04-19", "items.json"), "utf8")).toBe(firstItems);
  });

  it("wipes stale files from a prior run", async () => {
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    // Plant a stale file inside the out dir; a rerun must remove it.
    const stalePath = path.join(fx.outDir, "stale-from-prior-run.txt");
    await writeFile(stalePath, "stale");
    expect(await exists(stalePath)).toBe(true);
    await buildSite({
      repoRoot: fx.root,
      outDir: fx.outDir,
      siteDir: fx.siteDir,
      issuesDir: fx.issuesDir,
    });
    expect(await exists(stalePath)).toBe(false);
  });
});

describe("buildSite — degraded paths", () => {
  it("warns but succeeds when issues/latest.json is missing", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), "<title>x</title>");
      // Intentionally do not seed issues/latest.json.
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
      expect(warnings.some((w) => w.includes("latest.json is missing"))).toBe(true);
      expect(await exists(path.join(fx.outDir, "index.html"))).toBe(true);
      expect(await exists(path.join(fx.outDir, "latest.json"))).toBe(false);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("throws with a clear message when site/ is missing", async () => {
    const fx = await makeFixture();
    try {
      await rm(fx.siteDir, { recursive: true, force: true });
      await expect(
        buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        }),
      ).rejects.toThrow(/site\/ directory not found/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("throws when site/ path is a file, not a directory", async () => {
    const fx = await makeFixture();
    try {
      await rm(fx.siteDir, { recursive: true, force: true });
      await writeFile(fx.siteDir, "not a dir");
      await expect(
        buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        }),
      ).rejects.toThrow(/is not a directory/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("buildSite — per-issue page rendering (T3)", () => {
  async function seedMultiDateTree(fx: Fixture): Promise<void> {
    // Minimal brochure layout (reuses the standard tree seed).
    await writeFile(path.join(fx.siteDir, "index.html"), "<!doctype html><title>x</title>");
    await writeFile(path.join(fx.siteDir, "app.js"), "// app");
    await writeFile(path.join(fx.siteDir, "styles.css"), "body{}");

    // Three dates so prev/next wiring is non-trivial.
    const dates = ["2026-04-18", "2026-04-19", "2026-04-20"];
    for (const d of dates) {
      const dir = path.join(fx.issuesDir, d);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "items.json"),
        JSON.stringify({
          items: [
            {
              id: `${d}-1`,
              source: "hn",
              title: `Item for ${d}`,
              url: "https://example.com/x",
              category: "Tools & Launches",
              keep: true,
              relevanceScore: 0.8,
            },
          ],
          itemCount: { total: 1, kept: 1 },
        }),
      );
      await writeFile(
        path.join(dir, "issue.md"),
        `# AI Builder Pulse — ${d}\n\nBody for ${d}.\n`,
      );
    }
    // latest pointer references the newest date so the inliner has valid input.
    await writeFile(
      path.join(fx.issuesDir, "latest.json"),
      JSON.stringify({
        date: "2026-04-20",
        path: "issues/2026-04-20/",
        publishId: "em_t3",
        publishedAt: "2026-04-20T06:07:00.000Z",
      }),
    );
  }

  it("renders index.html for every date and wires prev/next for middle dates", async () => {
    const fx = await makeFixture();
    try {
      await seedMultiDateTree(fx);
      await buildSite({
        repoRoot: fx.root,
        outDir: fx.outDir,
        siteDir: fx.siteDir,
        issuesDir: fx.issuesDir,
      });
      for (const d of ["2026-04-18", "2026-04-19", "2026-04-20"]) {
        const p = path.join(fx.outDir, "issues", d, "index.html");
        expect(await exists(p)).toBe(true);
      }
      const mid = await readFile(
        path.join(fx.outDir, "issues", "2026-04-19", "index.html"),
        "utf8",
      );
      expect(mid).toContain(
        '<link rel="canonical" href="https://pulse.ryanhenderson.dev/issues/2026-04-19/" />',
      );
      // Middle date has both prev (18) and next (20).
      expect(mid).toContain('href="/issues/2026-04-18/"');
      expect(mid).toContain('href="/issues/2026-04-20/"');
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("boundary dates render with only one side of prev/next", async () => {
    const fx = await makeFixture();
    try {
      await seedMultiDateTree(fx);
      await buildSite({
        repoRoot: fx.root,
        outDir: fx.outDir,
        siteDir: fx.siteDir,
        issuesDir: fx.issuesDir,
      });
      const first = await readFile(
        path.join(fx.outDir, "issues", "2026-04-18", "index.html"),
        "utf8",
      );
      expect(first).not.toContain('class="issue-nav__prev"');
      expect(first).toContain('href="/issues/2026-04-19/"');
      expect(first).toContain('class="issue-nav__next"');

      const last = await readFile(
        path.join(fx.outDir, "issues", "2026-04-20", "index.html"),
        "utf8",
      );
      expect(last).toContain('href="/issues/2026-04-19/"');
      expect(last).toContain('class="issue-nav__prev"');
      expect(last).not.toContain('class="issue-nav__next"');
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails with a clear message when issue.md is missing for a date directory", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), "<title>x</title>");
      const dir = path.join(fx.issuesDir, "2026-04-19");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "items.json"),
        JSON.stringify({ items: [] }),
      );
      // Intentionally no issue.md.
      await expect(
        buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        }),
      ).rejects.toThrow(/issue\.md missing for 2026-04-19/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails with a file-named message when items.json is malformed", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(path.join(fx.siteDir, "index.html"), "<title>x</title>");
      const dir = path.join(fx.issuesDir, "2026-04-19");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "items.json"), "{not json");
      await writeFile(path.join(dir, "issue.md"), "# x\n");
      await expect(
        buildSite({
          repoRoot: fx.root,
          outDir: fx.outDir,
          siteDir: fx.siteDir,
          issuesDir: fx.issuesDir,
        }),
      ).rejects.toThrow(/items\.json/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("buildSite — archive index (T4)", () => {
  it("renders <out>/archive/index.html listing both dates in reverse order", async () => {
    const fx = await makeFixture();
    try {
      // Minimal brochure layout. Include the real site/index.html topnav
      // shape so we can verify the retargeted archive link survives the
      // copy step unchanged (AC-10).
      await writeFile(
        path.join(fx.siteDir, "index.html"),
        [
          "<!doctype html>",
          "<html><head><title>x</title></head><body>",
          '<nav class="topnav"><a class="topnav__archive" href="/archive/">archive</a></nav>',
          "</body></html>",
        ].join("\n"),
      );
      await writeFile(path.join(fx.siteDir, "styles.css"), "body{}");

      const dates = ["2026-04-18", "2026-04-19"];
      for (const d of dates) {
        const dir = path.join(fx.issuesDir, d);
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "items.json"),
          JSON.stringify({
            items: [
              {
                id: `${d}-1`,
                source: "hn",
                title: `Item for ${d}`,
                url: "https://example.com/x",
                category: "Tools & Launches",
                keep: true,
                relevanceScore: 0.8,
              },
              {
                // An unkept item must not inflate the count.
                id: `${d}-2`,
                source: "hn",
                title: "Dropped",
                url: "https://example.com/y",
                category: "Tools & Launches",
                keep: false,
              },
            ],
            itemCount: { total: 2, kept: 1 },
          }),
        );
        await writeFile(
          path.join(dir, "issue.md"),
          `# AI Builder Pulse — ${d}\n\nBody for ${d}.\n`,
        );
      }
      await writeFile(
        path.join(fx.issuesDir, "latest.json"),
        JSON.stringify({
          date: "2026-04-19",
          path: "issues/2026-04-19/",
          publishId: "em_t4",
          publishedAt: "2026-04-19T06:07:00.000Z",
        }),
      );

      await buildSite({
        repoRoot: fx.root,
        outDir: fx.outDir,
        siteDir: fx.siteDir,
        issuesDir: fx.issuesDir,
      });

      const archivePath = path.join(fx.outDir, "archive", "index.html");
      expect(await exists(archivePath)).toBe(true);
      const html = await readFile(archivePath, "utf8");
      // Both dates present, newest-first.
      const i19 = html.indexOf('href="/issues/2026-04-19/"');
      const i18 = html.indexOf('href="/issues/2026-04-18/"');
      expect(i19).toBeGreaterThan(-1);
      expect(i18).toBeGreaterThan(i19);
      // Kept-only count.
      expect(html).toContain("1 story");

      // Topnav archive link in the copied brochure index points at /archive/.
      const indexHtml = await readFile(path.join(fx.outDir, "index.html"), "utf8");
      expect(indexHtml).toMatch(/class="topnav__archive"\s+href="\/archive\/"/);
      expect(indexHtml).not.toContain("buttondown.com/ai-builder-pulse/archive");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("still emits archive/index.html with an empty-state when there are zero date folders", async () => {
    const fx = await makeFixture();
    try {
      await writeFile(
        path.join(fx.siteDir, "index.html"),
        "<!doctype html><title>x</title>",
      );
      await writeFile(path.join(fx.siteDir, "styles.css"), "body{}");
      // Deliberately do NOT seed any issues/<date>/ folders or latest.json.

      await buildSite({
        repoRoot: fx.root,
        outDir: fx.outDir,
        siteDir: fx.siteDir,
        issuesDir: fx.issuesDir,
      });

      const archivePath = path.join(fx.outDir, "archive", "index.html");
      expect(await exists(archivePath)).toBe(true);
      const html = await readFile(archivePath, "utf8");
      expect(html).toContain("No issues archived yet.");
      expect(html).not.toContain("<ul");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("scripts/build-site.ts — end-to-end exit code (AC-3)", () => {
  it("exits non-zero with a clear error when site/ is missing", async () => {
    const fx = await makeFixture();
    try {
      // Leave issues/ in place but remove site/ so the script fails fast.
      await rm(fx.siteDir, { recursive: true, force: true });
      // Invoke the tsx binary directly (vs. `node --import tsx`) so the
      // spawned process doesn't need to resolve `tsx` from the fixture's
      // node_modules — we run with cwd=fx.root to mimic how CI invokes
      // `pnpm build:site`.
      const tsxBin = path.join(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsx.cmd" : "tsx",
      );
      const result = spawnSync(tsxBin, [scriptPath, "--out", "_site"], {
        cwd: fx.root,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      });
      // The script sets process.exitCode = 1 on failure.
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/build-site failed/);
      expect(combined).toMatch(/site\/ directory not found/);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 30_000);
});
