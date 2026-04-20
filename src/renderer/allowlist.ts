// Template-URL allowlist owned by the Renderer (C5). These patterns exempt
// static URLs the Renderer injects into the issue body (newsletter home,
// archive, per-subscriber unsubscribe link) from the Un-01 link-integrity
// check. Callers pass the patterns to `verifyLinkIntegrity` as the third arg.
//
// Pattern matching runs against the raw URL string as it appears in rendered
// text — do NOT rely on URL normalization here. The patterns must match the
// exact literal forms the renderer emits.

// Canonical newsletter name on Buttondown. Used to construct home + archive
// URLs. Kept as a constant so renderer body and allowlist pattern stay in sync.
export const NEWSLETTER_SLUG = "ai-builder-pulse";

export const NEWSLETTER_HOME_URL = `https://buttondown.com/${NEWSLETTER_SLUG}`;
export const NEWSLETTER_ARCHIVE_URL = `https://buttondown.com/${NEWSLETTER_SLUG}/archive/`;

// Buttondown substitutes `{{unsubscribe_url}}` at send time with a
// per-subscriber tokenized URL of the form:
//   https://buttondown.com/emails/<token>/unsubscribe
// The renderer emits the Django template variable literally in markdown; the
// URL-extraction regex in linkIntegrity does NOT match `{{...}}` patterns, so
// we do not need an allowlist entry for the template variable itself. The
// pattern below covers the realized URL in case future renderer code emits
// a concrete unsubscribe URL (e.g., a preview build).
export const RENDERER_TEMPLATE_URL_PATTERNS: readonly RegExp[] = [
  // Newsletter home: exact match OR trailing path (e.g., /archive/, /subscribe).
  new RegExp(
    `^https://buttondown\\.com/${NEWSLETTER_SLUG}(/.*)?$`,
  ),
  // Realized per-subscriber unsubscribe URL.
  /^https:\/\/buttondown\.com\/emails\/[^/\s]+\/unsubscribe(\?.*)?$/,
];
