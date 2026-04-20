import { randomBytes } from "node:crypto";

type Level = "info" | "warn" | "error" | "debug";

function sanitizeAnnotation(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

// Central secret registry. Populated at startup from known env vars and
// redacted out of every emitted log line — belt-and-braces defense against a
// caller that accidentally includes a raw key in a `data` payload or an
// `error.message` bubbled up from a transport failure.
const secrets = new Set<string>();

// Env vars we treat as secrets. Kept small and explicit so an operator can
// grep this list and know what's covered. Add new names here as new secret
// sources get introduced (never derive from arbitrary `*_KEY` matching — too
// easy to pick up benign env vars like `SSH_AUTH_SOCK`).
const KNOWN_SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "BUTTONDOWN_API_KEY",
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "GITHUB_TOKEN",
] as const;

/**
 * Register a runtime value (typically an API key) for redaction. Values under
 * 6 characters are ignored to avoid corrupting unrelated log content.
 */
export function registerSecret(value: string | undefined): void {
  // Guard against empty / short strings — redacting substrings of length < 6
  // creates noise and can corrupt legitimate log content (e.g., a 3-char
  // value could appear inside unrelated IDs or timestamps).
  if (!value || value.length < 6) return;
  secrets.add(value);
}

/** Drop every registered secret. Test-only; no production callsite. */
export function clearSecrets(): void {
  secrets.clear();
}

/** Register every `KNOWN_SECRET_ENV_VARS` value. Idempotent; safe to re-run. */
export function registerSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const name of KNOWN_SECRET_ENV_VARS) {
    registerSecret(env[name]);
  }
}

function redact(text: string): string {
  if (secrets.size === 0) return text;
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

// Process-scoped run correlation id. Every log line written during a single
// orchestrator/weekly invocation shares this id so an operator can `grep
// runId=<id>` to isolate all lines from one run across interleaved async
// output. Set via `bindRunId` at the top of each entry point; cleared via
// `clearRunId` at test teardown if needed.
let boundRunId: string | undefined;

/** Make a process-unique run correlation id: `YYYYMMDDThhmm-xxxxxx`. */
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

/** Attach `runId` to every subsequent log line in this process. */
export function bindRunId(runId: string): void {
  boundRunId = runId;
}

/** Drop the bound runId (test teardown only). */
export function clearRunId(): void {
  boundRunId = undefined;
}

/** The currently bound runId, or `undefined` if `bindRunId` was not called. */
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
  const line = redact(JSON.stringify(payload));
  const annotation = redact(sanitizeAnnotation(msg));
  if (level === "error") {
    console.error(`::error::${annotation}`);
    console.error(line);
  } else if (level === "warn") {
    console.warn(`::warning::${annotation}`);
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Central logger. Emits JSON to stdout/stderr and writes GitHub Actions
 * annotations (`::error::` / `::warning::`) for `warn`/`error`. Every line
 * carries `runId` when `bindRunId` has been called. Registered secrets are
 * redacted. `debug` is a no-op unless `DEBUG=1`.
 */
export const log = {
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (process.env.DEBUG === "1") emit("debug", msg, data);
  },
};
