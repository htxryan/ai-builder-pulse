// Build-time preview inliner for the brochure homepage.
//
// Mirrors the client-side logic in `site/app.js` (`pickTopPick`,
// `categoryCounts`) so the shipped `index.html` is pre-filled with the
// most recent issue's top pick + category counts. Client-side
// `loadLatest()` still runs on navigation and refreshes the DOM when the
// cache is stale — this pre-fill is progressive enhancement for the
// first paint and for clients that (for any reason) skip the JS.
//
// All exports are pure and deterministic: same input → identical output.
// The build script is responsible for I/O; this module only transforms
// strings and in-memory values.

export interface LatestPointer {
  readonly date: string;
  readonly path: string;
  readonly publishId: string;
  readonly publishedAt: string;
}

export interface PreviewItem {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
  readonly source?: string;
  readonly category?: string;
  readonly keep?: boolean;
  readonly score?: number;
  readonly relevanceScore?: number;
  readonly metadata?: { readonly subreddit?: string };
}

export interface ItemsPayload {
  readonly itemCount?: { readonly kept?: number; readonly total?: number };
  readonly items: readonly PreviewItem[];
}

// Keep in lockstep with `site/app.js` `pickTopPick`. A drift here would
// cause the first paint to disagree with the hydrated DOM.
export function pickTopPick(
  items: readonly PreviewItem[],
): PreviewItem | null {
  const kept = items.filter((i) => i && i.keep === true);
  if (kept.length === 0) return null;
  const sorted = [...kept].sort((a, b) => {
    const ra = typeof a.relevanceScore === "number" ? a.relevanceScore : 0;
    const rb = typeof b.relevanceScore === "number" ? b.relevanceScore : 0;
    if (rb !== ra) return rb - ra;
    const sa = typeof a.score === "number" ? a.score : 0;
    const sb = typeof b.score === "number" ? b.score : 0;
    return sb - sa;
  });
  return sorted[0] ?? null;
}

// Keep in lockstep with `site/app.js` `categoryCounts`.
export function categoryCounts(
  items: readonly PreviewItem[],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it || it.keep !== true) continue;
    const cat = typeof it.category === "string" ? it.category : "Uncategorized";
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

// Mirrors `site/app.js` `sourceLabel`.
export function sourceLabel(item: PreviewItem): string {
  const s = item.source;
  if (s === "hn") return "Hacker News";
  if (s === "github-trending") return "GitHub Trending";
  if (s === "reddit") {
    const sub = item.metadata?.subreddit;
    return sub ? `r/${sub}` : "Reddit";
  }
  if (s === "rss") return "RSS";
  if (s === "twitter") return "Twitter";
  return s ?? "";
}

// Mirrors `site/app.js` `formatDateHuman`. Uses `en-US` with an explicit
// option bag so the build output is locale-independent (GHA runners
// default to `en-US`, but we don't want to rely on that).
export function formatDateHuman(iso: string): string {
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

// Mirrors `site/app.js` `safeExternalHref`. Only allow http/https —
// anything else becomes `#` so a poisoned items.json can't inject
// `javascript:` URLs into the rendered HTML.
export function safeExternalHref(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "#";
  try {
    const u = new URL(url, "https://example.invalid/");
    if (u.protocol !== "http:" && u.protocol !== "https:") return "#";
    return url;
  } catch {
    return "#";
  }
}

// Minimal HTML entity escape for text nodes and double-quoted attribute
// values. The inlined values come from a JSON payload we generated, but
// we still escape defensively so a malformed/attacker-controlled
// `items.json` can never produce executable markup.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface InlineInput {
  readonly pointer: LatestPointer;
  readonly items: ItemsPayload;
}

// Replace the data-latest-* skeleton/content/meta regions in the source
// HTML with pre-filled content for the given pointer + items payload.
//
// The output keeps the progressive-enhancement contract intact:
//   - `[data-latest-skeleton]` stays in the DOM but is hidden.
//   - `[data-latest-content]` is filled and its `hidden` attribute
//     removed so it paints immediately.
//   - `[data-latest-fallback]` stays hidden (client JS will flip this
//     on only if a later fetch fails).
//
// Implementation is regex-over-HTML — deliberately. The source template
// is ours, fully-controlled, and small. Pulling in a parser would add a
// runtime dependency for one transform with no real upside.
export function inlineLatestIntoHtml(
  html: string,
  { pointer, items }: InlineInput,
): string {
  const list = items.items;
  const top = pickTopPick(list);
  const counts = categoryCounts(list);
  const keptCount =
    (items.itemCount && typeof items.itemCount.kept === "number"
      ? items.itemCount.kept
      : list.filter((i) => i && i.keep === true).length) ?? 0;

  const metaText = `${formatDateHuman(pointer.date)} \u00b7 ${keptCount} stories \u00b7 ${counts.length} categories`;

  let out = html;

  // 1) Meta line: replace text inside `<p ... data-latest-meta>…</p>`.
  out = replaceElementText(out, "data-latest-meta", metaText);

  // 2) Skeleton: add `hidden` attribute to the wrapper div.
  out = addHiddenAttr(out, "data-latest-skeleton");

  // 3) Content wrapper: remove `hidden` and inject the filled children.
  const topPickHtml = renderTopPick(top);
  const categoriesHtml = renderCategories(counts);
  const ctaHref = `/${pointer.path}`;
  const filledContent = [
    `            <div class="top-pick">`,
    `              <p class="top-pick__label">today's top pick</p>`,
    topPickHtml,
    `            </div>`,
    `            <div class="categories">`,
    `              <h4 class="categories__heading">in this issue</h4>`,
    `              <ul class="categories__list" data-latest-categories>`,
    categoriesHtml,
    `              </ul>`,
    `            </div>`,
    `            <div class="latest__cta">`,
    `              <a`,
    `                class="btn btn--secondary"`,
    `                data-latest-read-full`,
    `                href="${escapeHtml(ctaHref)}"`,
    `                rel="noopener"`,
    `              >`,
    `                read the full issue →`,
    `              </a>`,
    `            </div>`,
  ].join("\n");

  out = replaceContentBlock(out, filledContent);

  return out;
}

