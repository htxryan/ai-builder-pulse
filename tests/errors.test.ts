import { describe, it, expect } from "vitest";
import {
  OrchestratorStageError,
  classifyRedirectError,
} from "../src/errors.js";
import { CollectorTimeoutError } from "../src/collectors/timeout.js";
import { PublishError } from "../src/publisher/buttondown.js";
import { RetryableError, RetryExhaustedError } from "../src/publisher/retry.js";
import {
  CostCeilingError,
  CountInvariantError,
} from "../src/curator/claudeCurator.js";

describe("OrchestratorStageError taxonomy", () => {
  it("CollectorTimeoutError extends base with stage=collect and retryable=true", () => {
    const err = new CollectorTimeoutError("hn", 60_000);
    expect(err).toBeInstanceOf(OrchestratorStageError);
    expect(err.stage).toBe("collect");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("CollectorTimeoutError");
  });

  it("PublishError extends base with stage=publish and retryable mirrors !terminal", () => {
    const retryable = new PublishError("boom", {
      status: 503,
      attempts: 1,
      terminal: false,
    });
    expect(retryable).toBeInstanceOf(OrchestratorStageError);
    expect(retryable.stage).toBe("publish");
    expect(retryable.retryable).toBe(true);
    const terminal = new PublishError("boom", {
      status: 400,
      attempts: 1,
      terminal: true,
    });
    expect(terminal.retryable).toBe(false);
  });

  it("RetryableError / RetryExhaustedError extend base with stage=publish", () => {
    const r = new RetryableError("x");
    expect(r).toBeInstanceOf(OrchestratorStageError);
    expect(r.stage).toBe("publish");
    expect(r.retryable).toBe(true);
    const e = new RetryExhaustedError("x", 3, new Error("inner"));
    expect(e).toBeInstanceOf(OrchestratorStageError);
    expect(e.stage).toBe("publish");
    expect(e.retryable).toBe(false);
  });

  it("Curator errors extend base with stage=curate", () => {
    const cost = new CostCeilingError(2, 1, "total");
    const count = new CountInvariantError(5, 4);
    expect(cost).toBeInstanceOf(OrchestratorStageError);
    expect(cost.stage).toBe("curate");
    expect(count).toBeInstanceOf(OrchestratorStageError);
    expect(count.stage).toBe("curate");
  });

  it("can be caught via instanceof OrchestratorStageError for stage-scoped handling", () => {
    const errs: unknown[] = [
      new CollectorTimeoutError("hn", 1),
      new CostCeilingError(2, 1, "chunk", 0),
      new PublishError("x", { attempts: 1, terminal: true }),
    ];
    const stages = errs
      .filter((e): e is OrchestratorStageError => e instanceof OrchestratorStageError)
      .map((e) => e.stage);
    expect(stages).toEqual(["collect", "curate", "publish"]);
  });
});

describe("classifyRedirectError", () => {
  it("timeout", () => {
    expect(classifyRedirectError(new Error("Request timeout after 30s"))).toBe(
      "timeout",
    );
  });
  it("tls", () => {
    expect(classifyRedirectError(new Error("TLS handshake failed"))).toBe("tls");
    expect(classifyRedirectError(new Error("self signed certificate"))).toBe("tls");
  });
  it("http_4xx / http_5xx", () => {
    expect(classifyRedirectError(new Error("redirect: http 404"))).toBe("http_4xx");
    expect(classifyRedirectError(new Error("redirect: http 503"))).toBe("http_5xx");
  });
  it("abort", () => {
    const e = new Error("operation aborted");
    e.name = "AbortError";
    expect(classifyRedirectError(e)).toBe("abort");
  });
  it("dns", () => {
    expect(classifyRedirectError(new Error("getaddrinfo ENOTFOUND nope"))).toBe(
      "dns",
    );
  });
  it("network", () => {
    expect(classifyRedirectError(new Error("fetch failed"))).toBe("network");
    expect(classifyRedirectError(new Error("ECONNRESET reading response"))).toBe(
      "network",
    );
  });
  it("other fallback", () => {
    expect(classifyRedirectError(new Error("nothing recognizable"))).toBe("other");
    expect(classifyRedirectError("string error")).toBe("other");
  });
});
