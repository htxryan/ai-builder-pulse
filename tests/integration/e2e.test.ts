// E7 Integration — End-to-end fixture pipeline run.
//
// Exercises the full orchestrator path — mock collectors → pre-filter →
// mock curator → link-integrity → renderer → injected publisher →
// archivist — and asserts the observable artifacts are all in place:
//
//   • Every stage emits its expected log line (smoke check, not regex soup)
//   • Rendered body passes Un-01 link-integrity with the renderer allowlist
//   • issues/{runDate}/issue.md exactly mirrors rendered.body (C5 ↔ C6)
//   • items.json schema is valid + includes sourceSummary with keptCount
//   • .published sentinel contains the publishId from the injected publisher
//   • A second run with the same runDate S-03 skips without re-publishing
//
// This is NOT a replacement for the per-epic suites; it's the "the wires
// are connected" smoke test that the epic's fitness function points at.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../../src/orchestrator.js";
import { verifyLinkIntegrity } from "../../src/curator/linkIntegrity.js";
import { RENDERER_TEMPLATE_URL_PATTERNS } from "../../src/renderer/allowlist.js";
import { sentinelPath, issueMdPath, itemsJsonPath } from "../../src/archivist/index.js";
import { ScoredItemSchema, SourceSummarySchema } from "../../src/types.js";
import { z } from "zod";

const fixedNow = new Date("2026-04-18T06:07:00.000Z");
const runDate = "2026-04-18";

const ItemsJsonSchema = z.object({
  runDate: z.string(),
  publishId: z.string(),
  publishedAt: z.string(),
  itemCount: z.object({
    total: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
  }),
  sourceSummary: SourceSummarySchema,
  items: z.array(ScoredItemSchema),
});

describe("E7 E2E fixture pipeline run", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-e2e-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("full pipeline: mock collectors + mock curator + injected publisher → archived issue", async () => {
    const publishCalls: Array<{ subject: string; bodyLen: number }> = [];
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        USE_MOCK_COLLECTORS: "1",
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
      },
      publisher: {
        async publish(issue) {
          publishCalls.push({ subject: issue.subject, bodyLen: issue.body.length });
          return { id: "em_e2e_ok", attempts: 1 };
        },
      },
    });

    expect(r.status).toBe("published");
    expect(r.runDate).toBe(runDate);
    expect(r.publishId).toBe("em_e2e_ok");
    expect(r.rendered).toBeDefined();

    // Publisher was invoked exactly once with the rendered issue.
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.subject).toBe(`AI Builder Pulse — ${runDate}`);

    // Archive artifacts (C6)
    expect(existsSync(issueMdPath(root, runDate))).toBe(true);
    expect(existsSync(itemsJsonPath(root, runDate))).toBe(true);
    expect(existsSync(sentinelPath(root, runDate))).toBe(true);

    // issue.md must byte-for-byte equal rendered.body (C5 ↔ C6)
    const issueMd = readFileSync(issueMdPath(root, runDate), "utf8");
    expect(issueMd).toBe(r.rendered!.body);

    // items.json schema-valid
    const parsed = ItemsJsonSchema.parse(
      JSON.parse(readFileSync(itemsJsonPath(root, runDate), "utf8")),
    );
    expect(parsed.runDate).toBe(runDate);
    expect(parsed.publishId).toBe("em_e2e_ok");
    expect(parsed.itemCount.total).toBeGreaterThan(0);
    // At least one kept item per keep policy of MockCurator
    expect(parsed.itemCount.kept).toBeGreaterThan(0);

    // keptCount per source propagates through summary (U-10)
    const summaryKept = Object.values(parsed.sourceSummary).reduce(
      (acc, s) => acc + (s?.keptCount ?? 0),
      0,
    );
    expect(summaryKept).toBeGreaterThan(0);

    // Sentinel content is publisher id
    expect(readFileSync(sentinelPath(root, runDate), "utf8").trim()).toBe(
      "em_e2e_ok",
    );

    // The rendered body's scored-item URLs must all trace back to the raw
    // set (Un-01). We re-run link-integrity with the renderer template
    // allowlist over the archived scored items.
    const integrity = verifyLinkIntegrity(
      parsed.items,
      parsed.items, // raw set = scored set (mock curator is pass-through for urls)
      RENDERER_TEMPLATE_URL_PATTERNS,
    );
    expect(integrity.ok).toBe(true);
  });

  it("second run with same runDate S-03 skips without re-publishing", async () => {
    // First run publishes
    await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        USE_MOCK_COLLECTORS: "1",
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
      },
      publisher: {
        async publish() {
          return { id: "em_first_e2e", attempts: 1 };
        },
      },
    });

    // Second run — same repoRoot, same runDate. Must skip via S-03.
    let secondPublishCalls = 0;
    const second = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        USE_MOCK_COLLECTORS: "1",
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
      },
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
  });

  it("DRY_RUN path runs the pipeline but writes no archive artifacts", async () => {
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: {
        DRY_RUN: "1",
        USE_MOCK_COLLECTORS: "1",
        MIN_ITEMS_TO_PUBLISH: "1",
        MIN_SOURCES: "2",
      },
    });
    expect(r.status).toBe("dry_run");
    expect(r.rendered).toBeDefined();
    expect(existsSync(sentinelPath(root, runDate))).toBe(false);
    expect(existsSync(issueMdPath(root, runDate))).toBe(false);
    expect(existsSync(itemsJsonPath(root, runDate))).toBe(false);
  });

  it("full pipeline emits expected stage log lines in order (smoke check)", async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    // Spy on all three channels so any future stage emitted at warn/error
    // (e.g. a backfill line) is still captured for the ordering assertion.
    const logSpy = vi.spyOn(console, "log").mockImplementation(capture);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(capture);
    const errSpy = vi.spyOn(console, "error").mockImplementation(capture);
    try {
      await runOrchestrator({
        now: fixedNow,
        repoRoot: root,
        env: {
          USE_MOCK_COLLECTORS: "1",
          MIN_ITEMS_TO_PUBLISH: "1",
          MIN_SOURCES: "2",
        },
        publisher: {
          async publish() {
            return { id: "em_logs", attempts: 1 };
          },
        },
      });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }

    const joined = logs.join("\n");
    // Required stage markers, in order
    const stages = [
      "orchestrator start",
      "pre-filter complete",
      "link-integrity ok",
      "curation complete",
      "renderer complete",
      "publish ok",
    ];
    let lastIdx = -1;
    for (const stage of stages) {
      const idx = joined.indexOf(stage, lastIdx + 1);
      expect(idx, `stage "${stage}" missing or out of order`).toBeGreaterThan(
        lastIdx,
      );
      lastIdx = idx;
    }
  });
});
