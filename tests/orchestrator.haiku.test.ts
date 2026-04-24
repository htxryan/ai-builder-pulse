// Integration coverage for the Haiku pre-filter stage wired into the
// orchestrator (ai-builder-pulse-3jf). Exercises:
//   - stage ordering: Haiku runs after S-05 source floor and before curator
//   - HAIKU_PREFILTER_DISABLED=1 bypasses the stage; curator sees full set
//   - successful run writes `issues/{runDate}/.haiku-stats.json`
//   - skipped/disabled run does NOT write the stats file
//   - cost ceiling is independent — Haiku cost not counted against CURATOR_MAX_USD
//
// These tests rely on `OrchestratorOptions.haikuClient` being injectable;
// production callers either inject one or the orchestrator constructs an
// `AnthropicHaikuClient` from env (skipped when DISABLED or no API key).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../src/orchestrator.js";
import type {
  HaikuClient,
  HaikuCallArgs,
  HaikuCallResult,
  HaikuRecord,
} from "../src/haiku/index.js";
import type { RawItem, SourceSummary } from "../src/types.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-orch-haiku-"));
}

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

function fixtureFetch(): Promise<{ items: RawItem[]; summary: SourceSummary }> {
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
  return Promise.resolve({ items, summary });
}

interface CapturedHaikuCall {
  readonly args: HaikuCallArgs;
}

/**
 * Build a Haiku client that drops half the items by id-suffix parity. Records
 * each call so tests can assert on chunk inputs (post-S-05, pre-curator).
 */
