// Un-02 URL-shape validation. Drops items whose URL is structurally unsuitable
// to surface in a newsletter even if scheme-valid: bare domains carry no
// article context, and GitHub user-profile pages are owner pages with no
// release/news content.

export type UrlShapeRejectReason =
  | "scheme_invalid"
  | "bare_domain"
  | "github_user_profile"
  | "github_non_article";

export type UrlShapeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: UrlShapeRejectReason };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

// Single-segment github.com paths that are navigation / site features, not
// user profiles. They share the rejection outcome with profiles but need a
// distinct reason for accurate diagnostics.
const GITHUB_NON_ARTICLE_SINGLE = new Set([
  "explore",
  "trending",
  "marketplace",
  "sponsors",
  "settings",
  "features",
  "about",
  "pricing",
  "topics",
  "login",
  "signup",
  "notifications",
  "pulls",
  "issues",
  "codespaces",
  "new",
  "security",
]);

function classifyGithub(u: URL): UrlShapeRejectReason | null {
  if (!GITHUB_HOSTS.has(u.hostname)) return null;
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  const first = segments[0];
  if (first === undefined) return null; // bare-domain branch handles this
  if (GITHUB_NON_ARTICLE_SINGLE.has(first)) return "github_non_article";
  if (segments.length === 1) return "github_user_profile";
  if (first === "orgs" && segments.length <= 2) return "github_user_profile";
  return null;
}

export function validateUrlShape(input: string): UrlShapeResult {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "scheme_invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "scheme_invalid" };
  }
  const path = u.pathname;
  const hasMeaningfulPath = path.length > 0 && path !== "/";
  const hasQuery = u.search.length > 0;
  if (!hasMeaningfulPath && !hasQuery) {
    return { ok: false, reason: "bare_domain" };
  }
  const githubReason = classifyGithub(u);
  if (githubReason) {
    return { ok: false, reason: githubReason };
  }
  return { ok: true };
}
