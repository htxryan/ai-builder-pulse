import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGithubStepSummary,
  renderOrchestratorSummary,
  renderRemoteSkipSummary,
  renderWeeklySummary,
} from "../src/runSummary.js";
import type { OrchestratorResult } from "../src/orchestrator.js";
import type { WeeklyResult } from "../src/weekly/index.js";
import type { SourceSummary } from "../src/types.js";

function baseResult(over: Partial<OrchestratorResult> = {}): OrchestratorResult {
  return {
    runDate: "2026-04-18",
    runId: "20260418T0607-abcdef",
    status: "published",
    timings: {
      collect: 450,
      preFilter: 12,
      curate: 2100,
      linkIntegrity: 3,
      render: 5,
      publish: 800,
      archive: 17,
      totalMs: 3387,
    },
    ...over,
  };
}

function sampleSummary(): SourceSummary {
  return {
    hn: { count: 220, status: "ok", keptCount: 180, redirectFailures: 4 },
    "github-trending": { count: 25, status: "ok", keptCount: 20 },
    reddit: {
      count: 0,
      status: "error",
      error: "reddit oauth http 401",
    },
    rss: { count: 12, status: "ok", keptCount: 10 },
    twitter: {
      count: 0,
      status: "skipped",
      error: "ENABLE_TWITTER not set",
    },
  };
}

describe("renderOrchestratorSummary", () => {
  it("renders a published run with sources, stage timings, and curator cost", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "published",
        summary: sampleSummary(),
        publishId: "em_abc",
        curatorMetrics: {
          inputTokens: 12_400,
          outputTokens: 3_100,
          estimatedUsd: 0.0837,
        },
        rendered: {
          subject: "AI Builder Pulse — 2026-04-18",
          body: "body".repeat(400),
        },
      }),
    );
    expect(md).toContain("Daily run — 2026-04-18");
    expect(md).toContain("`published`");
    expect(md).toContain("20260418T0607-abcdef");
    expect(md).toContain("em_abc");
    expect(md).toContain("$0.0837");
    // Per-source table rows
    expect(md).toContain("| hn |");
    expect(md).toContain("| github-trending |");
    expect(md).toContain("| reddit |");
    expect(md).toMatch(/\|\s*4\s*\|/); // redirect failures column for hn
    // Stage timing rows
    expect(md).toContain("| collect |");
    expect(md).toContain("| curate |");
    expect(md).toContain("| archive |");
    expect(md).toContain("**total**");
  });

  it("renders an idempotent_skip run with no sources", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "idempotent_skip",
        reason: "sentinel_present",
        timings: { totalMs: 2 },
      }),
    );
    expect(md).toContain("`idempotent_skip`");
    expect(md).toContain("sentinel_present");
    expect(md).toContain("no source summary");
  });

  it("renders a source_floor_skip with partial summary", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "source_floor_skip",
        reason: "S-05",
        summary: {
          hn: { count: 5, status: "ok", keptCount: 5 },
          "github-trending": { count: 0, status: "error", error: "timeout" },
        },
      }),
    );
    expect(md).toContain("`source_floor_skip`");
    expect(md).toContain("S-05");
    expect(md).toContain("| hn |");
  });

  it("renders empty_skip with scored count via summary", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "empty_skip",
        reason: "S-02",
        summary: sampleSummary(),
      }),
    );
    expect(md).toContain("`empty_skip`");
    expect(md).toContain("S-02");
  });

  it("renders dry_run", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "dry_run",
        summary: sampleSummary(),
      }),
    );
    expect(md).toContain("`dry_run`");
    expect(md).toContain("🧪");
  });

  it("renders published_archive_failed with warning emoji", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "published_archive_failed",
        publishId: "em_xyz",
        summary: sampleSummary(),
      }),
    );
    expect(md).toContain("`published_archive_failed`");
    expect(md).toContain("⚠️");
    expect(md).toContain("em_xyz");
  });

  it("renders failed with reason surfaced", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "failed",
        reason: "publish_failed",
        summary: sampleSummary(),
      }),
    );
    expect(md).toContain("`failed`");
    expect(md).toContain("publish_failed");
    expect(md).toContain("❌");
  });

  it("renders failed with missing_api_key before collection (no summary)", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "failed",
        reason: "missing_api_key",
        timings: { totalMs: 1 },
      }),
    );
    expect(md).toContain("missing_api_key");
    expect(md).toContain("no source summary");
  });

  it("escapes pipe characters in source error notes so the table stays valid", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "source_floor_skip",
        reason: "S-05",
        summary: {
          hn: {
            count: 0,
            status: "error",
            error: "http 500 | upstream-trace",
          },
        },
      }),
    );
    expect(md).toContain("http 500 \\| upstream-trace");
  });

  it("renders E-06 backfill section with zero-count hint when no orphans", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "published",
        summary: sampleSummary(),
        backfill: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          skippedOverCap: 0,
          attemptedDates: [],
        },
      }),
    );
    expect(md).toContain("E-06 Backfill");
    expect(md).toContain("no prior-day orphans detected");
  });

  it("renders E-06 backfill section with counts and attempted dates", () => {
    const md = renderOrchestratorSummary(
      baseResult({
        status: "published",
        summary: sampleSummary(),
        backfill: {
          attempted: 1,
          succeeded: 1,
          failed: 0,
          skippedOverCap: 2,
          attemptedDates: ["2026-04-15"],
        },
      }),
    );
    expect(md).toContain("| attempted | 1 |");
    expect(md).toContain("| succeeded | 1 |");
    expect(md).toContain("| skippedOverCap | 2 |");
    expect(md).toContain("2026-04-15");
  });
});

