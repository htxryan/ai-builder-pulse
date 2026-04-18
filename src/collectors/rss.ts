import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { RawItem } from "../types.js";
import { RawItemSchema } from "../types.js";
import { DEFAULT_REDIRECT_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";
import { resolveRedirects } from "./redirect.js";
import type { Collector, CollectorContext } from "./types.js";

export const DEFAULT_FEEDS: readonly string[] = [
  "https://simonwillison.net/atom/everything/",
  "https://huggingface.co/blog/feed.xml",
  "https://blog.langchain.dev/rss/",
  "https://openai.com/blog/rss.xml",
  "https://www.anthropic.com/news/rss.xml",
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  trimValues: true,
  textNodeName: "_text",
});

// Normalises fast-xml-parser output where a node may be a single value, an
// array, or undefined — callers treat the result uniformly as a list.
function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// Type guard: narrows unknown to a keyed object view. Avoids per-callsite
// `as Record<string, unknown>` assertions after a plain typeof check.
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function textOf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  const obj = asRecord(node);
  if (obj) {
    if (typeof obj._text === "string") return obj._text;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return undefined;
}

function atomLink(linkNode: unknown): string | undefined {
  if (!linkNode) return undefined;
  for (const n of asArray(linkNode)) {
    if (typeof n === "string") return n;
    const o = asRecord(n);
    if (o) {
      const rel = o["@_rel"];
      const href = o["@_href"];
      if ((rel === undefined || rel === "alternate") && typeof href === "string") {
        return href;
      }
    }
  }
  return undefined;
}

export interface ParsedFeedEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedMs: number;
  readonly author?: string;
}

export function parseFeedXml(xml: string, feedUrl: string): ParsedFeedEntry[] {
  let obj: unknown;
  try {
    obj = parser.parse(xml);
  } catch {
    return [];
  }
  const root = asRecord(obj);
  if (!root) return [];

  // Atom: <feed><entry>...</entry></feed>
  const feed = asRecord(root.feed);
  if (feed) {
    const out: ParsedFeedEntry[] = [];
    for (const entryRaw of asArray(feed.entry)) {
      const e = asRecord(entryRaw);
      if (!e) continue;
      const id = textOf(e.id) ?? textOf(e.guid) ?? atomLink(e.link);
      const title = textOf(e.title);
      const link = atomLink(e.link);
      const published =
        textOf(e.published) ?? textOf(e.updated) ?? textOf(e["pubDate"]);
      if (!id || !title || !link || !published) continue;
      const ms = Date.parse(published);
      if (!Number.isFinite(ms)) continue;
      let author: string | undefined;
      const authorRecord = asRecord(e.author);
      if (authorRecord) {
        author = textOf(authorRecord.name);
      } else if (typeof e.author === "string") {
        author = e.author;
      }
      const entry: ParsedFeedEntry = author
        ? { id: `rss-${hashFeedId(feedUrl, id)}`, title, url: link, publishedMs: ms, author }
        : { id: `rss-${hashFeedId(feedUrl, id)}`, title, url: link, publishedMs: ms };
      out.push(entry);
    }
    return out;
  }

  // RSS 2.0: <rss><channel><item>...</item></channel></rss>
  const rss = asRecord(root.rss);
  if (rss) {
    const channel = asRecord(rss.channel);
    if (!channel) return [];
    const out: ParsedFeedEntry[] = [];
    for (const itemRaw of asArray(channel.item)) {
      const it = asRecord(itemRaw);
      if (!it) continue;
      const link = textOf(it.link);
      const title = textOf(it.title);
      const pub = textOf(it.pubDate) ?? textOf(it["dc:date"]);
      const guid = textOf(it.guid) ?? link;
      if (!link || !title || !pub || !guid) continue;
      const ms = Date.parse(pub);
      if (!Number.isFinite(ms)) continue;
      const author = textOf(it["dc:creator"]) ?? textOf(it.author);
      const entry: ParsedFeedEntry = author
        ? { id: `rss-${hashFeedId(feedUrl, guid)}`, title, url: link, publishedMs: ms, author }
        : { id: `rss-${hashFeedId(feedUrl, guid)}`, title, url: link, publishedMs: ms };
      out.push(entry);
    }
    return out;
  }

  return [];
}

function hashFeedId(feedUrl: string, entryId: string): string {
  // sha1 truncated to 16 hex chars: stable, filesystem-safe, collision-resistant
  // across large feed corpora (FNV-32 had practical collision risk at scale).
  return createHash("sha1").update(`${feedUrl}#${entryId}`).digest("hex").slice(0, 16);
}

export interface RssFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolveImpl?: typeof resolveRedirects;
  readonly feeds?: readonly string[];
  readonly redirectConcurrency?: number;
}

async function fetchFeedXml(
  feedUrl: string,
  ctx: CollectorContext,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(feedUrl, {
    signal: ctx.abortSignal,
    headers: {
      accept: "application/atom+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.1",
      "user-agent": "ai-builder-pulse/0.1",
    },
  });
  if (!res.ok) throw new Error(`rss ${feedUrl} http ${res.status}`);
  return await res.text();
}

export async function mapRssEntry(
  entry: ParsedFeedEntry,
  feedUrl: string,
  ctx: CollectorContext,
  resolveImpl: typeof resolveRedirects,
): Promise<RawItem | null> {
  let url = entry.url;
  let sourceUrl: string | undefined;
  try {
    const resolved = await resolveImpl(entry.url, { signal: ctx.abortSignal });
    url = resolved.url;
    sourceUrl = resolved.sourceUrl;
  } catch {
    // keep original
  }
  const parsed = RawItemSchema.safeParse({
    id: entry.id,
    source: "rss",
    title: entry.title,
    url,
    sourceUrl,
    score: 1,
    publishedAt: new Date(entry.publishedMs).toISOString(),
    metadata: {
      source: "rss",
      feedUrl,
      author: entry.author,
    },
  });
  return parsed.success ? parsed.data : null;
}

export class RssCollector implements Collector {
  readonly source = "rss";
  constructor(private readonly opts: RssFetchOptions = {}) {}
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const resolveImpl = this.opts.resolveImpl ?? resolveRedirects;
    const feeds = this.opts.feeds ?? DEFAULT_FEEDS;
    const concurrency = this.opts.redirectConcurrency ?? DEFAULT_REDIRECT_CONCURRENCY;
    // Fetch feeds in parallel; tolerate individual failures.
    const feedResults = await Promise.all(
      feeds.map(async (feed) => {
        try {
          const xml = await fetchFeedXml(feed, ctx, fetchImpl);
          return { feed, entries: parseFeedXml(xml, feed) };
        } catch {
          return { feed, entries: [] as ParsedFeedEntry[] };
        }
      }),
    );
    const toMap: Array<{ entry: ParsedFeedEntry; feed: string }> = [];
    for (const { feed, entries } of feedResults) {
      for (const e of entries) {
        if (e.publishedMs < ctx.cutoffMs) continue;
        toMap.push({ entry: e, feed });
      }
    }
    const mapped = await mapWithConcurrency(toMap, concurrency, ({ entry, feed }) =>
      mapRssEntry(entry, feed, ctx, resolveImpl),
    );
    return mapped.filter((m): m is RawItem => m !== null);
  }
}

// re-export for test mocks
export { z };
