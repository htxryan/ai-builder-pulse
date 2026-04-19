// M2/M3 — LangGraph + Anthropic + Zod structured-output binding with the
// M3 safety-net invariants (cost ceiling, retry, prompt cache).
//
// This is the "deep module" (per advisor P1-7): LangGraph graph compile,
// DeepAgents harness integration, tool guard, and audit all live here.
// M2 shipped the zero-tool classifier path; M3 adds:
//   - Anthropic prompt-cache middleware (DA-U-09)
//   - Per-chunk usage extraction from @langchain/anthropic usage_metadata
//   - `CostCeilingError` surfacing (DA-U-11, DA-E-06)
// Tools + audit + guard land in M4.
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
//   - DA-U-09                : Anthropic prompt-caching middleware is wired.
//                              `minMessagesToCache: 1` because the classifier
//                              path has exactly one human message per chunk;
//                              the default 3 would silently disable caching.
//   - DA-U-11 / DA-E-06      : Per-chunk `CostCeilingError` threshold is
//                              checked the moment usage lands from the model;
//                              the error is thrown from the adapter with
//                              `retryable: false` so the orchestrator's
//                              stage-scoped catcher treats it as fatal.

import {
  createAgent,
  providerStrategy,
  HumanMessage,
  anthropicPromptCachingMiddleware,
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
  CostCeilingError,
  CountInvariantError,
  CurationResponseSchema,
  type CurationRecord,
} from "../claudeCurator.js";
import {
  estimateUsd,
  type CostRates,
} from "../costModel.js";
import {
  MODEL_PIN,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  formatItemsPayload,
} from "../prompt.js";

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
  /**
   * DA-U-11 — per-chunk cost ceiling in USD. When set, the adapter throws
   * `CostCeilingError` with `retryable: false` if the model's reported usage
   * translates to a USD cost above this value. Undefined ⇒ no per-chunk
   * ceiling (legacy M2 behavior). The orchestrator computes this as
   * `CURATOR_MAX_USD / chunkCount * 2`.
   */
  readonly perChunkCeilingUsd?: number;
  /** Cost rates override (defaults from costModel.ts). */
  readonly costRates?: CostRates;
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
  /**
   * Disable the Anthropic prompt-caching middleware. Production leaves this
   * false; the sole consumer is the adapter test that wants to inspect the
   * unfiltered graph. The prod path MUST ship with caching enabled or DA-U-09
   * silently regresses (2-4× token burn).
   */
  readonly disableCaching?: boolean;
}

// Loose type alias — the ReactAgent's full type parameter bag leaks
// middleware internals that we don't care about here. All call sites
// consume the agent through its narrow `invoke()` surface, so we keep the
// return type intentionally opaque to prevent type churn from spilling into
// index.ts.
export type CurationAgent = ReactAgent;

/**
 * Per-chunk usage accounting surfaced to the caller so index.ts can check
 * the per-run cost ceiling and populate `CuratorMetrics.cacheReadInputTokens`.
 *
 * Token counts are read from `@langchain/anthropic`'s `usage_metadata`.
 * NOTE: that field's `input_tokens` is the *sum* of real + cache_read +
 * cache_creation tokens (per LangChain's `buildUsageMetadata`). We expose
 * both the summed figure and the raw split so cost estimation can stay
 * consistent with the direct-SDK path (which uses raw `input_tokens` without
 * cache tokens mixed in).
 */
