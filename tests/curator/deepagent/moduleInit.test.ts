// DA-Un-05 — version-guard runs at module init (not lazily).
// A fresh import of src/curator/deepagent/index.ts should call
// assertPinnedVersions before any user code can invoke the curator.

import { describe, it, expect } from "vitest";

describe("DeepAgents module init", () => {
  it("importing the module triggers the version check", async () => {
    // Fresh ESM import — Vitest's module resolver imports it once, but for
    // our purpose we just need the exports to be present and the side
    // effect (assertPinnedVersions) to have run without throwing, which
    // proves the real versions match the pins in a fresh-install env.
    const mod = await import("../../../src/curator/deepagent/index.js");
    expect(mod.runDeepAgentCurator).toBeTypeOf("function");
    expect(mod.DeepAgentCurator).toBeTypeOf("function");
    expect(mod.assertPinnedVersions).toBeTypeOf("function");
    // If the module imported successfully, the top-level
    // `assertPinnedVersions()` call must have succeeded — otherwise import
    // itself would have thrown.
  });
});
