import type { Category, RawItem, ScoredItem } from "../types.js";
import { CATEGORIES, ScoredItemSchema } from "../types.js";

export interface Curator {
  curate(items: RawItem[]): Promise<ScoredItem[]>;
}

function pickCategory(item: RawItem): Category {
  const hash = Array.from(item.id).reduce(
    (acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0,
    0,
  );
  return CATEGORIES[hash % CATEGORIES.length]!;
}

function truncateDescription(title: string): string {
  const base = `Mock curation for: ${title}`;
  if (base.length >= 100) return base.slice(0, 300);
  return base.padEnd(100, ".");
}

export class MockCurator implements Curator {
  async curate(items: RawItem[]): Promise<ScoredItem[]> {
    const out: ScoredItem[] = items.map((raw, idx) => {
      const scored = {
        ...raw,
        category: pickCategory(raw),
        relevanceScore: Math.min(
          1,
          Math.max(0, 0.5 + ((idx % 10) - 5) * 0.05),
        ),
        keep: idx % 3 !== 0,
        description: truncateDescription(raw.title),
      };
      return ScoredItemSchema.parse(scored);
    });
    if (out.length !== items.length) {
      throw new Error(
        `MockCurator count invariant violated: in=${items.length} out=${out.length}`,
      );
    }
    return out;
  }
}
