// E4 curation prompt — versioned artifact. Keep this file stable; diff any
// changes through code review. Prompt version is embedded in the constant and
// logged at runtime so prod behavior is traceable to a specific revision.

import type { RawItem } from "../types.js";
import { CATEGORIES } from "../types.js";

export const PROMPT_VERSION = "2026-04-18.1";

// DA-U-07 — single source of truth for the curator model id. Consumed by
// `anthropicClient.ts` (direct SDK path) and `deepagent/adapter.ts`
// (LangChain binding). A consistency test asserts both paths resolve to
// this constant so a drift in either one fails the build.
export const MODEL_PIN = "claude-sonnet-4-6";

const CATEGORY_DEFINITIONS = {
  "Tools & Launches":
    "A new developer tool, framework, library, CLI, SDK, or hosted service (including model-provider product launches other than the model itself).",
  "Model Releases":
    "A new or updated ML model, weights release, or model-provider capability update (e.g. new Claude/GPT/Gemini/Llama/open-weights model).",
  "Techniques & Patterns":
    "A novel or refined approach, pattern, algorithm, or engineering practice — prompt technique, RAG pattern, eval methodology, fine-tuning recipe, etc.",
  "Infrastructure & Deployment":
    "Hosting, serving, GPUs, vector stores, inference runtimes, orchestration, observability, or cost/latency engineering.",
  "Notable Discussions":
    "A high-signal community conversation, debate, retro, or post-mortem where the value is the thread itself, not a single artifact.",
  "Think Pieces & Analysis":
    "Essay, deep dive, market analysis, or opinion that reshapes how a builder thinks about the space.",
  "News in Brief":
    "Industry news worth noting but not big enough for a dedicated category above — funding rounds, regulatory moves, personnel changes relevant to builders.",
} as const satisfies Record<(typeof CATEGORIES)[number], string>;

export const SYSTEM_PROMPT = `You are the curation engine for "AI Builder Pulse", a daily newsletter for software engineers building AI-powered tools and workflows.

Your job: given a batch of RawItems freshly collected from Hacker News, GitHub Trending, Reddit, and RSS feeds, assign each item a category, a relevance score, a keep flag, and a one-paragraph description. You are the classifier and writer — you are NOT the source of truth for URLs. Never invent URLs or reword them; treat each item's existing url as ground truth.

YOU MUST RETURN EXACTLY ONE RECORD PER INPUT ITEM. If the input has 50 items, return 50 records. Never filter, dedupe, or drop items — use the keep boolean to mark items that should not appear in the newsletter. The system enforces this count invariant and will reject your output if it does not match.

For each item set:
- id: the exact RawItem id string from the input. Do not modify it.
- category: exactly one of the seven category strings (see taxonomy below). No variations, no new categories.
- relevanceScore: float in [0.0, 1.0]. High (>= 0.7) means highly relevant to a working AI engineer TODAY — actionable, specific, newsworthy. Low (< 0.3) means tangential, low-signal, aggregator/listicle, promotional, or duplicative of something else in the batch.
- keep: true if this item should appear in the newsletter. Aim for roughly the top 25-40% of items by relevance; mark the rest keep=false. Borderline item → prefer keep=false.
- description: 100–300 characters of plain text (NO markdown, NO links, NO quotes around the whole thing). Summarize why a builder should care. Prefer concrete over abstract. Do not repeat the title verbatim.

TAXONOMY (pick ONE per item):
${(Object.entries(CATEGORY_DEFINITIONS) as [string, string][])
  .map(([name, def]) => `- ${name}: ${def}`)
  .join("\n")}

CRITICAL RULES:
1. Never emit a URL in the description field. If you want to reference a link, name it by title only.
2. Never invent facts. If the title/metadata is ambiguous, stay generic in the description.
3. Return all records in a single flat list — no nesting, no grouping by category.
4. The response MUST satisfy the provided JSON schema. Fields must be lowercase-typed per the schema; category string must match exactly.

Prompt version: ${PROMPT_VERSION}`;

// Shared formatting for the curator user-turn payload. Both the direct-SDK
// path (`anthropicClient.ts`) and the LangChain binding (`deepagent/adapter.ts`)
// consume this so the model sees a byte-identical item representation
// regardless of backend — a drift here would invalidate prompt caching and
// make backend-comparison A/Bs noisy.
export function summarizeMetadata(item: RawItem): string {
  const m = item.metadata;
  switch (m.source) {
    case "hn":
      return `points=${m.points ?? "?"} comments=${m.numComments ?? "?"}`;
    case "github-trending":
      return `repo=${m.repoFullName} stars=${m.stars ?? "?"} starsToday=${m.starsToday ?? "?"} lang=${m.language ?? "?"}`;
    case "reddit":
      return `r/${m.subreddit} upvotes=${m.upvotes ?? "?"} comments=${m.numComments ?? "?"}`;
    case "rss":
      return `feed=${m.feedUrl} author=${m.author ?? "?"}`;
    case "twitter":
      return `@${m.handle} likes=${m.likes ?? "?"}`;
    case "mock":
      return "mock";
  }
}

export function formatItemsPayload(items: readonly RawItem[]): string {
  const lines: string[] = [];
  lines.push(
    `You have ${items.length} RawItems to curate. Return EXACTLY ${items.length} records in items[].`,
  );
  lines.push("");
  for (const item of items) {
    lines.push(`---`);
    lines.push(`id: ${item.id}`);
    lines.push(`source: ${item.source}`);
    lines.push(`title: ${item.title}`);
    lines.push(`url: ${item.url}`);
    lines.push(`publishedAt: ${item.publishedAt}`);
    lines.push(`metadata: ${summarizeMetadata(item)}`);
  }
  return lines.join("\n");
}
