import type { Category, RawItem, ScoredItem } from "../types.js";
import { CATEGORIES, ScoredItemSchema } from "../types.js";
import type { SkippedItemRecord } from "./deadletter.js";

// Optional cost/token metrics emitted by curators that talk to a paid API.
// MockCurator leaves this undefined; ClaudeCurator populates after each
// successful `curate` call so the orchestrator can surface the run's cost in
// the operator job summary.
export interface CuratorMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
  // Cache telemetry — populated by clients that report Anthropic cache
  // accounting. Undefined when the client did not return usage data.
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface Curator {
  curate(items: RawItem[]): Promise<ScoredItem[]>;
  // Optional — returns metrics from the most recent `curate` call. Curators
  // that do not track cost (e.g. `MockCurator`) simply omit this hook.
  lastMetrics?(): CuratorMetrics | undefined;
  // Optional — returns RawItems the curator could not score (zod failures,
  // retry exhaustion with structured cause). The orchestrator writes these
  // to `issues/{runDate}/.skipped-items.json` and surfaces the count in the
  // GHA job summary. Empty array when every item mapped cleanly.
  lastSkipped?(): readonly SkippedItemRecord[];
}

function pickCategory(item: RawItem): Category {
  const hash = Array.from(item.id).reduce(
    (acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0,
    0,
  );
  return CATEGORIES[hash % CATEGORIES.length]!;
}

// Schema cap on description is 600. Keep this constant in sync.
const DESC_MAX = 600;

function truncateDescription(title: string): string {
  const base = `Mock curation for: ${title}`;
  if (base.length >= 100) return base.slice(0, Math.min(base.length, DESC_MAX));
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
