import { describe, it, expect } from "vitest";
import {
  CollectorTimeoutError,
  withTimeout,
} from "../../src/collectors/timeout.js";

describe("withTimeout", () => {
  it("resolves when inner resolves before the deadline", async () => {
    const v = await withTimeout("hn", 100, async () => 42);
    expect(v).toBe(42);
  });

  it("rejects with CollectorTimeoutError when the deadline fires", async () => {
    await expect(
      withTimeout("hn", 20, (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      ),
    ).rejects.toBeInstanceOf(CollectorTimeoutError);
  });

  it("propagates parent abort", async () => {
    const parent = new AbortController();
    const p = withTimeout(
      "hn",
      1000,
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      parent.signal,
    );
    parent.abort(new Error("upstream"));
    await expect(p).rejects.toBeTruthy();
  });

  it("aborts immediately when parent is already aborted at call time", async () => {
    const parent = new AbortController();
    parent.abort(new Error("already"));
    await expect(
      withTimeout(
        "hn",
        60_000,
        (signal) =>
          new Promise<number>((_resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
        parent.signal,
      ),
    ).rejects.toThrow(/already/);
  });
});
