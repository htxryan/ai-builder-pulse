// Real Anthropic SDK client wrapper. Kept thin: builds the user message from
// RawItems, runs messages.parse with a zod-derived JSON schema, and returns
// the parsed records plus token usage. ClaudeCurator handles retries, chunk
// merging, and the E-05 count invariant.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { RawItem } from "../types.js";
import {
  CurationResponseSchema,
  type CurationCallResult,
  type CurationClient,
} from "./claudeCurator.js";

export interface AnthropicClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  // Exposed for tests; wraps the single SDK call we make.
  readonly messagesParse?: MessagesParseFn;
  // Test-only escape hatch: the SDK's zodOutputFormat helper runs against
  // zod v4 internals but our project schemas are zod v3 — the call works
  // at runtime (the prod SDK bundles its own zod) but throws when invoked
  // inside the vitest process. Tests pass a stub format to avoid the call.
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

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 16_000;

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

function formatItemsPayload(items: readonly RawItem[]): string {
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
      this.messagesParse = (args) =>
        // The SDK's messages.parse accepts output_config.format from zodOutputFormat
        // and attaches parsed_output to the response. We type the call loosely to
        // avoid pinning to internal helper generics.
        (sdk.messages.parse as unknown as MessagesParseFn)(args);
    }
  }

  async call(args: {
    systemPrompt: string;
    rawItems: readonly RawItem[];
  }): Promise<CurationCallResult> {
    const userContent = formatItemsPayload(args.rawItems);
    const format =
      this.outputFormatOverride ?? zodOutputFormat(CurationResponseSchema);
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