describe("renderRemoteSkipSummary", () => {
  it("renders a daily remote_idempotent_skip tile", () => {
    const md = renderRemoteSkipSummary(
      "daily",
      "remote sentinel issues/2026-04-18/.published exists on origin/main",
    );
    expect(md).toContain("Daily run — remote_idempotent_skip");
    expect(md).toContain("issues/2026-04-18/.published");
  });

  it("renders a weekly remote_idempotent_skip tile", () => {
    const md = renderRemoteSkipSummary(
      "weekly",
      "remote sentinel weekly/2026-W16.published exists on origin/main",
    );
    expect(md).toContain("Weekly digest — remote_idempotent_skip");
    expect(md).toContain("weekly/2026-W16.published");
  });
});

describe("renderWeeklySummary", () => {
  function weekly(over: Partial<WeeklyResult> = {}): WeeklyResult {
    return {
      weekId: "2026-W16",
      runId: "20260420T1430-abcdef",
      status: "published",
      availableDays: ["2026-04-13", "2026-04-14", "2026-04-15"],
      missingDays: ["2026-04-16"],
      corruptDays: [],
      timings: { loadDays: 12, buildDigest: 6, publish: 900, totalMs: 920 },
      ...over,
    };
  }

  it("renders a published weekly digest", () => {
    const md = renderWeeklySummary(
      weekly({
        publishId: "em_w123",
        digestPath: "/tmp/weekly/2026-W16.md",
        itemCount: 24,
      }),
    );
    expect(md).toContain("Weekly digest — 2026-W16");
    expect(md).toContain("`published`");
    expect(md).toContain("em_w123");
    expect(md).toContain("2026-04-13");
    expect(md).toContain("itemCount");
  });

  it("renders no_days_available", () => {
    const md = renderWeeklySummary(
      weekly({
        status: "no_days_available",
        reason: "no_items_json_in_window",
        availableDays: [],
        missingDays: [
          "2026-04-13",
          "2026-04-14",
          "2026-04-15",
          "2026-04-16",
          "2026-04-17",
          "2026-04-18",
          "2026-04-19",
        ],
      }),
    );
    expect(md).toContain("`no_days_available`");
    expect(md).toContain("0 available");
    expect(md).toContain("7 missing");
  });

  it("renders idempotent_skip", () => {
    const md = renderWeeklySummary(
      weekly({ status: "idempotent_skip", reason: "sentinel_present" }),
    );
    expect(md).toContain("`idempotent_skip`");
    expect(md).toContain("sentinel_present");
  });

  it("renders published_sentinel_failed with warning", () => {
    const md = renderWeeklySummary(
      weekly({
        status: "published_sentinel_failed",
        publishId: "em_wfail",
      }),
    );
    expect(md).toContain("`published_sentinel_failed`");
    expect(md).toContain("⚠️");
    expect(md).toContain("em_wfail");
  });

  it("renders weekly failed", () => {
    const md = renderWeeklySummary(
      weekly({
        status: "failed",
        reason: "publish_failed",
      }),
    );
    expect(md).toContain("`failed`");
    expect(md).toContain("publish_failed");
    expect(md).toContain("❌");
  });
});

describe("appendGithubStepSummary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "abp-sum-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when GITHUB_STEP_SUMMARY is not set", () => {
    const wrote = appendGithubStepSummary("# hi", {});
    expect(wrote).toBe(false);
  });

  it("appends markdown when env var is set", () => {
    const target = path.join(dir, "summary.md");
    const wrote = appendGithubStepSummary("# hi", {
      GITHUB_STEP_SUMMARY: target,
    });
    expect(wrote).toBe(true);
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf8");
    expect(content).toContain("# hi");
  });

  it("appends (not overwrites) on repeat calls", () => {
    const target = path.join(dir, "summary.md");
    appendGithubStepSummary("first", { GITHUB_STEP_SUMMARY: target });
    appendGithubStepSummary("second", { GITHUB_STEP_SUMMARY: target });
    const content = readFileSync(target, "utf8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });
});
