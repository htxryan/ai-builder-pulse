// E-02 Weekly rollup runner. Reads the last 7 days' items.json files that
// exist (tolerant to <7), builds a cross-day best-of digest, publishes via
// the same Buttondown adapter the daily uses, and persists the digest to
// `weekly/{weekId}.md`. Commit + push is the workflow's job (weekly.yml).
//
// Idempotency: after a successful publish we write `weekly/{weekId}.published`
// as a sentinel (mirrors the daily S-03). A subsequent run for the same
// weekId short-circuits before the publisher call, so manual re-dispatch or
// rerun of a failed-after-publish job does not send a duplicate.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { bindRunId, log, makeRunId } from "../log.js";
import { publishToButtondown, PublishError } from "../publisher/index.js";
import type { Publisher } from "../orchestrator.js";
import {
  ArchivedDaySchema,
  buildWeeklyDigest,
  isoWeekId,
  priorSevenDays,
  type ArchivedDay,
} from "./digest.js";
import { itemsJsonPath } from "../archivist/index.js";
import { writeFileAtomic } from "../fsAtomic.js";

export interface WeeklyOptions {
  readonly now?: Date;
  readonly repoRoot?: string;
  readonly publisher?: Publisher;
  readonly env?: NodeJS.ProcessEnv;
}

export type WeeklyStatus =
  | "published"
  | "published_sentinel_failed"
  | "dry_run"
  | "no_days_available"
  | "idempotent_skip"
  | "failed";

export interface WeeklyStageTimings {
  readonly loadDays?: number;
  readonly buildDigest?: number;
  readonly publish?: number;
  readonly totalMs?: number;
}

export interface WeeklyResult {
  readonly weekId: string;
  readonly runId: string;
  readonly status: WeeklyStatus;
  readonly availableDays: readonly string[];
  readonly missingDays: readonly string[];
  readonly digestPath?: string;
  readonly publishId?: string;
  readonly reason?: string;
  readonly timings: WeeklyStageTimings;
  // Total items across all days in the digest, when available.
  readonly itemCount?: number;
}

function weeklyDir(repoRoot: string): string {
  return path.join(repoRoot, "weekly");
}

function digestPath(repoRoot: string, weekId: string): string {
  return path.join(weeklyDir(repoRoot), `${weekId}.md`);
}

export function weeklySentinelPath(repoRoot: string, weekId: string): string {
  return path.join(weeklyDir(repoRoot), `${weekId}.published`);
}

