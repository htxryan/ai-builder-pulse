// E7 Integration — The 10 authoritative IV scenarios from spec §4.
//
// These are the named scenarios the epic's fitness function points at:
// every one of them must pass in CI on the integration-verify.yml workflow.
// Where the underlying mechanic already has deep coverage in a focused
// test file (e.g. collector timeout, claude count invariant), the scenario
// test is a thin wrapper that asserts the mechanic stays wired up to the
// orchestrator surface. The two scenarios without prior coverage — #4
// (Un-06 divergence) and #10 (concurrency race) — get full narrative tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../../src/orchestrator.js";
import { runBackfill, findUnpublished } from "../../src/backfill.js";
import { archiveRun, sentinelPath } from "../../src/archivist/index.js";
import { renderIssue } from "../../src/renderer/renderer.js";
import {
  ClaudeCurator,
  CountInvariantError,
  type CurationClient,
  type CurationRecord,
} from "../../src/curator/claudeCurator.js";
import {
  CollectorTimeoutError,
  withTimeout,
} from "../../src/collectors/timeout.js";
import { verifyLinkIntegrity } from "../../src/curator/linkIntegrity.js";
import { buildWeeklyDigest } from "../../src/weekly/digest.js";
import {
  RENDERER_TEMPLATE_URL_PATTERNS,
  NEWSLETTER_ARCHIVE_URL,
} from "../../src/renderer/allowlist.js";
import { deriveRunDate } from "../../src/runDate.js";
import { freshnessVerdict } from "../../src/preFilter/freshness.js";
import type { RawItem, ScoredItem, SourceSummary } from "../../src/types.js";

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

