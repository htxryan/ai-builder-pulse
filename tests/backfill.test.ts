import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findUnpublished, runBackfill } from "../src/backfill.js";
import type { Publisher } from "../src/orchestrator.js";
import type { ScoredItem } from "../src/types.js";

// Builds the items.json payload the archivist would have written. `keep` is
// set on every item so the renderer has content to produce.
function makeItemsJson(runDate: string, count: number): string {
  const items: ScoredItem[] = Array.from({ length: count }, (_, i) => ({
    id: `hn-${i}`,
    source: "hn" as const,
    title: `title ${i}`,
    url: `https://example.com/item-${i}`,
    score: 10,
    publishedAt: "2026-04-17T05:00:00.000Z",
    metadata: { source: "hn" as const, points: 10 },
    category: "Tools & Launches" as const,
    relevanceScore: 0.8,
    keep: true,
    description:
      "A sufficiently-long backfill fixture description that satisfies the ScoredItem schema minimum length for this test.",
  }));
  const payload = {
    runDate,
    publishId: "em_original",
    publishedAt: "2026-04-17T06:10:00.000Z",
    itemCount: { total: count, kept: count },
    sourceSummary: { hn: { count, status: "ok", keptCount: count } },
    items,
  };
  return JSON.stringify(payload, null, 2);
}

// Writes the disk-state left behind after a successful archiveRun that
// lost its `.published` sentinel (or whose runner failed to push). The
// backfill reads items.json and ignores issue.md for payload.
function writeOrphan(root: string, runDate: string, count = 6): void {
  const dir = path.join(root, "issues", runDate);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "issue.md"), `# ${runDate} — orphaned`);
  writeFileSync(path.join(dir, "items.json"), makeItemsJson(runDate, count));
}

