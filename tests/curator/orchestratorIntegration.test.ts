import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOrchestrator } from "../../src/orchestrator.js";
import { ClaudeCurator } from "../../src/curator/claudeCurator.js";
import { CATEGORIES } from "../../src/types.js";
import type { RawItem, SourceSummary } from "../../src/types.js";
import type {
  CurationClient,
  CurationRecord,
} from "../../src/curator/claudeCurator.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "abp-e4-"));
}

const fixedNow = new Date("2026-04-18T06:07:00.000Z");

function fixtureFetch() {
  return async () => {
    const items: RawItem[] = Array.from({ length: 10 }, (_, i) => {
      const gh = i >= 5;
      return gh
        ? {
            id: `gh-${i}`,
            source: "github-trending" as const,
            title: `t ${i}`,
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
            title: `t ${i}`,
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
}

function mkRecord(id: string, over: Partial<CurationRecord> = {}): CurationRecord {
  return {
    id,
    category: CATEGORIES[0],
    relevanceScore: 0.8,
    keep: true,
    description:
      "A sufficiently long, plain-text description for the curated item to satisfy schema minimums.",
    ...over,
  };
}

describe("Orchestrator + ClaudeCurator (E4)", () => {
  let root: string;
  beforeEach(() => {
    root = tempRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("runs DRY_RUN end-to-end with ClaudeCurator using a mock client", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        return {
          records: rawItems.map((r) => mkRecord(r.id)),
          inputTokens: 1000,
          outputTokens: 500,
        };
      },
    };
    const curator = new ClaudeCurator({ client, chunkThreshold: 50 });
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch(),
      curator,
    });
    expect(r.status).toBe("dry_run");
    expect(r.scored?.length).toBe(10);
  });

  it("fails the run on Un-01 link-integrity violation", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        // First record rewrites its url to a fabricated domain.
        const records: CurationRecord[] = rawItems.map((r, idx) =>
          idx === 0
            ? mkRecord(r.id, {
                description:
                  "Item summary referencing https://evil.example.com/fabricated — no not a real link you'd want.",
              })
            : mkRecord(r.id),
        );
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const curator = new ClaudeCurator({ client });
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch(),
      curator,
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("Un-01");
  });

  it("fails the run when Curator throws CountInvariantError (E-05)", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        // Drop one item — Curator should detect via per-chunk id check.
        return {
          records: rawItems.slice(0, -1).map((r) => mkRecord(r.id)),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const curator = new ClaudeCurator({ client, maxRetries: 1 });
    const r = await runOrchestrator({
      now: fixedNow,
      repoRoot: root,
      env: { DRY_RUN: "1", MIN_ITEMS_TO_PUBLISH: "1", MIN_SOURCES: "2" },
      fetchAll: fixtureFetch(),
      curator,
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("curator_failed");
  });
});
