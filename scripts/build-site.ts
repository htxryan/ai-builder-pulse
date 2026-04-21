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

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  formatDateHuman,
  inlineLatestIntoHtml,
  type ItemsPayload,
  type LatestPointer,
  type PreviewItem,
} from "./lib/latestPreview.js";
import { renderIssuePage } from "./lib/issuePage.js";
import { extractH1 } from "./lib/renderMarkdown.js";
import { renderArchivePage, type ArchiveEntry } from "./lib/archivePage.js";

const CANONICAL_ORIGIN = "https://pulse.ryanhenderson.dev";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Load + validate `issues/latest.json`. Returns `null` on any shape or
 * I/O error; the caller falls back to the unfilled skeleton and emits a
 * warning. This intentionally mirrors the defensive checks in
 * `site/app.js` `parsePointer` so a build-time inline cannot produce
 * a link the client wouldn't accept.
 */
async function loadLatestPointer(
  issuesDir: string,
): Promise<LatestPointer | null> {
  const p = path.join(issuesDir, "latest.json");
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const date = o["date"];
  const pathField = o["path"];
  const publishId = o["publishId"];
  const publishedAt = o["publishedAt"];
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (
    typeof pathField !== "string" ||
    !pathField.startsWith("issues/") ||
    !pathField.endsWith("/") ||
    pathField.includes("..") ||
    pathField.includes("//")
  ) {
    return null;
  }
  if (typeof publishId !== "string" || publishId.length === 0) return null;
  if (typeof publishedAt !== "string") return null;
  return { date, path: pathField, publishId, publishedAt };
}

/**
 * Load the items.json referenced by a validated pointer. Returns `null`
 * if the file is missing or the shape is invalid.
 */
async function loadItemsPayload(
  issuesDir: string,
  pointer: LatestPointer,
): Promise<ItemsPayload | null> {
  // `pointer.path` is already constrained to `issues/<date>/` by
  // `loadLatestPointer`, so this join stays under `issuesDir`.
  const rel = pointer.path.replace(/^issues\//, "");
  const p = path.join(issuesDir, rel, "items.json");
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o["items"])) return null;
  const items = (o["items"] as unknown[]).filter(
    (x): x is PreviewItem => typeof x === "object" && x !== null,
  );
  const itemCountRaw = o["itemCount"];
  const itemCount =
    itemCountRaw && typeof itemCountRaw === "object"
      ? (itemCountRaw as ItemsPayload["itemCount"])
      : undefined;
  return itemCount ? { items, itemCount } : { items };
}

/**
 * Read the copied `<outDir>/index.html`, attempt to inline the latest
 * preview, and write it back. Any failure falls back to the untouched
 * skeleton — the brochure script re-hydrates client-side regardless.
 */
async function inlineLatestPreview(
  outDir: string,
  issuesDir: string,
): Promise<void> {
  const indexPath = path.join(outDir, "index.html");
  let html: string;
  try {
    html = await readFile(indexPath, "utf8");
  } catch {
    // No index.html to transform — nothing to do. The copy step is the
    // source of truth; if it didn't land, that's already a loud error
    // upstream.
    return;
  }

  const pointer = await loadLatestPointer(issuesDir);
  if (!pointer) {
    // eslint-disable-next-line no-console
    console.warn(
      "::warning::build-site: latest pointer unavailable or invalid; shipping untouched skeleton",
    );
    return;
  }

  const items = await loadItemsPayload(issuesDir, pointer);
  if (!items) {
    // eslint-disable-next-line no-console
    console.warn(
      `::warning::build-site: items.json for ${pointer.date} unavailable or invalid; shipping untouched skeleton`,
    );
    return;
  }

  const filled = inlineLatestIntoHtml(html, { pointer, items });
  await writeFile(indexPath, filled, "utf8");
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

  // 4. Pre-fill `<outDir>/index.html` with the latest issue's top pick +
  //    categories so the first paint shows real content instead of a
  //    skeleton. The client-side `loadLatest()` still runs and can
  //    overwrite this with fresher cached data; the inline is strictly
  //    progressive enhancement. Any failure falls back to the untouched
  //    skeleton (logged as a warning) so the build cannot break the site.
  await inlineLatestPreview(outDir, issuesDir);

  // 5. Render a per-issue HTML page for every archived date directory
  //    under `<outDir>/issues/`. Enumerated from the destination tree so
  //    the pages are driven by what actually shipped (step 3 above),
  //    not the source. `issue.md` is required; missing markdown for a
  //    copied date directory is a loud failure (R15 / AC-14). Malformed
  //    `items.json` is also a loud failure (R14 / AC-13).
  await renderIssuePages(path.join(outDir, "issues"));

  // 6. Render the archive index at `<outDir>/archive/index.html`. Always
  //    emitted — even with zero archived dates — so the brochure topnav
  //    (which links at `/archive/`) never 404s. Driven by the same
  //    destination tree as step 5, so a date directory that failed to
  //    render above would have already aborted the build.
  await renderArchiveIndex(outDir, path.join(outDir, "issues"));
}

