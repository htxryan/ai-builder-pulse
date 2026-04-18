// Buttondown Publisher (part of E5). POSTs a rendered issue to
// https://api.buttondown.com/v1/emails with `Authorization: Token <key>`.
//
// - 5xx responses are retried with exponential backoff (up to 3 attempts).
// - 4xx responses fail fast with a PublishError. The API key is never logged
//   in error messages or stack frames (U-07 secret-leak protection).
// - A `fetchImpl` override exists so tests can inject a fake fetch without
//   touching the global. Default is the native `globalThis.fetch` (Node ≥18).
// - `status: "about_to_send"` publishes immediately per Buttondown's API.

import type { RenderedIssue } from "../renderer/renderer.js";
import {
  DEFAULT_RETRY_OPTIONS,
  retry,
  RetryableError,
  RetryExhaustedError,
  type RetryOptions,
} from "./retry.js";

const DEFAULT_ENDPOINT = "https://api.buttondown.com/v1/emails";

export interface ButtondownPublishOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: Partial<RetryOptions>;
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
export class PublishError extends Error {
  readonly status: number | undefined;
  readonly attempts: number;
  readonly terminal: boolean;
  constructor(
    message: string,
    opts: {
      status?: number;
      attempts: number;
      terminal: boolean;
    },
  ) {
    super(message);
    this.name = "PublishError";
    this.status = opts.status;
    this.attempts = opts.attempts;
    this.terminal = opts.terminal;
  }
}

async function readBodySafely(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    // Truncate to keep logs bounded and avoid echoing large bodies that could
    // include sensitive context in a misconfigured proxy environment.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<unreadable>";
  }
}

export async function publishToButtondown(
  issue: RenderedIssue,
  opts: ButtondownPublishOptions,
): Promise<ButtondownPublishResult> {
  if (!opts.apiKey) {
    throw new PublishError("BUTTONDOWN_API_KEY not set", {
      attempts: 0,
      terminal: true,
    });
  }
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

  const body = JSON.stringify({
    subject: issue.subject,
    body: issue.body,
    status: opts.status ?? "about_to_send",
  });

  let attempts = 0;
  try {
    const result = await retry(async (attempt) => {
      attempts = attempt;
      let resp: Response;
      try {
        resp = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Token ${opts.apiKey}`,
          },
          body,
        });
      } catch (err) {
        // Transport-level failure (DNS, TCP reset) — retryable. Strip cause
        // when re-throwing to avoid dragging secrets into the stack.
        throw new RetryableError(
          `buttondown transport error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (resp.status >= 500) {
        const excerpt = await readBodySafely(resp);
        throw new RetryableError(
          `buttondown ${resp.status}: ${excerpt}`,
        );
      }
      if (resp.status >= 400) {
        const excerpt = await readBodySafely(resp);
        // Terminal — 4xx means our request is wrong. No retry.
        throw new PublishError(
          `buttondown ${resp.status}: ${excerpt}`,
          { status: resp.status, attempts, terminal: true },
        );
      }
      const json = (await resp.json().catch(() => null)) as
        | { id?: unknown }
        | null;
      if (!json || typeof json.id !== "string" || json.id.length === 0) {
        throw new PublishError(
          `buttondown response missing id field`,
          { status: resp.status, attempts, terminal: true },
        );
      }
      return { id: json.id, attempts, endpoint };
    }, retryOpts);
    return result;
  } catch (err) {
    if (err instanceof PublishError) throw err;
    if (err instanceof RetryExhaustedError) {
      throw new PublishError(
        `buttondown publish failed after ${err.attempts} attempts`,
        { attempts: err.attempts, terminal: false },
      );
    }
    throw new PublishError(
      `buttondown publish unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { attempts, terminal: true },
    );
  }
}