describe("findUnpublished", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-backfill-"));
    mkdirSync(path.join(root, "issues"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when issues/ dir is missing", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "abp-empty-"));
    expect(findUnpublished(empty, "2026-04-18")).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("detects a prior day with issue.md but no .published", () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    const out = findUnpublished(root, "2026-04-18");
    expect(out).toHaveLength(1);
    expect(out[0]!.runDate).toBe("2026-04-17");
  });

  it("skips a day that already has .published", () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    writeFileSync(path.join(dir, ".published"), "");
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  it("skips current runDate (only prior days)", () => {
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  it("ignores non-date directories", () => {
    mkdirSync(path.join(root, "issues", "README"), { recursive: true });
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  // Disk-corruption edge cases (cycle-2 polish audit AC5). In the wild we
  // have observed: a zero-byte .published sentinel (fs sync killed before
  // the first write flushed), a truncated items.json (runner OOM mid-write),
  // and an unreadable prior-day directory (stale chmod from a manual op).
  // The orchestrator must tolerate each without aborting today's run.
  it("treats a zero-byte .published sentinel as 'published' (not an orphan)", () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    writeFileSync(path.join(dir, ".published"), ""); // zero bytes
    // A present-but-empty sentinel still signals "publish happened" — the
    // file system's existence check, not its content, is the source of truth.
    // This prevents a wedged partial write from triggering a duplicate send.
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  it("tolerates an unstat-able prior-day entry (symlink loop → ELOOP) and skips with a warn", () => {
    // Simulates a disk-corruption scenario where a directory entry can be
    // *listed* (readdir) but not *stat-ed* (EACCES / ELOOP / EPERM). We use
    // a self-referencing symlink because it is cross-platform and does not
    // require elevated privileges to produce. The orphan-detection must not
    // crash: the bad entry is skipped with a warn, sibling days still work.
    const badDate = "2026-04-15";
    const goodDate = "2026-04-17";
    // Self-referencing symlink — stat follows links and hits ELOOP.
    symlinkSync(
      path.join(root, "issues", badDate),
      path.join(root, "issues", badDate),
    );
    mkdirSync(path.join(root, "issues", goodDate));
    writeFileSync(path.join(root, "issues", goodDate, "issue.md"), "# ok");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = findUnpublished(root, "2026-04-18");
      expect(out.map((d) => d.runDate)).toEqual([goodDate]);
      const warnOutput = warnSpy.mock.calls
        .flat()
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join("\n");
      expect(warnOutput).toContain("stat failed for prior day dir");
      expect(warnOutput).toContain(badDate);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns prior days in ascending date order so oldest is recovered first", () => {
    for (const d of ["2026-04-15", "2026-04-17", "2026-04-16"]) {
      const dir = path.join(root, "issues", d);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "issue.md"), "# x");
    }
    const out = findUnpublished(root, "2026-04-18");
    expect(out.map((d) => d.runDate)).toEqual([
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
    ]);
  });
});

describe("runBackfill (no orphans)", () => {
  it("attempts zero on clean tree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-bf-clean-"));
    const result = await runBackfill(root, "2026-04-18", { dryRun: false });
    expect(result.attempted).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skippedOverCap).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runBackfill (DRY_RUN)", () => {
  it("logs intent, does not touch disk or call publisher", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-bf-dry-"));
    writeOrphan(root, "2026-04-17");
    let publisherCalls = 0;
    const publisher: Publisher = {
      async publish() {
        publisherCalls++;
        return { id: "em_should_not_fire", attempts: 0 };
      },
    };
    const result = await runBackfill(root, "2026-04-18", {
      dryRun: true,
      publisher,
    });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(publisherCalls).toBe(0);
    expect(
      existsSync(path.join(root, "issues", "2026-04-17", ".published")),
    ).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("runBackfill (re-publish)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-bf-repub-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("re-publishes a prior day and writes .published on 2xx", async () => {
    writeOrphan(root, "2026-04-17");
    const calls: Array<{ subject: string; body: string }> = [];
    const publisher: Publisher = {
      async publish(issue) {
        calls.push({ subject: issue.subject, body: issue.body });
        return { id: "em_backfill_17", attempts: 1 };
      },
    };
    const result = await runBackfill(root, "2026-04-18", {
      dryRun: false,
      publisher,
    });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.attemptedDates).toEqual(["2026-04-17"]);
    // Subject matches what renderIssue produces deterministically for runDate.
    expect(calls[0]?.subject).toContain("2026-04-17");
    // Sentinel written with the returned publish id.
    const sentinel = readFileSync(
      path.join(root, "issues", "2026-04-17", ".published"),
      "utf8",
    ).trim();
    expect(sentinel).toBe("em_backfill_17");
  });

  it("surfaces a Publisher error as failed (non-blocking) without writing .published", async () => {
    writeOrphan(root, "2026-04-17");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const publisher: Publisher = {
        async publish() {
          throw new Error("Buttondown 400: invalid payload");
        },
      };
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
        publisher,
      });
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(
        existsSync(path.join(root, "issues", "2026-04-17", ".published")),
      ).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("fails when items.json is missing (cannot reconstruct kept set)", async () => {
    // Orphan day with issue.md but no items.json — archivist crashed between
    // the first and second write.
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "issue.md"), "# half-written");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const publisher: Publisher = {
        async publish() {
          return { id: "em_should_not_fire", attempts: 0 };
        },
      };
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
        publisher,
      });
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("surfaces a truncated items.json (mid-object) as ArchiveParseError with the runDate", async () => {
    // Simulates the classic OOM-during-write symptom: file exists, prefix is
    // valid-looking JSON, but the object is cut off mid-value. JSON.parse
    // must reject and the failure must be non-blocking with the runDate
    // pinned in the message so the operator can locate the corrupt archive.
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "issue.md"), "# orphan");
    writeFileSync(
      path.join(dir, "items.json"),
      '{"runDate":"2026-04-17","items":[{"id":"hn-0","source":"hn","title":"t","url":"https://example.com/a","sc',
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const publisher: Publisher = {
        async publish() {
          return { id: "em_noop", attempts: 0 };
        },
      };
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
        publisher,
      });
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
      const logged = errSpy.mock.calls.flat().join("\n");
      expect(logged).toContain("2026-04-17");
      expect(logged).toContain("items.json parse failed");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("wraps a syntactically-invalid items.json in ArchiveParseError (filePath attached)", async () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "issue.md"), "# orphan");
    writeFileSync(path.join(dir, "items.json"), "{not-json"); // corrupt
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const publisher: Publisher = {
        async publish() {
          return { id: "em_noop", attempts: 0 };
        },
      };
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
        publisher,
      });
      // Non-blocking: counted as failed, not thrown past the caller.
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
      // The error message surfaced to the log must include the file path so
      // operators can locate the corrupt archive without grepping the trace.
      const logged = errSpy.mock.calls.flat().join("\n");
      expect(logged).toContain("items.json parse failed for 2026-04-17");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("fails cleanly when publisher is absent (no snowball, no silent skip)", async () => {
    writeOrphan(root, "2026-04-17");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
      });
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("caps at maxAttempts=1 by default and defers extras with a loud warning", async () => {
    writeOrphan(root, "2026-04-15");
    writeOrphan(root, "2026-04-16");
    writeOrphan(root, "2026-04-17");
    const calls: string[] = [];
    const publisher: Publisher = {
      async publish(issue) {
        // Pull the runDate out of the subject the renderer produced.
        const m = issue.subject.match(/\d{4}-\d{2}-\d{2}/);
        calls.push(m?.[0] ?? "unknown");
        return { id: `em_${m?.[0] ?? "x"}`, attempts: 1 };
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runBackfill(root, "2026-04-18", {
        dryRun: false,
        publisher,
      });
      expect(result.attempted).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.skippedOverCap).toBe(2);
      // Only the oldest day (ascending order) was attempted.
      expect(calls).toEqual(["2026-04-15"]);
      expect(
        existsSync(path.join(root, "issues", "2026-04-15", ".published")),
      ).toBe(true);
      expect(
        existsSync(path.join(root, "issues", "2026-04-16", ".published")),
      ).toBe(false);
      expect(
        existsSync(path.join(root, "issues", "2026-04-17", ".published")),
      ).toBe(false);
      // Warning must mention the deferred dates so operators see them.
      const warnOutput = warnSpy.mock.calls
        .flat()
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join("\n");
      expect(warnOutput).toContain("2026-04-16");
      expect(warnOutput).toContain("2026-04-17");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("maxAttempts override lets operators catch up in a single run_workflow_dispatch", async () => {
    writeOrphan(root, "2026-04-16");
    writeOrphan(root, "2026-04-17");
    const publisher: Publisher = {
      async publish() {
        return { id: "em_x", attempts: 1 };
      },
    };
    const result = await runBackfill(root, "2026-04-18", {
      dryRun: false,
      maxAttempts: 5,
      publisher,
    });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.skippedOverCap).toBe(0);
  });
});
