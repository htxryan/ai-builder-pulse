// Tenacity-equivalent retry helper. Exponential backoff on retryable errors
// (5xx HTTP + transport-level failures). 4xx is terminal — no retry. Used by
// the Buttondown adapter; kept generic so it can be reused for other HTTP
// calls in future epics.

export interface RetryOptions {
  readonly maxAttempts: number; // total attempts INCLUDING the first
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  // Async sleeper — injected for tests so suites run in milliseconds, not
  // seconds. Default is `setTimeout`.
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
};

// Signal from the operation that the error is retryable (typically a 5xx or
// a transport failure). Anything else is terminal and fails fast.
export class RetryableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RetryableError";
  }
}

// Result of the final unsuccessful attempt — surfaced to callers so they can
// log `attempts` for observability (E-04 debugging).
export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, opts: RetryOptions): number {
  // Exponential: base * 2^(attempt-1), clamped at maxDelay. Deterministic —
  // no jitter so tests can assert total wait time. A daily cron has low
  // contention risk, so jitter gains little here.
  const raw = opts.baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(raw, opts.maxDelayMs);
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetryableError)) {
        // Terminal error (4xx, programmer error, validation) — do not retry.
        throw err;
      }
      if (attempt === opts.maxAttempts) break;
      await sleep(computeDelay(attempt, opts));
    }
  }
  throw new RetryExhaustedError(
    `Retry exhausted after ${opts.maxAttempts} attempts`,
    opts.maxAttempts,
    lastError,
  );
}
