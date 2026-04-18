// C4 link-integrity predicate. Enforces Un-01: every URL a ScoredItem exposes
// to the Renderer MUST trace back to a URL in the raw-item set. Allowlist
// patterns (owned by the Renderer in E5) exempt known-static template URLs
// such as the Buttondown unsubscribe footer and the newsletter archive page.

import { normalizeUrl } from "../preFilter/url.js";
import type { RawItem, ScoredItem } from "../types.js";

export type LinkViolationLocation = "url" | "description";

export interface LinkViolation {
  readonly scoredItemId: string;
  readonly url: string;
  readonly location: LinkViolationLocation;
  readonly reason: "not_in_raw_set" | "unparseable";
}

export interface LinkIntegrityResult {
  readonly ok: boolean;
  readonly violations: readonly LinkViolation[];
  readonly checkedCount: number;
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
): LinkIntegrityResult {
  const rawSet = buildRawUrlSet(raw);
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
      });
      return;
    }
    if (!rawSet.has(canonical)) {
      violations.push({
        scoredItemId: scoredId,
        url,
        location,
        reason: "not_in_raw_set",
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
