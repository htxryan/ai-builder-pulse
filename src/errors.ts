// Unified error taxonomy. Every stage-scoped error in the pipeline extends
// `OrchestratorStageError` so a top-level catcher can pattern-match by
// `err.stage` without needing instanceof checks for each concrete subclass.
//
// `retryable` is a hint, not a contract: the stage owner decides whether to
// act on it (publisher retries 5xx; collectors retry timeouts via the HTTP
// library, not here). The orchestrator uses it only for log classification.

export type Stage =
  | "collect"
  | "preFilter"
  | "curate"
  | "linkIntegrity"
  | "render"
  | "publish"
  | "archive"
  | "backfill"
  | "weekly";

export interface StageErrorOptions {
  readonly stage: Stage;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Base class for every stage-scoped pipeline error. Subclasses set `name` to
 * their concrete class name so `err.name` remains useful for log tags and
 * test assertions.
 */
export class OrchestratorStageError extends Error {
  readonly stage: Stage;
  readonly retryable: boolean;
  constructor(message: string, opts: StageErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OrchestratorStageError";
    this.stage = opts.stage;
    this.retryable = opts.retryable ?? false;
  }
}

/**
 * Thrown when an archive JSON file (items.json) is unreadable — either
 * syntactically invalid JSON or a zod shape mismatch. Carries `filePath`
 * so operators can locate the offending archive without grepping the trace.
 */
export class ArchiveParseError extends OrchestratorStageError {
  readonly filePath: string;
  constructor(
    message: string,
    opts: { filePath: string; stage: Stage; cause?: unknown },
  ) {
    super(message, {
      stage: opts.stage,
      retryable: false,
      cause: opts.cause,
    });
    this.name = "ArchiveParseError";
    this.filePath = opts.filePath;
  }
}

// Coarse redirect/fetch failure class. Used by collector redirect-resolve
// logging so operators can `grep errClass=timeout` across one run. Keep the
// set small — the point is triage, not forensic categorization.
export type RedirectErrorClass =
  | "timeout"
  | "tls"
  | "dns"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "abort"
  | "other";

/**
 * Coarse-classify an HTTP/redirect error into a `RedirectErrorClass` label.
 * Used for partial-failure summaries so operators can grep one run's output
 * by class (e.g. `errClass=http_5xx`).
 */
export function classifyRedirectError(err: unknown): RedirectErrorClass {
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const msg = err.message.toLowerCase();
    if (name === "aborterror" || msg.includes("aborted")) return "abort";
    if (name.includes("timeout") || msg.includes("timeout")) return "timeout";
    if (msg.includes("certificate") || msg.includes("tls") || msg.includes("ssl")) {
      return "tls";
    }
    if (msg.includes("enotfound") || msg.includes("dns")) return "dns";
    // HTTP status extracted from typical error strings like "http 404" or
    // "redirect: http 500". Not foolproof — collectors wrapping errors in
    // custom messages may bypass this and land in "other".
    const m = msg.match(/http[_ ]?(\d{3})/);
    if (m) {
      const status = Number(m[1]);
      if (status >= 400 && status < 500) return "http_4xx";
      if (status >= 500 && status < 600) return "http_5xx";
    }
    if (msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("econnrefused")) {
      return "network";
    }
  }
  return "other";
}
