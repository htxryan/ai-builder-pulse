// Consistency: package.json pins match src/curator/deepagent/version-guard.ts.
//
// If an operator bumps a pin in package.json but forgets the guard, runtime
// drift detection will start throwing on every run — painful. Catch the
// mismatch at test time instead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PINNED_VERSIONS } from "../../src/curator/deepagent/version-guard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("DeepAgents pin consistency", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  ) as PkgJson;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  for (const [name, expected] of Object.entries(PINNED_VERSIONS)) {
    it(`package.json pin for ${name} matches guard (${expected})`, () => {
      const actual = deps[name];
      expect(actual, `${name} missing from package.json`).toBeDefined();
      // DA-U-06: exact-version pins. Reject ^ or ~ ranges outright.
      expect(actual).not.toMatch(/^[\^~]/);
      expect(actual).toBe(expected);
    });
  }

  it("all four expected packages are pinned", () => {
    const expected = [
      "deepagents",
      "@langchain/langgraph",
      "@langchain/anthropic",
      "@langchain/core",
    ];
    for (const name of expected) {
      expect(PINNED_VERSIONS).toHaveProperty(name);
    }
  });
});