/**
 * List YYYY-MM-DD subdirectories under `<outDir>/issues/` in sorted
 * order. Non-directory entries and names that don't match the date
 * pattern are ignored (defensive — only the copy step writes into this
 * tree).
 */
async function listIssueDates(destIssuesDir: string): Promise<string[]> {
  if (!(await pathExists(destIssuesDir))) return [];
  const entries = await readdir(destIssuesDir, { withFileTypes: true });
  const dates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!ISO_DATE_RE.test(entry.name)) continue;
    dates.push(entry.name);
  }
  dates.sort();
  return dates;
}

/**
 * Parse `<dateDir>/items.json` into a plain `{ items: unknown[] }`
 * shape. Throws with a clear, file-qualified message on JSON parse
 * failure or shape violation (AC-13 / R14). Missing file → returns
 * `{ items: [] }` so a page can still render with an empty sidebar;
 * the mandatory artifact is `issue.md`, not `items.json`.
 */
async function loadIssueItems(dateDir: string): Promise<{ items: unknown[] }> {
  const p = path.join(dateDir, "items.json");
  if (!(await pathExists(p))) {
    return { items: [] };
  }
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read ${p}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse ${p}: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid shape in ${p}: expected object`);
  }
  const items = (parsed as Record<string, unknown>)["items"];
  if (!Array.isArray(items)) {
    throw new Error(`invalid shape in ${p}: expected { items: [] }`);
  }
  return { items: items as unknown[] };
}

/**
 * Render `<destIssuesDir>/<date>/index.html` for every date directory.
 * Prev/next are computed from the sorted date list: prev is the
 * chronologically-earlier neighbour, next is the later one. Boundary
 * dates get only one side.
 */
async function renderIssuePages(destIssuesDir: string): Promise<void> {
  const dates = await listIssueDates(destIssuesDir);
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i] as string;
    const dateDir = path.join(destIssuesDir, date);
    const mdPath = path.join(dateDir, "issue.md");
    if (!(await pathExists(mdPath))) {
      throw new Error(
        `issue.md missing for ${date} (expected at ${mdPath})`,
      );
    }
    const markdown = await readFile(mdPath, "utf8");
    const { items } = await loadIssueItems(dateDir);
    const prevDate = i > 0 ? dates[i - 1] : undefined;
    const nextDate = i + 1 < dates.length ? dates[i + 1] : undefined;
    const html = renderIssuePage({
      date,
      markdown,
      items,
      prev: prevDate ? { date: prevDate } : undefined,
      next: nextDate ? { date: nextDate } : undefined,
      canonicalOrigin: CANONICAL_ORIGIN,
    });
    await writeFile(path.join(dateDir, "index.html"), html, "utf8");
  }
}

/**
 * Count items with `keep === true` from a parsed items payload. Defensive
 * against malformed entries (non-objects are ignored) so a single bad row
 * doesn't poison the count.
 */
function countKept(items: readonly unknown[]): number {
  let n = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if ((it as { keep?: unknown }).keep === true) n += 1;
  }
  return n;
}

/**
 * Enumerate the shipped issue directories, derive an `ArchiveEntry` for
 * each (title from `issue.md` H1 with a date-qualified fallback, kept
 * count from `items.json`), sort newest-first, and write the archive
 * index HTML. Always emits the file — zero entries → empty-state page —
 * so the brochure's `/archive/` link is never a 404.
 */
async function renderArchiveIndex(
  outDir: string,
  destIssuesDir: string,
): Promise<void> {
  const dates = await listIssueDates(destIssuesDir);
  const entries: ArchiveEntry[] = [];
  for (const date of dates) {
    const dateDir = path.join(destIssuesDir, date);
    const mdPath = path.join(dateDir, "issue.md");
    // `renderIssuePages` already asserted `issue.md` existed before we
    // got here, so treat a missing file as an invariant violation rather
    // than silently falling back.
    const markdown = await readFile(mdPath, "utf8");
    const h1 = extractH1(markdown);
    const title = h1 ?? `AI Builder Pulse \u00b7 ${formatDateHuman(date)}`;
    const { items } = await loadIssueItems(dateDir);
    entries.push({ date, title, keptCount: countKept(items) });
  }
  // Newest-first: sort date strings descending. ISO-8601 YYYY-MM-DD is
  // lexicographically ordered, so a plain string compare is correct.
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const archiveDir = path.join(outDir, "archive");
  await mkdir(archiveDir, { recursive: true });
  const html = renderArchivePage(entries, CANONICAL_ORIGIN);
  await writeFile(path.join(archiveDir, "index.html"), html, "utf8");
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
