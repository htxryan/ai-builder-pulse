import { z } from "zod";
import type { RawItem } from "../types.js";
import { RawItemSchema } from "../types.js";
import { resolveRedirects } from "./redirect.js";
import type { Collector, CollectorContext } from "./types.js";

const HN_ALGOLIA_ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";

const HnHitSchema = z.object({
  objectID: z.string(),
  title: z.string().nullable().optional(),
  story_title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  story_url: z.string().nullable().optional(),
  points: z.number().int().nullable().optional(),
  num_comments: z.number().int().nullable().optional(),
  author: z.string().nullable().optional(),
  created_at_i: z.number().int(),
});

const HnResponseSchema = z.object({
  hits: z.array(HnHitSchema),
});

export type HnHit = z.infer<typeof HnHitSchema>;

export interface HnFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolveImpl?: typeof resolveRedirects;
  readonly tags?: string;
  readonly hitsPerPage?: number;
}

export async function fetchHnRaw(
  ctx: CollectorContext,
  opts: HnFetchOptions = {},
): Promise<HnHit[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tags = opts.tags ?? "story";
  const hitsPerPage = opts.hitsPerPage ?? 100;
  const cutoffSec = Math.floor(ctx.cutoffMs / 1000);
  const params = new URLSearchParams({
    tags,
    numericFilters: `created_at_i>${cutoffSec}`,
    hitsPerPage: String(hitsPerPage),
  });
  const res = await fetchImpl(`${HN_ALGOLIA_ENDPOINT}?${params.toString()}`, {
    signal: ctx.abortSignal,
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`hn algolia http ${res.status}`);
  }
  const json = await res.json();
  return HnResponseSchema.parse(json).hits;
}

export async function mapHnHitToRawItem(
  hit: HnHit,
  ctx: CollectorContext,
  resolveImpl: typeof resolveRedirects,
): Promise<RawItem | null> {
  const title = hit.title ?? hit.story_title;
  const rawUrl = hit.url ?? hit.story_url;
  if (!title || !rawUrl) return null;
  let url = rawUrl;
  let sourceUrl: string | undefined;
  try {
    const resolved = await resolveImpl(rawUrl, { signal: ctx.abortSignal });
    url = resolved.url;
    sourceUrl = resolved.sourceUrl;
  } catch {
    // if redirect resolution fails, keep the original url
  }
  const publishedAt = new Date(hit.created_at_i * 1000).toISOString();
  const parsed = RawItemSchema.safeParse({
    id: `hn-${hit.objectID}`,
    source: "hn",
    title,
    url,
    sourceUrl,
    score: hit.points ?? 0,
    publishedAt,
    metadata: {
      source: "hn",
      points: hit.points ?? undefined,
      numComments: hit.num_comments ?? undefined,
      author: hit.author ?? undefined,
    },
  });
  return parsed.success ? parsed.data : null;
}

export class HnCollector implements Collector {
  readonly source = "hn";
  constructor(private readonly opts: HnFetchOptions = {}) {}
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    const resolveImpl = this.opts.resolveImpl ?? resolveRedirects;
    const hits = await fetchHnRaw(ctx, this.opts);
    const items: RawItem[] = [];
    for (const hit of hits) {
      const mapped = await mapHnHitToRawItem(hit, ctx, resolveImpl);
      if (mapped) items.push(mapped);
    }
    return items;
  }
}
