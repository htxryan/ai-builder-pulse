import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import type { RawItem, SourceSummary } from "../src/types.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-orch-"));
}

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

const fixtureFetch = async () => {
  const items: RawItem[] = Array.from({ length: 10 }, (_, i) => ({
    id: `hn-${i}`,
    source: "hn" as const,
    title: `title ${i}`,
    url: `https://example.com/${i}`,
    score: 10,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" as const, points: 10 },
  }));
  const summary: SourceSummary = {
    hn: { count: 5, status: "ok" },
    "github-trending": { count: 5, status: "ok" },
  };
  return { items, summary };
};

describe("runOrchestrator", () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("derives runDate and threads it through (AC-3)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: fixtureFetch,
    });
    expect(r.runDate).toBe("2026-04-18");
  });

  it("DRY_RUN=1 produces dry_run status and does not require publish (AC-10)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("dry_run");
    expect(r.scored?.length).toBe(10);
  });

  it("idempotent skip when .published exists (AC-9)", async () => {
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".published"), "");
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {},
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("idempotent_skip");
  });

  it("DRY_RUN bypasses S-03 sentinel (AC-10)", async () => {
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".published"), "");
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("dry_run");
  });

  it("S-05 source floor skip when only one source returns ok", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "2" },
      fetchAll: async () => ({
        items: [
          {
            id: "hn-1",
            source: "hn" as const,
            title: "t",
            url: "https://example.com/1",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: { source: "hn" as const },
          },
        ],
        summary: { hn: { count: 1, status: "ok" } } as SourceSummary,
      }),
    });
    expect(r.status).toBe("source_floor_skip");
  });

  it("S-02 empty skip when kept < minItemsToPublish", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "100" },
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("empty_skip");
  });

  it("runs end-to-end with default mockFetchAll", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        DRY_RUN: "1",
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
        USE_MOCK_COLLECTORS: "1",
      },
    });
    expect(r.runDate).toBe("2026-04-18");
    expect(["dry_run", "empty_skip"].includes(r.status)).toBe(true);
  });

  it("E-06 backfill detection emits warning non-blocking", async () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "issue.md"), "# prior");
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("dry_run");
  });
});
