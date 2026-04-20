import { existsSync } from "node:fs";
import {
  runArchivesFallback,
  type ArchivesFallbackResult,
} from "./archivesFallback.js";
import { archiveRun, sentinelPath as archiveSentinelPath } from "./archivist/index.js";
import { fetchAll as realFetchAll } from "./collectors/index.js";
import { mockFetchAll } from "./collectors/mock.js";
import { type Curator } from "./curator/mockCurator.js";
import {
  CostCeilingError,
  CuratorHallucinationCircuitBreakerError,
  selectCurator,
} from "./curator/index.js";
import { verifyLinkIntegrity } from "./curator/linkIntegrity.js";
import { writeSkippedItemsJson } from "./curator/deadletter.js";
import type { CuratorMetrics } from "./curator/mockCurator.js";
import { bindRunId, log, makeRunId, registerSecretsFromEnv } from "./log.js";
import { parsePositiveInt } from "./env.js";
import { runBackfill, type BackfillResult } from "./backfill.js";
import { applyPreFilter, uniqueSources } from "./preFilter/index.js";
import { renderIssue, type RenderedIssue } from "./renderer/index.js";
import {
  publishToButtondown,
  PublishError,
} from "./publisher/index.js";
import { deriveRunDate } from "./runDate.js";
import type { RawItem, RunContext, ScoredItem, SourceSummary } from "./types.js";

/**
 * Minimum info the orchestrator needs back from a publisher. Alternate
 * publishers (E7) implement only this; Buttondown-specific fields live in
 * `ButtondownPublishResult` inside the adapter.
 */
export interface PublishOutcome {
  readonly id: string;
  readonly attempts: number;
}

/** Narrow publish contract: take a rendered issue, return an id + attempts. */
export interface Publisher {
  publish(issue: RenderedIssue): Promise<PublishOutcome>;
}

/** Optional injection points for tests (collectors, curator, publisher). */
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

/** Terminal status of a daily orchestrator run — drives CI exit code + job summary. */
export type OrchestratorStatus =
  | "published"
  | "published_archive_failed"
  | "published_from_archives"
  | "dry_run"
  | "idempotent_skip"
  | "empty_skip"
  | "source_floor_skip"
  | "failed";

/**
 * Per-stage wall time in milliseconds. Keys are populated as each stage
 * completes (successfully or not) so a skip/fail run carries partial data
 * through to the job-summary renderer.
 */
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

/** Finalized daily run result passed to the summary renderer and index.ts. */
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
  // E-06 backfill summary. Captured regardless of whether the CURRENT run
  // published or skipped — backfill is independent of today's runDate.
  // Undefined only when backfill itself threw unexpectedly (logged as a
  // non-blocking error) or when an early fail-fast exit preceded it.
  backfill?: BackfillResult | undefined;
  // Count of RawItems the curator could not score cleanly. Deadlettered to
  // `issues/{runDate}/.skipped-items.json`. 0 when all items mapped cleanly.
  skippedItemCount?: number;
  // Populated when AC7 archives fallback was invoked (i.e. a day that would
  // otherwise have been silent re-published a prior day's top items).
  archivesFallback?: ArchivesFallbackResult;
}

const DEFAULT_MIN_ITEMS = 5;
const DEFAULT_MIN_SOURCES = 2;
// 12 min — leaves a 3 min safety margin under GHA's 15 min job cap.
const DEFAULT_ORCHESTRATOR_TIMEOUT_MS = 12 * 60 * 1000;

function checkSentinel(repoRoot: string, runDate: string): boolean {
  return existsSync(archiveSentinelPath(repoRoot, runDate));
}

/**
 * Top-level daily pipeline entry. Collects, pre-filters, curates, renders,
 * publishes, and archives one runDate. Honors `DRY_RUN`, the S-03 sentinel,
 * S-02/S-05 skip gates, ARCHIVES_FALLBACK, and a global `ORCHESTRATOR_TIMEOUT_MS`.
 * Always resolves — errors surface via `result.status === "failed"`.
 */
