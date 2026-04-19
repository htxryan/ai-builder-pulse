// Factory routing (DC1 unchanged outward signature, DC8 rollback toggle).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { selectCurator } from "../../../src/curator/index.js";

// AnthropicCurationClient reads process.env.ANTHROPIC_API_KEY at construction.
// Set/unset a stub for the tests that exercise the legacy path.
let originalKey: string | undefined;
beforeEach(() => {
  originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-fixture";
});
afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalKey;
  }
});

describe("selectCurator", () => {
  it("routes to MockCurator by default", async () => {
    const c = await selectCurator(
      {},
      { runId: "r", runDate: "2026-04-19" },
    );
    expect(c.constructor.name).toBe("MockCurator");
  });

  it.each(["", "mock", "MOCK", "Mock", "anything-not-claude"])(
    "routes %j to MockCurator",
    async (val) => {
      const c = await selectCurator(
        { CURATOR: val },
        { runId: "r", runDate: "2026-04-19" },
      );
      expect(c.constructor.name).toBe("MockCurator");
    },
  );

  it("routes CURATOR=claude + CURATOR_BACKEND=legacy to ClaudeCurator (preserved)", async () => {
    const c = await selectCurator(
      {
        CURATOR: "claude",
        CURATOR_BACKEND: "legacy",
        ANTHROPIC_API_KEY: "sk-test",
      },
      { runId: "r", runDate: "2026-04-19" },
    );
    expect(c.constructor.name).toBe("ClaudeCurator");
  });

  it("routes CURATOR=claude (no backend flag) to DeepAgentCurator", async () => {
    const c = await selectCurator(
      { CURATOR: "claude", ANTHROPIC_API_KEY: "sk-test" },
      { runId: "r", runDate: "2026-04-19" },
    );
    expect(c.constructor.name).toBe("DeepAgentCurator");
  });

  it("routes CURATOR=Claude (case-insensitive) to DeepAgentCurator", async () => {
    const c = await selectCurator(
      { CURATOR: "Claude", ANTHROPIC_API_KEY: "sk-test" },
      { runId: "r", runDate: "2026-04-19" },
    );
    expect(c.constructor.name).toBe("DeepAgentCurator");
  });

  it("CURATOR_BACKEND=legacy without CURATOR=claude is ignored (still Mock)", async () => {
    const c = await selectCurator(
      { CURATOR_BACKEND: "legacy" },
      { runId: "r", runDate: "2026-04-19" },
    );
    expect(c.constructor.name).toBe("MockCurator");
  });

  it("rejects malformed CURATOR_CHUNK_THRESHOLD for legacy path", async () => {
    await expect(
      selectCurator(
        {
          CURATOR: "claude",
          CURATOR_BACKEND: "legacy",
          CURATOR_CHUNK_THRESHOLD: "NaN",
          ANTHROPIC_API_KEY: "sk-test",
        },
        { runId: "r", runDate: "2026-04-19" },
      ),
    ).rejects.toThrow(/CURATOR_CHUNK_THRESHOLD/);
  });

  it("rejects malformed DEEPAGENT_TOOL_BUDGET for DeepAgents path", async () => {
    // DEEPAGENT_* env parsing runs inside the factory *before* any
    // @langchain module is imported, so we can observe the throw without
    // a real API key.
    await expect(
      selectCurator(
        { CURATOR: "claude", DEEPAGENT_TOOL_BUDGET: "-1" },
        { runId: "r", runDate: "2026-04-19" },
      ),
    ).rejects.toThrow(/DEEPAGENT_TOOL_BUDGET/);
  });
});
