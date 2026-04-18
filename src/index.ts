#!/usr/bin/env node
import { runOrchestrator } from "./orchestrator.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  try {
    const result = await runOrchestrator();
    log.info("orchestrator done", {
      runDate: result.runDate,
      status: result.status,
      reason: result.reason,
    });
    if (result.status === "failed" || result.status === "stub_no_publisher") {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    // Do not log err.stack here: a stack frame could include env-var values
    // and bypass the AC-1 secret-leak protection (which only checks message).
    log.error("orchestrator uncaught error (E-04)", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
