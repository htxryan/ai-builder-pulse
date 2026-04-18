import { describe, it, expect, afterEach, vi } from "vitest";
import {
  clearSecrets,
  log,
  registerSecret,
  registerSecretsFromEnv,
} from "../src/log.js";

interface CapturedLogs {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureLogs(): CapturedLogs {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    });
  const warnSpy = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
  return {
    stdout,
    stderr,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("log redactor", () => {
  afterEach(() => {
    clearSecrets();
  });

  it("redacts a registered secret appearing in data payload (info)", () => {
    registerSecret("test-token-ABC123");
    const cap = captureLogs();
    try {
      log.info("example", { apiKey: "test-token-ABC123", other: 1 });
    } finally {
      cap.restore();
    }
    const all = [...cap.stdout, ...cap.stderr].join("\n");
    expect(all).not.toContain("test-token-ABC123");
    expect(all).toContain("[REDACTED]");
  });

  it("redacts a registered secret appearing in data payload (error)", () => {
    registerSecret("sk-very-secret-long-token-XYZ");
    const cap = captureLogs();
    try {
      log.error("boom", { leaked: "sk-very-secret-long-token-XYZ" });
    } finally {
      cap.restore();
    }
    const all = cap.stderr.join("\n");
    expect(all).not.toContain("sk-very-secret-long-token-XYZ");
    expect(all).toContain("[REDACTED]");
  });

  it("redacts a secret embedded inside an error message string", () => {
    registerSecret("BDKey-AAAAAAAA");
    const cap = captureLogs();
    try {
      log.warn("publish failed: 401 for token BDKey-AAAAAAAA is invalid", {
        status: 401,
      });
    } finally {
      cap.restore();
    }
    const all = cap.stderr.join("\n");
    expect(all).not.toContain("BDKey-AAAAAAAA");
  });

  it("registerSecretsFromEnv picks up known env vars", () => {
    registerSecretsFromEnv({
      ANTHROPIC_API_KEY: "anthropic-test-key-1234567",
      BUTTONDOWN_API_KEY: "bd-test-key-9876543",
      UNRELATED: "ignore-me",
    });
    const cap = captureLogs();
    try {
      log.info("checkpoint", {
        a: "anthropic-test-key-1234567",
        b: "bd-test-key-9876543",
      });
    } finally {
      cap.restore();
    }
    const all = cap.stdout.join("\n");
    expect(all).not.toContain("anthropic-test-key-1234567");
    expect(all).not.toContain("bd-test-key-9876543");
    // Non-registered env var is NOT redacted.
    expect(all).not.toContain("[REDACTED]ignore");
  });

  it("ignores short / empty secret values to avoid corrupting unrelated content", () => {
    registerSecret(""); // empty
    registerSecret("abc"); // too short
    const cap = captureLogs();
    try {
      log.info("msg", { value: "abc embedded in content" });
    } finally {
      cap.restore();
    }
    const all = cap.stdout.join("\n");
    expect(all).toContain("abc embedded in content");
  });

  it("redacts secrets from the error annotation line too", () => {
    registerSecret("LeakedToken-0001");
    const cap = captureLogs();
    try {
      log.error("token LeakedToken-0001 rejected", {});
    } finally {
      cap.restore();
    }
    const all = cap.stderr.join("\n");
    expect(all).not.toContain("LeakedToken-0001");
  });
});
