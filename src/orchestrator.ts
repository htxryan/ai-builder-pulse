import { existsSync } from "node:fs";
import path from "node:path";
import { MockCurator, type Curator } from "./curator/mockCurator.js";
import { log } from "./log.js";
import { runBackfill } from "./backfill.js";
import { deriveRunDate } from "./runDate.js";
import type { RawItem, RunContext, ScoredItem, SourceSummary } from "./types.js";

export interface OrchestratorOptions {
  now?: Date;
  repoRoot?: string;
  curator?: Curator;
  fetchAll?: (ctx: RunContext) => Promise<{
    items: RawItem[];
    summary: SourceSummary;
  }>;
  env?: NodeJS.ProcessEnv;
}

export interface OrchestratorResult {
  runDate: string;
  status:
    | "published"
    | "dry_run"
    | "idempotent_skip"
    | "empty_skip"
    | "source_floor_skip"
    | "failed";
  reason?: string;
  scored?: ScoredItem[];
}

const DEFAULT_MIN_ITEMS = 5;
const DEFAULT_MIN_SOURCES = 2;

async function mockFetchAll(ctx: RunContext): Promise<{
  items: RawItem[];
  summary: SourceSummary;
}> {
  const items: RawItem[] = [
    {
      id: "mock-hn-1",
      source: "hn",
      title: "Example AI tooling article on HN",
      url: "https://example.com/ai-tool-1",
      score: 120,
      publishedAt: `${ctx.runDate}T08:00:00.000Z`,
      metadata: { source: "hn", points: 120, numComments: 30, author: "someone" },
    },
    {
      id: "mock-ght-1",
      source: "github-trending",
      title: "trending/repo — a new AI tool",
      url: "https://github.com/trending/repo",
      score: 500,
      publishedAt: `${ctx.runDate}T07:00:00.000Z`,
      metadata: {
        source: "github-trending",
        repoFullName: "trending/repo",
        stars: 500,
        starsToday: 50,
        language: "TypeScript",
      },
    },
    {
      id: "mock-reddit-1",
      source: "reddit",
      title: "r/LocalLLaMA: running 70B locally",
      url: "https://reddit.com/r/LocalLLaMA/abc",
      score: 320,
      publishedAt: `${ctx.runDate}T05:00:00.000Z`,
      metadata: { source: "reddit", subreddit: "LocalLLaMA", upvotes: 320, numComments: 45 },
    },
    {
      id: "mock-rss-1",
      source: "rss",
      title: "Simon Willison: structured outputs GA",
      url: "https://simonwillison.net/2026/Apr/18/structured-outputs/",
      score: 1,
      publishedAt: `${ctx.runDate}T04:00:00.000Z`,
      metadata: {
        source: "rss",
        feedUrl: "https://simonwillison.net/atom/everything/",
        author: "simonw",
      },
    },
    {
      id: "mock-hn-2",
      source: "hn",
      title: "Another HN story about AI infra",
      url: "https://example.com/infra-1",
      score: 85,
      publishedAt: `${ctx.runDate}T06:30:00.000Z`,
      metadata: { source: "hn", points: 85, numComments: 12 },
    },
  ];
  const summary: SourceSummary = {
    hn: { count: 2, status: "ok" },
    "github-trending": { count: 1, status: "ok" },
    reddit: { count: 1, status: "ok" },
    rss: { count: 1, status: "ok" },
  };
  return { items, summary };
}

function checkSentinel(repoRoot: string, runDate: string): boolean {
  return existsSync(path.join(repoRoot, "issues", runDate, ".published"));
}

export async function runOrchestrator(
  opts: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const runDate = deriveRunDate(now);
  const repoRoot = opts.repoRoot ?? process.cwd();
  const dryRun = env.DRY_RUN === "1";
  const ctx: RunContext = {
    runDate,
    dryRun,
    repoRoot,
    minItemsToPublish: Number(env.MIN_ITEMS_TO_PUBLISH ?? DEFAULT_MIN_ITEMS),
    minSources: Number(env.MIN_SOURCES ?? DEFAULT_MIN_SOURCES),
  };

  log.info("orchestrator start", {
    runDate,
    dryRun,
    repoRoot,
    minItems: ctx.minItemsToPublish,
    minSources: ctx.minSources,
  });

  // E-06 backfill scan (detect-only in E1)
  try {
    await runBackfill(repoRoot, runDate, { dryRun });
  } catch (err) {
    log.warn("backfill scan failed (non-blocking)", {
      error: (err as Error).message,
    });
  }

  // S-03 sentinel check (bypassed when DRY_RUN)
  if (!dryRun && checkSentinel(repoRoot, runDate)) {
    log.info("S-03 idempotent skip: .published already exists", { runDate });
    return { runDate, status: "idempotent_skip", reason: "sentinel_present" };
  }
  if (dryRun && checkSentinel(repoRoot, runDate)) {
    log.info("[DRY_RUN] sentinel present but bypassed (O-02)", { runDate });
  }

  // Collect
  const fetchAll = opts.fetchAll ?? mockFetchAll;
  let items: RawItem[];
  let summary: SourceSummary;
  try {
    const r = await fetchAll(ctx);
    items = r.items;
    summary = r.summary;
  } catch (err) {
    log.error("fetchAll failed (E-04)", { error: (err as Error).message });
    return { runDate, status: "failed", reason: "fetch_failed" };
  }

  // S-05 source floor
  const okSources = Object.values(summary).filter((s) => s?.status === "ok").length;
  if (okSources < ctx.minSources) {
    log.warn("S-05 source floor not met", {
      okSources,
      minSources: ctx.minSources,
    });
    return { runDate, status: "source_floor_skip", reason: "S-05" };
  }

  // Curate (Mock in E1)
  const curator = opts.curator ?? new MockCurator();
  let scored: ScoredItem[];
  try {
    scored = await curator.curate(items);
  } catch (err) {
    log.error("curator failed (E-05/Un-05)", { error: (err as Error).message });
    return { runDate, status: "failed", reason: "curator_failed" };
  }

  const kept = scored.filter((s) => s.keep);
  log.info("curation complete", {
    totalScored: scored.length,
    kept: kept.length,
  });

  // S-02 empty guard
  if (kept.length < ctx.minItemsToPublish) {
    log.info("S-02 empty-issue skip", {
      kept: kept.length,
      min: ctx.minItemsToPublish,
    });
    return { runDate, status: "empty_skip", reason: "S-02", scored };
  }

  if (dryRun) {
    log.info("[DRY_RUN] would publish", { runDate, itemCount: kept.length });
    return { runDate, status: "dry_run", scored };
  }

  // E1 does not wire real Publisher/Archivist — those land in E5/E6.
  log.info("E1 foundation: publisher not yet wired (E5), archivist not wired (E6)", {
    runDate,
    itemCount: kept.length,
  });
  return { runDate, status: "published", scored };
}
