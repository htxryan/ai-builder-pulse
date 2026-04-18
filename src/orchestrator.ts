import { existsSync } from "node:fs";
import path from "node:path";
import { fetchAll as realFetchAll } from "./collectors/index.js";
import { mockFetchAll } from "./collectors/mock.js";
import { MockCurator, type Curator } from "./curator/mockCurator.js";
import {
  ClaudeCurator,
  AnthropicCurationClient,
} from "./curator/index.js";
import { verifyLinkIntegrity } from "./curator/linkIntegrity.js";
import { log } from "./log.js";
import { runBackfill } from "./backfill.js";
import { applyPreFilter, uniqueSources } from "./preFilter/index.js";
import {
  renderIssue,
  RENDERER_TEMPLATE_URL_PATTERNS,
  type RenderedIssue,
} from "./renderer/index.js";
import {
  publishToButtondown,
  PublishError,
  type ButtondownPublishResult,
} from "./publisher/index.js";
import { deriveRunDate } from "./runDate.js";
import type { RawItem, RunContext, ScoredItem, SourceSummary } from "./types.js";

export interface Publisher {
  publish(issue: RenderedIssue): Promise<ButtondownPublishResult>;
}

export interface OrchestratorOptions {
  now?: Date;
  repoRoot?: string;
  curator?: Curator;
  publisher?: Publisher;
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
  // Per-source summary including pre-filter `keptCount`. Populated whenever
  // the run progressed past collection.
  summary?: SourceSummary;
  // C5 render output — populated once kept items pass all gates. Surfaced so
  // E6 (Archivist) can persist it without re-rendering.
  rendered?: RenderedIssue;
  // Buttondown publish id, only set on status === "published".
  publishId?: string;
}

