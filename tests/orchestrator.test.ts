import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import type { RawItem, SourceSummary } from "../src/types.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-orch-"));
}

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

const fixtureFetch = async () => {
  const items: RawItem[] = Array.from({ length: 10 }, (_, i) => {
    const useGht = i >= 5;
    return useGht
      ? {
          id: `gh-${i}`,
          source: "github-trending" as const,
          title: `title ${i}`,
          url: `https://github.com/owner${i}/repo${i}`,
          score: 10,
          publishedAt: "2026-04-18T05:00:00.000Z",
          metadata: {
            source: "github-trending" as const,
            repoFullName: `owner${i}/repo${i}`,
          },
        }
      : {
          id: `hn-${i}`,
          source: "hn" as const,
          title: `title ${i}`,
          url: `https://example.com/${i}`,
          score: 10,
          publishedAt: "2026-04-18T05:00:00.000Z",
          metadata: { source: "hn" as const, points: 10 },
        };
  });
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

  it("S-05 floor evaluated AFTER pre-filter — items collapsed to one source skip", async () => {
    // Two sources collected items, but every github-trending item is a user
    // profile and therefore dropped by Un-02. Only `hn` contributes after
    // pre-filter, so S-05 should skip even though collectorSummary reports 2.
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
      fetchAll: async () => ({
        items: [
          {
            id: "hn-1",
            source: "hn" as const,
            title: "t",
            url: "https://example.com/post-1",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: { source: "hn" as const },
          },
          {
            id: "gh-bad",
            source: "github-trending" as const,
            title: "profile",
            url: "https://github.com/torvalds",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: {
              source: "github-trending" as const,
              repoFullName: "torvalds/linux",
            },
          },
        ],
        summary: {
          hn: { count: 1, status: "ok" },
          "github-trending": { count: 1, status: "ok" },
        } as SourceSummary,
      }),
    });
    expect(r.status).toBe("source_floor_skip");
    expect(r.reason).toBe("S-05");
  });

  it("pre-filter dedups items with UTM-only difference before curation", async () => {
    // hn-dup1 + hn-dup2 share the same canonical URL → collapse to one.
    // gh-other comes from a different source so the floor (2) is met.
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
      fetchAll: async () => ({
        items: [
          {
            id: "hn-dup1",
            source: "hn" as const,
            title: "t",
            url: "https://example.com/post-1?utm_source=hn",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: { source: "hn" as const },
          },
          {
            id: "hn-dup2",
            source: "hn" as const,
            title: "t",
            url: "https://example.com/post-1?utm_medium=link",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: { source: "hn" as const },
          },
          {
            id: "gh-other",
            source: "github-trending" as const,
            title: "t2",
            url: "https://github.com/owner/repo",
            score: 1,
            publishedAt: "2026-04-18T01:00:00.000Z",
            metadata: {
              source: "github-trending" as const,
              repoFullName: "owner/repo",
            },
          },
        ],
        summary: {
          hn: { count: 2, status: "ok" },
          "github-trending": { count: 1, status: "ok" },
        } as SourceSummary,
      }),
    });
    expect(r.status).toBe("dry_run");
    // 3 items in, 1 dedup-collapsed → 2 curated.
    expect(r.scored?.length).toBe(2);
  });

  it("threads filtered summary with keptCount on the result", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
      fetchAll: fixtureFetch,
    });
    expect(r.summary).toBeDefined();
    expect(r.summary?.hn?.keptCount).toBe(5);
    expect(r.summary?.["github-trending"]?.keptCount).toBe(5);
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

  it("E5 DRY_RUN renders issue but does not invoke publisher (O-02)", async () => {
    let publishCalls = 0;
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async () => {
          publishCalls += 1;
          return { id: "should-not-be-called", attempts: 1, endpoint: "x" };
        },
      },
    });
    expect(r.status).toBe("dry_run");
    expect(publishCalls).toBe(0);
    expect(r.rendered).toBeDefined();
    expect(r.rendered?.subject).toBe("AI Builder Pulse — 2026-04-18");
    expect(r.rendered?.body).toContain("# AI Builder Pulse — 2026-04-18");
  });

  it("E5 publishes via injected publisher and returns publishId", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async (issue) => {
          expect(issue.subject).toBeDefined();
          return {
            id: "em_published_1",
            attempts: 1,
            endpoint: "https://api.buttondown.com/v1/emails",
          };
        },
      },
    });
    expect(r.status).toBe("published");
    expect(r.publishId).toBe("em_published_1");
    expect(r.rendered).toBeDefined();
  });

  it("E5 publisher failure maps to status=failed with publish_failed reason", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("publish_failed");
    expect(r.rendered).toBeDefined(); // still surfaced for triage
  });

  it("E5 writes S-03 sentinel after successful publish (idempotency)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async () => ({ id: "em_persisted", attempts: 1 }),
      },
    });
    expect(r.status).toBe("published");
    const sentinel = path.join(root, "issues", "2026-04-18", ".published");
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8").trim()).toBe("em_persisted");
  });

  it("E5 fails fast when BUTTONDOWN_API_KEY missing in non-DRY_RUN", async () => {
    // No publisher injected, no DRY_RUN, no key → must fail BEFORE collection
    // (no fetchAll call), saving Claude budget.
    let fetchCalls = 0;
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: async () => {
        fetchCalls += 1;
        return fixtureFetch();
      },
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("missing_api_key");
    expect(fetchCalls).toBe(0);
  });

  it("E5 sentinel skip wins over missing-API-key fail-fast (idempotency first)", async () => {
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".published"), "em_prior\n");
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {},
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("idempotent_skip");
  });

  it("E5 S-02 empty skip does NOT call publisher", async () => {
    let publishCalls = 0;
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "100", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async () => {
          publishCalls += 1;
          return { id: "x", attempts: 1, endpoint: "x" };
        },
      },
    });
    expect(r.status).toBe("empty_skip");
    expect(publishCalls).toBe(0);
  });
});
