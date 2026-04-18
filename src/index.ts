#!/usr/bin/env node
import { runOrchestrator } from "./orchestrator.js";
import { runWeeklyDigest } from "./weekly/index.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? "daily").toLowerCase();
  try {
    if (mode === "weekly") {
      const result = await runWeeklyDigest();
      log.info("weekly done", {
        weekId: result.weekId,
        status: result.status,
        reason: result.reason,
        availableDays: result.availableDays.length,
        missingDays: result.missingDays.length,
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
    log.info("orchestrator done", {
      runDate: result.runDate,
      status: result.status,
      reason: result.reason,
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
