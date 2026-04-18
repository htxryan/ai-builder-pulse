// Buttondown Publisher (part of E5). POSTs a rendered issue to
// https://api.buttondown.com/v1/emails with `Authorization: Token <key>`.
//
// - 5xx responses are retried with exponential backoff (up to 3 attempts).
// - 4xx responses fail fast with a PublishError. The API key is never logged
//   in error messages or stack frames (U-07 secret-leak protection).
// - A `fetchImpl` override exists so tests can inject a fake fetch without
//   touching the global. Default is the native `globalThis.fetch` (Node ≥18).
// - `status: "about_to_send"` publishes immediately per Buttondown's API.
// - Per-attempt timeout via AbortController so a stuck connection cannot hang
//   the daily cron until the GHA job-level timeout.

import { OrchestratorStageError } from "../errors.js";
import type { RenderedIssue } from "../renderer/renderer.js";
import {
  DEFAULT_RETRY_OPTIONS,
  retry,
  RetryableError,
  RetryExhaustedError,
  type RetryOptions,
} from "./retry.js";

const DEFAULT_ENDPOINT = "https://api.buttondown.com/v1/emails";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ButtondownPublishOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: Partial<RetryOptions>;
  readonly requestTimeoutMs?: number;
  // Buttondown accepts `about_to_send` (immediate) or `scheduled` + a
  // publish_date. Default to immediate for the daily cron.
  readonly status?: "about_to_send" | "draft";
}

export interface ButtondownPublishResult {
  readonly id: string;
  readonly attempts: number;
  readonly endpoint: string;
}

// PublishError carries only public, non-secret context. Do NOT attach the
// request body or headers here — they contain the API key indirectly.
export class PublishError extends OrchestratorStageError {
  readonly status: number | undefined;
  readonly attempts: number;
  readonly terminal: boolean;
  constructor(
    message: string,
    opts: {
      status?: number;
      attempts: number;
      terminal: boolean;
      cause?: unknown;
    },
  ) {
    super(message, {
      stage: "publish",
      retryable: !opts.terminal,
      cause: opts.cause,
    });
    this.name = "PublishError";
    this.status = opts.status;
    this.attempts = opts.attempts;
    this.terminal = opts.terminal;
  }
}

function sanitizeForLog(text: string, apiKey: string): string {
  // Defense-in-depth: even though Buttondown 4xx bodies are not expected to
  // echo the token, scrub it from any excerpt before it lands in a log line
  // or PublishError.message (U-07).
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}

// Hard cap on error-body size. A pathological proxy returning megabytes of
// HTML would otherwise fill logs and slow the retry loop. 1MB is generous for
// a legitimate API error payload while bounding worst-case.
const MAX_ERROR_BODY_BYTES = 1_000_000;

async function readBodySafely(
  resp: Response,
  apiKey: string,
): Promise<string> {
  try {
    const lenHeader = resp.headers.get("content-length");
    if (lenHeader) {
      const declared = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) {
        return `<body too large: ${declared} bytes>`;
      }
    }
    const text = await resp.text();
    // Truncate to keep logs bounded and avoid echoing large bodies that could
    // include sensitive context in a misconfigured proxy environment.
    const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return sanitizeForLog(truncated, apiKey);
  } catch {
    return "<unreadable>";
  }
}

function validateApiKey(apiKey: string): void {
  // GHA secrets occasionally come with trailing whitespace/newlines from
  // copy-paste; Node's fetch then throws a confusing "invalid header" error
  // from inside the retry loop. Reject up front with a clear terminal error.
  if (!apiKey) {
    throw new PublishError("BUTTONDOWN_API_KEY not set", {
      attempts: 0,
      terminal: true,
    });
  }
  if (/[\r\n]/.test(apiKey) || apiKey.trim() !== apiKey) {
    throw new PublishError(
      "BUTTONDOWN_API_KEY contains whitespace or newlines (likely a misconfigured secret)",
      { attempts: 0, terminal: true },
    );
  }
}

/**
 * POST a rendered issue to Buttondown with exponential retry on 5xx. 4xx
 * fails fast as a terminal `PublishError`. The API key is never logged.
 */
export async function publishToButtondown(
  issue: RenderedIssue,
  opts: ButtondownPublishOptions,
): Promise<ButtondownPublishResult> {
  validateApiKey(opts.apiKey);
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new PublishError("fetch is not available in this runtime", {
      attempts: 0,
      terminal: true,
    });
  }
  const retryOpts: RetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    ...(opts.retry ?? {}),
  };
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const body = JSON.stringify({
    subject: issue.subject,
    body: issue.body,
    status: opts.status ?? "about_to_send",
  });

  let attempts = 0;
  try {
    const result = await retry(async (attempt) => {
      attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Token ${opts.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        // Transport-level failure (DNS, TCP reset, abort/timeout) — retryable.
        // Distinguish abort so the message is actionable.
        const aborted =
          (err instanceof Error && err.name === "AbortError") ||
          controller.signal.aborted;
        const detail = aborted
          ? `request timeout after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        throw new RetryableError(`buttondown transport error: ${detail}`);
      } finally {
        clearTimeout(timer);
      }
      if (resp.status >= 500) {
        const excerpt = await readBodySafely(resp, opts.apiKey);
        throw new RetryableError(`buttondown ${resp.status}: ${excerpt}`);
      }
      if (resp.status >= 400) {
        const excerpt = await readBodySafely(resp, opts.apiKey);
        // Terminal — 4xx means our request is wrong. No retry.
        throw new PublishError(`buttondown ${resp.status}: ${excerpt}`, {
          status: resp.status,
          attempts,
          terminal: true,
        });
      }
      const json = (await resp.json().catch(() => null)) as
        | { id?: unknown }
        | null;
      if (!json || typeof json.id !== "string" || json.id.length === 0) {
        throw new PublishError(`buttondown response missing id field`, {
          status: resp.status,
          attempts,
          terminal: true,
        });
      }
      return { id: json.id, attempts, endpoint };
    }, retryOpts);
    return result;
  } catch (err) {
    if (err instanceof PublishError) throw err;
    if (err instanceof RetryExhaustedError) {
      // Preserve the final attempt's message so production triage in CI logs
      // sees *why* the retries failed (e.g., "buttondown 502: Bad Gateway"),
      // not just the attempt count. The message is already sanitized.
      const lastMsg =
        err.lastError instanceof Error
          ? err.lastError.message
          : err.lastError !== undefined
            ? String(err.lastError)
            : "unknown error";
      throw new PublishError(
        `buttondown publish failed after ${err.attempts} attempts: ${sanitizeForLog(lastMsg, opts.apiKey)}`,
        { attempts: err.attempts, terminal: false, cause: err.lastError },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new PublishError(
      `buttondown publish unexpected error: ${sanitizeForLog(detail, opts.apiKey)}`,
      { attempts, terminal: true, cause: err },
    );
  }
}