export async function runOrchestrator(
  opts: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  const env = opts.env ?? process.env;
  const timeoutMs = parsePositiveInt(
    env.ORCHESTRATOR_TIMEOUT_MS,
    DEFAULT_ORCHESTRATOR_TIMEOUT_MS,
    "ORCHESTRATOR_TIMEOUT_MS",
  );
  const now = opts.now ?? new Date();
  const runDate = deriveRunDate(now);
  const runId = makeRunId(now);
  // Bind runId NOW so a timeout log-line still carries it. The inner body
  // re-binds (no-op) and re-registers secrets.
  bindRunId(runId);
  const t0 = Date.now();

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"__timeout__">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve("__timeout__");
    }, timeoutMs);
  });

  try {
    const winner = await Promise.race([
      runOrchestratorInner(opts, { runDate, runId, t0 }),
      timeoutPromise,
    ]);
    if (winner === "__timeout__") {
      log.error("orchestrator global timeout exceeded", {
        runId,
        runDate,
        timeoutMs,
        elapsedMs: Date.now() - t0,
      });
      return {
        runDate,
        runId,
        status: "failed",
        reason: "orchestrator_timeout",
        timings: { totalMs: Date.now() - t0 },
      };
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface InnerPreRun {
  readonly runDate: string;
  readonly runId: string;
  readonly t0: number;
}

async function runOrchestratorInner(
  opts: OrchestratorOptions,
  pre: InnerPreRun,
): Promise<OrchestratorResult> {
  const env = opts.env ?? process.env;
  const { runDate, runId, t0 } = pre;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const dryRun = env.DRY_RUN === "1";
  bindRunId(runId);
  registerSecretsFromEnv(env);
  const timings: StageTimings = {};
  const stage = async <T>(name: keyof StageTimings, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - start;
    }
  };
  // Captured by `runBackfill` below. Defaulted here so early-return code paths
  // (missing-api-key fail-fast) still surface an explicit zeroed backfill in
  // the run summary rather than an ambiguous `undefined`.
  let backfillResult: BackfillResult | undefined;
  const done = (result: Omit<OrchestratorResult, "runId" | "timings">): OrchestratorResult => {
    timings.totalMs = Date.now() - t0;
    // Backfill is orthogonal to every skip/fail status — always attach it so
    // the operator can see whether a prior-day orphan was recovered even on
    // a day when today itself was skipped/failed. Existing explicit values
    // on `result` take precedence.
    return {
      ...result,
      runId,
      timings,
      backfill: result.backfill ?? backfillResult,
    };
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

  // S-03 sentinel check first (idempotency trumps everything). An
  // already-published runDate needs no key, no publisher, and no backfill —
  // the entire pipeline skips cleanly. Bypassed under DRY_RUN so operators
  // can preview an already-sent day.
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
  // already-published runDate doesn't need a key). Moved ABOVE the backfill
  // call (vs. the original post-backfill placement) so E-06 has a real
  // publisher to hand down when it re-publishes prior-day orphans.
  // DRY_RUN and an injected publisher both bypass this check.
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

  // Build the publisher once — shared by backfill (if any) and today's
  // publish. Tests inject their own via opts.publisher.
  const publisher = opts.publisher ?? defaultButtondownPublisher(env);

  // E-06 backfill. Runs AFTER today's sentinel + key checks so we only
  // attempt re-publish when we know we have a viable path to publish; but
  // BEFORE collection so today's pipeline runs unimpeded. Cap at 1 per
  // cron run (snowball protection); failures log ::error:: but never
  // abort today's pipeline.
  try {
    backfillResult = await runBackfill(repoRoot, runDate, {
      dryRun,
      publisher,
    });
  } catch (err) {
    log.error("backfill scan unexpectedly threw (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
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
    futureDropped: preFiltered.stats.futureDropped,
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
    const fallback = await maybeRunArchivesFallback(
      env,
      repoRoot,
      runDate,
      dryRun,
      publisher,
    );
    if (fallback?.status === "published" || fallback?.status === "dry_run") {
      return done({
        runDate,
        status: fallback.status === "dry_run" ? "dry_run" : "published_from_archives",
        reason: "S-05_fallback",
        summary: filteredSummary,
        ...(fallback.rendered ? { rendered: fallback.rendered } : {}),
        ...(fallback.publishId ? { publishId: fallback.publishId } : {}),
        archivesFallback: fallback,
      });
    }
    return done({
      runDate,
      status: "source_floor_skip",
      reason: "S-05",
      summary: filteredSummary,
      ...(fallback ? { archivesFallback: fallback } : {}),
    });
  }

  // Curate — env-selectable. Backends routed by `selectCurator` in
  // `src/curator/index.ts`:
  //   CURATOR=mock (default)                        → MockCurator (E1)
  //   CURATOR=claude (default backend)              → ClaudeCurator (preserved)
  //   CURATOR=claude + CURATOR_BACKEND=deepagents   → DeepAgents curator (M2+)
  //
  // Wrap factory in try/catch so an env parse error or version-drift error
  // surfaces through the orchestrator's `failed` contract instead of as an
  // unhandled rejection (runOrchestrator promises "always resolves").
  let curator: Curator;
  try {
    curator = opts.curator ?? (await selectCurator(env, { runId, runDate }));
  } catch (err) {
    log.error("curator init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return done({
      runDate,
      status: "failed",
      reason: "curator_init_failed",
      summary: filteredSummary,
    });
  }
  let scored: ScoredItem[];
  try {
    scored = await stage("curate", () => curator.curate(filteredItems));
  } catch (err) {
    if (err instanceof CostCeilingError) {
      log.error("curator cost ceiling exceeded", {
        estimatedUsd: err.estimatedUsd,
        maxUsd: err.maxUsd,
        scope: err.scope,
        chunkIdx: err.chunkIdx,
      });
      return done({
        runDate,
        status: "failed",
        reason: "cost_ceiling",
        summary: filteredSummary,
        curatorMetrics: curator.lastMetrics?.(),
      });
    }
    // ai-builder-pulse-gwv — fail fast with a distinct reason when the model
    // reproducibly returns the same hallucinated id across consecutive mitigated
    // retries on a chunk. Operators can grep for this status to distinguish a
    // stuck-model incident from ordinary curator failures (JSON parse, count
    // invariant, transient 5xx) without having to parse log lines.
    if (err instanceof CuratorHallucinationCircuitBreakerError) {
      log.error("curator hallucination circuit breaker", {
        unexpectedId: err.unexpectedId,
        chunkIdx: err.chunkIdx,
        attempts: err.attempts,
      });
      return done({
        runDate,
        status: "failed",
        reason: "curator_hallucination_circuit_breaker",
        summary: filteredSummary,
        curatorMetrics: curator.lastMetrics?.(),
      });
    }
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
  const skippedItems = curator.lastSkipped?.() ?? [];

  // P3 deadletter: persist any skipped RawItems so an operator has audit
  // trail without having to grep logs. Best-effort — write failure logs but
  // does not abort the run (the curator already partitioned these out).
  if (skippedItems.length > 0) {
    writeSkippedItemsJson(repoRoot, runDate, skippedItems);
    log.warn("curator skipped items deadlettered", {
      runDate,
      skippedCount: skippedItems.length,
    });
  }

  // E-05 defensive re-check: scored + skipped must fully cover the input.
  // A curator that drops items outside the deadletter path is a regression.
  if (scored.length + skippedItems.length !== filteredItems.length) {
    log.error("curator count mismatch (E-05)", {
      expected: filteredItems.length,
      scored: scored.length,
      skipped: skippedItems.length,
    });
    return done({
      runDate,
      status: "failed",
      reason: "E-05",
      scored,
      summary: filteredSummary,
      curatorMetrics,
      skippedItemCount: skippedItems.length,
    });
  }

  // Un-01 link-integrity gate. Pass an empty allowlist: the renderer's
  // template URLs (newsletter home, archive, unsubscribe) are deterministic
  // constants emitted only into the rendered body — they do NOT appear in
  // ScoredItem fields. Including the allowlist here would *widen* the gate
  // and let a hallucinated `https://buttondown.com/ai-builder-pulse/...` URL
  // in a Claude description bypass Un-01.
  // Pass the pre-pre-filter `items` as `preFilterRaw` so violations whose
  // URL was in the raw collection but got dropped by pre-filter classify as
  // `dropped_by_pre_filter` (legitimate miss) rather than `not_in_raw_set`
  // (hallucinated). Still an Un-01 failure either way; the kind aids triage.
  const integrity = await stage("linkIntegrity", async () =>
    verifyLinkIntegrity(scored, filteredItems, [], { preFilterRaw: items }),
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
      skippedItemCount: skippedItems.length,
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
    const fallback = await maybeRunArchivesFallback(
      env,
      repoRoot,
      runDate,
      dryRun,
      publisher,
    );
    if (fallback?.status === "published" || fallback?.status === "dry_run") {
      return done({
        runDate,
        status: fallback.status === "dry_run" ? "dry_run" : "published_from_archives",
        reason: "S-02_fallback",
        scored,
        summary: filteredSummary,
        ...(fallback.rendered ? { rendered: fallback.rendered } : {}),
        ...(fallback.publishId ? { publishId: fallback.publishId } : {}),
        curatorMetrics,
        skippedItemCount: skippedItems.length,
        archivesFallback: fallback,
      });
    }
    return done({
      runDate,
      status: "empty_skip",
      reason: "S-02",
      scored,
      summary: filteredSummary,
      curatorMetrics,
      skippedItemCount: skippedItems.length,
      ...(fallback ? { archivesFallback: fallback } : {}),
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
      skippedItemCount: skippedItems.length,
    });
  }

  // E5 Publisher. Already constructed above (shared with backfill).
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
      skippedItemCount: skippedItems.length,
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
    skippedItemCount: skippedItems.length,
  });
}

// AC7 gate. Called from S-05 and S-02 skip paths; returns undefined when the
// flag is off so the silence-SLA behavior (document skip, don't send) is the
// default. Off-by-default is deliberate: freshness is the core product value
// and operators must opt in to the re-share path per run.
async function maybeRunArchivesFallback(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  runDate: string,
  dryRun: boolean,
  publisher: Publisher,
): Promise<ArchivesFallbackResult | undefined> {
  if (env.ARCHIVES_FALLBACK !== "1") return undefined;
  log.info("ARCHIVES_FALLBACK=1: attempting from-archives re-publish", {
    runDate,
  });
  try {
    return await runArchivesFallback(repoRoot, runDate, {
      dryRun,
      publisher,
    });
  } catch (err) {
    log.error("archives fallback threw unexpectedly", {
      runDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      reason: "threw",
    };
  }
}

function defaultButtondownPublisher(env: NodeJS.ProcessEnv): Publisher {
  return {
    publish: async (issue) =>
      publishToButtondown(issue, {
        apiKey: env.BUTTONDOWN_API_KEY ?? "",
      }),
  };
}
