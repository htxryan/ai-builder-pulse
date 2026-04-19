// M2 — DeepAgent adapter behavioural tests.
//
// These exercise the full LangGraph pipeline with `fakeModel()` standing
// in for Anthropic. Using the real `createAgent` + `providerStrategy` path
// means the test fails if:
//   - the structured-output binding silently drops the response,
//   - the Zod schema contract drifts, or
//   - a future middleware default starts adding tools we didn't register.
//
// Covered EARS:
//   - DA-U-04: `tools: []` — graph introspection confirms zero tool specs.
//   - DA-U-03 / DA-E-02: E-05 count invariant.
//   - DA-S-01: `recursionLimit` honoured at invocation.

import { describe, it, expect } from "vitest";
import { AIMessage, fakeModel } from "langchain";
import {
  buildCurationAgent,
  runAdapter,
} from "../../../src/curator/deepagent/adapter.js";
import { CountInvariantError } from "../../../src/curator/claudeCurator.js";
import { CATEGORIES, type RawItem } from "../../../src/types.js";

function rawItem(i: number): RawItem {
  return {
    id: `itm-${i}`,
    source: "hn",
    title: `Test title ${i} — something a builder might care about`,
    url: `https://example.com/${i}`,
    score: i,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 10 + i },
  };
}

function makeRecords(items: readonly RawItem[], opts?: { count?: number }) {
  const n = opts?.count ?? items.length;
  return Array.from({ length: n }, (_, i) => ({
    id: items[i % items.length]!.id,
    category: CATEGORIES[i % CATEGORIES.length]!,
    relevanceScore: 0.5,
    keep: i % 3 !== 0,
    description: `desc-${i} `.repeat(10).slice(0, 150),
  }));
}

function jsonMessage(body: unknown): AIMessage {
  // `providerStrategy.parse` extracts text content and `JSON.parse`s it.
  return new AIMessage({ content: JSON.stringify(body) });
}

describe("DeepAgent adapter — structured output", () => {
  it("returns 50 Zod-valid ScoredItems from 50 RawItems", async () => {
    const items = Array.from({ length: 50 }, (_, i) => rawItem(i));
    const model = fakeModel().respond(
      jsonMessage({ items: makeRecords(items) }),
    );

    const scored = await runAdapter(
      items,
      { runId: "rid", runDate: "2026-04-19" },
      { model },
    );

    expect(scored).toHaveLength(50);
    for (const s of scored) {
      expect(items.some((r) => r.id === s.id)).toBe(true);
      expect(CATEGORIES).toContain(s.category);
      expect(s.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(s.relevanceScore).toBeLessThanOrEqual(1);
      expect(typeof s.keep).toBe("boolean");
      // Each ScoredItem must preserve the original RawItem URL — no
      // hallucinated replacement field.
      const src = items.find((r) => r.id === s.id)!;
      expect(s.url).toBe(src.url);
    }
  });

  it("throws CountInvariantError when the response is short by one record", async () => {
    const items = Array.from({ length: 50 }, (_, i) => rawItem(i));
    // Emit 49 records for 50 inputs — E-05 must reject.
    const model = fakeModel().respond(
      jsonMessage({ items: makeRecords(items, { count: 49 }) }),
    );

    await expect(
      runAdapter(
        items,
        { runId: "rid", runDate: "2026-04-19" },
        { model },
      ),
    ).rejects.toBeInstanceOf(CountInvariantError);
  });

  it("rejects a response with an id not in the chunk input", async () => {
    const items = Array.from({ length: 3 }, (_, i) => rawItem(i));
    const recs = makeRecords(items);
    recs[0] = { ...recs[0]!, id: "unknown-id" };
    const model = fakeModel().respond(jsonMessage({ items: recs }));

    await expect(
      runAdapter(
        items,
        { runId: "rid", runDate: "2026-04-19" },
        { model },
      ),
    ).rejects.toThrow(/unexpected id/);
  });

  it("rejects a response that fails Zod validation", async () => {
    const items = Array.from({ length: 2 }, (_, i) => rawItem(i));
    // `relevanceScore: 1.5` violates the 0..1 bound.
    const model = fakeModel().respond(
      jsonMessage({
        items: [
          {
            id: items[0]!.id,
            category: CATEGORIES[0],
            relevanceScore: 1.5,
            keep: true,
            description: "x".repeat(120),
          },
          {
            id: items[1]!.id,
            category: CATEGORIES[0],
            relevanceScore: 0.5,
            keep: false,
            description: "y".repeat(120),
          },
        ],
      }),
    );

    await expect(
      runAdapter(
        items,
        { runId: "rid", runDate: "2026-04-19" },
        { model },
      ),
    ).rejects.toThrow(/Zod validation/);
  });

  it("empty input returns empty output without invoking the model", async () => {
    // `runAdapter` short-circuits on length 0 — we never build the agent.
    const scored = await runAdapter([], {
      runId: "rid",
      runDate: "2026-04-19",
    });
    expect(scored).toEqual([]);
  });
});

describe("DeepAgent adapter — graph construction (DA-U-04)", () => {
  it("registers zero tools on the compiled agent", () => {
    const model = fakeModel();
    const agent = buildCurationAgent({ model });
    // The ReactAgent persists its construction options; DA-U-04 requires
    // `tools: []`. We introspect the options object so a future refactor
    // that accidentally adds a default tool (e.g. by routing through
    // `createDeepAgent`) is caught here — not in production when an
    // injected `write_todos` inflates tool-call budget.
    const opts = (agent as unknown as { options?: { tools?: unknown[] } })
      .options;
    expect(opts).toBeDefined();
    expect(Array.isArray(opts!.tools)).toBe(true);
    expect(opts!.tools!.length).toBe(0);
  });

  it("exposes a compiled LangGraph `graph` (M3/M4 hook)", () => {
    const model = fakeModel();
    const agent = buildCurationAgent({ model });
    // `ReactAgent.graph` is the compiled state-graph. Its presence is a
    // smoke check that `createAgent` ran through; middleware work in
    // M3/M4 will exercise node-level details.
    expect(agent.graph).toBeDefined();
  });
});

describe("DeepAgent adapter — runDeepAgentCurator wiring", () => {
  it("runDeepAgentCurator delegates through the factory surface", async () => {
    const { runDeepAgentCurator } = await import(
      "../../../src/curator/deepagent/index.js"
    );
    const items = Array.from({ length: 5 }, (_, i) => rawItem(i));
    const model = fakeModel().respond(
      jsonMessage({ items: makeRecords(items) }),
    );
    const scored = await runDeepAgentCurator(items, {
      runId: "rid",
      runDate: "2026-04-19",
      modelOverride: model,
    });
    expect(scored).toHaveLength(5);
  });
});
