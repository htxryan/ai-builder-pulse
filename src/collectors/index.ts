import type { RawItem, RunContext, Source, SourceSummary } from "../types.js";
import { log } from "../log.js";
import { GithubTrendingCollector } from "./githubTrending.js";
import { HnCollector } from "./hn.js";
import { RedditCollector, pickRedditMode } from "./reddit.js";
import { RssCollector } from "./rss.js";
import { TwitterCollector } from "./twitter.js";
import {
  DEFAULT_COLLECTOR_TIMEOUT_MS,
  CollectorTimeoutError,
  withTimeout,
} from "./timeout.js";
import type { Collector, CollectorContext } from "./types.js";
import { cutoffForRunDate } from "./types.js";

export {
  HnCollector,
  GithubTrendingCollector,
  RedditCollector,
  RssCollector,
  TwitterCollector,
};
export * from "./types.js";
export * from "./timeout.js";
export * from "./redirect.js";

export interface FetchAllOptions {
  readonly collectors?: readonly Collector[];
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export function defaultCollectors(): Collector[] {
  return [
    new HnCollector(),
    new GithubTrendingCollector(),
    new RedditCollector(),
    new RssCollector(),
    new TwitterCollector(),
  ];
}

function classifyError(err: unknown): "timeout" | "error" {
  if (err instanceof CollectorTimeoutError) return "timeout";
  if (
    err instanceof Error &&
    (err.name === "AbortError" || /abort/i.test(err.message))
  ) {
    return "timeout";
  }
  return "error";
}

function reasonForReddit(env: NodeJS.ProcessEnv): string | undefined {
  const mode = pickRedditMode(env);
  if (mode === "skip") return "reddit disabled via env";
  return undefined;
}

export async function fetchAll(
  ctx: RunContext,
  opts: FetchAllOptions = {},
): Promise<{ items: RawItem[]; summary: SourceSummary }> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const collectors = opts.collectors ?? defaultCollectors();
  const cutoffMs = cutoffForRunDate(ctx.runDate);

  const results = await Promise.all(
    collectors.map(async (c) => {
      const source = c.source as Source;
      // O-01 / S-04 skip semantics emerge from collector returning [] when flag off.
      // Record distinct "skipped" status when the collector itself signals skip.
      if (source === "twitter" && env.ENABLE_TWITTER !== "1") {
        return {
          source,
          items: [] as RawItem[],
          status: "skipped" as const,
          error: "ENABLE_TWITTER not set",
        };
      }
      if (source === "reddit") {
        const skipReason = reasonForReddit(env);
        if (skipReason) {
          return {
            source,
            items: [] as RawItem[],
            status: "skipped" as const,
            error: skipReason,
          };
        }
      }
      const subCtx: CollectorContext = {
        runDate: ctx.runDate,
        cutoffMs,
        abortSignal: new AbortController().signal,
        env,
      };
      try {
        const items = await withTimeout(source, timeoutMs, async (signal) => {
          const inner: CollectorContext = { ...subCtx, abortSignal: signal };
          return await c.fetch(inner);
        });
        return { source, items, status: "ok" as const };
      } catch (err) {
        const kind = classifyError(err);
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("collector failed", { source, kind, error: msg });
        return {
          source,
          items: [] as RawItem[],
          status: kind,
          error: msg,
        };
      }
    }),
  );

  const items: RawItem[] = [];
  const summary: SourceSummary = {};
  for (const r of results) {
    summary[r.source] = {
      count: r.items.length,
      status: r.status,
      error: r.status === "ok" ? undefined : r.error,
    };
    for (const it of r.items) items.push(it);
  }
  return { items, summary };
}
