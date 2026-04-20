// DEEPAGENT_* env parsing — NaN-guarded with documented defaults.

import { describe, it, expect } from "vitest";
import {
  DEEPAGENT_DEFAULTS,
  parseDeepAgentConfig,
} from "../../../src/curator/deepagent/index.js";
import { MODEL_PIN } from "../../../src/curator/prompt.js";

describe("parseDeepAgentConfig", () => {
  it("returns the documented defaults when no DEEPAGENT_* vars are set", () => {
    const cfg = parseDeepAgentConfig({});
    expect(cfg).toEqual(DEEPAGENT_DEFAULTS);
  });

  it("ignores unrelated env vars", () => {
    const cfg = parseDeepAgentConfig({
      CURATOR: "mock",
      NODE_ENV: "test",
      UNRELATED: "123",
    });
    expect(cfg).toEqual(DEEPAGENT_DEFAULTS);
  });

  it("accepts well-formed integers", () => {
    const cfg = parseDeepAgentConfig({
      DEEPAGENT_MAX_ITERATIONS: "10",
      DEEPAGENT_TOOL_BUDGET: "16",
      DEEPAGENT_MAX_CHUNK_RETRIES: "5",
      DEEPAGENT_MAX_CONCURRENT_CHUNKS: "2",
    });
    expect(cfg.maxIterations).toBe(10);
    expect(cfg.toolBudget).toBe(16);
    expect(cfg.maxChunkRetries).toBe(5);
    expect(cfg.maxConcurrentChunks).toBe(2);
  });

  it.each([
    ["DEEPAGENT_MAX_ITERATIONS", "NaN"],
    ["DEEPAGENT_MAX_ITERATIONS", "abc"],
    ["DEEPAGENT_MAX_ITERATIONS", "0"],
    ["DEEPAGENT_MAX_ITERATIONS", "-3"],
    ["DEEPAGENT_MAX_ITERATIONS", "1.5"],
    ["DEEPAGENT_TOOL_BUDGET", "NaN"],
    ["DEEPAGENT_TOOL_BUDGET", "0"],
    ["DEEPAGENT_MAX_CHUNK_RETRIES", "abc"],
    ["DEEPAGENT_MAX_CONCURRENT_CHUNKS", "-1"],
  ])("rejects malformed %s=%s with a NaN-guarded error", (key, value) => {
    expect(() =>
      parseDeepAgentConfig({ [key]: value } as NodeJS.ProcessEnv),
    ).toThrow(new RegExp(`Invalid env ${key}`));
  });

  it("treats empty string as unset (not an error)", () => {
    const cfg = parseDeepAgentConfig({
      DEEPAGENT_MAX_ITERATIONS: "",
      DEEPAGENT_ENABLE_LANGSMITH: "",
    });
    expect(cfg.maxIterations).toBe(DEEPAGENT_DEFAULTS.maxIterations);
    expect(cfg.enableLangsmith).toBe(false);
  });

  it("requires explicit '1' to enable LangSmith (DA-Un-08)", () => {
    expect(parseDeepAgentConfig({}).enableLangsmith).toBe(false);
    expect(
      parseDeepAgentConfig({ DEEPAGENT_ENABLE_LANGSMITH: "0" }).enableLangsmith,
    ).toBe(false);
    expect(
      parseDeepAgentConfig({ DEEPAGENT_ENABLE_LANGSMITH: "true" })
        .enableLangsmith,
    ).toBe(false);
    expect(
      parseDeepAgentConfig({ DEEPAGENT_ENABLE_LANGSMITH: "1" })
        .enableLangsmith,
    ).toBe(true);
  });

  it("LANGSMITH_API_KEY alone does NOT enable tracing (DA-Un-08)", () => {
    // Presence of LangSmith's own env var must not auto-wire.
    const cfg = parseDeepAgentConfig({
      LANGSMITH_API_KEY: "ls_test",
      LANGSMITH_PROJECT: "my-proj",
    });
    expect(cfg.enableLangsmith).toBe(false);
  });

  it("shares CURATOR_CHUNK_THRESHOLD and CURATOR_MAX_USD with the legacy path", () => {
    // M3 reuses the same env vars as ClaudeCurator so an operator's
    // existing runbook works when they flip CURATOR_BACKEND.
    const cfg = parseDeepAgentConfig({
      CURATOR_CHUNK_THRESHOLD: "25",
      CURATOR_MAX_USD: "0.75",
    });
    expect(cfg.chunkThreshold).toBe(25);
    expect(cfg.maxUsd).toBe(0.75);
  });

  it("captures the resolved curator model id at parse time", () => {
    // Scoped env → scoped override. `model` is frozen on the config so a
    // mid-run mutation to process.env can't desynchronize the adapter binding
    // from CuratorMetrics.model.
    expect(parseDeepAgentConfig({}).model).toBe(MODEL_PIN);
    expect(
      parseDeepAgentConfig({
        CURATOR_MODEL_OVERRIDE: "anthropic/claude-sonnet-4.5",
      }).model,
    ).toBe("anthropic/claude-sonnet-4.5");
    expect(
      parseDeepAgentConfig({ CURATOR_MODEL_OVERRIDE: "" }).model,
    ).toBe(MODEL_PIN);
  });

  it("rejects malformed CURATOR_MAX_USD", () => {
    expect(() =>
      parseDeepAgentConfig({ CURATOR_MAX_USD: "NaN" }),
    ).toThrow(/Invalid env CURATOR_MAX_USD/);
    expect(() =>
      parseDeepAgentConfig({ CURATOR_MAX_USD: "0" }),
    ).toThrow(/Invalid env CURATOR_MAX_USD/);
  });

  it("audit-to-file is off by default and gated by DEEPAGENT_AUDIT_TO_FILE=1", () => {
    expect(parseDeepAgentConfig({}).auditToFile).toBe(false);
    expect(
      parseDeepAgentConfig({ DEEPAGENT_AUDIT_TO_FILE: "1" }).auditToFile,
    ).toBe(true);
    expect(
      parseDeepAgentConfig({ DEEPAGENT_AUDIT_TO_FILE: "yes" }).auditToFile,
    ).toBe(false);
  });
});
