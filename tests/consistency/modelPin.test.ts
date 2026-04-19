import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_PIN } from "../../src/curator/prompt.js";

// DA-U-07 — `MODEL_PIN` in `src/curator/prompt.ts` is the single source of
// truth for the curator model id. Consumed by both the direct-SDK path
// (`anthropicClient.ts`) and the LangChain binding (`deepagent/adapter.ts`).
// This test blocks a regression where one consumer hard-codes a literal that
// drifts from the pin — the operator must update the pin in one place.
describe("model pin consistency (prompt.ts ↔ CLAUDE.md ↔ consumers)", () => {
  const root = path.resolve(__dirname, "../..");

  it("MODEL_PIN is a recognisable claude-* model id", () => {
    expect(MODEL_PIN).toMatch(/^claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+$/);
  });

  it("MODEL_PIN matches a model named in CLAUDE.md", () => {
    const claudeMd = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const modelsInMd = new Set(
      claudeMd.match(/claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+/g) ?? [],
    );
    expect(
      modelsInMd.size,
      "expected CLAUDE.md to mention at least one claude-* model id",
    ).toBeGreaterThan(0);
    expect(
      modelsInMd.has(MODEL_PIN),
      `MODEL_PIN "${MODEL_PIN}" does not match any model named in CLAUDE.md (${[...modelsInMd].join(", ")})`,
    ).toBe(true);
  });

  it("anthropicClient.ts sources DEFAULT_MODEL from MODEL_PIN", () => {
    const client = readFileSync(
      path.join(root, "src/curator/anthropicClient.ts"),
      "utf8",
    );
    // Reject a raw "claude-..." literal in the default-model line — drift
    // risk vs. the shared constant. The operator must use `MODEL_PIN`.
    expect(
      client,
      "anthropicClient.ts must import MODEL_PIN from ./prompt.js",
    ).toMatch(/import\s*\{[^}]*\bMODEL_PIN\b[^}]*\}\s*from\s*"\.\/prompt\.js"/);
    expect(
      client,
      "DEFAULT_MODEL must reference MODEL_PIN (not a literal)",
    ).toMatch(/const\s+DEFAULT_MODEL\s*=\s*MODEL_PIN\s*;/);
  });

  it("deepagent/adapter.ts sources its model id from MODEL_PIN", () => {
    const adapter = readFileSync(
      path.join(root, "src/curator/deepagent/adapter.ts"),
      "utf8",
    );
    expect(
      adapter,
      "adapter.ts must import MODEL_PIN from ../prompt.js",
    ).toMatch(
      /import\s*\{[^}]*\bMODEL_PIN\b[^}]*\}\s*from\s*"\.\.\/prompt\.js"/,
    );
    // Guard against an inline "claude-..." literal slipping in.
    expect(
      adapter.match(/"claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+"/),
      "adapter.ts should not inline a claude-* literal; import MODEL_PIN instead",
    ).toBeNull();
  });
});
