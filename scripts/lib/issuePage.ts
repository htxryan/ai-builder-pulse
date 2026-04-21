// Per-issue HTML page renderer for the archive site.
//
// Produces a static `<out>/issues/<date>/index.html` for every archived
// issue, reusing the brochure's stylesheet (`../../styles.css`) and the
// shared preview helpers from `latestPreview.ts` (single source of truth
// for top-pick selection, category counts, source labels, date
// formatting, and HTML escaping).
//
// Kept pure and deterministic: same input → identical HTML bytes. All
// I/O (reading `issue.md`, `items.json`; writing the page) belongs to
// `build-site.ts`.

import { renderMarkdown, extractH1 } from "./renderMarkdown.js";
import {
  categoryCounts,
  escapeHtml,
  formatDateHuman,
  pickTopPick,
  safeExternalHref,
  sourceLabel,
  type PreviewItem,
} from "./latestPreview.js";

export interface IssuePageInput {
  readonly date: string; // YYYY-MM-DD
  readonly markdown: string; // raw issue.md body
  readonly items: readonly unknown[]; // parsed items.json `items` array
  readonly prev?: { readonly date: string } | undefined;
  readonly next?: { readonly date: string } | undefined;
  readonly canonicalOrigin: string; // e.g. "https://pulse.ryanhenderson.dev"
}

/**
 * Narrow an arbitrary `unknown` to `PreviewItem`. We trust the archive's
 * schema but defensively coerce anything non-object-shaped to an empty
 * record so downstream helpers (`pickTopPick`, `categoryCounts`,
 * `sourceLabel`) see consistent input and never throw on a poisoned
 * `items.json`.
 */
function toPreviewItems(items: readonly unknown[]): readonly PreviewItem[] {
  const out: PreviewItem[] = [];
  for (const it of items) {
    if (it && typeof it === "object") {
      out.push(it as PreviewItem);
    }
  }
  return out;
}

/**
 * Count kept items by `source` using `sourceLabel` for display. Sorted
 * by count desc, then label asc for deterministic byte-stable output.
 */
function sourceMix(items: readonly PreviewItem[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it || it.keep !== true) continue;
    const label = sourceLabel(it) || "Unknown";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

/**
 * Trim a free-text description into a concise meta description. Strips
 * whitespace, clamps to ~160 chars (adds an ellipsis if clamped).
 */
function clampDescription(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 160) return collapsed;
  return collapsed.slice(0, 157).trimEnd() + "...";
}

function renderTopPickAside(top: PreviewItem | null): string {
  if (!top) {
    return [
      `      <div class="issue-aside__card">`,
      `        <h3 class="issue-aside__heading">today's top pick</h3>`,
      `        <p class="issue-aside__empty">No kept items.</p>`,
      `      </div>`,
    ].join("\n");
  }
  const title = escapeHtml(top.title ?? "(untitled)");
  const href = escapeHtml(safeExternalHref(top.url));
  const source = escapeHtml(sourceLabel(top));
  return [
    `      <div class="issue-aside__card">`,
    `        <h3 class="issue-aside__heading">today's top pick</h3>`,
    `        <p class="issue-aside__toppick-title">`,
    `          <a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`,
    `        </p>`,
    `        <p class="issue-aside__toppick-source">${source}</p>`,
    `      </div>`,
  ].join("\n");
}

function renderCategoriesAside(
  counts: ReadonlyArray<readonly [string, number]>,
): string {
  const items =
    counts.length === 0
      ? `        <li class="issue-aside__empty">No kept items.</li>`
      : counts
          .map(
            ([name, count]) =>
              `        <li><span>${escapeHtml(name)}</span><span>${count}</span></li>`,
          )
          .join("\n");
  return [
    `      <div class="issue-aside__card">`,
    `        <h3 class="issue-aside__heading">categories</h3>`,
    `        <ul class="issue-aside__list">`,
    items,
    `        </ul>`,
    `      </div>`,
  ].join("\n");
}

function renderSourceMixAside(
  mix: ReadonlyArray<readonly [string, number]>,
): string {
  const items =
    mix.length === 0
      ? `        <li class="issue-aside__empty">No kept items.</li>`
      : mix
          .map(
            ([name, count]) =>
              `        <li><span>${escapeHtml(name)}</span><span>${count}</span></li>`,
          )
          .join("\n");
  return [
    `      <div class="issue-aside__card">`,
    `        <h3 class="issue-aside__heading">source mix</h3>`,
    `        <ul class="issue-aside__list">`,
    items,
    `        </ul>`,
    `      </div>`,
  ].join("\n");
}

function renderStatsAside(keptCount: number, categoryCount: number): string {
  return [
    `      <div class="issue-aside__card">`,
    `        <h3 class="issue-aside__heading">this issue</h3>`,
    `        <p class="issue-aside__stats">${keptCount} ${keptCount === 1 ? "story" : "stories"} \u00b7 ${categoryCount} ${categoryCount === 1 ? "category" : "categories"}</p>`,
    `      </div>`,
  ].join("\n");
}

