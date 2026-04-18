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
      process.exit(result.status === "failed" ? 1 : 0);
    }
    const result = await runOrchestrator();
    log.info("orchestrator done", {
      runDate: result.runDate,
      status: result.status,
      reason: result.reason,
    });
    if (result.status === "failed") {
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
