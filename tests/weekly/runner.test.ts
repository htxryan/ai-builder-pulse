import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWeeklyDigest, weeklySentinelPath } from "../../src/weekly/index.js";
import { archiveRun } from "../../src/archivist/index.js";
import type { ScoredItem, SourceSummary } from "../../src/types.js";
import type { Publisher } from "../../src/orchestrator.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-weekly-"));
}

const mkItem = (id: string, relevance: number): ScoredItem => ({
  id,
  source: "hn",
  title: `title ${id}`,
  url: `https://example.com/${id}`,
  score: 10,
  publishedAt: "2026-04-18T01:00:00.000Z",
  metadata: { source: "hn", points: 10 },
  category: "Tools & Launches",
  relevanceScore: relevance,
  keep: true,
  description: `desc ${id}`,
});

function seedDay(root: string, runDate: string, items: ScoredItem[]): void {
  archiveRun({
    runDate,
    repoRoot: root,
    rendered: { subject: `s-${runDate}`, body: `# ${runDate}` },
    scored: items,
    summary: { hn: { count: items.length, status: "ok" } } as SourceSummary,
    publishId: `em_${runDate}`,
    publishedAt: "2026-04-18T06:10:00.000Z",
  });
}

const fixedNow = new Date("2026-04-20T14:30:00.000Z"); // Monday W17
// Anchor = Monday - 1 day = 2026-04-19 (Sunday, still W16)

describe("runWeeklyDigest", () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("no days available returns no_days_available status", async () => {
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: { BUTTONDOWN_API_KEY: "test-key" },
    });
    expect(r.status).toBe("no_days_available");
    expect(r.missingDays).toHaveLength(7);
  });

  it("DRY_RUN writes digest to disk but does not publish", async () => {
    seedDay(root, "2026-04-18", [mkItem("a", 0.9)]);
    let publishCalls = 0;
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1" },
      publisher: {
        publish: async () => {
          publishCalls++;
          return { id: "x", attempts: 1 };
        },
      },
    });
    expect(r.status).toBe("dry_run");
    expect(publishCalls).toBe(0);
    expect(r.digestPath && existsSync(r.digestPath)).toBe(true);
    const contents = readFileSync(r.digestPath!, "utf8");
    expect(contents).toContain("AI Builder Pulse Weekly");
    expect(contents).toContain("/a");
  });

  it("publishes digest and returns publishId when days available", async () => {
    seedDay(root, "2026-04-17", [mkItem("a", 0.9)]);
    seedDay(root, "2026-04-18", [mkItem("b", 0.8)]);
    const publisher: Publisher = {
      publish: async (issue) => {
        expect(issue.subject).toContain("Weekly");
        expect(issue.body).toContain("/a");
        expect(issue.body).toContain("/b");
        return { id: "em_weekly_1", attempts: 1 };
      },
    };
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher,
    });
    expect(r.status).toBe("published");
    expect(r.publishId).toBe("em_weekly_1");
    expect([...r.availableDays].sort()).toEqual(["2026-04-17", "2026-04-18"]);
    expect(r.missingDays).toHaveLength(5);
  });

  it("writes weekly/{weekId}.md on disk", async () => {
    seedDay(root, "2026-04-18", [mkItem("a", 0.9)]);
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher: {
        publish: async () => ({ id: "em_x", attempts: 1 }),
      },
    });
    expect(r.status).toBe("published");
    // Anchor = 2026-04-19 (Sun), ISO week = 2026-W16
    const expected = path.join(root, "weekly", "2026-W16.md");
    expect(r.digestPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("publisher failure returns status=failed", async () => {
    seedDay(root, "2026-04-18", [mkItem("a", 0.9)]);
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher: {
        publish: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("publish_failed");
    // Digest still written to disk for inspection
    expect(r.digestPath && existsSync(r.digestPath)).toBe(true);
  });

  it("writes sentinel after publish and short-circuits on re-run", async () => {
    seedDay(root, "2026-04-18", [mkItem("a", 0.9)]);
    let calls = 0;
    const publisher: Publisher = {
      publish: async () => {
        calls++;
        return { id: "em_weekly_2", attempts: 1 };
      },
    };
    const first = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher,
    });
    expect(first.status).toBe("published");
    expect(calls).toBe(1);
    const sentinel = weeklySentinelPath(root, first.weekId);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf8").trim()).toBe("em_weekly_2");

    const second = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher,
    });
    expect(second.status).toBe("idempotent_skip");
    expect(calls).toBe(1);
  });

  it("fails fast when BUTTONDOWN_API_KEY missing and no publisher injected", async () => {
    seedDay(root, "2026-04-18", [mkItem("a", 0.9)]);
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {}, // no BUTTONDOWN_API_KEY, no DRY_RUN, no injected publisher
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("missing_api_key");
    // Digest should NOT be written — the guard short-circuits before build.
    expect(r.digestPath).toBeUndefined();
  });

  it("tolerates corrupt items.json (skips the day, continues)", async () => {
    seedDay(root, "2026-04-17", [mkItem("a", 0.9)]);
    // Corrupt 2026-04-18 manually
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "items.json"), "not valid json{{{");
    let published = false;
    const r = await runWeeklyDigest({
      now: fixedNow,
      repoRoot: root,
      env: {},
      publisher: {
        publish: async () => {
          published = true;
          return { id: "em_x", attempts: 1 };
        },
      },
    });
    expect(r.status).toBe("published");
    expect(published).toBe(true);
    expect(r.availableDays).toEqual(["2026-04-17"]);
    expect(r.corruptDays).toContain("2026-04-18");
    expect(r.missingDays).not.toContain("2026-04-18");
  });
});
