import { parse as parseHtml } from "node-html-parser";
import type { RawItem } from "../types.js";
import { RawItemSchema } from "../types.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { Collector, CollectorContext } from "./types.js";

const GITHUB_TRENDING_URL = "https://github.com/trending?since=daily&spoken_language_code=en";
const GITHUB_API_BASE = "https://api.github.com";
const HOMEPAGE_LOOKUP_CONCURRENCY = 4;

export interface GithubTrendingFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
  // When true (default), each trending repo is enriched with its `homepage`
  // field from the GitHub REST API so the Un-01 link-integrity gate accepts
  // it if the curator references it in a description. Disabled in fixture
  // tests that only care about the trending HTML→RawItem mapping.
  readonly enrichHomepage?: boolean;
}

export interface TrendingRepo {
  readonly fullName: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stars: number;
  readonly starsToday: number;
}

// Canonicalize a `homepage` string from the GitHub API. Accepts bare hostnames
// ("example.com") and missing-scheme URLs ("www.example.com/path"); returns a
// fully-qualified https URL or null if the value cannot be interpreted.
export function normalizeHomepage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function fetchRepoHomepage(
  fullName: string,
  ctx: CollectorContext,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ai-builder-pulse/0.1 (+github.com/ryanandrewhenderson)",
    "x-github-api-version": "2022-11-28",
  };
  const token = ctx.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`${GITHUB_API_BASE}/repos/${fullName}`, {
      signal: ctx.abortSignal,
      headers,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { homepage?: string | null };
    return normalizeHomepage(body.homepage);
  } catch {
    // Enrichment is best-effort — a failure here must never abort the
    // collector. The caller falls back to un-enriched RawItems.
    return null;
  }
}

function parseIntSafe(txt: string | undefined): number {
  if (!txt) return 0;
  const n = Number.parseInt(txt.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseTrendingHtml(html: string): TrendingRepo[] {
  const root = parseHtml(html);
  const rows = root.querySelectorAll("article.Box-row");
  const out: TrendingRepo[] = [];
  for (const row of rows) {
    const anchor = row.querySelector("h2 a") ?? row.querySelector("h1 a");
    const href = anchor?.getAttribute("href");
    if (!href) continue;
    const fullName = href.replace(/^\/+/, "").trim();
    if (!fullName.includes("/")) continue;
    const descEl = row.querySelector("p");
    const description = descEl?.text.trim().replace(/\s+/g, " ") ?? null;
    const languageEl = row.querySelector("[itemprop=programmingLanguage]");
    const language = languageEl?.text.trim() ?? null;
    // Iterate anchors rather than interpolating fullName into a CSS selector —
    // unusual (but legal) characters in repo/org names would break selection.
    let stars = 0;
    for (const a of row.querySelectorAll("a")) {
      const h = a.getAttribute("href");
      if (h && h.endsWith(`/${fullName}/stargazers`)) {
        stars = parseIntSafe(a.text.trim());
        break;
      }
    }
    let starsToday = 0;
    for (const span of row.querySelectorAll("span.d-inline-block")) {
      const t = span.text;
      if (/stars? today/i.test(t)) {
        starsToday = parseIntSafe(t);
        break;
      }
    }
    out.push({ fullName, description, language, stars, starsToday });
  }
  return out;
}

export async function fetchTrendingHtml(
  ctx: CollectorContext,
  opts: GithubTrendingFetchOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? GITHUB_TRENDING_URL;
  const res = await fetchImpl(url, {
    signal: ctx.abortSignal,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "ai-builder-pulse/0.1 (+github.com/ryanandrewhenderson)",
    },
  });
  if (!res.ok) {
    throw new Error(`github trending http ${res.status}`);
  }
  return await res.text();
}

export function mapTrendingToRawItem(
  repo: TrendingRepo,
  runDate: string,
  homepage: string | null = null,
): RawItem | null {
  const title = repo.description
    ? `${repo.fullName} — ${repo.description}`
    : repo.fullName;
  const parsed = RawItemSchema.safeParse({
    id: `ght-${repo.fullName.replace(/\//g, "-")}`,
    source: "github-trending",
    title: title.slice(0, 500),
    url: `https://github.com/${repo.fullName}`,
    // Declared homepage (when the repo sets one on GitHub) goes into
    // `sourceUrl` so `verifyLinkIntegrity` accepts it as an allowed URL.
    // Without this, the curator's tendency to reference well-known project
    // homepages ("cloud.qdrant.io", etc.) from training data trips the
    // Un-01 gate and fails-closed the whole run.
    ...(homepage ? { sourceUrl: homepage } : {}),
    score: repo.starsToday || repo.stars,
    publishedAt: `${runDate}T00:00:00.000Z`,
    metadata: {
      source: "github-trending",
      repoFullName: repo.fullName,
      stars: repo.stars || undefined,
      starsToday: repo.starsToday || undefined,
      language: repo.language,
    },
  });
  return parsed.success ? parsed.data : null;
}

export class GithubTrendingCollector implements Collector {
  readonly source = "github-trending";
  constructor(private readonly opts: GithubTrendingFetchOptions = {}) {}
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    const html = await fetchTrendingHtml(ctx, this.opts);
    const repos = parseTrendingHtml(html);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const enrich = this.opts.enrichHomepage !== false;
    const homepages: (string | null)[] = enrich
      ? await mapWithConcurrency(repos, HOMEPAGE_LOOKUP_CONCURRENCY, (r) =>
          fetchRepoHomepage(r.fullName, ctx, fetchImpl),
        )
      : repos.map(() => null);
    const out: RawItem[] = [];
    for (let i = 0; i < repos.length; i += 1) {
      const mapped = mapTrendingToRawItem(repos[i]!, ctx.runDate, homepages[i] ?? null);
      if (mapped) out.push(mapped);
    }
    return out;
  }
}