// Shared fetchAll fixture: 10 items from two sources, all fresh at fixedNow.
const fixtureFetch = async (): Promise<{
  items: RawItem[];
  summary: SourceSummary;
}> => {
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

// ---------- Scenario 1 ------------------------------------------------------
describe("IV scenario 1 — E-05 Claude count mismatch rejects + exhausts retries", () => {
  it("curator returning fewer records than items trips CountInvariantError after retries", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        // Drop last record every time — retries cannot recover.
        const records: CurationRecord[] = rawItems.slice(0, -1).map((r) => ({
          id: r.id,
          category: "Tools & Launches",
          relevanceScore: 0.5,
          keep: true,
          description:
            "A long-enough mock description to satisfy the ScoredItem schema minimum length.",
        }));
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 3 });
    await expect(
      cur.curate([
        {
          id: "a",
          source: "hn",
          title: "t",
          url: "https://example.com/a",
          score: 1,
          publishedAt: "2026-04-18T00:00:00.000Z",
          metadata: { source: "hn" },
        },
        {
          id: "b",
          source: "hn",
          title: "t",
          url: "https://example.com/b",
          score: 1,
          publishedAt: "2026-04-18T00:00:00.000Z",
          metadata: { source: "hn" },
        },
      ]),
    ).rejects.toBeInstanceOf(CountInvariantError);
  });

  it("orchestrator maps curator throw to status=failed with reason=curator_failed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-iv1-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: { DRY_RUN: "1", MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
        fetchAll: fixtureFetch,
        curator: {
          async curate() {
            throw new CountInvariantError(10, 9);
          },
        },
      });
      expect(r.status).toBe("failed");
      expect(r.reason).toBe("curator_failed");
    } finally {
      errSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------- Scenario 2 ------------------------------------------------------
describe("IV scenario 2 — Collector timeout fires AbortSignal, late response dropped", () => {
  it("withTimeout rejects with CollectorTimeoutError; inner work sees aborted signal", async () => {
    let innerAborted = false;
    await expect(
      withTimeout("hn", 15, (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            innerAborted = true;
            reject(signal.reason);
          });
        }),
      ),
    ).rejects.toBeInstanceOf(CollectorTimeoutError);
    expect(innerAborted).toBe(true);
  });

  it("inner work that checks signal on tick rejects promptly at timeout", async () => {
    // Inner would have resolved at 60ms, but honors the abort signal by
    // rejecting as soon as it fires (deadline 10ms). The outer promise must
    // settle well before the 60ms inner timer elapses.
    const start = Date.now();
    await expect(
      withTimeout("hn", 10, (signal) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve("late"), 60);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        }),
      ),
    ).rejects.toBeInstanceOf(CollectorTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------- Scenario 3 ------------------------------------------------------
describe("IV scenario 3 — S-05 minSources floor not met → source_floor_skip", () => {
  it("single contributing source with floor=2 yields E-04-like skip (no publish)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-iv3-"));
    let publishCalls = 0;
    try {
      const r = await runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: { MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
        fetchAll: async () => ({
          items: [
            {
              id: "hn-1",
              source: "hn",
              title: "t",
              url: "https://example.com/1",
              score: 1,
              publishedAt: "2026-04-18T00:00:00.000Z",
              metadata: { source: "hn" },
            },
          ],
          summary: { hn: { count: 1, status: "ok" } },
        }),
        publisher: {
          async publish() {
            publishCalls += 1;
            return { id: "should-not-fire", attempts: 0 };
          },
        },
      });
      expect(r.status).toBe("source_floor_skip");
      expect(r.reason).toBe("S-05");
      expect(publishCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------- Scenario 4 ------------------------------------------------------
// Un-06 divergence: publish returns 2xx, workflow `git push` fails OR the
// archivist dies between issue.md and .published. On the NEXT run, E-06
// backfill reads the orphan's items.json, re-renders deterministically,
// re-POSTs to Buttondown, and writes `.published` on 2xx — closing the
// duplicate-send window that previously required manual recovery.
describe("IV scenario 4 — Un-06 divergence: next run's E-06 re-publishes orphaned day", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-iv4-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Writes the disk state the archivist leaves behind on a successful
  // publish: issue.md + items.json, without .published (simulated crash or
  // push failure).
  function writeOrphanWithItems(runDate: string): void {
    const dir = path.join(root, "issues", runDate);
    mkdirSync(dir, { recursive: true });
    const items: ScoredItem[] = Array.from({ length: 6 }, (_, i) => ({
      id: `hn-${i}`,
      source: "hn" as const,
      title: `orphan title ${i}`,
      url: `https://example.com/orphan-${i}`,
      score: 10,
      publishedAt: "2026-04-17T05:00:00.000Z",
      metadata: { source: "hn" as const, points: 10 },
      category: "Tools & Launches" as const,
      relevanceScore: 0.9,
      keep: true,
      description:
        "Prior-day orphan fixture description long enough to satisfy the schema minimum length.",
    }));
    writeFileSync(path.join(dir, "issue.md"), `# ${runDate}`);
    writeFileSync(
      path.join(dir, "items.json"),
      JSON.stringify({
        runDate,
        publishId: "em_orig",
        publishedAt: `${runDate}T06:10:00.000Z`,
        itemCount: { total: items.length, kept: items.length },
        sourceSummary: { hn: { count: items.length, status: "ok" } },
        items,
      }),
    );
  }

  it("detects orphan day and reports it via findUnpublished", () => {
    writeOrphanWithItems("2026-04-17");
    const orphans = findUnpublished(root, "2026-04-18");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.runDate).toBe("2026-04-17");
  });

  it("backfill re-publishes the orphan and writes .published", async () => {
    writeOrphanWithItems("2026-04-17");
    const publishCalls: string[] = [];
    const publisher = {
      async publish(issue: { subject: string; body: string }) {
        publishCalls.push(issue.subject);
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
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toContain("2026-04-17");
    expect(existsSync(path.join(root, "issues", "2026-04-17", ".published"))).toBe(true);
  });

  it("Un-06 full sequence: day 1 push fails → day 2 orchestrator backfills day 1 AND publishes day 2", async () => {
    // Simulate the Un-06 failure mode surface: day 1 archivist wrote all
    // three files (issue.md + items.json + .published) but workflow `git
    // push` failed, so on day 2's fresh checkout only issue.md and
    // items.json came back via `git pull` — IF they were on origin. Our
    // simulated state: .published absent, items.json present (same as if
    // the push actually landed without the sentinel, or partial disk
    // state). Either way, backfill should recover.
    writeOrphanWithItems("2026-04-17");

    const publishes: string[] = [];
    const r = await runOrchestrator({
      now: fixedNow, // 2026-04-18T06:07
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        async publish(issue) {
          // Single shared publisher across backfill + today — matches prod.
          publishes.push(issue.subject);
          if (issue.subject.includes("2026-04-17")) {
            return { id: "em_recovered_17", attempts: 1 };
          }
          return { id: "em_today_18", attempts: 1 };
        },
      },
    });

    // Today's run completed normally.
    expect(r.status).toBe("published");
    expect(r.publishId).toBe("em_today_18");
    // Backfill recovered day 1 inline with today's run.
    expect(r.backfill?.attempted).toBe(1);
    expect(r.backfill?.succeeded).toBe(1);
    expect(r.backfill?.failed).toBe(0);
    expect(r.backfill?.attemptedDates).toEqual(["2026-04-17"]);
    // Both sentinels now exist on disk.
    expect(
      existsSync(path.join(root, "issues", "2026-04-17", ".published")),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "issues", "2026-04-18", ".published")),
    ).toBe(true);
    // Publisher was called for day 1 (backfill) THEN day 2 (today).
    expect(publishes).toHaveLength(2);
    expect(publishes[0]).toContain("2026-04-17");
    expect(publishes[1]).toContain("2026-04-18");
  });

  it("backfill failure (e.g. Buttondown 4xx) does NOT block today's publish", async () => {
    writeOrphanWithItems("2026-04-17");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let publishCalls = 0;
      const r = await runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
        fetchAll: fixtureFetch,
        publisher: {
          async publish(issue) {
            publishCalls++;
            if (issue.subject.includes("2026-04-17")) {
              throw new Error("Buttondown 400: validation error");
            }
            return { id: "em_today_18", attempts: 1 };
          },
        },
      });
      expect(r.status).toBe("published");
      expect(r.publishId).toBe("em_today_18");
      expect(r.backfill?.attempted).toBe(1);
      expect(r.backfill?.failed).toBe(1);
      expect(r.backfill?.succeeded).toBe(0);
      // Orphan remains orphaned — operator intervention required, logged
      // loudly via ::error:: annotation (spied above).
      expect(
        existsSync(path.join(root, "issues", "2026-04-17", ".published")),
      ).toBe(false);
      // Today's publish happened despite the backfill failure.
      expect(publishCalls).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------- Scenario 5 ------------------------------------------------------
describe("IV scenario 5 — E-06 backfill + DRY_RUN: logs, no writes, no re-publish", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-iv5-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("DRY_RUN=1 with prior orphan logs [DRY_RUN] but leaves sentinels untouched", async () => {
    const day1 = path.join(root, "issues", "2026-04-17");
    mkdirSync(day1, { recursive: true });
    writeFileSync(path.join(day1, "issue.md"), "# prior");

    const result = await runBackfill(root, "2026-04-18", { dryRun: true });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0); // dry-run neither succeeds nor fails
    expect(existsSync(path.join(day1, ".published"))).toBe(false);
  });

  it("orchestrator DRY_RUN invokes backfill but writes no .published for either day", async () => {
    const day1 = path.join(root, "issues", "2026-04-17");
    mkdirSync(day1, { recursive: true });
    writeFileSync(path.join(day1, "issue.md"), "# prior");

    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
    });
    expect(r.status).toBe("dry_run");
    expect(existsSync(path.join(day1, ".published"))).toBe(false);
    expect(
      existsSync(path.join(root, "issues", "2026-04-18", ".published")),
    ).toBe(false);
  });
});

