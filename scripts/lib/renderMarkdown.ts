// Markdown → sanitized HTML helper for the brochure/archive site build.
//
// Used by later tasks (T3 renders `issues/<date>/issue.md`; T4 derives
// archive titles via `extractH1`). Kept pure and deterministic so the
// artifact is byte-stable for a given input.
//
// Design notes:
//   - `marked` is the single parser. No second HTML parser (e.g. cheerio,
//     jsdom) is pulled in for sanitation — we own the generator and the
//     inputs (our own `issue.md` plus occasional curator output), so a
//     small allowlist-based post-processor is sufficient and ships far
//     less code than DOMPurify+jsdom.
//   - Sanitation is deliberately aggressive: unknown/unsafe tags are
//     dropped with their content; URL-bearing attributes are validated
//     against a scheme allowlist; every `on*` handler attribute is
//     stripped. When in doubt, strip.
//   - Token walking for `extractH1` uses marked's tokenizer directly so
//     we don't parse the source twice.

import { marked, type Token, type Tokens } from "marked";

/**
 * Tags removed entirely from the rendered HTML (opening tag, content,
 * and closing tag all elided). `<script>`/`<style>` must never reach
 * the browser; the rest are either capable of loading external
 * resources (`<iframe>`, `<object>`, `<embed>`, `<link>`) or of
 * redirecting relative-URL resolution and form posts in ways the
 * brochure site has no use for.
 */
const FORBIDDEN_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
] as const;

/**
 * Regex that matches a whole forbidden element — opening tag through
 * closing tag — as well as its inner content. `[\s\S]` rather than `.`
 * so newlines inside the block are consumed. The `i` flag covers
 * `<SCRIPT>`, `<Script>`, etc. Self-closing variants are handled by
 * the second alternative.
 *
 * Built once at module load because the allowlist is static.
 */
const FORBIDDEN_TAG_RE = new RegExp(
  FORBIDDEN_TAGS.map(
    (tag) =>
      // Paired form: <tag ...>...</tag>
      `<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>` +
      // OR self-closing / void form: <tag ... /> or <tag ...>
      `|<${tag}\\b[^>]*\\/?>`,
  ).join("|"),
  "gi",
);

/**
 * Strip every attribute whose name begins with `on` (case-insensitive).
 * Matches `onclick=`, `ONERROR="..."`, `onLoad='...'`, and the rarer
 * bareword form `onfocus` (no value). The leading `\s+` ensures we only
 * match attributes, not text inside content.
 */
const ON_ATTR_RE =
  /\s+on[a-z0-9_-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gi;

/**
 * Matches `href=` or `src=` with any of the three quoting styles.
 * Capture groups:
 *   1. attribute name (`href` | `src`)
 *   2. quote character (`"` | `'` | empty for unquoted)
 *   3. URL value
 */
const URL_ATTR_RE =
  /\b(href|src)\s*=\s*(?:(")([^"]*)"|(')([^']*)'|()([^\s>]+))/gi;

/**
 * Schemes we refuse to emit. Anything starting with these (after
 * trimming whitespace — browsers tolerate leading whitespace in URL
 * attributes, so an attacker can smuggle `\tjavascript:` past a naive
 * check) gets rewritten to `#` which is a no-op navigation.
 */
const DANGEROUS_SCHEME_RE = /^\s*(javascript|data|vbscript):/i;

function neutralizeUrl(url: string): string {
  return DANGEROUS_SCHEME_RE.test(url) ? "#" : url;
}

/**
 * Post-process marked's HTML output: remove forbidden tags, strip
 * event handlers, and neutralize dangerous URL schemes on `href`/`src`.
 * The inner text of allowed tags is left untouched.
 */
function sanitizeHtml(html: string): string {
  let out = html.replace(FORBIDDEN_TAG_RE, "");
  out = out.replace(ON_ATTR_RE, "");
  out = out.replace(URL_ATTR_RE, (_match, name: string, ...groups: string[]) => {
    // The alternation yields six capture groups (quote+value × 3).
    // Find whichever pair matched and rebuild the attribute with a
    // safe URL. We always re-emit with double quotes for consistency.
    const dq = groups[0] === '"' ? groups[1] : undefined;
    const sq = groups[2] === "'" ? groups[3] : undefined;
    const uq = groups[4] === "" ? groups[5] : undefined;
    const raw = dq ?? sq ?? uq ?? "";
    const safe = neutralizeUrl(raw);
    return ` ${name}="${safe}"`;
  });
  return out;
}

/**
 * Render markdown `src` to sanitized HTML. Pure / deterministic.
 */
export function renderMarkdown(src: string): string {
  // `marked(src)` can return `string | Promise<string>` depending on
  // async extension configuration. We use no async extensions, so the
  // return is synchronous; narrow here at the boundary rather than
  // leaking the union upward.
  const raw = marked.parse(src, { async: false });
  if (typeof raw !== "string") {
    throw new Error("marked returned a non-string value (unexpected async path)");
  }
  return sanitizeHtml(raw);
}

/**
 * Return the text of the first `#` heading in `src`, or `null` if the
 * source contains no H1. Walks marked's token stream directly so the
 * source isn't parsed twice when callers also need the HTML.
 */
export function extractH1(src: string): string | null {
  const tokens = marked.lexer(src);
  const first = findFirstH1(tokens);
  return first?.text.trim() ?? null;
}

function findFirstH1(tokens: readonly Token[]): Tokens.Heading | null {
  for (const token of tokens) {
    if (token.type === "heading" && (token as Tokens.Heading).depth === 1) {
      return token as Tokens.Heading;
    }
  }
  return null;
}
