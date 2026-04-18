// Un-02 URL-shape validation. Drops items whose URL is structurally unsuitable
// to surface in a newsletter even if scheme-valid: bare domains carry no
// article context, and GitHub user-profile pages are owner pages with no
// release/news content.

export type UrlShapeRejectReason =
  | "scheme_invalid"
  | "bare_domain"
  | "github_user_profile";

export type UrlShapeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: UrlShapeRejectReason };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

// Allow GitHub paths that look like a real artifact, not a user profile.
// `github.com/<user>` and `github.com/<user>/` are profiles; `github.com/<user>/<repo>`
// (and deeper) are project pages. `github.com/orgs/<org>/...` is also a profile.
function isGithubUserProfile(u: URL): boolean {
  if (!GITHUB_HOSTS.has(u.hostname)) return false;
  const segments = u.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false; // bare-domain branch handles this
  if (segments.length === 1) return true;
  if (segments[0] === "orgs" && segments.length <= 2) return true;
  return false;
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
  if (isGithubUserProfile(u)) {
    return { ok: false, reason: "github_user_profile" };
  }
  return { ok: true };
}
