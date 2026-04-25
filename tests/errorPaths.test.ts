import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

describe("E-04 error path (AC-7)", () => {
  let root: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-err-"));
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    errSpy.mockRestore();
  });

  it("fetchAll throw yields failed status and emits ::error:: annotation", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: async () => {
        throw new Error("boom");
      },
    });
    expect(r.status).toBe("failed");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.startsWith("::error::"))).toBe(true);
  });

  it("curator throw yields failed status and emits ::error:: annotation", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "1", MIN_ITEMS_TO_PUBLISH: "1" },
      fetchAll: async () => ({
        items: [
          {
            id: "x",
            source: "hn" as const,
            title: "t",
            url: "https://example.com/x",
            score: 1,
            publishedAt: "2026-04-18T00:00:00.000Z",
            metadata: { source: "hn" as const, points: 5, numComments: 2 },
          },
        ],
        summary: { hn: { count: 1, status: "ok" } },
      }),
      curator: {
        async curate(): Promise<never> {
          throw new Error("curator exploded");
        },
      },
    });
    expect(r.status).toBe("failed");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.startsWith("::error::"))).toBe(true);
  });
});

describe("env validation (NaN-guard)", () => {
  it("throws on non-numeric MIN_ITEMS_TO_PUBLISH", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-env-"));
    await expect(
      runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "abc" },
      }),
    ).rejects.toThrow(/MIN_ITEMS_TO_PUBLISH/);
    rmSync(root, { recursive: true, force: true });
  });

  it("throws on non-numeric MIN_SOURCES", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-env2-"));
    await expect(
      runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: { DRY_RUN: "1", MIN_SOURCES: "xyz" },
      }),
    ).rejects.toThrow(/MIN_SOURCES/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("AC-1 secret non-leakage", () => {
  it("does not log ANTHROPIC_API_KEY / BUTTONDOWN_API_KEY / REDDIT_CLIENT_SECRET values", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-secret-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const SECRETS = {
      ANTHROPIC_API_KEY: "sk-ant-TESTSECRET-000AAA",
      BUTTONDOWN_API_KEY: "btn-TESTSECRET-111BBB",
      REDDIT_CLIENT_ID: "reddit-TESTSECRET-222CCC",
      REDDIT_CLIENT_SECRET: "reddit-TESTSECRET-333DDD",
    };

    await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        DRY_RUN: "1",
        MIN_SOURCES: "2",
        MIN_ITEMS_TO_PUBLISH: "1",
        USE_MOCK_COLLECTORS: "1",
        ...SECRETS,
      },
    });

    const allOutput = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errSpy.mock.calls,
    ]
      .flat()
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(allOutput, `${name} leaked`).not.toContain(value);
    }

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
});
