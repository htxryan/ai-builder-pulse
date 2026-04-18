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
    if (result.status === "failed") {
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    log.error("orchestrator uncaught error (E-04)", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    process.exit(1);
  }
}

void main();
