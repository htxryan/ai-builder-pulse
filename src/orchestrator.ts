import { existsSync } from "node:fs";
import { archiveRun, sentinelPath as archiveSentinelPath } from "./archivist/index.js";
import { fetchAll as realFetchAll } from "./collectors/index.js";
import { mockFetchAll } from "./collectors/mock.js";
import { MockCurator, type Curator } from "./curator/mockCurator.js";
import {
  ClaudeCurator,
  AnthropicCurationClient,
} from "./curator/index.js";
import { verifyLinkIntegrity } from "./curator/linkIntegrity.js";
import type { CuratorMetrics } from "./curator/mockCurator.js";
import { bindRunId, log, makeRunId } from "./log.js";
import { runBackfill } from "./backfill.js";
import { applyPreFilter, uniqueSources } from "./preFilter/index.js";
import { renderIssue, type RenderedIssue } from "./renderer/index.js";
import {
  publishToButtondown,
  PublishError,
} from "./publisher/index.js";
import { deriveRunDate } from "./runDate.js";
import type { RawItem, RunContext, ScoredItem, SourceSummary } from "./types.js";

// Narrow contract intentionally — alternate publishers (E7) only need to
// return `id` + `attempts`. Buttondown-specific fields (e.g. endpoint) live in
// `ButtondownPublishResult` and stay inside the adapter.
export interface PublishOutcome {
  readonly id: string;
  readonly attempts: number;
}