function renderTopPick(top: PreviewItem | null): string {
  if (!top) {
    // No kept items — leave the slot empty but structurally valid so
    // the client-side script can still populate it later if the cache
    // ever returns a newer payload.
    return [
      `              <h3 class="top-pick__title">`,
      `                <a data-latest-toppick-link href="#" rel="noopener"></a>`,
      `              </h3>`,
      `              <p class="top-pick__source" data-latest-toppick-source></p>`,
      `              <p class="top-pick__desc" data-latest-toppick-desc></p>`,
    ].join("\n");
  }
  const title = escapeHtml(top.title ?? "(untitled)");
  const href = escapeHtml(safeExternalHref(top.url));
  const source = escapeHtml(sourceLabel(top));
  const desc = escapeHtml(top.description ?? "");
  return [
    `              <h3 class="top-pick__title">`,
    `                <a data-latest-toppick-link href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`,
    `              </h3>`,
    `              <p class="top-pick__source" data-latest-toppick-source>${source}</p>`,
    `              <p class="top-pick__desc" data-latest-toppick-desc>${desc}</p>`,
  ].join("\n");
}

function renderCategories(counts: ReadonlyArray<readonly [string, number]>): string {
  if (counts.length === 0) return "";
  return counts
    .map(
      ([name, count]) =>
        `                <li><span>${escapeHtml(name)}</span><span>${count}</span></li>`,
    )
    .join("\n");
}

// --- small, scoped HTML transforms -----------------------------------------

// Replace the inner text of the first element carrying `data-attr` with
// the given plain text (which is HTML-escaped). Matches the opening tag
// on any element name, across any attribute ordering — enough for the
// fixed source template we control.
function replaceElementText(
  html: string,
  dataAttr: string,
  text: string,
): string {
  const re = new RegExp(
    `(<([a-zA-Z][a-zA-Z0-9]*)[^>]*\\b${dataAttr}\\b[^>]*>)([\\s\\S]*?)(</\\2>)`,
  );
  return html.replace(re, (_m, open: string, _tag: string, _inner: string, close: string) => {
    return `${open}${escapeHtml(text)}${close}`;
  });
}

// Add a `hidden` attribute to the first opening tag carrying `data-attr`,
// unless it already has one.
function addHiddenAttr(html: string, dataAttr: string): string {
  const re = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)([^>]*\\b${dataAttr}\\b[^>]*)>`,
  );
  return html.replace(re, (m: string, tag: string, attrs: string) => {
    if (/\bhidden\b/.test(attrs)) return m;
    return `<${tag}${attrs} hidden>`;
  });
}

// Replace the *children* of the first element carrying
// `data-latest-content`, also stripping its `hidden` attribute so the
// pre-filled content paints immediately.
//
// The content block has nested `<div>`s, so a non-greedy regex would
// stop at the first `</div>` — wrong. We instead locate the opening
// tag with a regex, then scan forward to find the matching close by
// counting `<div>` depth.
function replaceContentBlock(html: string, innerHtml: string): string {
  const openRe =
    /<([a-zA-Z][a-zA-Z0-9]*)([^>]*\bdata-latest-content\b[^>]*)>/;
  const m = openRe.exec(html);
  if (!m) return html;
  const tagName = m[1];
  if (!tagName) return html;
  const tagLower = tagName.toLowerCase();
  const openStart = m.index;
  const openEnd = openStart + m[0].length;
  const close = findMatchingClose(html, openEnd, tagLower);
  if (close === -1) return html;
  const openTag = m[0];
  const openNoHidden = openTag.replace(/\s+hidden(?=[\s>])/g, "");
  return (
    html.slice(0, openStart) +
    openNoHidden +
    `\n${innerHtml}\n          ` +
    html.slice(close)
  );
}

// Given `html` and an offset just past an opening `<tag …>`, return the
// index of the matching `</tag>`. Returns -1 if unbalanced. Only
// handles the subset of HTML we control: attribute-less `<` in text is
// not expected, and nested tags of the same name are counted.
function findMatchingClose(html: string, from: number, tagLower: string): number {
  const tokenRe = new RegExp(`<(/)?${tagLower}\\b[^>]*>`, "gi");
  tokenRe.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const isClose = match[1] === "/";
    if (isClose) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }
  return -1;
}
