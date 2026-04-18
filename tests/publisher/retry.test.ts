import { describe, it, expect } from "vitest";
import {
  retry,
  RetryableError,
  RetryExhaustedError,
} from "../../src/publisher/retry.js";

function noSleep(): Promise<void> {
  return Promise.resolve();
}

describe("retry", () => {
  it("returns immediately on first-attempt success", async () => {
    let calls = 0;
    const out = await retry(
      async () => {
        calls += 1;
        return 42;
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
    );
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries on RetryableError and eventually succeeds", async () => {
    let calls = 0;
    const out = await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError("5xx");
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws RetryExhaustedError after maxAttempts (E-04)", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new RetryableError(`fail ${calls}`);
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(3);
  });

  it("does NOT retry on non-retryable errors (e.g., 4xx wrapped as Error)", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new Error("terminal");
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("terminal");
    expect(calls).toBe(1);
  });

  it("uses exponential backoff with maxDelay clamp", async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls += 1;
          throw new RetryableError("x");
        },
        {
          maxAttempts: 4,
          baseDelayMs: 10,
          maxDelayMs: 50,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    // 4 attempts → 3 sleeps between them. Delays: 10, 20, 40 (clamp < 50 OK).
    expect(delays).toEqual([10, 20, 40]);
  });
});