// ---------- Scenario 6 ------------------------------------------------------
describe("IV scenario 6 — Weekly digest with 5 of 7 days present annotates missing", () => {
  it("missing days render as explicit _Note:_ in the digest body", () => {
    const availableDays = [
      { runDate: "2026-04-12", items: [] },
      { runDate: "2026-04-13", items: [] },
      { runDate: "2026-04-14", items: [] },
      { runDate: "2026-04-17", items: [] },
      { runDate: "2026-04-18", items: [] },
    ];
    const missing = ["2026-04-15", "2026-04-16"];
    const digest = buildWeeklyDigest({
      weekId: "2026-W16",
      availableDays,
      missingDays: missing,
    });
    expect(digest.body).toContain("2 days missing");
    expect(digest.body).toContain("2026-04-15");
    expect(digest.body).toContain("2026-04-16");
  });
});

// ---------- Scenario 7 ------------------------------------------------------
describe("IV scenario 7 — Un-01 + renderer allowlist: template URLs pass, fabricated fails", () => {
  const raw = (id: string, url: string): RawItem => ({
    id,
    source: "hn",
    title: `t-${id}`,
    url,
    score: 1,
    publishedAt: "2026-04-18T00:00:00.000Z",
    metadata: { source: "hn" },
  });
  const scored = (id: string, url: string, description: string): ScoredItem => ({
    ...raw(id, url),
    category: "Tools & Launches",
    relevanceScore: 0.5,
    keep: true,
    description,
  });

  it("rendered template URL (archive) passes when allowlist is applied", () => {
    const desc = `See ${NEWSLETTER_ARCHIVE_URL} for the archive and more items from today.`;
    const r = verifyLinkIntegrity(
      [scored("a", "https://example.com/a", desc)],
      [raw("a", "https://example.com/a")],
      RENDERER_TEMPLATE_URL_PATTERNS,
    );
    expect(r.ok).toBe(true);
  });

  it("fabricated URL in description fails the gate even with allowlist", () => {
    const desc =
      "Check the [secret dashboard](https://evil.example.com/leak) for details on this topic.";
    const r = verifyLinkIntegrity(
      [scored("a", "https://example.com/a", desc)],
      [raw("a", "https://example.com/a")],
      RENDERER_TEMPLATE_URL_PATTERNS,
    );
    expect(r.ok).toBe(false);
    const violation = r.violations.find(
      (v) => v.url === "https://evil.example.com/leak",
    );
    expect(violation).toBeDefined();
  });

  it("orchestrator rejects runs with fabricated URLs via status=failed/reason=Un-01", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-iv7-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        // DRY_RUN bypasses the API-key fail-fast so we exercise the Un-01
        // link-integrity gate. In prod the gate runs before the Buttondown
        // POST; DRY_RUN reaches the same gate.
        env: {
          DRY_RUN: "1",
          MIN_ITEMS_TO_PUBLISH: "1",
          MIN_SOURCES: "2",
        },
        fetchAll: fixtureFetch,
        // Curator injects fabricated URLs into descriptions
        curator: {
          async curate(items) {
            return items.map((it) => ({
              ...it,
              category: "Tools & Launches" as const,
              relevanceScore: 0.5,
              keep: true,
              description: `A helpful note — see https://evil.example.com/${it.id} for more information on this.`,
            }));
          },
        },
      });
      expect(r.status).toBe("failed");
      expect(r.reason).toBe("Un-01");
    } finally {
      errSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------- Scenario 8 ------------------------------------------------------
describe("IV scenario 8 — Secret in RawItem.metadata: gitleaks scans committed archive", () => {
  // gitleaks itself is a CI step (daily.yml) — we can't invoke it from vitest
  // without spawning the binary. What we CAN test is the precondition:
  // secret values in metadata round-trip through the archive faithfully,
  // giving gitleaks the same bytes it would scan. The workflow's scan step
  // is the runtime guard.
  it("secret-like string in metadata survives archive write for gitleaks to see", () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-iv8-"));
    try {
      // Build the AWS-like pattern at runtime so gitleaks (which scans
      // committed source) doesn't flag this test fixture itself on the
      // daily push. The pattern still matches once assembled.
      const fakeSecret = "AKIA" + "IOSFODNN7EXAMPLE";
      const scoredItem: ScoredItem = {
        id: "a",
        source: "reddit",
        title: "t",
        url: "https://example.com/a",
        score: 1,
        publishedAt: "2026-04-18T00:00:00.000Z",
        metadata: {
          source: "reddit",
          subreddit: "r/x",
          permalink: `/r/x/comments/abc/?token=${fakeSecret}`,
        },
        category: "Tools & Launches",
        relevanceScore: 0.5,
        keep: true,
        description:
          "A long-enough scored description that satisfies the ScoredItem schema.",
      };
      const rendered = renderIssue("2026-04-18", [scoredItem]);
      archiveRun({
        runDate: "2026-04-18",
        repoRoot: root,
        rendered,
        scored: [scoredItem],
        summary: { reddit: { count: 1, status: "ok", keptCount: 1 } },
        publishId: "em_iv8",
        publishedAt: "2026-04-18T06:10:00.000Z",
      });
      const itemsJson = readFileSync(
        path.join(root, "issues", "2026-04-18", "items.json"),
        "utf8",
      );
      // The bytes gitleaks will scan contain the planted pattern — if this
      // assertion ever fails, the archive serializer is silently dropping
      // metadata fields that a secret scan would catch in prod.
      expect(itemsJson).toContain(fakeSecret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("daily workflow pins gitleaks between commit and push (contract check)", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "daily.yml"),
      "utf8",
    );
    // Gitleaks action must run BEFORE `git push` in the workflow.
    const gitleaksIdx = workflow.indexOf("gitleaks-action");
    const pushIdx = workflow.indexOf("Push daily archive");
    // Assert both markers exist before comparing, so a rename of either
    // step produces a pointed failure rather than a confusing index-diff.
    expect(gitleaksIdx, "gitleaks-action step missing from daily.yml").toBeGreaterThan(0);
    expect(pushIdx, "'Push daily archive' step missing from daily.yml").toBeGreaterThan(0);
    expect(pushIdx).toBeGreaterThan(gitleaksIdx);
  });
});

// ---------- Scenario 4b (Un-06 remote pre-flight contract check) -----------
// The pre-flight step in daily.yml / weekly.yml is the Un-06 closure: a
// failed push leaves no local sentinel on the next run's fresh checkout,
// but `git ls-tree origin/{ref}` against the remote sees whatever's on
// origin. We verify the workflow is wired correctly — the TS code can't
// simulate a GHA runner, but it CAN enforce that the step exists, runs
// before the orchestrator, and sets SKIP_RUN.
describe("IV scenario 4b — Un-06 remote pre-flight wiring (daily + weekly workflows)", () => {
  it("daily.yml runs pre-flight BEFORE the orchestrator and sets SKIP_RUN when sentinel is on origin", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "daily.yml"),
      "utf8",
    );
    const preflightIdx = workflow.indexOf("Pre-flight remote sentinel check");
    const orchestratorIdx = workflow.indexOf("Run orchestrator");
    expect(preflightIdx, "Pre-flight step missing from daily.yml").toBeGreaterThan(0);
    expect(orchestratorIdx, "'Run orchestrator' step missing from daily.yml").toBeGreaterThan(0);
    // Ordering is load-bearing: we MUST NOT invoke the orchestrator before
    // the remote sentinel has been consulted.
    expect(orchestratorIdx).toBeGreaterThan(preflightIdx);
    // The step must export SKIP_RUN so index.ts can short-circuit.
    expect(workflow).toContain("SKIP_RUN=1");
    // And it must key the probe off today's runDate.
    expect(workflow).toContain("issues/${RUN_DATE}/.published");
  });

  it("weekly.yml runs pre-flight BEFORE the digest step and keys on weekly/{weekId}.published", () => {
    const workflow = readFileSync(
      path.join(process.cwd(), ".github", "workflows", "weekly.yml"),
      "utf8",
    );
    const preflightIdx = workflow.indexOf("Pre-flight remote sentinel check");
    const runIdx = workflow.indexOf("Run weekly digest");
    expect(preflightIdx, "Pre-flight step missing from weekly.yml").toBeGreaterThan(0);
    expect(runIdx, "'Run weekly digest' step missing from weekly.yml").toBeGreaterThan(0);
    expect(runIdx).toBeGreaterThan(preflightIdx);
    expect(workflow).toContain("SKIP_RUN=1");
    expect(workflow).toContain("weekly/${WEEK_ID}.published");
  });
});