// Signup form copied verbatim from `site/index.html` (hero form), with a
// unique id `signup-issue` and a fresh `for`/`id` pairing on the label +
// input so the cloned form remains accessible on issue pages.
function renderSignupAside(): string {
  return [
    `      <form`,
    `        class="signup signup--aside"`,
    `        id="signup-issue"`,
    `        action="https://buttondown.com/api/emails/embed-subscribe/ai-builder-pulse"`,
    `        method="post"`,
    `        target="popupwindow"`,
    `      >`,
    `        <label class="signup__label" for="signup-issue-email">`,
    `          Get tomorrow's briefing`,
    `        </label>`,
    `        <div class="signup__row">`,
    `          <input`,
    `            id="signup-issue-email"`,
    `            class="signup__input"`,
    `            type="email"`,
    `            name="email"`,
    `            placeholder="you@builder.dev"`,
    `            required`,
    `            autocomplete="email"`,
    `          />`,
    `          <button class="btn btn--primary" type="submit">`,
    `            <span class="btn__label">subscribe</span>`,
    `            <span class="btn__arrow" aria-hidden="true">&rarr;</span>`,
    `          </button>`,
    `        </div>`,
    `        <input type="hidden" name="embed" value="1" />`,
    `        <p class="signup__success" data-signup-success hidden>`,
    `          \u2713 check your email to confirm the subscription`,
    `        </p>`,
    `        <p class="signup__fine-print">`,
    `          free \u00b7 unsubscribe with one click \u00b7 double opt-in`,
    `        </p>`,
    `      </form>`,
  ].join("\n");
}

function renderPrevNext(
  prev: IssuePageInput["prev"],
  next: IssuePageInput["next"],
): string {
  const prevHtml = prev
    ? `      <a class="issue-nav__prev" href="/issues/${escapeHtml(prev.date)}/" rel="prev">&larr; ${escapeHtml(prev.date)}</a>`
    : "";
  const nextHtml = next
    ? `      <a class="issue-nav__next" href="/issues/${escapeHtml(next.date)}/" rel="next">${escapeHtml(next.date)} &rarr;</a>`
    : "";
  const parts = [`    <nav class="issue-nav" aria-label="issue navigation">`];
  if (prevHtml) parts.push(prevHtml);
  if (nextHtml) parts.push(nextHtml);
  parts.push(`    </nav>`);
  return parts.join("\n");
}

/**
 * Render a full `<!doctype html>…</html>` page for a single archived
 * issue. The output path is assumed to be
 * `<out>/issues/<date>/index.html`, so the stylesheet href is
 * `../../styles.css` (relative) and canonical/og URLs are absolute.
 */
export function renderIssuePage(input: IssuePageInput): string {
  const { date, markdown, items, prev, next, canonicalOrigin } = input;

  const previewItems = toPreviewItems(items);
  const categories = categoryCounts(previewItems);
  const top = pickTopPick(previewItems);
  const keptCount = previewItems.filter((i) => i && i.keep === true).length;
  const mix = sourceMix(previewItems);
  const humanDate = formatDateHuman(date);

  const h1Text = extractH1(markdown) ?? `AI Builder Pulse \u00b7 ${humanDate}`;
  const pageTitle = `AI Builder Pulse \u2014 ${humanDate}`;
  const canonicalUrl = `${canonicalOrigin}/issues/${date}/`;

  // Description: prefer the top pick + its source; fall back to a
  // generic summary line. Keep deterministic for byte-stable output.
  const description = top
    ? clampDescription(
        `${top.title ?? "Today's top pick"} (${sourceLabel(top) || "source"}) \u2014 ${keptCount} kept ${keptCount === 1 ? "story" : "stories"} across ${categories.length} ${categories.length === 1 ? "category" : "categories"}.`,
      )
    : clampDescription(
        `${keptCount} kept ${keptCount === 1 ? "story" : "stories"} across ${categories.length} ${categories.length === 1 ? "category" : "categories"} for ${humanDate}.`,
      );

  const bodyHtml = renderMarkdown(markdown);

  // Strip the leading H1 from the rendered markdown so we don't double
  // up with the page's own `<h1>` just above it. We render exactly one
  // `<h1>` in the body region per epic AC.
  const bodyWithoutH1 = bodyHtml.replace(
    /<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i,
    "",
  );

  const metaLine = `${humanDate} \u00b7 ${keptCount} ${keptCount === 1 ? "story" : "stories"} \u00b7 ${categories.length} ${categories.length === 1 ? "category" : "categories"}`;

  const asideHtml = [
    renderStatsAside(keptCount, categories.length),
    renderTopPickAside(top),
    renderCategoriesAside(categories),
    renderSourceMixAside(mix),
    renderSignupAside(),
  ].join("\n");

  const prevNextHtml = renderPrevNext(prev, next);

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
    `    <meta property="og:type" content="article" />`,
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
    `    <link rel="icon" type="image/svg+xml" href="../../favicon.svg" />`,
    `    <link rel="stylesheet" href="../../styles.css" />`,
    `  </head>`,
    `  <body>`,
    `    <div class="scanlines" aria-hidden="true"></div>`,
    ``,
    `    <header class="issue-header">`,
    `      <nav class="topnav" aria-label="primary">`,
    `        <a class="topnav__brand" href="/">`,
    `          <span class="pulse-dot" aria-hidden="true"></span>`,
    `          <span>AI Builder Pulse</span>`,
    `        </a>`,
    `        <a class="topnav__archive" href="/archive/">archive</a>`,
    `      </nav>`,
    `    </header>`,
    ``,
    `    <main class="issue-page">`,
    `      <article class="issue-body">`,
    `        <h1 class="issue-body__title">${escapeHtml(h1Text)}</h1>`,
    `        <p class="issue-body__meta">${escapeHtml(metaLine)}</p>`,
    `        <div class="issue-body__content">`,
    bodyWithoutH1,
    `        </div>`,
    prevNextHtml,
    `      </article>`,
    ``,
    `      <aside class="issue-aside" aria-label="issue metadata">`,
    asideHtml,
    `      </aside>`,
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
