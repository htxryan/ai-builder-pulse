// M1 surface test — runDeepAgentCurator is scaffolded but not wired to
// LangGraph yet. It must throw NotYetImplementedError with an actionable
// message so a misconfigured env fails loudly (not silently with empty
// output).

import { describe, it, expect } from "vitest";
import {
  DeepAgentCurator,
  NotYetImplementedError,
  runDeepAgentCurator,
} from "../../../src/curator/deepagent/index.js";
import type { RawItem } from "../../../src/types.js";

function rawItem(id: string): RawItem {
  return {
    id,
    source: "hn",
    title: `t-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 10 },
  };
}

describe("runDeepAgentCurator (M1 stub)", () => {
  it("throws NotYetImplementedError with a pointer to the decomposition doc", async () => {
    await expect(
      runDeepAgentCurator([rawItem("a")], {
        runId: "rid",
        runDate: "2026-04-19",
      }),
    ).rejects.toBeInstanceOf(NotYetImplementedError);

    try {
      await runDeepAgentCurator([], { runId: "rid", runDate: "2026-04-19" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("deepagents-migration");
      expect((err as Error).message).toContain("CURATOR_BACKEND=legacy");
    }
  });

  it("DeepAgentCurator wraps the function and throws identically", async () => {
    const c = new DeepAgentCurator({ runId: "rid", runDate: "2026-04-19" });
    await expect(c.curate([rawItem("a")])).rejects.toBeInstanceOf(
      NotYetImplementedError,
    );
    expect(c.lastMetrics()).toBeUndefined();
    expect(c.lastSkipped()).toEqual([]);
  });
});
