// Per-run GitHub Actions job-summary builder. Takes a finalized
// OrchestratorResult or WeeklyResult and renders a markdown table that lands
// at the top of the run's "Summary" tab so an operator can triage without
// scrolling through the raw log pane.
//
// This module is intentionally pure: no fs, no env reads. The caller (index.ts)
// owns the side effect of appending to `$GITHUB_STEP_SUMMARY`.

import { appendFileSync } from "node:fs";
import type { OrchestratorResult, StageTimings } from "./orchestrator.js";
import type { WeeklyResult, WeeklyStageTimings } from "./weekly/index.js";
import type { SourceSummary } from "./types.js";

const STAGE_ORDER: readonly (keyof StageTimings)[] = [
  "collect",
  "preFilter",
  "curate",
  "linkIntegrity",
  "render",
  "publish",
  "archive",
];

const WEEKLY_STAGE_ORDER: readonly (keyof WeeklyStageTimings)[] = [
  "loadDays",
  "buildDigest",
  "publish",
];

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined) return "—";
  return `$${n.toFixed(4)}`;
}

function statusEmoji(status: string): string {
  if (status === "published") return "✅";
  if (status === "dry_run") return "🧪";
  if (status === "idempotent_skip") return "⏭️";
  if (
    status === "empty_skip" ||
    status === "source_floor_skip" ||
    status === "no_days_available"
  )
    return "⏸️";
  if (status === "published_archive_failed" || status === "published_sentinel_failed")
    return "⚠️";
  if (status === "failed") return "❌";
  return "•";
}

function renderSourceRows(summary: SourceSummary | undefined): string {
  if (!summary || Object.keys(summary).length === 0) {
    return "_(no source summary — run exited before collection)_\n";
  }
  const rows: string[] = [];
  rows.push(
    "| Source | Status | Raw | Kept | Redirect fails | Note |",
  );
  rows.push("|---|---|--:|--:|--:|---|");
  for (const [src, entry] of Object.entries(summary)) {
    if (!entry) continue;
    const note = entry.error ? entry.error.replace(/\|/g, "\\|") : "";
    rows.push(
      `| ${src} | ${entry.status} | ${entry.count} | ${
        entry.keptCount ?? "—"
      } | ${entry.redirectFailures ?? 0} | ${note} |`,
    );
  }
  return rows.join("\n") + "\n";
}

function renderTimingRows(
  timings: StageTimings | WeeklyStageTimings,
  order: readonly string[],
): string {
  const rows: string[] = [];
  rows.push("| Stage | Duration |");
  rows.push("|---|--:|");
  for (const key of order) {
    const v = (timings as Record<string, number | undefined>)[key];
    rows.push(`| ${key} | ${fmtMs(v)} |`);
  }
  const total = (timings as StageTimings).totalMs;
  rows.push(`| **total** | **${fmtMs(total)}** |`);
  return rows.join("\n") + "\n";
}

export function renderOrchestratorSummary(r: OrchestratorResult): string {
  const lines: string[] = [];
  lines.push(
    `## ${statusEmoji(r.status)} Daily run — ${r.runDate} · \`${r.status}\``,
  );
  lines.push("");
  lines.push(`- **runId**: \`${r.runId}\``);
  if (r.reason) lines.push(`- **reason**: \`${r.reason}\``);
  if (r.publishId) lines.push(`- **publishId**: \`${r.publishId}\``);
  if (r.curatorMetrics) {
    const m = r.curatorMetrics;
    lines.push(
      `- **curator cost**: ${fmtUsd(m.estimatedUsd)} (in ${m.inputTokens} / out ${m.outputTokens} tokens)`,
    );
  }
  if (r.rendered) {
    lines.push(
      `- **rendered**: ${r.rendered.subject.length}b subject · ${r.rendered.body.length}b body`,
    );
  }
  lines.push("");
  lines.push("### Sources");
  lines.push("");
  lines.push(renderSourceRows(r.summary));
  lines.push("### Stage timings");
  lines.push("");
  lines.push(renderTimingRows(r.timings, STAGE_ORDER));
  return lines.join("\n");
}

export function renderWeeklySummary(r: WeeklyResult): string {
  const lines: string[] = [];
  lines.push(
    `## ${statusEmoji(r.status)} Weekly digest — ${r.weekId} · \`${r.status}\``,
  );
  lines.push("");
  lines.push(`- **runId**: \`${r.runId}\``);
  if (r.reason) lines.push(`- **reason**: \`${r.reason}\``);
  if (r.publishId) lines.push(`- **publishId**: \`${r.publishId}\``);
  if (r.digestPath) lines.push(`- **digestPath**: \`${r.digestPath}\``);
  if (r.itemCount !== undefined) lines.push(`- **itemCount**: ${r.itemCount}`);
  lines.push(
    `- **days**: ${r.availableDays.length} available (${r.availableDays.join(", ") || "—"}), ${r.missingDays.length} missing`,
  );
  lines.push("");
  lines.push("### Stage timings");
  lines.push("");
  lines.push(renderTimingRows(r.timings, WEEKLY_STAGE_ORDER));
  return lines.join("\n");
}

// Append markdown to $GITHUB_STEP_SUMMARY if the env var is set. No-op locally.
// Returns true if the write happened — useful for tests and log annotation.
export function appendGithubStepSummary(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  // Leading newline guarantees a separation from any prior step summary
  // written earlier in the same job (linter, setup script, etc.).
  appendFileSync(path, `\n${markdown}\n`, "utf8");
  return true;
}
