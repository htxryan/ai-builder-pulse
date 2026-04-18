import { describe, it, expect } from "vitest";
import {
  ClaudeCurator,
  CountInvariantError,
  chunkItems,
  type CurationCallResult,
  type CurationClient,
  type CurationRecord,
} from "../../src/curator/claudeCurator.js";
import { CATEGORIES } from "../../src/types.js";
import type { RawItem } from "../../src/types.js";

function raw(id: string): RawItem {
  return {
    id,
    source: "hn",
    title: `title-${id}`,
    url: `https://example.com/${id}`,
    score: 1,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn", points: 10 },
  };
}

function mkRecord(id: string, over: Partial<CurationRecord> = {}): CurationRecord {
  return {
    id,
    category: CATEGORIES[0],
    relevanceScore: 0.7,
    keep: true,
    description:
      "A well-formed curation description that is long enough for the Zod minimum length requirement.",
    ...over,
  };
}

class DeterministicClient implements CurationClient {
  public calls = 0;
  public batchSizes: number[] = [];
  constructor(private readonly keep: (i: number) => boolean = () => true) {}
  async call(args: {
    systemPrompt: string;
    rawItems: readonly RawItem[];
  }): Promise<CurationCallResult> {
    this.calls += 1;
    this.batchSizes.push(args.rawItems.length);
    const records: CurationRecord[] = args.rawItems.map((r, i) =>
      mkRecord(r.id, { keep: this.keep(i) }),
    );
    return { records, inputTokens: 100, outputTokens: 50 };
  }
}

describe("chunkItems", () => {
  it("returns single chunk when under threshold", () => {
    expect(chunkItems([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it("splits exactly at threshold boundary", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(chunkItems(items, 50).length).toBe(1);
  });

  it("splits 180 items into 4 chunks at threshold 50", () => {
    const items = Array.from({ length: 180 }, (_, i) => i);
    const chunks = chunkItems(items, 50);
    expect(chunks.length).toBe(4);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 50, 30]);
  });
});

describe("ClaudeCurator", () => {
  it("returns empty when given no items (skips Claude call)", async () => {
    const client = new DeterministicClient();
    const cur = new ClaudeCurator({ client });
    const out = await cur.curate([]);
    expect(out).toEqual([]);
    expect(client.calls).toBe(0);
  });

  it("E-05: 50 items in → 50 ScoredItems out (single chunk)", async () => {
    const client = new DeterministicClient();
    const cur = new ClaudeCurator({ client });
    const items = Array.from({ length: 50 }, (_, i) => raw(`i${i}`));
    const out = await cur.curate(items);
    expect(out.length).toBe(50);
    expect(client.calls).toBe(1);
  });

  it("E-05 count-stable across keep=true/false mix", async () => {
    const client = new DeterministicClient((i) => i % 2 === 0);
    const cur = new ClaudeCurator({ client });
    const items = Array.from({ length: 50 }, (_, i) => raw(`i${i}`));
    const out = await cur.curate(items);
    expect(out.length).toBe(50);
    expect(out.filter((s) => s.keep).length).toBe(25);
  });

  it("O-05: 180 items chunks into 4 parallel calls and merges by id", async () => {
    const client = new DeterministicClient();
    const cur = new ClaudeCurator({ client, chunkThreshold: 50 });
    const items = Array.from({ length: 180 }, (_, i) => raw(`i${i}`));
    const out = await cur.curate(items);
    expect(out.length).toBe(180);
    expect(client.calls).toBe(4);
    expect(client.batchSizes.sort((a, b) => a - b)).toEqual([30, 50, 50, 50]);
    // Output order must match input order (stable for Renderer).
    for (let i = 0; i < items.length; i += 1) {
      expect(out[i]!.id).toBe(items[i]!.id);
    }
  });

  it("retries on invalid JSON and succeeds within limit", async () => {
    let attempts = 0;
    const client: CurationClient = {
      async call({ rawItems }) {
        attempts += 1;
        if (attempts < 2) throw new SyntaxError("invalid JSON");
        return {
          records: rawItems.map((r) => mkRecord(r.id)),
          inputTokens: 10,
          outputTokens: 5,
        };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 3 });
    const out = await cur.curate([raw("a"), raw("b")]);
    expect(attempts).toBe(2);
    expect(out.length).toBe(2);
  });

  it("Un-05: fails run after retries are exhausted", async () => {
    const client: CurationClient = {
      async call() {
        throw new SyntaxError("invalid JSON");
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 3 });
    await expect(cur.curate([raw("a")])).rejects.toBeInstanceOf(SyntaxError);
  });

  it("E-05: mismatched count from client triggers CountInvariantError", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        // Drop the last record — simulates Claude filtering
        const records = rawItems.slice(0, -1).map((r) => mkRecord(r.id));
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 1 });
    await expect(cur.curate([raw("a"), raw("b")])).rejects.toBeInstanceOf(
      CountInvariantError,
    );
  });

  it("rejects records with unknown ids", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        const records = rawItems.map(() => mkRecord("ghost"));
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 1 });
    await expect(cur.curate([raw("a")])).rejects.toThrow(
      /unexpected id "ghost"/,
    );
  });

  it("rejects duplicate ids in a single chunk response", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        const records = rawItems.map(() => mkRecord(rawItems[0]!.id));
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 1 });
    await expect(cur.curate([raw("a"), raw("b")])).rejects.toThrow(
      /duplicate id/,
    );
  });

  it("rejects invalid category values", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        const records = rawItems.map((r) => ({
          ...mkRecord(r.id),
          // Force invalid category past CurationRecordSchema
          category: "Not A Category" as unknown as CurationRecord["category"],
        }));
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 1 });
    await expect(cur.curate([raw("a")])).rejects.toBeDefined();
  });

  it("rejects relevanceScore out of [0,1]", async () => {
    const client: CurationClient = {
      async call({ rawItems }) {
        const records = rawItems.map((r) =>
          mkRecord(r.id, { relevanceScore: 1.5 as number }),
        );
        return { records, inputTokens: 1, outputTokens: 1 };
      },
    };
    const cur = new ClaudeCurator({ client, maxRetries: 1 });
    await expect(cur.curate([raw("a")])).rejects.toBeDefined();
  });

  it("merges chunks and preserves RawItem fields in ScoredItem", async () => {
    const client = new DeterministicClient();
    const cur = new ClaudeCurator({ client, chunkThreshold: 10 });
    const items = Array.from({ length: 25 }, (_, i) => raw(`i${i}`));
    const out = await cur.curate(items);
    for (const s of out) {
      expect(s.source).toBe("hn");
      expect(s.title).toBe(`title-${s.id}`);
      expect(s.url).toBe(`https://example.com/${s.id}`);
      expect(s.category).toBeTruthy();
      expect(typeof s.keep).toBe("boolean");
    }
  });

  it("detects cross-chunk id collision", async () => {
    // Client returns a canonical set regardless of input — forces collision
    // across chunks because the same id appears in response twice.
    const client: CurationClient = {
      async call({ rawItems }) {
        // Take each raw id but respond with the SAME id "clash" for all.
        // Would normally fail per-chunk id check first, so simulate it by
        // returning expected ids but with an extra that matches another chunk's id.
        return {
          records: rawItems.map((r) => mkRecord(r.id)),
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const cur = new ClaudeCurator({ client, chunkThreshold: 2 });
    // Intentionally duplicate the id across two inputs so that after chunking
    // into two chunks we get duplicates on merge.
    const items = [raw("a"), raw("b"), raw("a"), raw("c")];
    await expect(cur.curate(items)).rejects.toThrow(/merge conflict/);
  });
});
