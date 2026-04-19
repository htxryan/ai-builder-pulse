// M2 — LangGraph + Anthropic + Zod structured-output binding.
//
// This is the "deep module" (per advisor P1-7): LangGraph graph compile,
// DeepAgents harness integration, tool guard, and audit all live here.
// M2 ships the zero-tool classifier path; tools + audit + guard land in M4.
//
// DA-U-08 compliance: we deliberately route through `createAgent` from
// `langchain` (the primitive DeepAgents itself uses under the hood) rather
// than `createDeepAgent` from `deepagents`. `createDeepAgent` unconditionally
// registers the `write_todos` planner and the filesystem tool set; the spec
// requires those be *disabled*, and `createDeepAgent` has no opt-out. The
// `deepagents` package stays in the dependency closure (version-guarded at
// module load) because M-follow-ups will use its subagent primitives; for
// M2 with `tools: []`, the harness exposes nothing we consume.
//
// Invariants enforced here:
//   - DA-U-04 (tools=[])     : `tools: []` is passed literally; graph spec
//                              has zero tool nodes.
//   - DA-U-03 / DA-E-02      : E-05 count-invariant: exactly one record per
//                              RawItem, no extras, no drops.
//   - DA-S-01                : LangGraph `recursionLimit` at invocation.
// DA-U-09 (cache preservation) is landed in M3; M2 uses a plain string
// system prompt so the cache_control wiring can be added + tested in one
// focused change.

import {
  createAgent,
  providerStrategy,
  HumanMessage,
  type ProviderStrategy,
  type ReactAgent,
} from "langchain";
import type { InteropZodType } from "@langchain/core/utils/types";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { z } from "zod";
import { log } from "../../log.js";
import { OrchestratorStageError } from "../../errors.js";
import type { RawItem, ScoredItem } from "../../types.js";
import { ScoredItemSchema } from "../../types.js";
import {
  CountInvariantError,
  CurationResponseSchema,
  type CurationRecord,
} from "../claudeCurator.js";
import { MODEL_PIN, SYSTEM_PROMPT, PROMPT_VERSION } from "../prompt.js";

const DEFAULT_MAX_TOKENS = 16_000;
// Test-time fallback only. `runDeepAgentCurator` always supplies
// `ctx.maxIterations` from `DEEPAGENT_DEFAULTS.maxIterations`; this default
// exists because `runAdapter` is also called directly from the adapter tests,
// which don't plumb through the config module. Kept local to avoid a
// circular import between `adapter.ts` ↔ `index.ts`; values are asserted
// equal by `tests/curator/deepagent/adapter.test.ts` if this drifts.
const DEFAULT_MAX_ITERATIONS = 6;

/**
 * E-05 sibling error: the agent returned the right count but at least one
 * record id is unknown, or a single id appears more than once. Orchestrator
 * catchers branching on `OrchestratorStageError` treat this uniformly with
 * `CountInvariantError` — both mean "the response does not correspond
 * bijectively to the input chunk."
 */
export class UnexpectedRecordIdError extends OrchestratorStageError {
  constructor(
    message: string,
    public readonly recordId: string,
    public readonly kind: "unknown" | "duplicate",
  ) {
    super(message, { stage: "curate", retryable: false });
    this.name = "UnexpectedRecordIdError";
  }
}

export interface AdapterContext {
  readonly runId: string;
  readonly runDate: string;
  readonly chunkIdx?: number;
  /** DA-S-01 — LangGraph recursion limit for this chunk. */
  readonly maxIterations?: number;
}

export interface BuildAgentOptions {
  /**
   * Override the chat model. Production leaves this undefined so the
   * adapter binds `@langchain/anthropic`'s `ChatAnthropic` to
   * `MODEL_PIN`; tests inject `fakeModel()` to exercise the full graph
   * without hitting the network.
   */
  readonly model?: BaseChatModel;
  /** Override the system prompt (tests). Defaults to the versioned artifact. */
  readonly systemPrompt?: string;
  /** Override Anthropic `max_tokens`. Ignored when `model` is provided. */
  readonly maxTokens?: number;
}

// Loose type alias — the ReactAgent's full type parameter bag leaks
// middleware internals that we don't care about here. All call sites
// consume the agent through its narrow `invoke()` surface, so we keep the
// return type intentionally opaque to prevent type churn from spilling into
// index.ts.
export type CurationAgent = ReactAgent;

