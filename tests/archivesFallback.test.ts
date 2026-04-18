import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runArchivesFallback, findLatestArchive } from "../src/archivesFallback.js";
import type { ScoredItem } from "../src/types.js";

function mkScored(id: string, keep = true): ScoredItem {
  return {
    id,
    source: "hn",
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    score: 10,
    publishedAt: "2026-04-10T00:00:00Z",
    metadata: { source: "hn" },
    category: "Tools & Launches",
    relevanceScore: 0.9,
    keep,
    description: "a".repeat(120),
  };
}

function seedArchive(root: string, runDate: string, items: ScoredItem[]): void {
  const dir = path.join(root, "issues", runDate);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "items.json"),
    JSON.stringify({ runDate, items }, null, 2),
  );
  writeFileSync(path.join(dir, "issue.md"), `# Issue ${runDate}\n`);
  writeFileSync(path.join(dir, ".published"), "em_seed\n");
}

describe("findLatestArchive", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-afb-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the most recent prior date with items.json", () => {
    seedArchive(root, "2026-04-15", [mkScored("a")]);
    seedArchive(root, "2026-04-16", [mkScored("b")]);
    seedArchive(root, "2026-04-17", [mkScored("c")]);
    expect(findLatestArchive(root, "2026-04-18")).toBe("2026-04-17");
  });

  it("skips the current runDate itself", () => {
    seedArchive(root, "2026-04-18", [mkScored("a")]);
    expect(findLatestArchive(root, "2026-04-18")).toBeUndefined();
  });

  it("returns undefined when no archives exist", () => {
    expect(findLatestArchive(root, "2026-04-18")).toBeUndefined();
  });
});

describe("runArchivesFallback", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-afb-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns no_archive_available when no prior archive exists", async () => {
    const r = await runArchivesFallback(root, "2026-04-18", {
      dryRun: false,
      publisher: { publish: async () => ({ id: "x", attempts: 1 }) },
    });
    expect(r.status).toBe("no_archive_available");
  });

  it("publishes with banner when prior archive exists", async () => {
    seedArchive(root, "2026-04-17", [mkScored("a", true), mkScored("b", true)]);
    let publishedSubject = "";
    let publishedBody = "";
    const r = await runArchivesFallback(root, "2026-04-18", {
      dryRun: false,
      publisher: {
        publish: async (issue) => {
          publishedSubject = issue.subject;
          publishedBody = issue.body;
          return { id: "em_archives", attempts: 1 };
        },
      },
    });
    expect(r.status).toBe("published");
    expect(r.sourceRunDate).toBe("2026-04-17");
    expect(r.publishId).toBe("em_archives");
    expect(publishedSubject.startsWith("[Archives]")).toBe(true);
    expect(publishedBody).toContain("From the archives");
    expect(publishedBody).toContain("2026-04-17");
  });

  it("dry_run does not call publisher and does not write sentinel", async () => {
    seedArchive(root, "2026-04-17", [mkScored("a")]);
    let called = false;
    const r = await runArchivesFallback(root, "2026-04-18", {
      dryRun: true,
      publisher: {
        publish: async () => {
          called = true;
          return { id: "x", attempts: 1 };
        },
      },
    });
    expect(r.status).toBe("dry_run");
    expect(called).toBe(false);
  });
});
