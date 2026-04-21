// Archive index renderer for the brochure/archive site build.
//
// Emitted at `<out>/archive/index.html` by `scripts/build-site.ts`. Reuses
// the per-issue page's chrome (topnav + footer) and the shared CSS tokens
// so the archive feels like the same site rather than a bolt-on.
//
// Kept pure and deterministic: same input → identical bytes. All I/O
// (enumerating `issues/<date>/`, reading `issue.md` / `items.json`) lives
// in `build-site.ts`.

import { escapeHtml, formatDateHuman } from "./latestPreview.js";

export interface ArchiveEntry {
  readonly date: string; // YYYY-MM-DD
  readonly title: string; // derived from issue.md H1, or fallback
  readonly keptCount: number; // items with keep === true
}

// Newsletter subscribe landing page on Buttondown. Used only by the
// empty-state CTA so the page remains useful on cold starts before any
// issues have been archived.
const BUTTONDOWN_SUBSCRIBE_URL = "https://buttondown.com/ai-builder-pulse";

function renderEntry(entry: ArchiveEntry): string {
  const humanDate = formatDateHuman(entry.date);
  const href = `/issues/${escapeHtml(entry.date)}/`;
  const countLabel = `${entry.keptCount} ${entry.keptCount === 1 ? "story" : "stories"}`;
  return [
    `        <li class="archive__entry">`,
    `          <time class="archive__date" datetime="${escapeHtml(entry.date)}">${escapeHtml(humanDate)}</time>`,
    `          <a class="archive__title" href="${href}">${escapeHtml(entry.title)}</a>`,
    `          <span class="archive__count">${escapeHtml(countLabel)}</span>`,
    `        </li>`,
  ].join("\n");
}

function renderList(entries: readonly ArchiveEntry[]): string {
  const rows = entries.map(renderEntry).join("\n");
  return [
    `      <ul class="archive__list">`,
    rows,
    `      </ul>`,
  ].join("\n");
}

function renderEmptyState(): string {
  return [
    `      <div class="archive__empty">`,
    `        <p class="archive__empty-text">No issues archived yet.</p>`,
    `        <a class="btn btn--secondary" href="${escapeHtml(BUTTONDOWN_SUBSCRIBE_URL)}" rel="noopener">`,
    `          subscribe for the first issue \u2192`,
    `        </a>`,
    `      </div>`,
  ].join("\n");
}

/**
 * Render a full `<!doctype html>…</html>` archive index page. The output
 * path is assumed to be `<out>/archive/index.html`, so the stylesheet
 * href is `../styles.css` (relative) and canonical / og URLs are
 * absolute under `canonicalOrigin`.
 *
 * The caller is responsible for sorting `entries` — this function renders
 * them in the order received. `build-site.ts` sorts newest-first.
 */
export function renderArchivePage(
  entries: readonly ArchiveEntry[],
  canonicalOrigin: string,
): string {
  const pageTitle = "AI Builder Pulse \u2014 Archive";
  const canonicalUrl = `${canonicalOrigin}/archive/`;
  const description =
    entries.length === 0
      ? "The AI Builder Pulse archive. Daily briefings for engineers building with AI — subscribe for the first issue."
      : `Every AI Builder Pulse issue, newest first. ${entries.length} ${entries.length === 1 ? "issue" : "issues"} archived.`;

  const body =
    entries.length === 0 ? renderEmptyState() : renderList(entries);

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `  <head>`,
    `    <meta charset="utf-8" />`,
    `    <meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `    <title>${escapeHtml(pageTitle)}</title>`,
    `    <meta name="description" content="${escapeHtml(description)}" />`,
    `    <meta name="color-scheme" content="dark" />`,
    `    <meta name="theme-color" content="#0b0320" />`,
    ``,
    `    <meta property="og:type" content="website" />`,
    `    <meta property="og:title" content="${escapeHtml(pageTitle)}" />`,
    `    <meta property="og:description" content="${escapeHtml(description)}" />`,
    `    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `    <meta property="og:image" content="${escapeHtml(canonicalOrigin)}/og-image.svg" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <meta name="twitter:title" content="${escapeHtml(pageTitle)}" />`,
    `    <meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `    <meta name="twitter:image" content="${escapeHtml(canonicalOrigin)}/og-image.svg" />`,
    ``,
    `    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    `    <link rel="icon" type="image/svg+xml" href="../favicon.svg" />`,
    `    <link rel="stylesheet" href="../styles.css" />`,
    `  </head>`,
    `  <body>`,
    `    <div class="scanlines" aria-hidden="true"></div>`,
    ``,
    `    <header class="archive-header">`,
    `      <nav class="topnav" aria-label="primary">`,
    `        <a class="topnav__brand" href="/">`,
    `          <span class="pulse-dot" aria-hidden="true"></span>`,
    `          <span>AI Builder Pulse</span>`,
    `        </a>`,
    `        <a class="topnav__archive" href="/archive/">archive</a>`,
    `      </nav>`,
    `    </header>`,
    ``,
    `    <main class="archive">`,
    `      <h1 class="archive__title-main">Archive</h1>`,
    `      <p class="archive__tagline">Every transmission, newest first.</p>`,
    body,
    `    </main>`,
    ``,
    `    <footer class="footer">`,
    `      <p class="footer__line">`,
    `        built by an ai builder, for ai builders \u00b7`,
    `        <a href="https://github.com/htxryan/ai-builder-pulse" rel="noopener">source on github</a>`,
    `        \u00b7`,
    `        <a href="/archive/">archive</a>`,
    `      </p>`,
    `      <p class="footer__ascii" aria-hidden="true">`,
    `        \u2591\u2592\u2593 END OF TRANSMISSION \u2593\u2592\u2591`,
    `      </p>`,
    `    </footer>`,
    `  </body>`,
    `</html>`,
    ``,
  ].join("\n");
}
