import type { RawItem, RunContext, Source, SourceSummary } from "../types.js";
import { log } from "../log.js";
import { GithubTrendingCollector } from "./githubTrending.js";
import { HnCollector } from "./hn.js";
import { RedditCollector, pickRedditMode } from "./reddit.js";
import { RssCollector } from "./rss.js";
import { TwitterCollector, twitterStubStatus } from "./twitter.js";
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
  readonly abortSignal?: AbortSignal;
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
  // Only name-based check — message regex could misclassify unrelated errors
  // (e.g., payment/transaction "aborted" semantics from upstream APIs).
  if (err instanceof Error && err.name === "AbortError") return "timeout";
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
      // O-01 / S-04 skip semantics. Twitter is always skipped in v1 — the
      // ENABLE_TWITTER flag only changes the reported reason, not the outcome
      // (collector is not implemented). Letting the flag through to .fetch()
      // would raise and surface as a noisy "error" in the summary.
      if (source === "twitter") {
        const stub = twitterStubStatus(env);
        return {
          source,
          items: [] as RawItem[],
          status: "skipped" as const,
          error: stub.enabled
            ? "twitter not implemented in v1"
            : "ENABLE_TWITTER not set",
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
      try {
        const items = await withTimeout(
          source,
          timeoutMs,
          async (signal) => {
            const inner: CollectorContext = {
              runDate: ctx.runDate,
              cutoffMs,
              abortSignal: signal,
              env,
            };
            return await c.fetch(inner);
          },
          opts.abortSignal,
        );
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
