import type { RawItem } from "../types.js";

// Hardcoded HN megathread title fragments. Match is case-insensitive substring
// so any variant ("Ask HN: Who is Hiring? (April 2026)", "WHO IS HIRING in AI
// (2026)", etc.) is caught without per-month upkeep. Only applied when
// `item.source === "hn"`; other sources are unaffected even if their titles
// happen to contain the same phrase.
export const HARDCODED_HN_DROP_PATTERNS: readonly string[] = [
  "who is hiring",
  "who wants to be hired",
  "seeking freelancer",
];

const ENV_VAR_NAME = "HN_DROP_PATTERNS";

function parseEnvPatterns(env: NodeJS.ProcessEnv | undefined): string[] {
  const raw = env?.[ENV_VAR_NAME];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Returns true iff `item.source === "hn"` AND the lowercased title contains
 * any hardcoded pattern or any pattern from `HN_DROP_PATTERNS` (comma-
 * separated, trimmed). Pure: no side effects, no I/O.
 */
export function matchesHnDropPattern(
  item: RawItem,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (item.source !== "hn") return false;
  const haystack = item.title.toLowerCase();
  for (const pat of HARDCODED_HN_DROP_PATTERNS) {
    if (haystack.includes(pat)) return true;
  }
  for (const pat of parseEnvPatterns(env)) {
    if (haystack.includes(pat)) return true;
  }
  return false;
}
