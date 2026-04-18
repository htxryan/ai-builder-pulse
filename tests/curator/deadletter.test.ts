import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  skippedItemsPath,
  writeSkippedItemsJson,
} from "../../src/curator/deadletter.js";
import type { RawItem } from "../../src/types.js";

function mkRaw(id: string): RawItem {
  return {
    id,
    source: "hn",
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T00:00:00Z",
    metadata: { source: "hn" },
  };
}

describe("writeSkippedItemsJson", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "abp-dl-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("no-ops on empty input", () => {
    const wrote = writeSkippedItemsJson(root, "2026-04-18", []);
    expect(wrote).toBe(false);
    expect(existsSync(skippedItemsPath(root, "2026-04-18"))).toBe(false);
  });

  it("writes json payload with count and skipped records when non-empty", () => {
    const raw = mkRaw("hn-1");
    const wrote = writeSkippedItemsJson(root, "2026-04-18", [
      { rawItem: raw, zodPath: "items.0.category", reason: "invalid enum" },
    ]);
    expect(wrote).toBe(true);
    const body = readFileSync(skippedItemsPath(root, "2026-04-18"), "utf8");
    const parsed = JSON.parse(body);
    expect(parsed.runDate).toBe("2026-04-18");
    expect(parsed.skippedCount).toBe(1);
    expect(parsed.skipped[0].rawItem.id).toBe("hn-1");
    expect(parsed.skipped[0].zodPath).toBe("items.0.category");
  });
});
