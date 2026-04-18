// E-02 Weekly rollup runner. Reads the last 7 days' items.json files that
// exist (tolerant to <7), builds a cross-day best-of digest, publishes via
// the same Buttondown adapter the daily uses, and persists the digest to
// `weekly/{weekId}.md`. Commit + push is the workflow's job (weekly.yml).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../log.js";
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

export interface WeeklyOptions {
  readonly now?: Date;
  readonly repoRoot?: string;
  readonly publisher?: Publisher;
  readonly env?: NodeJS.ProcessEnv;
}

export type WeeklyStatus =
  | "published"
  | "dry_run"
  | "no_days_available"
  | "failed";

export interface WeeklyResult {
  readonly weekId: string;
  readonly status: WeeklyStatus;
  readonly availableDays: readonly string[];
  readonly missingDays: readonly string[];
  readonly digestPath?: string;
  readonly publishId?: string;
  readonly reason?: string;
}

function weeklyDir(repoRoot: string): string {
  return path.join(repoRoot, "weekly");
}

function digestPath(repoRoot: string, weekId: string): string {
  return path.join(weeklyDir(repoRoot), `${weekId}.md`);
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

  // Anchor the rollup window at the *previous* UTC day so a Monday 14:30 UTC
  // cron run rolls up the preceding Sunday-inclusive week. Using `now`
  // directly would pull in partial data for the current day (which likely
  // hasn't run yet at 14:30 if the daily fires at 06:07).
  const anchor = new Date(now.getTime() - 86_400_000);
  const endDate = anchor.toISOString().slice(0, 10);
  const weekId = isoWeekId(anchor);
  const window = priorSevenDays(endDate);

  log.info("weekly digest start", { weekId, window, dryRun });

  const availableDays: ArchivedDay[] = [];
  const missingDays: string[] = [];
  for (const d of window) {
    const loaded = loadDay(repoRoot, d);
    if (loaded) availableDays.push(loaded);
    else missingDays.push(d);
  }

  if (availableDays.length === 0) {
    log.warn("weekly: no days available in window", { weekId, window });
    return {
      weekId,
      status: "no_days_available",
      availableDays: [],
      missingDays: window,
      reason: "no_items_json_in_window",
    };
  }

  const digest = buildWeeklyDigest({
    weekId,
    availableDays,
    missingDays,
  });

  log.info("weekly digest built", {
    weekId,
    days: availableDays.length,
    missingDays: missingDays.length,
    itemCount: digest.itemCount,
  });

  // Persist the digest BEFORE publishing so a publish failure still leaves
  // an inspectable artifact on disk (matches the daily archivist ordering).
  // Atomic write via tmp+rename — same rationale as the daily archivist.
  mkdirSync(weeklyDir(repoRoot), { recursive: true });
  const dest = digestPath(repoRoot, weekId);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, digest.body);
  renameSync(tmp, dest);

  if (dryRun) {
    log.info("[DRY_RUN] would publish weekly digest", {
      weekId,
      subject: digest.subject,
      digestPath: dest,
    });
    return {
      weekId,
      status: "dry_run",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
    };
  }

  const publisher = opts.publisher ?? defaultPublisher(env);
  try {
    const result = await publisher.publish({
      subject: digest.subject,
      body: digest.body,
    });
    log.info("weekly publish ok", {
      weekId,
      publishId: result.id,
      attempts: result.attempts,
    });
    return {
      weekId,
      status: "published",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
      publishId: result.id,
    };
  } catch (err) {
    const status = err instanceof PublishError ? err.status : undefined;
    log.error("weekly publish failed", {
      weekId,
      error: err instanceof Error ? err.message : String(err),
      httpStatus: status,
    });
    return {
      weekId,
      status: "failed",
      availableDays: availableDays.map((d) => d.runDate),
      missingDays,
      digestPath: dest,
      reason: "publish_failed",
    };
  }
}
