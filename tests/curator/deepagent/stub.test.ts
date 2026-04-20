// M2 surface test — `runDeepAgentCurator` is now wired to the LangGraph
// adapter. The NotYetImplementedError class is retained for backwards
// compat (M1 callers matched against it) but the happy path no longer
// throws. Behavioural coverage lives in `adapter.test.ts`; this file
// checks only the public-surface exports.

import { describe, it, expect } from "vitest";
import {
  DeepAgentCurator,
  NotYetImplementedError,
  runDeepAgentCurator,
} from "../../../src/curator/deepagent/index.js";

describe("runDeepAgentCurator (public surface)", () => {
  it("NotYetImplementedError remains exported for M1 compatibility", () => {
    // Retained across M1→M2 so any external match on the symbol still
    // type-checks. Sunset schedule tracks with the legacy path (M5).
    const err = new NotYetImplementedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotYetImplementedError");
  });

  it("runDeepAgentCurator returns an empty array for empty input (no model call)", async () => {
    // Empty input short-circuits before model construction — no API key
    // or network required. This is the cheapest smoke that the wiring
    // exists without spinning up a fake model.
    const out = await runDeepAgentCurator([], {
      runId: "rid",
      runDate: "2026-04-19",
    });
    expect(out).toEqual([]);
  });

  it("DeepAgentCurator satisfies the Curator interface shape", () => {
    const c = new DeepAgentCurator({ runId: "rid", runDate: "2026-04-19" });
    expect(typeof c.curate).toBe("function");
    expect(c.lastMetrics()).toBeUndefined();
    expect(c.lastSkipped()).toEqual([]);
  });
});
