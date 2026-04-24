// Real Anthropic SDK client wrapper for the Haiku pre-filter stage.
// Mirrors `AnthropicCurationClient` (curator/anthropicClient.ts) — keeps
// the messagesCreate seam exposed for tests and resolves the model id via
// `resolveHaikuModel()` so `HAIKU_MODEL_OVERRIDE` flows through cleanly.
//
// Kept thin: builds a user message from RawItems, runs `messages.parse`
// with our hand-authored Haiku JSON Schema, and returns parsed records +
// token usage. Validation, fallback, and chunking live in `index.ts`.

import Anthropic from "@anthropic-ai/sdk";
import type { RawItem } from "../types.js";
import {
  HAIKU_SYSTEM_PROMPT,
  formatHaikuItemsPayload,
  resolveHaikuModel,
} from "./prompt.js";
import {
  haikuOutputFormat,
  type HaikuRecord,
  type HaikuResponse,
} from "./haikuOutputFormat.js";

export interface HaikuCallArgs {
  readonly model: string;
  readonly maxTokens: number;
  readonly systemPrompt: string;
  readonly rawItems: readonly RawItem[];
}

export interface HaikuCallResult {
  readonly records: readonly HaikuRecord[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface HaikuClient {
  call(args: HaikuCallArgs): Promise<HaikuCallResult>;
  readonly model?: string;
}

// Test seam: shape mirrors the subset of `messages.parse` we care about so
// tests can inject a deterministic stub without touching the SDK.
export interface HaikuMessagesParseArgs {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly messages: ReadonlyArray<{ role: "user"; content: string }>;
  readonly output_config: { format: unknown };
}

export interface HaikuMessagesParseUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface HaikuMessagesParseResult {
  readonly parsed_output: unknown;
  readonly usage: HaikuMessagesParseUsage;
}

export type HaikuMessagesParseFn = (
  args: HaikuMessagesParseArgs,
) => Promise<HaikuMessagesParseResult>;

export interface AnthropicHaikuClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly messagesParse?: HaikuMessagesParseFn;
  readonly outputFormat?: unknown;
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_HAIKU_MAX_TOKENS = 4_000;

export class AnthropicHaikuClient implements HaikuClient {
  private readonly messagesParse: HaikuMessagesParseFn;
  public readonly model: string;
  private readonly maxTokens: number;
  private readonly outputFormatOverride: unknown;

  constructor(opts: AnthropicHaikuClientOptions = {}) {
    this.model = opts.model ?? resolveHaikuModel(opts.env);
    this.maxTokens = opts.maxTokens ?? DEFAULT_HAIKU_MAX_TOKENS;
    this.outputFormatOverride = opts.outputFormat;
    if (opts.messagesParse) {
      this.messagesParse = opts.messagesParse;
    } else {
      const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) {
        throw new Error(
          "AnthropicHaikuClient: ANTHROPIC_API_KEY is required (or inject messagesParse for tests)",
        );
      }
      const sdk = new Anthropic({ apiKey });
      // External type-boundary cast: same pattern as AnthropicCurationClient.
      // SDK's generic `messages.parse` does not structurally simplify to our
      // narrow test-friendly adapter shape; the runtime call is unchanged.
      this.messagesParse = sdk.messages.parse.bind(
        sdk.messages,
      ) as unknown as HaikuMessagesParseFn;
    }
  }

  async call(args: HaikuCallArgs): Promise<HaikuCallResult> {
    const userContent = formatHaikuItemsPayload(args.rawItems);
    const format = this.outputFormatOverride ?? haikuOutputFormat();
    const result = await this.messagesParse({
      model: args.model,
      max_tokens: args.maxTokens,
      system: [{ type: "text", text: args.systemPrompt }],
      messages: [{ role: "user", content: userContent }],
      output_config: { format },
    });
    // The format's parse callback already ran HaikuResponseSchema.safeParse
    // and threw on failure. Cast to the narrow type so we don't double-parse.
    const parsed = result.parsed_output as HaikuResponse;
    return {
      records: parsed.items,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    };
  }
}

// Default factory used by `applyHaikuPreFilter` when the caller does not
// inject a client. Pulling construction into a hook makes the env-driven
// model resolution + max-tokens defaults discoverable in one place.
export function buildDefaultHaikuClient(
  env: NodeJS.ProcessEnv,
): HaikuClient {
  return new AnthropicHaikuClient({
    env,
    model: resolveHaikuModel(env),
    maxTokens: DEFAULT_HAIKU_MAX_TOKENS,
  });
}

export { DEFAULT_HAIKU_MAX_TOKENS };
export type { HaikuRecord };