function loadDay(repoRoot: string, runDate: string): ArchivedDay | null {
  const p = itemsJsonPath(repoRoot, runDate);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const parsed = ArchivedDaySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("weekly: items.json shape invalid; skipping day", {
        runDate,
        error: parsed.error.issues[0]?.message,
      });
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn("weekly: items.json unreadable; skipping day", {
      runDate,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function defaultPublisher(env: NodeJS.ProcessEnv): Publisher {
  return {
    publish: async (issue) =>
      publishToButtondown(issue, {
        apiKey: env.BUTTONDOWN_API_KEY ?? "",
      }),
  };
}

export async function runWeeklyDigest(
  opts: WeeklyOptions = {},
): Promise<WeeklyResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const repoRoot = opts.repoRoot ?? process.cwd();
  const dryRun = env.DRY_RUN === "1";
  const runId = makeRunId(now);
  bindRunId(runId);
  const t0 = Date.now();
  const timings: { loadDays?: number; buildDigest?: number; publish?: number; totalMs?: number } = {};
  const finish = (r: Omit<WeeklyResult, "runId" | "timings">): WeeklyResult => {
    timings.totalMs = Date.now() - t0;
    return { ...r, runId, timings };
  };

  // Anchor the rollup window at the *previous* UTC day so a Monday 14:30 UTC
  // cron run rolls up the preceding Sunday-inclusive week. Using `now`
  // directly would pull in partial data for the current day (which likely
  // hasn't run yet at 14:30 if the daily fires at 06:07).
  const anchor = new Date(now.getTime() - 86_400_000);
  const endDate = anchor.toISOString().slice(0, 10);
  const weekId = isoWeekId(anchor);
  const window = priorSevenDays(endDate);

  log.info("weekly digest start", { weekId, runId, window, dryRun });

  // Weekly S-03 equivalent: bail before any Buttondown POST if this weekId
  // was already published. Bypassed under DRY_RUN so operators can preview.
  if (!dryRun && existsSync(weeklySentinelPath(repoRoot, weekId))) {
    log.info("weekly idempotent skip: sentinel present", { weekId });
    return finish({
      weekId,
      status: "idempotent_skip",
      availableDays: [],
      missingDays: [],
      reason: "sentinel_present",
    });
  }

  // Mirror the daily orchestrator fail-fast: refuse to read 7 days of
  // archives and render a digest when the publish secret is absent. DRY_RUN
  // and an injected publisher both bypass this check (tests, preview builds).
  if (!dryRun && opts.publisher === undefined) {
    const key = env.BUTTONDOWN_API_KEY ?? "";
    if (!key) {
      log.error("BUTTONDOWN_API_KEY not set (weekly fail-fast pre-collection)", {
        weekId,
      });
      return finish({
        weekId,
        status: "failed",
        availableDays: [],
        missingDays: [],
        reason: "missing_api_key",
      });
    }
  }

  const loadStart = Date.now();
  const availableDays: ArchivedDay[] = [];
  const missingDays: string[] = [];
  for (const d of window) {
    const loaded = loadDay(repoRoot, d);
    if (loaded) availableDays.push(loaded);
    else missingDays.push(d);
  }
  timings.loadDays = Date.now() - loadStart;

  if (availableDays.length === 0) {
    log.warn("weekly: no days available in window", { weekId, window });
    return finish({
      weekId,
      status: "no_days_available",
      availableDays: [],
      missingDays: window,
      reason: "no_items_json_in_window",
    });
  }

  const buildStart = Date.now();
  const digest = buildWeeklyDigest({
    weekId,
    availableDays,
    missingDays,
  });
  timings.buildDigest = Date.now() - buildStart;

  log.info("weekly digest built", {
    weekId,
    days: availableDays.length,
    missingDays: missingDays.length,
    itemCount: digest.itemCount,
  });

  // Persist the digest BEFORE publishing so a publish failure still leaves
  // an inspectable artifact on disk. Uses the shared atomic helper (tmp is
  // cleaned up on rename failure, preventing `weekly/{weekId}.md.tmp` from
  // being committed by the workflow's `git add weekly/`).
  mkdirSync(weeklyDir(repoRoot), { recursive: true });
  const dest = digestPath(repoRoot, weekId);
  writeFileAtomic(dest, digest.body);

  if (dryRun) {
    log.info("[DRY_RUN] would publish weekly digest", {
      weekId,
      subject: digest.subject,
      digestPath: dest,
    });
    return finish({
      weekId,
      status: "dry_run",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
      itemCount: digest.itemCount,
    });
  }

  const publisher = opts.publisher ?? defaultPublisher(env);
  const publishStart = Date.now();
  try {
    const result = await publisher.publish({
      subject: digest.subject,
      body: digest.body,
    });
    timings.publish = Date.now() - publishStart;
    log.info("weekly publish ok", {
      weekId,
      publishId: result.id,
      attempts: result.attempts,
    });
    // Weekly sentinel AFTER publish 2xx (C7-equivalent for weekly). Next
    // run sees this and short-circuits. If the write fails, surface via a
    // distinct status so src/index.ts exits non-zero — otherwise the NEXT
    // cron has no sentinel to key off of and will re-send the digest.
    let sentinelOk = true;
    try {
      writeFileAtomic(weeklySentinelPath(repoRoot, weekId), `${result.id}\n`);
    } catch (err) {
      sentinelOk = false;
      log.error(
        "weekly sentinel write failed (publish already succeeded — divergence risk)",
        {
          weekId,
          publishId: result.id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return finish({
      weekId,
      status: sentinelOk ? "published" : "published_sentinel_failed",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
      publishId: result.id,
      itemCount: digest.itemCount,
    });
  } catch (err) {
    timings.publish = Date.now() - publishStart;
    const status = err instanceof PublishError ? err.status : undefined;
    log.error("weekly publish failed", {
      weekId,
      error: err instanceof Error ? err.message : String(err),
      httpStatus: status,
    });
    return finish({
      weekId,
      status: "failed",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
      reason: "publish_failed",
      itemCount: digest.itemCount,
    });
  }
}
