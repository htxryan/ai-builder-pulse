// Shared, pure URL normalizer used for dedup keys (E3) and link-integrity
// canonicalization (E4). Keep deterministic: same input → same output. No I/O.

const TRACKING_PARAM_PATTERNS: readonly RegExp[] = [
  /^utm_/i,
  /^_ga$/i,
  /^_gl$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^mc_eid$/i,
  /^mc_cid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^mkt_tok$/i,
  /^vero_id$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^ref_url$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^msclkid$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((p) => p.test(key));
}

// Returns canonicalized URL string, or null if input is not parseable as
// http(s). Canonical form:
//   - lowercase host (case-insensitive per RFC 3986 §3.2.2)
//   - default ports stripped
//   - tracking query params removed
//   - remaining query params sorted by key for stable comparison
//   - trailing slash stripped from non-root paths
//   - fragment removed
export function normalizeUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hostname = u.hostname.toLowerCase();
  // Drop userinfo so `https://user@example.com/x` and `https://example.com/x`
  // dedup to the same canonical form. Public newsletter URLs should never
  // carry credentials; if one slips through it must not split the dedup key.
  u.username = "";
  u.password = "";
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  const entries = [...u.searchParams.entries()].filter(
    ([key]) => !isTrackingParam(key),
  );
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [k, v] of entries) sorted.append(k, v);
  u.search = sorted.toString() ? `?${sorted.toString()}` : "";

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/g, "") || "/";
  }

  u.hash = "";
  return u.toString();
}