const DEFAULT_MIN_ITEMS = 5;
const DEFAULT_MIN_SOURCES = 2;

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid env ${name}=${raw} (expected positive integer >= 1)`,
    );
  }
  return n;
}

function checkSentinel(repoRoot: string, runDate: string): boolean {
  return existsSync(path.join(repoRoot, "issues", runDate, ".published"));
}

function selectCurator(env: NodeJS.ProcessEnv): Curator {
  const which = (env.CURATOR ?? "mock").toLowerCase();
  if (which === "claude") {
    return new ClaudeCurator({
      client: new AnthropicCurationClient(),
      chunkThreshold: env.CURATOR_CHUNK_THRESHOLD
        ? parsePositiveInt(
            env.CURATOR_CHUNK_THRESHOLD,
            50,
            "CURATOR_CHUNK_THRESHOLD",
          )
        : 50,
    });
  }
  return new MockCurator();
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
    minItemsToPublish: parsePositiveInt(
      env.MIN_ITEMS_TO_PUBLISH,
      DEFAULT_MIN_ITEMS,
      "MIN_ITEMS_TO_PUBLISH",
    ),
    minSources: parsePositiveInt(
      env.MIN_SOURCES,
      DEFAULT_MIN_SOURCES,
      "MIN_SOURCES",
    ),
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
      error: err instanceof Error ? err.message : String(err),
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
  const useMock = env.USE_MOCK_COLLECTORS === "1";
  const fetchAll =
    opts.fetchAll ??
    (useMock
      ? mockFetchAll
      : (runCtx) => realFetchAll(runCtx, { env }));
  let items: RawItem[];
  let summary: SourceSummary;
  try {
    const r = await fetchAll(ctx);
    items = r.items;
    summary = r.summary;
  } catch (err) {
    log.error("fetchAll failed (E-04)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { runDate, status: "failed", reason: "fetch_failed" };
  }

  // E3 pre-filter: freshness, URL-shape, normalized-URL dedup. Runs BEFORE
  // S-05 so the floor reflects sources that contribute *usable* items, not
  // just sources that returned without erroring.
  const preFiltered = applyPreFilter(items, runDate, summary);
  log.info("pre-filter complete", {
    inputCount: preFiltered.stats.inputCount,
    freshnessDropped: preFiltered.stats.freshnessDropped,
    invalidDateDropped: preFiltered.stats.invalidDateDropped,
    shapeDropped: preFiltered.stats.shapeDropped,
    duplicateDropped: preFiltered.stats.duplicateDropped,
    normFailDropped: preFiltered.stats.normFailDropped,
    outputCount: preFiltered.stats.outputCount,
  });
  const filteredItems = preFiltered.items;
  const filteredSummary = preFiltered.summary;

  // S-05 source floor — evaluated on unique sources in the *post-filter* set
  // so a source that returned items but had them all filtered out does not
  // count toward the floor.
  const contributingSources = uniqueSources(filteredItems).size;
  if (contributingSources < ctx.minSources) {
    log.warn("S-05 source floor not met", {
      contributingSources,
      minSources: ctx.minSources,
    });
    return {
      runDate,
      status: "source_floor_skip",
      reason: "S-05",
      summary: filteredSummary,
    };
  }

  // Curate — env-selectable:
  //   CURATOR=mock (default) → MockCurator (E1 pass-through)
  //   CURATOR=claude         → ClaudeCurator (E4 real Claude call)
  const curator = opts.curator ?? selectCurator(env);
  let scored: ScoredItem[];
  try {
    scored = await curator.curate(filteredItems);
  } catch (err) {
    log.error("curator failed (E-05/Un-05)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { runDate, status: "failed", reason: "curator_failed" };
  }

  // E-05 defensive re-check (Curator should have enforced this already).
  if (scored.length !== filteredItems.length) {
    log.error("curator count mismatch (E-05)", {
      expected: filteredItems.length,
      actual: scored.length,
    });
    return { runDate, status: "failed", reason: "E-05" };
  }

  // Un-01 link-integrity gate. Renderer-owned allowlist exempts template
  // URLs (newsletter home, archive, unsubscribe) that the Renderer will
  // inject into the body. Any URL in Claude output that does not trace back
  // to a raw item (and is not allowlisted) fails the run.
  const integrity = verifyLinkIntegrity(
    scored,
    filteredItems,
    RENDERER_TEMPLATE_URL_PATTERNS,
  );
  if (!integrity.ok) {
    log.error("Un-01 link-integrity violation", {
      violationCount: integrity.violations.length,
      sample: integrity.violations.slice(0, 5),
    });
    return { runDate, status: "failed", reason: "Un-01" };
  }
  log.info("link-integrity ok", {
    checked: integrity.checkedCount,
    scoredCount: scored.length,
  });

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
    return {
      runDate,
      status: "empty_skip",
      reason: "S-02",
      scored,
      summary: filteredSummary,
    };
  }

  // E5 C5 render. Happens even on DRY_RUN so operators see the exact body
  // that would have been sent (O-02: "pipeline runs up to but not including
  // the POST"). Renderer is pure so this is cheap.
  const rendered = renderIssue(runDate, kept);
  log.info("renderer complete", {
    subjectLength: rendered.subject.length,
    bodyLength: rendered.body.length,
    itemCount: kept.length,
  });

  if (dryRun) {
    log.info("[DRY_RUN] would publish", {
      runDate,
      itemCount: kept.length,
      subject: rendered.subject,
    });
    return {
      runDate,
      status: "dry_run",
      scored,
      summary: filteredSummary,
      rendered,
    };
  }

  // E5 Publisher. Default adapter POSTs to Buttondown; tests and E7 wire a
  // fake via opts.publisher. BUTTONDOWN_API_KEY is read lazily so DRY_RUN
  // and skip paths do not require the secret.
  const publisher = opts.publisher ?? defaultButtondownPublisher(env);
  let publishResult: ButtondownPublishResult;
  try {
    publishResult = await publisher.publish(rendered);
  } catch (err) {
    const status = err instanceof PublishError ? err.status : undefined;
    const attempts =
      err instanceof PublishError ? err.attempts : undefined;
    log.error("publish failed (E-04)", {
      error: err instanceof Error ? err.message : String(err),
      httpStatus: status,
      attempts,
    });
    return {
      runDate,
      status: "failed",
      reason: "publish_failed",
      scored,
      summary: filteredSummary,
      rendered,
    };
  }

  log.info("publish ok", {
    runDate,
    publishId: publishResult.id,
    attempts: publishResult.attempts,
  });

  return {
    runDate,
    status: "published",
    scored,
    summary: filteredSummary,
    rendered,
    publishId: publishResult.id,
  };
}

function defaultButtondownPublisher(env: NodeJS.ProcessEnv): Publisher {
  return {
    publish: async (issue) =>
      publishToButtondown(issue, {
        apiKey: env.BUTTONDOWN_API_KEY ?? "",
      }),
  };
}