export interface Publisher {
  publish(issue: RenderedIssue): Promise<PublishOutcome>;
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

export type OrchestratorStatus =
  | "published"
  | "published_archive_failed"
  | "dry_run"
  | "idempotent_skip"
  | "empty_skip"
  | "source_floor_skip"
  | "failed";

// Per-stage wall time in milliseconds. Keys are populated as each stage
// completes (successfully or not) so a skip/fail run carries partial data
// through to the job-summary renderer.
export interface StageTimings {
  collect?: number;
  preFilter?: number;
  curate?: number;
  linkIntegrity?: number;
  render?: number;
  publish?: number;
  archive?: number;
  totalMs?: number;
}

export interface OrchestratorResult {
  runDate: string;
  // Stable correlation id shared by every log line emitted during this run.
  // Also surfaced in the GHA job summary so operators can grep the raw logs
  // for a single run in a pipeline that may have multiple concurrent jobs.
  runId: string;
  status: OrchestratorStatus;
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
  // Per-stage wall times. Always present (possibly partial on early skips).
  timings: StageTimings;
  // Cost and token usage from the curator, if the curator exposes it.
  // MockCurator leaves this undefined; ClaudeCurator populates it.
  curatorMetrics?: CuratorMetrics | undefined;
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
  return existsSync(archiveSentinelPath(repoRoot, runDate));
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
  const runId = makeRunId(now);
  bindRunId(runId);
  const t0 = Date.now();
  const timings: StageTimings = {};
  const stage = async <T>(name: keyof StageTimings, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - start;
    }
  };
  const done = (result: Omit<OrchestratorResult, "runId" | "timings">): OrchestratorResult => {
    timings.totalMs = Date.now() - t0;
    return { ...result, runId, timings };
  };
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
    runId,
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
    return done({
      runDate,
      status: "idempotent_skip",
      reason: "sentinel_present",
    });
  }
  if (dryRun && checkSentinel(repoRoot, runDate)) {
    log.info("[DRY_RUN] sentinel present but bypassed (O-02)", { runDate });
  }

  // Fail-fast on missing publishing secret AFTER the sentinel check (an
  // already-published runDate doesn't need a key) so we don't burn Claude
  // curation budget collecting+scoring for a run that cannot publish. DRY_RUN
  // and an injected publisher both bypass this check (tests, preview builds).
  if (!dryRun && opts.publisher === undefined) {
    const key = env.BUTTONDOWN_API_KEY ?? "";
    if (!key) {
      log.error("BUTTONDOWN_API_KEY not set (fail-fast pre-collection)", {
        runDate,
      });
      return done({
        runDate,
        status: "failed",
        reason: "missing_api_key",
      });
    }
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
    const r = await stage("collect", () => fetchAll(ctx));
    items = r.items;
    summary = r.summary;
  } catch (err) {
    log.error("fetchAll failed (E-04)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return done({ runDate, status: "failed", reason: "fetch_failed" });
  }

  // E3 pre-filter: freshness, URL-shape, normalized-URL dedup. Runs BEFORE
  // S-05 so the floor reflects sources that contribute *usable* items, not
  // just sources that returned without erroring.
  const preFiltered = await stage("preFilter", async () =>
    applyPreFilter(items, runDate, summary),
  );
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
    return done({
      runDate,
      status: "source_floor_skip",
      reason: "S-05",
      summary: filteredSummary,
    });
  }

  // Curate — env-selectable:
  //   CURATOR=mock (default) → MockCurator (E1 pass-through)
  //   CURATOR=claude         → ClaudeCurator (E4 real Claude call)
  const curator = opts.curator ?? selectCurator(env);
  let scored: ScoredItem[];
  try {
    scored = await stage("curate", () => curator.curate(filteredItems));
  } catch (err) {
    log.error("curator failed (E-05/Un-05)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return done({
      runDate,
      status: "failed",
      reason: "curator_failed",
      summary: filteredSummary,
      curatorMetrics: curator.lastMetrics?.(),
    });
  }
  const curatorMetrics = curator.lastMetrics?.();

  // E-05 defensive re-check (Curator should have enforced this already).
  if (scored.length !== filteredItems.length) {
    log.error("curator count mismatch (E-05)", {
      expected: filteredItems.length,
      actual: scored.length,
    });
    return done({
      runDate,
      status: "failed",
      reason: "E-05",
      scored,
      summary: filteredSummary,
      curatorMetrics,
    });
  }

  // Un-01 link-integrity gate. Pass an empty allowlist: the renderer's
  // template URLs (newsletter home, archive, unsubscribe) are deterministic
  // constants emitted only into the rendered body — they do NOT appear in
  // ScoredItem fields. Including the allowlist here would *widen* the gate
  // and let a hallucinated `https://buttondown.com/ai-builder-pulse/...` URL
  // in a Claude description bypass Un-01.
  const integrity = await stage("linkIntegrity", async () =>
    verifyLinkIntegrity(scored, filteredItems, []),
  );
  if (!integrity.ok) {
    log.error("Un-01 link-integrity violation", {
      violationCount: integrity.violations.length,
      sample: integrity.violations.slice(0, 5),
    });
    return done({
      runDate,
      status: "failed",
      reason: "Un-01",
      scored,
      summary: filteredSummary,
      curatorMetrics,
    });
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
    return done({
      runDate,
      status: "empty_skip",
      reason: "S-02",
      scored,
      summary: filteredSummary,
      curatorMetrics,
    });
  }

  // E5 C5 render. Happens even on DRY_RUN so operators see the exact body
  // that would have been sent (O-02: "pipeline runs up to but not including
  // the POST"). Renderer is pure so this is cheap.
  const rendered = await stage("render", async () => renderIssue(runDate, kept));
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
    return done({
      runDate,
      status: "dry_run",
      scored,
      summary: filteredSummary,
      rendered,
      curatorMetrics,
    });
  }

  // E5 Publisher. Default adapter POSTs to Buttondown; tests and E7 wire a
  // fake via opts.publisher. BUTTONDOWN_API_KEY is read lazily so DRY_RUN
  // and skip paths do not require the secret.
  const publisher = opts.publisher ?? defaultButtondownPublisher(env);
  let publishResult: PublishOutcome;
  try {
    publishResult = await stage("publish", () => publisher.publish(rendered));
  } catch (err) {
    const status = err instanceof PublishError ? err.status : undefined;
    const attempts =
      err instanceof PublishError ? err.attempts : undefined;
    log.error("publish failed (E-04)", {
      error: err instanceof Error ? err.message : String(err),
      httpStatus: status,
      attempts,
    });
    return done({
      runDate,
      status: "failed",
      reason: "publish_failed",
      scored,
      summary: filteredSummary,
      rendered,
      curatorMetrics,
    });
  }

  log.info("publish ok", {
    runDate,
    publishId: publishResult.id,
    attempts: publishResult.attempts,
  });

  // E6 Archivist: write issue.md + items.json + .published atomically AFTER
  // the Buttondown POST succeeds (C7 contract). A failure here means the
  // email has already gone out but the archive is incomplete. We escalate
  // via a distinct status (`published_archive_failed`) so the workflow can
  // fail loudly (non-zero exit) rather than silently skipping the commit —
  // the partial-archive case is exactly what E-06 backfill detection
  // covers (issue.md present, .published missing) on the NEXT cron run.
  let archiveOk = true;
  try {
    await stage("archive", async () => {
      archiveRun({
        runDate,
        repoRoot,
        rendered,
        scored,
        summary: filteredSummary,
        publishId: publishResult.id,
        publishedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    archiveOk = false;
    log.error("archivist write failed (publish already succeeded)", {
      runDate,
      publishId: publishResult.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return done({
    runDate,
    status: archiveOk ? "published" : "published_archive_failed",
    scored,
    summary: filteredSummary,
    rendered,
    publishId: publishResult.id,
    curatorMetrics,
  });
}

function defaultButtondownPublisher(env: NodeJS.ProcessEnv): Publisher {
  return {
    publish: async (issue) =>
      publishToButtondown(issue, {
        apiKey: env.BUTTONDOWN_API_KEY ?? "",
      }),
  };
}
