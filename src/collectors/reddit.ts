import { z } from "zod";
import type { RawItem } from "../types.js";
import { RawItemSchema } from "../types.js";
import { resolveRedirects } from "./redirect.js";
import type { Collector, CollectorContext } from "./types.js";

export const DEFAULT_SUBREDDITS = [
  "LocalLLaMA",
  "MachineLearning",
  "mlops",
  "OpenAI",
  "LangChain",
];

const USER_AGENT = "ai-builder-pulse/0.1 (by /u/ai-builder-pulse-bot)";

const RedditPostDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  permalink: z.string(),
  score: z.number().int(),
  num_comments: z.number().int().nonnegative().default(0),
  subreddit: z.string(),
  created_utc: z.number(),
  author: z.string().optional(),
  is_self: z.boolean().optional(),
  stickied: z.boolean().optional(),
});

const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(
      z.object({
        kind: z.literal("t3"),
        data: RedditPostDataSchema,
      }),
    ),
  }),
});

type RedditPost = z.infer<typeof RedditPostDataSchema>;

export type RedditMode = "oauth" | "public" | "skip";

export function pickRedditMode(env: NodeJS.ProcessEnv): RedditMode {
  if (env.REDDIT_DISABLED === "1") return "skip";
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) return "oauth";
  if (env.REDDIT_FALLBACK_PUBLIC === "0") return "skip";
  return "public";
}

export interface RedditFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolveImpl?: typeof resolveRedirects;
  readonly subreddits?: readonly string[];
  readonly limit?: number;
}

async function getOauthToken(
  ctx: CollectorContext,
  fetchImpl: typeof fetch,
): Promise<string> {
  const id = ctx.env.REDDIT_CLIENT_ID;
  const secret = ctx.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("reddit: missing client credentials");
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    signal: ctx.abortSignal,
    headers: {
      authorization: `Basic ${auth}`,
      "user-agent": USER_AGENT,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`reddit oauth http ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("reddit oauth: no token in response");
  return json.access_token;
}

async function fetchSubredditListing(
  subreddit: string,
  ctx: CollectorContext,
  mode: "oauth" | "public",
  fetchImpl: typeof fetch,
  limit: number,
  token?: string,
): Promise<RedditPost[]> {
  const base =
    mode === "oauth"
      ? `https://oauth.reddit.com/r/${subreddit}/new`
      : `https://www.reddit.com/r/${subreddit}/new.json`;
  const params = new URLSearchParams({ limit: String(limit), t: "day" });
  const url = `${base}?${params.toString()}`;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
  };
  if (mode === "oauth" && token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { signal: ctx.abortSignal, headers });
  if (!res.ok) throw new Error(`reddit ${subreddit} http ${res.status}`);
  const json = await res.json();
  const parsed = RedditListingSchema.parse(json);
  return parsed.data.children.map((c) => c.data);
}

export async function mapRedditPost(
  post: RedditPost,
  ctx: CollectorContext,
  resolveImpl: typeof resolveRedirects,
): Promise<RawItem | null> {
  if (post.stickied || post.is_self) return null;
  let url = post.url;
  let sourceUrl: string | undefined;
  try {
    const resolved = await resolveImpl(post.url, { signal: ctx.abortSignal });
    url = resolved.url;
    sourceUrl = resolved.sourceUrl;
  } catch {
    // keep original
  }
  const publishedAt = new Date(post.created_utc * 1000).toISOString();
  const parsed = RawItemSchema.safeParse({
    id: `reddit-${post.id}`,
    source: "reddit",
    title: post.title,
    url,
    sourceUrl,
    score: post.score,
    publishedAt,
    metadata: {
      source: "reddit",
      subreddit: post.subreddit,
      upvotes: post.score,
      numComments: post.num_comments,
      permalink: `https://reddit.com${post.permalink}`,
    },
  });
  return parsed.success ? parsed.data : null;
}

export class RedditCollector implements Collector {
  readonly source = "reddit";
  constructor(private readonly opts: RedditFetchOptions = {}) {}
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const resolveImpl = this.opts.resolveImpl ?? resolveRedirects;
    const subs = this.opts.subreddits ?? DEFAULT_SUBREDDITS;
    const limit = this.opts.limit ?? 25;
    const mode = pickRedditMode(ctx.env);
    if (mode === "skip") return [];

    let token: string | undefined;
    if (mode === "oauth") {
      token = await getOauthToken(ctx, fetchImpl);
    }

    const out: RawItem[] = [];
    for (const sub of subs) {
      let posts: RedditPost[];
      try {
        posts = await fetchSubredditListing(sub, ctx, mode, fetchImpl, limit, token);
      } catch {
        continue;
      }
      for (const p of posts) {
        if (p.created_utc * 1000 < ctx.cutoffMs) continue;
        const mapped = await mapRedditPost(p, ctx, resolveImpl);
        if (mapped) out.push(mapped);
      }
    }
    return out;
  }
}
