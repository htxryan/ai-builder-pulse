// Assemble the GitHub Pages artifact for the brochure site.
//
// Replaces the inline bash that previously lived in
// `.github/workflows/pages.yml`. Keeping this in TypeScript gives future
// tasks (markdown-to-HTML rendering, archive index page, etc.) a single
// well-typed entry point to extend.
//
// Scope (T1): byte-equivalent replacement for the old bash —
//   - copy `site/*` → `<out>/*`
//   - copy `issues/latest.json` → `<out>/latest.json` (warn if absent)
//   - copy `issues/` → `<out>/issues/` excluding `latest.json`
//
// Intentionally does NOT render markdown. That lands in T2/T3.
//
// Idempotent: rerunning on an existing `<out>/` yields the same tree.
// Fails loud on any I/O error with a non-zero exit.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

interface BuildOptions {
  readonly repoRoot: string;
  readonly outDir: string;
  readonly siteDir: string;
  readonly issuesDir: string;
}

/**
 * Parse `--out <dir>` out of argv. Unknown flags are an error so typos
 * fail fast instead of silently being treated as defaults.
 */
export function parseArgs(argv: readonly string[]): { outDir: string } {
  let outDir = "_site";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--out requires a directory argument");
      }
      outDir = next;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
      if (outDir.length === 0) {
        throw new Error("--out requires a directory argument");
      }
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return { outDir };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function assertDir(p: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} not found at ${p}`);
    }
    throw err;
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} at ${p} is not a directory`);
  }
}

/**
 * Copy everything in `issuesDir` to `<outDir>/issues/` EXCEPT the
 * top-level `latest.json` pointer (which is already lifted to
 * `<outDir>/latest.json`).
 *
 * Nested `latest.json` under per-issue directories (if any ever exist)
 * is preserved — only the top-level pointer is excluded.
 */
async function copyIssuesTree(
  issuesDir: string,
  destIssuesDir: string,
): Promise<void> {
  await mkdir(destIssuesDir, { recursive: true });
  const entries = await readdir(issuesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "latest.json" && !entry.isDirectory()) continue;
    const src = path.join(issuesDir, entry.name);
    const dst = path.join(destIssuesDir, entry.name);
    await cp(src, dst, { recursive: true });
  }
}

export async function buildSite(opts: BuildOptions): Promise<void> {
  const { outDir, siteDir, issuesDir } = opts;

  await assertDir(siteDir, "site/ directory");

  // Idempotence: wipe and recreate `<outDir>` so a rerun produces the
  // same tree regardless of prior state. `fs.cp` with `recursive: true`
  // would otherwise merge on top of stale files.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 1. site/ → out/ (contents at the root, so `./latest.json` resolves)
  await cp(siteDir, outDir, { recursive: true });

  // 2. issues/latest.json → out/latest.json (lift the pointer to root)
  const latestJson = path.join(issuesDir, "latest.json");
  if (await pathExists(latestJson)) {
    await cp(latestJson, path.join(outDir, "latest.json"));
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `::warning::${latestJson} is missing; brochure will fall back to archive link`,
    );
  }

  // 3. issues/ (minus top-level latest.json) → out/issues/
  if (await pathExists(issuesDir)) {
    await copyIssuesTree(issuesDir, path.join(outDir, "issues"));
  }
}

async function main(): Promise<void> {
  const { outDir: outArg } = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const outDir = path.resolve(repoRoot, outArg);
  const siteDir = path.join(repoRoot, "site");
  const issuesDir = path.join(repoRoot, "issues");

  await buildSite({ repoRoot, outDir, siteDir, issuesDir });

  // eslint-disable-next-line no-console
  console.log(`site artifact assembled at ${outDir}`);
}

// Run only when executed directly (not when imported by tests).
// tsx preserves import.meta.url; comparing against process.argv[1] is
// the portable way to detect "this module is the entry point".
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const entryUrl = new URL(`file://${path.resolve(entry)}`).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`::error::build-site failed: ${msg}`);
    process.exitCode = 1;
  });
}
