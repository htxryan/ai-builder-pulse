// C4 link-integrity predicate. Enforces Un-01: every URL a ScoredItem exposes
// to the Renderer MUST trace back to a URL in the raw-item set. Allowlist
// patterns (owned by the Renderer in E5) exempt known-static template URLs
// such as the Buttondown unsubscribe footer and the newsletter archive page.

import { normalizeUrl } from "../preFilter/url.js";
import type { RawItem, ScoredItem } from "../types.js";

export type LinkViolationLocation = "url" | "description";

// Semantic classification of a violation. Callers use this to distinguish a
// hallucinated URL (Claude fabricated something that never appeared in any
// source) from a legitimate pre-filter miss (URL was in raw collection but
// got dropped on freshness/shape/dedup grounds) — the remediation differs.
//   - `not_in_raw_set`: URL does not appear in the post-pre-filter raw set
//     AND is not known to have been dropped; most likely hallucinated.
//   - `dropped_by_pre_filter`: URL was in the pre-pre-filter raw set but the
//     filter dropped it. Requires passing `opts.preFilterRaw` to classify.
//   - `unparseable`: URL could not be normalized — schema-invalid string or
//     template placeholder. Almost always a renderer or curator bug.
//   - `external_allowlist_violation`: reserved for future use (e.g.
//     distinguishing a hallucinated buttondown.com URL in a context where
//     the renderer's allowlist was intentionally not passed). Not currently
//     emitted by `verifyLinkIntegrity` — kinds are additive.
export type LinkViolationKind =
  | "not_in_raw_set"
  | "dropped_by_pre_filter"
  | "unparseable"
  | "external_allowlist_violation";

export interface LinkViolation {
  readonly scoredItemId: string;
  readonly url: string;
  readonly location: LinkViolationLocation;
  // Legacy two-value structural reason. Preserved for log-line compatibility
  // and coarse triage; `kind` is the preferred discriminator for new code.
  readonly reason: "not_in_raw_set" | "unparseable";
  readonly kind: LinkViolationKind;
}

export interface LinkIntegrityResult {
  readonly ok: boolean;
  readonly violations: readonly LinkViolation[];
  readonly checkedCount: number;
}

export interface LinkIntegrityOptions {
  // Pre-pre-filter raw items. When provided, violations whose canonical URL
  // appears in this set but not in the post-filter set are classified as
  // `dropped_by_pre_filter` instead of `not_in_raw_set`. Omit to fall back
  // to the conservative "not_in_raw_set" default.
  readonly preFilterRaw?: readonly RawItem[];
}

// Permissive matcher for URLs embedded in free text. Covers both Markdown
// link syntax `[text](url)` and bare `https://...`. We keep it simple and
// then canonicalize via normalizeUrl — the normalizer is the trust anchor.
const MD_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL_RE = /(?<![(\[])https?:\/\/[^\s)<>"']+/gi;

function extractUrlsFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MD_LINK_RE)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of text.matchAll(BARE_URL_RE)) {
    if (m[0]) out.push(m[0]);
  }
  return out;
}

function buildRawUrlSet(raw: readonly RawItem[]): Set<string> {
  const set = new Set<string>();
  for (const item of raw) {
    const norms = [item.url, item.sourceUrl].filter(
      (x): x is string => typeof x === "string",
    );
    for (const n of norms) {
      const canonical = normalizeUrl(n);
      if (canonical) set.add(canonical);
    }
  }
  return set;
}

function matchesAllowlist(
  url: string,
  allowlist: readonly RegExp[],
): boolean {
  return allowlist.some((pat) => pat.test(url));
}

// Pure, synchronous, deterministic. Callers pass an allowlist of RegExp
// patterns that the Renderer controls — leave empty for raw E4 gate usage.
export function verifyLinkIntegrity(
  scored: readonly ScoredItem[],
  raw: readonly RawItem[],
  allowlistPatterns: readonly RegExp[] = [],
  opts: LinkIntegrityOptions = {},
): LinkIntegrityResult {
  const rawSet = buildRawUrlSet(raw);
  const preFilterSet = opts.preFilterRaw
    ? buildRawUrlSet(opts.preFilterRaw)
    : undefined;
  const violations: LinkViolation[] = [];
  let checked = 0;

  const check = (
    scoredId: string,
    url: string,
    location: LinkViolationLocation,
  ): void => {
    checked += 1;
    if (matchesAllowlist(url, allowlistPatterns)) return;
    const canonical = normalizeUrl(url);
    if (canonical === null) {
      violations.push({
        scoredItemId: scoredId,
        url,
        location,
        reason: "unparseable",
        kind: "unparseable",
      });
      return;
    }
    if (!rawSet.has(canonical)) {
      const kind: LinkViolationKind =
        preFilterSet && preFilterSet.has(canonical)
          ? "dropped_by_pre_filter"
          : "not_in_raw_set";
      violations.push({
        scoredItemId: scoredId,
        url,
        location,
        reason: "not_in_raw_set",
        kind,
      });
    }
  };

  for (const s of scored) {
    check(s.id, s.url, "url");
    for (const extracted of extractUrlsFromText(s.description)) {
      check(s.id, extracted, "description");
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedCount: checked,
  };
}
