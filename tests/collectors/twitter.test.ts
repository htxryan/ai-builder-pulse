import { describe, it, expect } from "vitest";
import {
  TwitterCollector,
  twitterStubStatus,
} from "../../src/collectors/twitter.js";
import type { CollectorContext } from "../../src/collectors/types.js";

function ctx(env: NodeJS.ProcessEnv): CollectorContext {
  return {
    runDate: "2026-04-18",
    cutoffMs: 0,
    abortSignal: new AbortController().signal,
    env,
  };
}

describe("TwitterCollector (O-01 stub)", () => {
  it("returns [] when ENABLE_TWITTER unset", async () => {
    const c = new TwitterCollector();
    const items = await c.fetch(ctx({}));
    expect(items).toEqual([]);
  });

  it("throws when ENABLE_TWITTER=1 (not implemented in v1)", async () => {
    const c = new TwitterCollector();
    await expect(c.fetch(ctx({ ENABLE_TWITTER: "1" }))).rejects.toThrow(/v2/);
  });

  it("twitterStubStatus reflects env", () => {
    expect(twitterStubStatus({}).enabled).toBe(false);
    expect(twitterStubStatus({ ENABLE_TWITTER: "1" }).enabled).toBe(true);
  });
});
