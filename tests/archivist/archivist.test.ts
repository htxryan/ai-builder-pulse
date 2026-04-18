import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archiveRun,
  archiveDir,
  sentinelPath,
  issueMdPath,
  itemsJsonPath,
} from "../../src/archivist/index.js";
import type { ScoredItem, SourceSummary } from "../../src/types.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-archivist-"));
}

const baseItem = (overrides: Partial<ScoredItem> = {}): ScoredItem => ({
  id: "hn-1",
  source: "hn",
  title: "Example",
  url: "https://example.com/post",
  score: 10,
  publishedAt: "2026-04-18T01:00:00.000Z",
  metadata: { source: "hn", points: 10 },
  category: "Tools & Launches",
  relevanceScore: 0.9,
  keep: true,
  description: "desc",
  ...overrides,
});

describe("archiveRun", () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runDate = "2026-04-18";

  it("writes issue.md, items.json, and .published sentinel", () => {
    const scored = [baseItem(), baseItem({ id: "hn-2", keep: false })];
    const summary: SourceSummary = {
      hn: { count: 2, status: "ok", keptCount: 1 },
    };
    const result = archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "# Body\n" },
      scored,
      summary,
      publishId: "em_abc",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });

    expect(existsSync(result.issueMdPath)).toBe(true);
    expect(existsSync(result.itemsJsonPath)).toBe(true);
    expect(existsSync(result.sentinelPath)).toBe(true);

    expect(result.issueMdPath).toBe(issueMdPath(root, runDate));
    expect(result.itemsJsonPath).toBe(itemsJsonPath(root, runDate));
    expect(result.sentinelPath).toBe(sentinelPath(root, runDate));
    expect(result.dir).toBe(archiveDir(root, runDate));
  });

  it("issue.md contains the exact rendered body (C5 verbatim)", () => {
    const body = "# AI Builder Pulse — 2026-04-18\n\ncontent";
    archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body },
      scored: [baseItem()],
      summary: { hn: { count: 1, status: "ok" } } as SourceSummary,
      publishId: "em_x",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });
    expect(readFileSync(issueMdPath(root, runDate), "utf8")).toBe(body);
  });

  it("items.json contains sourceSummary and items array (U-10)", () => {
    const summary: SourceSummary = {
      hn: { count: 3, status: "ok", keptCount: 2 },
      "github-trending": { count: 1, status: "ok", keptCount: 1 },
    };
    archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "b" },
      scored: [
        baseItem(),
        baseItem({ id: "hn-2", keep: false }),
        baseItem({ id: "gh-1", source: "github-trending", metadata: { source: "github-trending", repoFullName: "a/b" } }),
      ],
      summary,
      publishId: "em_a",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });
    const json = JSON.parse(readFileSync(itemsJsonPath(root, runDate), "utf8"));
    expect(json.runDate).toBe(runDate);
    expect(json.publishId).toBe("em_a");
    expect(json.itemCount).toEqual({ total: 3, kept: 2 });
    expect(json.sourceSummary).toEqual(summary);
    expect(json.items).toHaveLength(3);
  });

  it(".published sentinel contains the publishId", () => {
    archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "b" },
      scored: [baseItem()],
      summary: {} as SourceSummary,
      publishId: "em_abc123",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });
    expect(readFileSync(sentinelPath(root, runDate), "utf8").trim()).toBe("em_abc123");
  });

  it("is idempotent on repeated write (overwrites cleanly)", () => {
    const args = {
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "one" },
      scored: [baseItem()],
      summary: {} as SourceSummary,
      publishId: "em_1",
      publishedAt: "2026-04-18T06:10:00.000Z",
    };
    archiveRun(args);
    archiveRun({ ...args, rendered: { subject: "S", body: "two" }, publishId: "em_2" });
    expect(readFileSync(issueMdPath(root, runDate), "utf8")).toBe("two");
    expect(readFileSync(sentinelPath(root, runDate), "utf8").trim()).toBe("em_2");
  });

  it("writes all three files on a successful run with the sentinel carrying the publishId", () => {
    // The crash-ordering contract (issue.md / items.json present WITHOUT
    // .published → E-06 backfill candidate) is covered in tests/backfill.
    // Here we only assert the happy-path final state: all three files
    // land and the sentinel holds the expected publishId.
    archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "b" },
      scored: [baseItem()],
      summary: {} as SourceSummary,
      publishId: "em_x",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });
    expect(existsSync(issueMdPath(root, runDate))).toBe(true);
    expect(existsSync(itemsJsonPath(root, runDate))).toBe(true);
    expect(existsSync(sentinelPath(root, runDate))).toBe(true);
    expect(readFileSync(sentinelPath(root, runDate), "utf8").trim()).toBe("em_x");
  });

  it("leaves no .tmp files behind (atomic rename)", () => {
    archiveRun({
      runDate,
      repoRoot: root,
      rendered: { subject: "S", body: "b" },
      scored: [baseItem()],
      summary: {} as SourceSummary,
      publishId: "em_x",
      publishedAt: "2026-04-18T06:10:00.000Z",
    });
    const entries = readdirSync(archiveDir(root, runDate));
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
    expect(new Set(entries)).toEqual(new Set(["issue.md", "items.json", ".published"]));
  });
});
