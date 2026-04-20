// DA-Un-05 — version-drift enforcement.

import { describe, it, expect } from "vitest";
import {
  PINNED_VERSIONS,
  VersionDriftError,
  assertPinnedVersions,
  readInstalledVersion,
} from "../../../src/curator/deepagent/version-guard.js";

describe("version-guard", () => {
  it("reads the installed version of each pinned package", () => {
    for (const pkg of Object.keys(PINNED_VERSIONS)) {
      const v = readInstalledVersion(pkg);
      expect(v, `${pkg} version is a non-empty string`).toMatch(
        /^\d+\.\d+\.\d+/,
      );
    }
  });

  it("agrees with PINNED_VERSIONS for all four deps (fresh install)", () => {
    // If this fires, either package.json drifted or the guard's pin table
    // drifted — update them together.
    expect(() => assertPinnedVersions()).not.toThrow();
  });

  it("throws VersionDriftError with all mismatches listed", () => {
    const fakePins = Object.freeze({
      deepagents: "0.0.1",
      "@langchain/core": "0.0.1",
    });
    try {
      assertPinnedVersions(fakePins);
      expect.fail("expected VersionDriftError");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionDriftError);
      const ve = err as VersionDriftError;
      expect(ve.mismatches).toHaveLength(2);
      expect(ve.mismatches.join("\n")).toContain("deepagents");
      expect(ve.mismatches.join("\n")).toContain("@langchain/core");
      expect(ve.message).toContain("pnpm install");
    }
  });

  it("surfaces an actionable error when a package cannot be resolved", () => {
    const fakeResolve = (_spec: string) => {
      throw new Error("Cannot find package");
    };
    try {
      assertPinnedVersions({ "does-not-exist": "1.0.0" }, fakeResolve);
      expect.fail("expected VersionDriftError");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionDriftError);
      expect((err as VersionDriftError).mismatches[0]).toContain(
        "does-not-exist",
      );
    }
  });

  it("lets a drift-injection pass when the read hook returns the expected version", () => {
    const fakeResolve = (_spec: string) => "file:///fake/package.json";
    const fakeRead = (_path: string) =>
      JSON.stringify({ name: "x", version: "9.9.9" });
    expect(() =>
      assertPinnedVersions({ x: "9.9.9" }, fakeResolve, fakeRead),
    ).not.toThrow();
  });

  it("detects drift when the read hook returns a different version", () => {
    const fakeResolve = (_spec: string) => "file:///fake/package.json";
    const fakeRead = (_path: string) =>
      JSON.stringify({ name: "x", version: "2.0.0" });
    expect(() =>
      assertPinnedVersions({ x: "1.0.0" }, fakeResolve, fakeRead),
    ).toThrow(VersionDriftError);
  });

  it("rejects a package.json whose version field isn't a string", () => {
    const fakeResolve = (_spec: string) => "file:///fake/package.json";
    const fakeRead = (_path: string) => JSON.stringify({ version: 42 });
    try {
      assertPinnedVersions({ x: "1.0.0" }, fakeResolve, fakeRead);
      expect.fail("expected VersionDriftError");
    } catch (err) {
      expect((err as VersionDriftError).mismatches[0]).toContain(
        'missing a string "version" field',
      );
    }
  });
});
