// Strip URLs from ScoredItem descriptions before Un-01 runs.
//
// Rationale: the curator system prompt forbids URLs in the description
// field (plain prose only). Models still occasionally emit well-known
// homepage URLs pulled from training data — cloud.qdrant.io for the
// Qdrant repo, for instance. A hallucinated URL embedded in description
// would trip verifyLinkIntegrity and fail-close the entire run. This
// sanitizer enforces the prompt rule programmatically so a single line
// of errant prose cannot nuke the day.
//
// The guard on `ScoredItem.url` (the primary link) stays unchanged — only
// URLs embedded *inside the description text* are stripped. A hallucinated
// primary `url` will still correctly fail Un-01.

import type { ScoredItem } from "../types.js";

const MD_LINK_RE = /\[([^\]]*)\]\(https?:\/\/[^\s)]+\)/gi;
const BARE_URL_RE = /https?:\/\/[^\s)<>"']+/gi;

export interface SanitizeResult {
  readonly items: readonly ScoredItem[];
  // Ids of items whose description had at least one URL stripped. Surfaced
  // so the orchestrator can log them — a persistent id here means the
  // prompt tightening needs another pass.
  readonly strippedIds: readonly string[];
}

function cleanDescription(raw: string): string {
  // [title](url) → title (preserve the link text, drop the target).
  const withoutMdLinks = raw.replace(MD_LINK_RE, (_m, text: string) => text);
  // Any remaining bare URL → empty string.
  const withoutBareUrls = withoutMdLinks.replace(BARE_URL_RE, "");
  // Collapse runs of whitespace and clean up stranded punctuation/parens
  // left behind when a URL is removed mid-sentence (e.g. "…see (.) for…").
  return withoutBareUrls
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeDescriptions(
  scored: readonly ScoredItem[],
): SanitizeResult {
  const out: ScoredItem[] = [];
  const strippedIds: string[] = [];
  for (const s of scored) {
    const cleaned = cleanDescription(s.description);
    if (cleaned !== s.description) {
      strippedIds.push(s.id);
      // Fall back to the original description if stripping left it too
      // short to satisfy downstream schemas — preserves fail-close
      // behavior for the pathological "description was only a URL" case.
      const safe = cleaned.length >= 20 ? cleaned : s.description;
      out.push({ ...s, description: safe });
    } else {
      out.push(s);
    }
  }
  return { items: out, strippedIds };
}