export interface ChunkUsage {
  /** Real input tokens only (excludes cache read + cache creation). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface ChunkResult {
  readonly scored: readonly ScoredItem[];
  readonly usage: ChunkUsage;
  readonly estimatedUsd: number;
}

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
 *
 * M3: `anthropicPromptCachingMiddleware` is wired by default with
 * `minMessagesToCache: 1` because the classifier path sends exactly one
 * user message per chunk; the library default (3) would silently disable
 * caching. `unsupportedModelBehavior: "ignore"` is chosen so tests using
 * `fakeModel()` don't log a stderr warning on every invocation.
 */
export function buildCurationAgent(
  opts: BuildAgentOptions = {},
): CurationAgent {
  const model = resolveModel(opts);
  const systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  const middleware = opts.disableCaching
    ? []
    : [buildCachingMiddleware()];
  return createAgent({
    model,
    tools: [],
    systemPrompt,
    responseFormat: buildResponseFormat(),
    middleware,
  });
}

// Build the Anthropic prompt-caching middleware (DA-U-09). Isolated in its
// own function because `PromptCachingMiddlewareConfig` resolves to `never`
// under `InferInteropZodInput<typeof contextSchema>` in some zod-v3/v4
// interop paths, and TS narrows the parameter to `undefined`. We route
// around that by letting inference pick up the `as const` shape — the
// call site here never forms a `PromptCachingMiddlewareConfig` value
// explicitly. Documented as a single localized workaround: if this fails
// after a LangChain upgrade, swap to a named typed variable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildCachingMiddleware(): any {
  return anthropicPromptCachingMiddleware(
    // `satisfies` is intentionally omitted — the compiler's inferred shape
    // for the param is `undefined` (known upstream type-bundling issue),
    // so we pass a plain object literal and let TS infer parameter `any`
    // through the enclosing function's return type.
    {
      minMessagesToCache: 1,
      ttl: "5m",
      unsupportedModelBehavior: "ignore",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  );
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
 * Pull LangChain usage metadata off the last AI message in the agent
 * result. The structured-output path does NOT surface usage on
 * `result.structuredResponse`, so we walk `result.messages` back-to-front
 * and grab the first AI message that carries `usage_metadata`.
 *
 * LangChain's `buildUsageMetadata` sums `cache_read_input_tokens` and
 * `cache_creation_input_tokens` into `input_tokens`; we subtract them back
 * out so the returned `inputTokens` matches what the direct-SDK path
 * reports (the `messages.parse` helper returns cache tokens separately).
 */
interface UsageBearingMessage {
  readonly usage_metadata?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_token_details?: {
      readonly cache_read?: number;
      readonly cache_creation?: number;
    };
  };
}

function extractUsage(result: unknown): ChunkUsage {
  const messages: readonly UsageBearingMessage[] =
    typeof result === "object" &&
    result !== null &&
    "messages" in result &&
    Array.isArray((result as { messages: readonly UsageBearingMessage[] }).messages)
      ? (result as { messages: readonly UsageBearingMessage[] }).messages
      : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const um = m?.usage_metadata;
    if (um && (um.input_tokens !== undefined || um.output_tokens !== undefined)) {
      const cacheRead = um.input_token_details?.cache_read ?? 0;
      const cacheCreation = um.input_token_details?.cache_creation ?? 0;
      const summedInput = um.input_tokens ?? 0;
      // LangChain sums cache_read + cache_creation into input_tokens. The
      // direct-SDK path reports these separately, so subtract them back out
      // to keep cost estimates apples-to-apples across backends. Floor at 0
      // because an older @langchain/anthropic that doesn't sum them would
      // otherwise produce a negative count.
      const rawInput = Math.max(0, summedInput - cacheRead - cacheCreation);
      return {
        inputTokens: rawInput,
        outputTokens: um.output_tokens ?? 0,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
      };
    }
  }
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/**
 * Run a single curation chunk through the DeepAgents-backed adapter. M2
 * shipped the single-chunk path; M3 adds usage extraction + per-chunk
 * cost ceiling. Per-run aggregation and retry land in `index.ts`.
 *
 * Throws:
 *   - `CountInvariantError` when the agent's record count differs from
 *     the input chunk length (E-05).
 *   - `UnexpectedRecordIdError` (also `OrchestratorStageError`) when the
 *     count matches but a record id is unknown or duplicated (E-05 sibling
 *     — the response still fails to map bijectively to the input).
 *   - `CostCeilingError` (DA-E-06) when the chunk's estimated USD exceeds
 *     `ctx.perChunkCeilingUsd`. Not retryable.
 *   - a plain `Error` when the structured response is present but fails
 *     the `CurationResponseSchema` re-validation (LangChain's JSON-schema
 *     path and our Zod schema must agree; a drift here is a programmer
 *     error, not a runtime condition to retry).
 */
export async function runAdapterChunk(
  items: readonly RawItem[],
  ctx: AdapterContext,
  overrides: BuildAgentOptions = {},
): Promise<ChunkResult> {
  if (items.length === 0) {
    return {
      scored: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      estimatedUsd: 0,
    };
  }

  const agent = buildCurationAgent(overrides);
  const maxIterations = ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  log.info("deepagent adapter start", {
    runId: ctx.runId,
    runDate: ctx.runDate,
    chunkIdx: ctx.chunkIdx ?? 0,
    itemCount: items.length,
    promptVersion: PROMPT_VERSION,
    maxIterations,
    perChunkCeilingUsd: ctx.perChunkCeilingUsd,
  });

  const userMessage = new HumanMessage(formatItemsPayload(items));
  const result = await agent.invoke(
    { messages: [userMessage] },
    { recursionLimit: maxIterations },
  );

  const usage = extractUsage(result);
  const chunkUsd = estimateUsd(
    usage.inputTokens,
    usage.outputTokens,
    ctx.costRates,
  );

  // DA-E-06 — cost ceiling check before merge. Throwing here means we do
  // NOT return a partial result; the caller's retry loop sees
  // CostCeilingError (retryable: false) and abandons the chunk.
  if (
    ctx.perChunkCeilingUsd !== undefined &&
    chunkUsd > ctx.perChunkCeilingUsd
  ) {
    log.error("deepagent cost ceiling exceeded (chunk)", {
      chunkIdx: ctx.chunkIdx ?? 0,
      estimatedUsd: chunkUsd,
      perChunkCeilingUsd: Number(ctx.perChunkCeilingUsd.toFixed(4)),
    });
    throw new CostCeilingError(
      chunkUsd,
      ctx.perChunkCeilingUsd,
      "chunk",
      ctx.chunkIdx,
    );
  }

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
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    estimatedUsd: chunkUsd,
  });
  return { scored, usage, estimatedUsd: chunkUsd };
}

/**
 * Back-compat shim — pre-M3 tests import `runAdapter` and expect the
 * bare `ScoredItem[]` return. Keep this signature stable until the legacy
 * sunset so the adapter.test.ts suite doesn't churn; new code should call
 * `runAdapterChunk` directly.
 */
export async function runAdapter(
  items: readonly RawItem[],
  ctx: AdapterContext,
  overrides: BuildAgentOptions = {},
): Promise<ScoredItem[]> {
  const { scored } = await runAdapterChunk(items, ctx, overrides);
  return [...scored];
}