function buildHalvingHaikuClient(
  captured: CapturedHaikuCall[] = [],
): HaikuClient {
  return {
    model: "claude-haiku-4-5-test",
    async call(args: HaikuCallArgs): Promise<HaikuCallResult> {
      captured.push({ args });
      const records: HaikuRecord[] = args.rawItems.map((r, i) => ({
        id: r.id,
        keep: i % 2 === 0,
      }));
      return {
        records,
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };
}

describe("runOrchestrator + Haiku pre-filter wiring (ai-builder-pulse-3jf)", () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("Haiku stage runs between S-05 and curator (curator sees Haiku-filtered subset)", async () => {
    const haikuCalls: CapturedHaikuCall[] = [];
    const haikuClient = buildHalvingHaikuClient(haikuCalls);
    const curatorInputs: RawItem[][] = [];
    const curator = {
      async curate(items: RawItem[]) {
        curatorInputs.push(items.slice());
        return [];
      },
      lastMetrics: () => undefined,
    };

    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_SOURCES: "2", MIN_ITEMS_TO_PUBLISH: "1" },
      fetchAll: fixtureFetch,
      haikuClient,
      curator,
    });

    // Haiku was called at least once with all 10 items in some chunk.
    expect(haikuCalls.length).toBeGreaterThan(0);
    const totalHaikuInputs = haikuCalls.reduce(
      (acc, c) => acc + c.args.rawItems.length,
      0,
    );
    expect(totalHaikuInputs).toBe(10);
    // Curator received only the Haiku-kept subset (5 items, every other one).
    expect(curatorInputs.length).toBe(1);
    expect(curatorInputs[0]?.length).toBe(5);
    // The orchestrator records the haiku stage ran before curate.
    expect(r.timings.haikuPreFilter).toBeDefined();
    expect(r.haikuStats).toBeDefined();
    expect(r.haikuStats?.inputCount).toBe(10);
    expect(r.haikuStats?.keptCount).toBe(5);
    expect(r.haikuStats?.droppedCount).toBe(5);
  });

  it("HAIKU_PREFILTER_DISABLED=1 bypasses Haiku — curator sees full pre-filter output", async () => {
    let haikuCalls = 0;
    const haikuClient: HaikuClient = {
      async call() {
        haikuCalls += 1;
        return { records: [], inputTokens: 0, outputTokens: 0 };
      },
    };
    const curatorInputs: RawItem[][] = [];
    const curator = {
      async curate(items: RawItem[]) {
        curatorInputs.push(items.slice());
        return [];
      },
      lastMetrics: () => undefined,
    };

    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        DRY_RUN: "1",
        MIN_SOURCES: "2",
        MIN_ITEMS_TO_PUBLISH: "1",
        HAIKU_PREFILTER_DISABLED: "1",
      },
      fetchAll: fixtureFetch,
      haikuClient,
      curator,
    });

    expect(haikuCalls).toBe(0);
    expect(curatorInputs.length).toBe(1);
    expect(curatorInputs[0]?.length).toBe(10);
    expect(r.haikuStats?.inputCount).toBe(10);
    expect(r.haikuStats?.keptCount).toBe(10);
    // Status irrelevant; we just need the bypass observable.
    expect(r.timings.haikuPreFilter).toBeDefined();
  });

  it("successful run writes .haiku-stats.json with expected fields (AC-20 / OQ2)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch,
      haikuClient: buildHalvingHaikuClient(),
      publisher: {
        publish: async () => ({ id: "em_haiku_test", attempts: 1 }),
      },
    });
    expect(r.status).toBe("published");
    const statsPath = path.join(
      root,
      "issues",
      "2026-04-18",
      ".haiku-stats.json",
    );
    expect(existsSync(statsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(statsPath, "utf8"));
    expect(parsed.inputCount).toBe(10);
    expect(parsed.keptCount).toBe(5);
    expect(parsed.droppedCount).toBe(5);
    expect(typeof parsed.chunkCount).toBe("number");
    expect(typeof parsed.estimatedUsd).toBe("number");
  });

  it(".haiku-stats.json is NOT written when stage is skipped (HAIKU_PREFILTER_DISABLED)", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
        HAIKU_PREFILTER_DISABLED: "1",
      },
      fetchAll: fixtureFetch,
      publisher: {
        publish: async () => ({ id: "em_haiku_disabled", attempts: 1 }),
      },
    });
    expect(r.status).toBe("published");
    const statsPath = path.join(
      root,
      "issues",
      "2026-04-18",
      ".haiku-stats.json",
    );
    expect(existsSync(statsPath)).toBe(false);
    expect(r.haikuStats?.inputCount).toBe(10);
    // Haiku stage was bypassed — but file must NOT be written.
  });

  it("AC-17 / R18: Haiku $0.05 + Sonnet $9.95 + CURATOR_MAX_USD=10 does NOT trip CostCeilingError", async () => {
    // Haiku cost is independent of the Sonnet cost ceiling. Build a Haiku
    // client that reports tokens producing ~$0.05 and a curator that reports
    // ~$9.95 — the run must succeed (not status=failed/cost_ceiling).
    const haikuClient: HaikuClient = {
      async call(args) {
        // 10M input + 10M output tokens at $0.80 + $4.00 per MTok → $48
        // would blow the budget if it were combined. We pass small numbers
        // here; the assertion is simply that the curator's lastMetrics is
        // independent and no CostCeilingError is raised.
        return {
          records: args.rawItems.map((r) => ({ id: r.id, keep: true })),
          inputTokens: 50_000,
          outputTokens: 5_000,
        };
      },
    };
    const curator = {
      async curate(items: RawItem[]) {
        return items.map((it) => ({
          id: it.id,
          source: it.source,
          title: it.title,
          url: it.url,
          score: it.score,
          publishedAt: it.publishedAt,
          metadata: it.metadata,
          category: "Tools & Launches" as const,
          relevanceScore: 0.7,
          keep: true,
          description:
            "A well-formed curation description long enough for zod min length.",
        }));
      },
      lastMetrics: () => ({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        estimatedUsd: 9.95,
      }),
    };

    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        DRY_RUN: "1",
        MIN_SOURCES: "2",
        MIN_ITEMS_TO_PUBLISH: "1",
        CURATOR_MAX_USD: "10",
      },
      fetchAll: fixtureFetch,
      haikuClient,
      curator,
    });

    expect(r.status).toBe("dry_run");
    expect(r.reason).not.toBe("cost_ceiling");
    // Sonnet cost stands alone in curatorMetrics; Haiku cost is in haikuStats.
    expect(r.curatorMetrics?.estimatedUsd).toBe(9.95);
    expect(r.haikuStats?.estimatedUsd).toBeGreaterThan(0);
  });
});
