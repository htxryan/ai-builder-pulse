import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runOrchestrator } from "../src/orchestrator.js";
import type { RawItem, ScoredItem, SourceSummary } from "../src/types.js";

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

function mkScored(id: string): ScoredItem {
  return {
    id,
    source: "hn",
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    score: 10,
    publishedAt: "2026-04-17T10:00:00Z",
    metadata: { source: "hn", points: 10 },
    category: "Tools & Launches",
    relevanceScore: 0.9,
    keep: true,
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
  writeFileSync(path.join(dir, "issue.md"), `# ${runDate}\n`);
  writeFileSync(path.join(dir, ".published"), "em_seed\n");
}

// fetchAll that returns an empty items list with an 'ok' source summary.
const emptyFetch = async () => {
  const items: RawItem[] = [];
  const summary: SourceSummary = {
    hn: { count: 0, status: "ok" },
  };
  return { items, summary };
};

describe("runOrchestrator archives fallback (AC7)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-afb-orch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("source_floor_skip with ARCHIVES_FALLBACK=1 re-publishes yesterday's archive", async () => {
    seedArchive(root, "2026-04-17", [mkScored("a"), mkScored("b"), mkScored("c")]);
    let publishedSubject = "";
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { ARCHIVES_FALLBACK: "1", BUTTONDOWN_API_KEY: "fake-key-123456" },
      fetchAll: emptyFetch,
      publisher: {
        publish: async (issue) => {
          publishedSubject = issue.subject;
          return { id: "em_fallback", attempts: 1 };
        },
      },
    });
    expect(r.status).toBe("published_from_archives");
    expect(r.publishId).toBe("em_fallback");
    expect(r.archivesFallback?.sourceRunDate).toBe("2026-04-17");
    expect(publishedSubject.startsWith("[Archives]")).toBe(true);
    // Today's sentinel must be written so S-03 blocks a rerun
    expect(existsSync(path.join(root, "issues", "2026-04-18", ".published"))).toBe(
      true,
    );
  });

  it("without ARCHIVES_FALLBACK=1 the day stays silent (source_floor_skip)", async () => {
    seedArchive(root, "2026-04-17", [mkScored("a")]);
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { BUTTONDOWN_API_KEY: "fake-key-123456" },
      fetchAll: emptyFetch,
      publisher: {
        publish: async () => {
          throw new Error("should not publish");
        },
      },
    });
    expect(r.status).toBe("source_floor_skip");
    expect(r.archivesFallback).toBeUndefined();
    // No sentinel is written — S-02/S-05 skip leaves the day un-committed
    expect(existsSync(path.join(root, "issues", "2026-04-18", ".published"))).toBe(
      false,
    );
  });

  it("no prior archive + flag on → still skips (no_archive_available)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { ARCHIVES_FALLBACK: "1", BUTTONDOWN_API_KEY: "fake-key-123456" },
      fetchAll: emptyFetch,
      publisher: {
        publish: async () => {
          throw new Error("should not publish");
        },
      },
    });
    expect(r.status).toBe("source_floor_skip");
    expect(r.archivesFallback?.status).toBe("no_archive_available");
  });
});
