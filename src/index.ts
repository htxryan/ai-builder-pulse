#!/usr/bin/env node
import { runOrchestrator } from "./orchestrator.js";
import { runWeeklyDigest } from "./weekly/index.js";
import { log } from "./log.js";
import {
  appendGithubStepSummary,
  renderOrchestratorSummary,
  renderRemoteSkipSummary,
  renderWeeklySummary,
} from "./runSummary.js";

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? "daily").toLowerCase();
  try {
    // Un-06 remote-idempotency short-circuit. The workflow's pre-flight step
    // (daily.yml / weekly.yml) probes the remote for the sentinel that would
    // have been written by a prior successful run. If present, it exports
    // SKIP_RUN=1 and we bail BEFORE building a publisher, calling any API,
    // or running the pipeline. Exits 0: this is an expected no-op, not a
    // failure. The step summary records it so operators see "why nothing ran".
    if (process.env.SKIP_RUN === "1") {
      const skipReason =
        process.env.SKIP_RUN_REASON ?? "remote sentinel present";
      log.info("remote_idempotent_skip", { mode, skipReason });
      try {
        appendGithubStepSummary(renderRemoteSkipSummary(mode, skipReason));
      } catch (err) {
        log.warn("remote skip summary write failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      process.exit(0);
    }

    if (mode === "weekly") {
      const result = await runWeeklyDigest();
      try {
        appendGithubStepSummary(renderWeeklySummary(result));
      } catch (err) {
        log.warn("weekly run summary write failed (non-blocking)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      log.info("weekly done", {
        weekId: result.weekId,
        runId: result.runId,
        status: result.status,
        reason: result.reason,
        availableDays: result.availableDays.length,
        missingDays: result.missingDays.length,
        totalMs: result.timings.totalMs,
      });
      // `published_sentinel_failed` means the weekly digest was sent but the
      // idempotency sentinel did not land. Exiting 0 would let the workflow
      // commit a state where the *next* cron run cannot detect the duplicate
      // and would re-send. Fail loudly instead.
      const weeklyFail =
        result.status === "failed" ||
        result.status === "published_sentinel_failed";
      process.exit(weeklyFail ? 1 : 0);
    }
    const result = await runOrchestrator();
    try {
      appendGithubStepSummary(renderOrchestratorSummary(result));
    } catch (err) {
      log.warn("daily run summary write failed (non-blocking)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    log.info("orchestrator done", {
      runDate: result.runDate,
      runId: result.runId,
      status: result.status,
      reason: result.reason,
      totalMs: result.timings.totalMs,
      // Haiku savings outcome on a single line so operators can grep one
      // entry per run without piecing together the per-stage logs.
      haikuInput: result.haikuStats?.inputCount,
      haikuKept: result.haikuStats?.keptCount,
      haikuDropped: result.haikuStats?.droppedCount,
      haikuEstimatedUsd: result.haikuStats?.estimatedUsd,
    });
    // `published_archive_failed` means Buttondown accepted the email but the
    // archive write did not complete. The commit step would otherwise push a
    // partial archive with no sentinel; exit 1 so the workflow surfaces the
    // divergence instead of silently swallowing it.
    if (
      result.status === "failed" ||
      result.status === "published_archive_failed"
    ) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    // Do not log err.stack here: a stack frame could include env-var values
    // and bypass the AC-1 secret-leak protection (which only checks message).
    log.error("uncaught error (E-04)", {
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
