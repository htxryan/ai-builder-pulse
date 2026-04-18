import { randomBytes } from "node:crypto";

type Level = "info" | "warn" | "error" | "debug";

function sanitizeAnnotation(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

// Process-scoped run correlation id. Every log line written during a single
// orchestrator/weekly invocation shares this id so an operator can `grep
// runId=<id>` to isolate all lines from one run across interleaved async
// output. Set via `bindRunId` at the top of each entry point; cleared via
// `clearRunId` at test teardown if needed.
let boundRunId: string | undefined;

export function makeRunId(now: Date = new Date()): string {
  // ISO ts (minute precision, no punctuation) + 6 hex chars from crypto
  // randomness. Minute precision keeps the id short and human-scannable
  // while the random suffix guarantees uniqueness across reruns within the
  // same minute. Format: `YYYYMMDDThhmm-xxxxxx`.
  const iso = now.toISOString();
  const stamp =
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    "T" +
    iso.slice(11, 13) +
    iso.slice(14, 16);
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

export function bindRunId(runId: string): void {
  boundRunId = runId;
}

export function clearRunId(): void {
  boundRunId = undefined;
}

export function currentRunId(): string | undefined {
  return boundRunId;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(boundRunId ? { runId: boundRunId } : {}),
    ...(data ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(`::error::${sanitizeAnnotation(msg)}`);
    console.error(line);
  } else if (level === "warn") {
    console.warn(`::warning::${sanitizeAnnotation(msg)}`);
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (process.env.DEBUG === "1") emit("debug", msg, data);
  },
};
