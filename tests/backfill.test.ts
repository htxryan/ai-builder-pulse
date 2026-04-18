import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findUnpublished, runBackfill } from "../src/backfill.js";

describe("findUnpublished", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-backfill-"));
    mkdirSync(path.join(root, "issues"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when issues/ dir is missing", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "abp-empty-"));
    expect(findUnpublished(empty, "2026-04-18")).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("detects a prior day with issue.md but no .published", () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    const out = findUnpublished(root, "2026-04-18");
    expect(out).toHaveLength(1);
    expect(out[0]!.runDate).toBe("2026-04-17");
  });

  it("skips a day that already has .published", () => {
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    writeFileSync(path.join(dir, ".published"), "");
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  it("skips current runDate (only prior days)", () => {
    const dir = path.join(root, "issues", "2026-04-18");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "issue.md"), "# test");
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });

  it("ignores non-date directories", () => {
    mkdirSync(path.join(root, "issues", "README"), { recursive: true });
    expect(findUnpublished(root, "2026-04-18")).toEqual([]);
  });
});

describe("runBackfill", () => {
  it("attempts zero on clean tree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-bf-clean-"));
    const result = await runBackfill(root, "2026-04-18", { dryRun: false });
    expect(result.attempted).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("DRY_RUN logs but does not mark success/fail", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "abp-bf-dry-"));
    const dir = path.join(root, "issues", "2026-04-17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "issue.md"), "# test");
    const result = await runBackfill(root, "2026-04-18", { dryRun: true });
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
