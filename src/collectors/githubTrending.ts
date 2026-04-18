import { parse as parseHtml } from "node-html-parser";
import type { RawItem } from "../types.js";
import { RawItemSchema } from "../types.js";
import type { Collector, CollectorContext } from "./types.js";

const GITHUB_TRENDING_URL = "https://github.com/trending?since=daily&spoken_language_code=en";

export interface GithubTrendingFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
}

export interface TrendingRepo {
  readonly fullName: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stars: number;
  readonly starsToday: number;
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
    const starsAnchor = row.querySelector(`a[href="/${fullName}/stargazers"]`);
    const stars = parseIntSafe(starsAnchor?.text.trim());
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
): RawItem | null {
  const title = repo.description
    ? `${repo.fullName} — ${repo.description}`
    : repo.fullName;
  const parsed = RawItemSchema.safeParse({
    id: `ght-${repo.fullName.replace(/\//g, "-")}`,
    source: "github-trending",
    title: title.slice(0, 500),
    url: `https://github.com/${repo.fullName}`,
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
    const out: RawItem[] = [];
    for (const r of repos) {
      const mapped = mapTrendingToRawItem(r, ctx.runDate);
      if (mapped) out.push(mapped);
    }
    return out;
  }
}
