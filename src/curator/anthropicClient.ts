// Real Anthropic SDK client wrapper. Kept thin: builds the user message from
// RawItems, runs messages.parse with a zod-derived JSON schema, and returns
// the parsed records plus token usage. ClaudeCurator handles retries, chunk
// merging, and the E-05 count invariant.

import Anthropic from "@anthropic-ai/sdk";
import type { RawItem } from "../types.js";
import {
  CurationResponseSchema,
  type CurationCallResult,
  type CurationClient,
} from "./claudeCurator.js";
import { curationOutputFormat } from "./curationOutputFormat.js";
import { MODEL_PIN, formatItemsPayload } from "./prompt.js";

export interface AnthropicClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  // Exposed for tests; wraps the single SDK call we make.
  readonly messagesParse?: MessagesParseFn;
  // Override for tests. Prod uses `curationOutputFormat()` — a hand-authored
  // JSON Schema that avoids the SDK's `zodOutputFormat()` helper, whose
  // `zod/v4` internals crash on this project's Zod v3 schemas.
  readonly outputFormat?: unknown;
}

// System is passed as a content-block array so we can attach
// `cache_control: { type: "ephemeral" }` to the (stable) system prompt.
// Anthropic caches the block for ~5 minutes — subsequent chunk calls within
// the same run hit the cache and return `cache_read_input_tokens > 0`.
export interface SystemBlock {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: { readonly type: "ephemeral" };
}

export interface MessagesParseArgs {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: readonly SystemBlock[];
  readonly messages: Array<{ role: "user"; content: string }>;
  readonly output_config: { format: unknown };
}

export interface MessagesParseUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

export interface MessagesParseResult {
  readonly parsed_output: unknown;
  readonly usage: MessagesParseUsage;
}

export type MessagesParseFn = (
  args: MessagesParseArgs,
) => Promise<MessagesParseResult>;

// DA-U-07 — consume the shared MODEL_PIN constant. Do not inline a literal
// here; the consistency test asserts this file sources the model id from
// `prompt.ts` so both the direct SDK path and the LangChain binding stay
// aligned.
const DEFAULT_MODEL = MODEL_PIN;
const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicCurationClient implements CurationClient {
  private readonly messagesParse: MessagesParseFn;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly outputFormatOverride: unknown;

  constructor(opts: AnthropicClientOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.outputFormatOverride = opts.outputFormat;
    if (opts.messagesParse) {
      this.messagesParse = opts.messagesParse;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "AnthropicCurationClient: ANTHROPIC_API_KEY is required (or inject messagesParse for tests)",
        );
      }
      const sdk = new Anthropic({ apiKey });
      // External type-boundary cast: `sdk.messages.parse` is generic over
      // internal SDK `MessageCreateParamsNonStreaming` + helper types that
      // do not structurally simplify to our testable `MessagesParseFn`
      // adapter shape. The runtime call is unchanged — the cast isolates
      // the SDK's generic surface from the rest of the pipeline.
      this.messagesParse = sdk.messages.parse.bind(sdk.messages) as unknown as MessagesParseFn;
    }
  }

  async call(args: {
    systemPrompt: string;
    rawItems: readonly RawItem[];
  }): Promise<CurationCallResult> {
    const userContent = formatItemsPayload(args.rawItems);
    const format = this.outputFormatOverride ?? curationOutputFormat();
    const result = await this.messagesParse({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        {
          type: "text",
          text: args.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: { format },
    });

    const parsed = CurationResponseSchema.parse(result.parsed_output);
    const out: CurationCallResult = {
      records: parsed.items,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      ...(result.usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: result.usage.cache_read_input_tokens }
        : {}),
      ...(result.usage.cache_creation_input_tokens !== undefined
        ? { cacheCreationInputTokens: result.usage.cache_creation_input_tokens }
        : {}),
    };
    return out;
  }
}
