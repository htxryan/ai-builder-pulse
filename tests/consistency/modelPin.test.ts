import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_PIN, resolveCuratorModel } from "../../src/curator/prompt.js";

// DA-U-07 — `MODEL_PIN` in `src/curator/prompt.ts` is the single source of
// truth for the curator model id. Consumed by both the direct-SDK path
// (`anthropicClient.ts`) and the LangChain binding (`deepagent/adapter.ts`).
// This test blocks a regression where one consumer hard-codes a literal that
// drifts from the pin — the operator must update the pin in one place.
//
// `resolveCuratorModel()` is the shared helper both consumers call. It
// returns `MODEL_PIN` unless `CURATOR_MODEL_OVERRIDE` is set (dev/demo/alt-
// provider escape hatch), so override behavior is identical across backends
// by construction.
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

  it("anthropicClient.ts routes through resolveCuratorModel()", () => {
    const client = readFileSync(
      path.join(root, "src/curator/anthropicClient.ts"),
      "utf8",
    );
    expect(
      client,
      "anthropicClient.ts must import resolveCuratorModel from ./prompt.js",
    ).toMatch(
      /import\s*\{[^}]*\bresolveCuratorModel\b[^}]*\}\s*from\s*"\.\/prompt\.js"/,
    );
    expect(
      client,
      "anthropicClient.ts must call resolveCuratorModel() to pick the default model",
    ).toMatch(/resolveCuratorModel\(\)/);
    // Guard against an inline "claude-..." literal slipping in.
    expect(
      client.match(/"claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+"/),
      "anthropicClient.ts should not inline a claude-* literal; route through resolveCuratorModel()",
    ).toBeNull();
  });

  it("deepagent/adapter.ts routes through resolveCuratorModel()", () => {
    const adapter = readFileSync(
      path.join(root, "src/curator/deepagent/adapter.ts"),
      "utf8",
    );
    expect(
      adapter,
      "adapter.ts must import resolveCuratorModel from ../prompt.js",
    ).toMatch(
      /import\s*\{[^}]*\bresolveCuratorModel\b[^}]*\}\s*from\s*"\.\.\/prompt\.js"/,
    );
    expect(
      adapter,
      "adapter.ts must call resolveCuratorModel() to bind ChatAnthropic",
    ).toMatch(/resolveCuratorModel\(\)/);
    // Guard against an inline "claude-..." literal slipping in.
    expect(
      adapter.match(/"claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+"/),
      "adapter.ts should not inline a claude-* literal; route through resolveCuratorModel()",
    ).toBeNull();
  });
});

describe("resolveCuratorModel()", () => {
  const PRIOR = process.env["CURATOR_MODEL_OVERRIDE"];
  afterEach(() => {
    if (PRIOR === undefined) delete process.env["CURATOR_MODEL_OVERRIDE"];
    else process.env["CURATOR_MODEL_OVERRIDE"] = PRIOR;
  });

  it("returns MODEL_PIN when CURATOR_MODEL_OVERRIDE is unset", () => {
    expect(resolveCuratorModel({})).toBe(MODEL_PIN);
  });

  it("returns MODEL_PIN when CURATOR_MODEL_OVERRIDE is empty or whitespace", () => {
    expect(resolveCuratorModel({ CURATOR_MODEL_OVERRIDE: "" })).toBe(MODEL_PIN);
    expect(resolveCuratorModel({ CURATOR_MODEL_OVERRIDE: "   " })).toBe(
      MODEL_PIN,
    );
  });

  it("returns the override when set (trimmed)", () => {
    expect(
      resolveCuratorModel({
        CURATOR_MODEL_OVERRIDE: "anthropic/claude-sonnet-4.5",
      }),
    ).toBe("anthropic/claude-sonnet-4.5");
    expect(
      resolveCuratorModel({
        CURATOR_MODEL_OVERRIDE: "  claude-haiku-4-5  ",
      }),
    ).toBe("claude-haiku-4-5");
  });

  it("reads from process.env by default", () => {
    process.env["CURATOR_MODEL_OVERRIDE"] = "anthropic/claude-sonnet-4.5";
    expect(resolveCuratorModel()).toBe("anthropic/claude-sonnet-4.5");
    delete process.env["CURATOR_MODEL_OVERRIDE"];
    expect(resolveCuratorModel()).toBe(MODEL_PIN);
  });
});