// ---------- Scenario 9 ------------------------------------------------------
describe("IV scenario 9 — runDate 23:58 UTC boundary: no archive/freshness off-by-one", () => {
  it("runDate derivation at 23:58 UTC stays on the same calendar day", () => {
    expect(deriveRunDate(new Date("2026-04-18T23:58:00.000Z"))).toBe(
      "2026-04-18",
    );
  });

  it("freshness cutoff anchored to runDate (not 'now') is stable at the boundary", () => {
    const runDate = "2026-04-18";
    // Item published at 00:05 UTC on 2026-04-17 — 24h window = midnight 04-17
    // to midnight 04-18. Item should be FRESH.
    expect(freshnessVerdict("2026-04-17T00:05:00.000Z", runDate)).toBe("fresh");
    // Item published at 23:55 UTC on 2026-04-16 — just before the cutoff
    // at midnight 04-17. Should be STALE.
    expect(freshnessVerdict("2026-04-16T23:55:00.000Z", runDate)).toBe("stale");
  });

  it("archive path for 23:58 UTC run is issues/2026-04-18/ (not 2026-04-19)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-iv9-"));
    try {
      const r = await runOrchestrator({
        now: new Date("2026-04-18T23:58:00.000Z"),
        repoRoot: root,
        env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
        fetchAll: fixtureFetch,
        publisher: {
          async publish() {
            return { id: "em_iv9", attempts: 1 };
          },
        },
      });
      expect(r.runDate).toBe("2026-04-18");
      expect(r.status).toBe("published");
      expect(
        existsSync(path.join(root, "issues", "2026-04-18", ".published")),
      ).toBe(true);
      expect(existsSync(path.join(root, "issues", "2026-04-19"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------- Scenario 10 -----------------------------------------------------
// Concurrency edge: two runs fire the same runDate. First succeeds and writes
// `.published`. Second reads sentinel via S-03 and exits without publishing.
// We simulate by running the orchestrator twice sequentially on the same
// repoRoot — the filesystem sentinel is the coordination point, so the order
// matters but not the concurrency primitive itself.
describe("IV scenario 10 — Concurrency race: second run S-03 skips after first's archive", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-iv10-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("second run sees first's .published and returns idempotent_skip", async () => {
    let firstPublishCalls = 0;
    let secondPublishCalls = 0;

    const first = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        async publish() {
          firstPublishCalls += 1;
          return { id: "em_first", attempts: 1 };
        },
      },
    });
    expect(first.status).toBe("published");
    expect(firstPublishCalls).toBe(1);

    // Second run — same runDate, same repoRoot. Must S-03 skip.
    const second = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      publisher: {
        async publish() {
          secondPublishCalls += 1;
          return { id: "em_second_SHOULD_NOT_FIRE", attempts: 1 };
        },
      },
    });
    expect(second.status).toBe("idempotent_skip");
    expect(second.reason).toBe("sentinel_present");
    expect(secondPublishCalls).toBe(0);

    // Sentinel content must still be from the first run (no overwrite).
    const sentinel = readFileSync(
      sentinelPath(root, "2026-04-18"),
      "utf8",
    ).trim();
    expect(sentinel).toBe("em_first");
  });

  // Note: a true concurrent-race test would require injecting a pause
  // between the first run's publish and sentinel-write so the second run's
  // S-03 check could be ordered *into* that window. The orchestrator API
  // does not expose such a hook, and a sleep-based approximation would be
  // flaky. The sequential test above exercises the only invariant that
  // matters for IV scenario 10: once a sentinel exists for runDate, the
  // next run with the same runDate returns idempotent_skip. GHA's
  // `concurrency: daily-publish` group serializes runs in production.
});