function resolveModel(opts: BuildAgentOptions): BaseChatModel {
  if (opts.model) return opts.model;
  // ChatAnthropic reads `ANTHROPIC_API_KEY` from env; the factory validates
  // key presence before selecting the DeepAgents backend in production.
  return new ChatAnthropic({
    model: MODEL_PIN,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

/**
 * Compile the curation agent. One `ReactAgent` wraps a LangGraph
 * state-graph, a model-invocation node, and (in M4) a tool loop. For M2 we
 * pass `tools: []` so the compiled graph has zero tool nodes — DA-U-04
 * holds by construction.
 *
 * `providerStrategy(CurationResponseSchema)` tells LangGraph to use the
 * model's native JSON-schema output path; the returned `structuredResponse`
 * is JSON-schema-valid (and further re-validated with Zod on return to
 * catch any drift in LangChain's schema translation).
 */
export function buildCurationAgent(
  opts: BuildAgentOptions = {},
): CurationAgent {
  const model = resolveModel(opts);
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  return createAgent({
    model,
    tools: [],
    systemPrompt,
    responseFormat: buildResponseFormat(),
    middleware: [],
  });
}

// External type-boundary cast: `providerStrategy` is typed against
// `InteropZodType<T>` whose `ZodV3Like` branch expects `description?: string`
// (implicit-optional). Zod v3's ZodSchema declares `description: string | undefined`
// (explicit-union), and with `exactOptionalPropertyTypes: true` the two are
// not assignable. The runtime schema is exactly what providerStrategy needs
// — the same schema already round-trips successfully through
// `@anthropic-ai/sdk/helpers/zod.zodOutputFormat` elsewhere in this module.
// Narrowing via `InteropZodType<z.infer<...>>` at the call site keeps the
// output type precise (no `unknown` leak into the rest of the adapter).
function buildResponseFormat(): ProviderStrategy<
  z.infer<typeof CurationResponseSchema>
> {
  const zodAsInterop = CurationResponseSchema as unknown as InteropZodType<
    z.infer<typeof CurationResponseSchema>
  >;
  return providerStrategy(zodAsInterop);
}

function summarizeMetadata(item: RawItem): string {
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

function formatUserContent(items: readonly RawItem[]): string {
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

function assertChunkIds(
  chunk: readonly RawItem[],
  records: readonly CurationRecord[],
): void {
  if (records.length !== chunk.length) {
    throw new CountInvariantError(chunk.length, records.length);
  }
  const want = new Set(chunk.map((x) => x.id));
  const seen = new Set<string>();
  for (const r of records) {
    if (!want.has(r.id)) {
      throw new UnexpectedRecordIdError(
        `DeepAgent adapter: response contained unexpected id "${r.id}" not in chunk input`,
        r.id,
        "unknown",
      );
    }
    if (seen.has(r.id)) {
      throw new UnexpectedRecordIdError(
        `DeepAgent adapter: response contained duplicate id "${r.id}"`,
        r.id,
        "duplicate",
      );
    }
    seen.add(r.id);
  }
}

function mergeToScoredItems(
  items: readonly RawItem[],
  records: readonly CurationRecord[],
): ScoredItem[] {
  const recById = new Map(records.map((r) => [r.id, r]));
  const out: ScoredItem[] = [];
  for (const raw of items) {
    const rec = recById.get(raw.id);
    if (!rec) {
      // Dead-code defense: `assertChunkIds` has already proven
      // `Set(records.map(id)) === Set(items.map(id))`, so this branch is
      // unreachable at runtime. Kept so the invariant is visible at the
      // merge site and a future refactor that skips `assertChunkIds` fails
      // loudly instead of silently dropping items.
      throw new CountInvariantError(items.length, records.length);
    }
    // Full ScoredItemSchema parse — catches any drift where the record's
    // category or relevanceScore would deserialize but fail the stricter
    // ScoredItem bounds.
    out.push(
      ScoredItemSchema.parse({
        ...raw,
        category: rec.category,
        relevanceScore: rec.relevanceScore,
        keep: rec.keep,
        description: rec.description,
      }),
    );
  }
  return out;
}

/**
 * Run a single curation chunk through the DeepAgents-backed adapter. M2
 * ships the single-chunk path; per-run chunking, cost ceiling, retries,
 * and cache preservation land in M3, and tools + audit in M4.
 *
 * Throws:
 *   - `CountInvariantError` when the agent's record count differs from
 *     the input chunk length (E-05).
 *   - `UnexpectedRecordIdError` (also `OrchestratorStageError`) when the
 *     count matches but a record id is unknown or duplicated (E-05 sibling
 *     — the response still fails to map bijectively to the input).
 *   - a plain `Error` when the structured response is present but fails
 *     the `CurationResponseSchema` re-validation (LangChain's JSON-schema
 *     path and our Zod schema must agree; a drift here is a programmer
 *     error, not a runtime condition to retry).
 */
export async function runAdapter(
  items: readonly RawItem[],
  ctx: AdapterContext,
  overrides: BuildAgentOptions = {},
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];

  const agent = buildCurationAgent(overrides);
  const maxIterations = ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  log.info("deepagent adapter start", {
    runId: ctx.runId,
    runDate: ctx.runDate,
    chunkIdx: ctx.chunkIdx ?? 0,
    itemCount: items.length,
    promptVersion: PROMPT_VERSION,
    maxIterations,
  });

  const userMessage = new HumanMessage(formatUserContent(items));
  const result = await agent.invoke(
    { messages: [userMessage] },
    { recursionLimit: maxIterations },
  );

  // Distinguish "LangChain dropped the key entirely" (API shape changed)
  // from "key is present but the JSON fails our Zod schema" (model drift).
  // The two failures look identical when we only read `.structuredResponse`
  // — an absent key produces `undefined`, which Zod then rejects with a
  // misleading "expected object" message. Explicit `in` check surfaces the
  // true cause.
  if (
    typeof result !== "object" ||
    result === null ||
    !("structuredResponse" in result)
  ) {
    throw new Error(
      `DeepAgent adapter: agent result missing "structuredResponse" key — @langchain/core providerStrategy API may have changed`,
    );
  }
  const structured = (result as { structuredResponse: unknown })
    .structuredResponse;
  const parsed = CurationResponseSchema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      `DeepAgent adapter: structured response failed Zod validation: ${parsed.error.message}`,
    );
  }
  const records = parsed.data.items;
  // E-05 — the count-invariant guard. Must run BEFORE merging so the
  // thrown error carries the expected/actual pair the orchestrator logs.
  assertChunkIds(items, records);
  const scored = mergeToScoredItems(items, records);
  log.info("deepagent adapter done", {
    runId: ctx.runId,
    chunkIdx: ctx.chunkIdx ?? 0,
    itemCount: items.length,
    kept: scored.filter((s) => s.keep).length,
  });
  return scored;
}
