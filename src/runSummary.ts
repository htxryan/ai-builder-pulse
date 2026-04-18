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
import type { Source, SourceSummary } from "./types.js";
import type { BackfillResult } from "./backfill.js";
import type { CuratorMetrics } from "./curator/mockCurator.js";

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
  if (status === "published_from_archives") return "🔁";
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
    "| Source | Status | Raw | Kept | Redirect fails | Partial | Note |",
  );
  rows.push("|---|---|--:|--:|--:|--:|---|");
  const partialDetails: string[] = [];
  for (const [src, entry] of Object.entries(summary)) {
    if (!entry) continue;
    // Partial failures: compact count in the row; one-line breakdown below
    // the table so the main grid stays scannable but detail is never lost.
    const partialCount = entry.partialFailures?.length ?? 0;
    const note = entry.error ? entry.error.replace(/\|/g, "\\|") : "";
    rows.push(
      `| ${src} | ${entry.status} | ${entry.count} | ${
        entry.keptCount ?? "—"
      } | ${entry.redirectFailures ?? 0} | ${partialCount || "—"} | ${note} |`,
    );
    if (entry.partialFailures && entry.partialFailures.length > 0) {
      const brief = entry.partialFailures
        .map((p) => `${p.scope}:${p.errClass}`)
        .join(", ");
      partialDetails.push(`- **${src}** partial failures: ${brief}`);
    }
  }
  let out = rows.join("\n") + "\n";
  if (partialDetails.length > 0) {
    out += "\n" + partialDetails.join("\n") + "\n";
  }
  return out;
}

function renderPerSourceCostRows(m: CuratorMetrics): string {
  const costs = m.costPerSource ?? {};
  const tokens = m.tokensPerSource ?? {};
  const totalCost = m.estimatedUsd > 0 ? m.estimatedUsd : 0;
  const rows: string[] = [];
  rows.push("| Source | Tokens | Cost | % of run |");
  rows.push("|---|--:|--:|--:|");
  const sources = Object.keys(costs).sort() as Source[];
  for (const src of sources) {
    const c = costs[src] ?? 0;
    const t = tokens[src] ?? 0;
    const pct = totalCost > 0 ? ((c / totalCost) * 100).toFixed(1) + "%" : "—";
    rows.push(`| ${src} | ${t} | ${fmtUsd(c)} | ${pct} |`);
  }
  return rows.join("\n") + "\n";
}

function renderBackfillRows(bf: BackfillResult | undefined): string {
  if (!bf || bf.attempted === 0) {
    return "_(no prior-day orphans detected)_\n";
  }
  const rows: string[] = [];
  rows.push("| Metric | Value |");
  rows.push("|---|--:|");
  rows.push(`| attempted | ${bf.attempted} |`);
  rows.push(`| succeeded | ${bf.succeeded} |`);
  rows.push(`| failed | ${bf.failed} |`);
  rows.push(`| skippedOverCap | ${bf.skippedOverCap} |`);
  rows.push(`| dates | \`${bf.attemptedDates.join(", ") || "—"}\` |`);
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

/** Render a daily OrchestratorResult as the markdown block posted to `$GITHUB_STEP_SUMMARY`. */
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
  if (r.curatorMetrics?.costPerSource) {
    lines.push("");
    lines.push("### Curator cost by source");
    lines.push("");
    lines.push(renderPerSourceCostRows(r.curatorMetrics));
  }
  if (r.rendered) {
    lines.push(
      `- **rendered**: ${r.rendered.subject.length}b subject · ${r.rendered.body.length}b body`,
    );
  }
  if (r.skippedItemCount && r.skippedItemCount > 0) {
    lines.push(
      `- **skipped items**: ${r.skippedItemCount} (see \`issues/${r.runDate}/.skipped-items.json\`)`,
    );
  }
  if (r.archivesFallback) {
    const af = r.archivesFallback;
    lines.push(
      `- **archives fallback**: \`${af.status}\`${af.sourceRunDate ? ` · from ${af.sourceRunDate}` : ""}${af.itemCount !== undefined ? ` · ${af.itemCount} items` : ""}`,
    );
  }
  lines.push("");
  lines.push("### Sources");
  lines.push("");
  lines.push(renderSourceRows(r.summary));
  lines.push("### E-06 Backfill");
  lines.push("");
  lines.push(renderBackfillRows(r.backfill));
  lines.push("### Stage timings");
  lines.push("");
  lines.push(renderTimingRows(r.timings, STAGE_ORDER));
  return lines.join("\n");
}

/** Render a weekly digest result as the markdown block for `$GITHUB_STEP_SUMMARY`. */
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
    `- **days**: ${r.availableDays.length} available (${r.availableDays.join(", ") || "—"}), ${r.missingDays.length} missing, ${r.corruptDays.length} corrupt`,
  );
  if (r.corruptDays.length > 0) {
    lines.push(`- **corruptDays**: \`${r.corruptDays.join(", ")}\``);
  }
  lines.push("");
  lines.push("### Stage timings");
  lines.push("");
  lines.push(renderTimingRows(r.timings, WEEKLY_STAGE_ORDER));
  return lines.join("\n");
}

/**
 * Un-06 remote-idempotency short-circuit summary. Emitted when the workflow
 * pre-flight detects the remote sentinel and sets `SKIP_RUN=1`. Operators
 * browsing the Actions tab see an explicit "why nothing ran" tile.
 */
export function renderRemoteSkipSummary(mode: string, reason: string): string {
  const label = mode === "weekly" ? "Weekly digest" : "Daily run";
  return [
    `## ⏭️ ${label} — remote_idempotent_skip`,
    "",
    `- **reason**: ${reason}`,
    `- **action**: none — the sentinel on the remote proves this mode already ran for this period. The orchestrator was not invoked.`,
    "",
  ].join("\n");
}

/**
 * Append `markdown` to the file at `$GITHUB_STEP_SUMMARY`. No-op locally when
 * the env var is unset. Returns true iff a write happened.
 */
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
