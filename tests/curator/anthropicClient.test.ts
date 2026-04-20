import { describe, it, expect, afterEach } from "vitest";
import { AnthropicCurationClient } from "../../src/curator/anthropicClient.js";
import type {
  MessagesParseArgs,
  MessagesParseResult,
} from "../../src/curator/anthropicClient.js";
import { MODEL_PIN } from "../../src/curator/prompt.js";
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

describe("AnthropicCurationClient", () => {
  it("O-03: attaches cache_control ephemeral to the system block", async () => {
    const captured: MessagesParseArgs[] = [];
    const client = new AnthropicCurationClient({
      outputFormat: { type: "stub" },
      messagesParse: async (args): Promise<MessagesParseResult> => {
        captured.push(args);
        return {
          parsed_output: {
            items: args.messages[0]!.content.includes("id: a")
              ? [
                  {
                    id: "a",
                    category: "Tools & Launches",
                    relevanceScore: 0.5,
                    keep: true,
                    description:
                      "A valid description that meets the minimum-length requirement for Zod parse in curation.",
                  },
                ]
              : [],
          },
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    });

    await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });

    expect(captured.length).toBe(1);
    const { system } = captured[0]!;
    expect(Array.isArray(system)).toBe(true);
    expect(system.length).toBe(1);
    expect(system[0]!.type).toBe("text");
    expect(system[0]!.text).toBe("SYS");
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("propagates cache_read_input_tokens when present in usage", async () => {
    const client = new AnthropicCurationClient({
      outputFormat: { type: "stub" },
      messagesParse: async (): Promise<MessagesParseResult> => ({
        parsed_output: {
          items: [
            {
              id: "a",
              category: "Tools & Launches",
              relevanceScore: 0.5,
              keep: true,
              description:
                "A valid description that meets the minimum-length requirement for Zod parse in curation.",
            },
          ],
        },
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 25,
        },
      }),
    });

    const r = await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
    expect(r.cacheReadInputTokens).toBe(150);
    expect(r.cacheCreationInputTokens).toBe(25);
    expect(r.inputTokens).toBe(200);
    expect(r.outputTokens).toBe(50);
  });

  it("leaves cache fields undefined when usage omits them", async () => {
    const client = new AnthropicCurationClient({
      outputFormat: { type: "stub" },
      messagesParse: async (): Promise<MessagesParseResult> => ({
        parsed_output: {
          items: [
            {
              id: "a",
              category: "Tools & Launches",
              relevanceScore: 0.5,
              keep: true,
              description:
                "A valid description that meets the minimum-length requirement for Zod parse in curation.",
            },
          ],
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    const r = await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
    expect(r.cacheReadInputTokens).toBeUndefined();
    expect(r.cacheCreationInputTokens).toBeUndefined();
  });

  describe("CURATOR_MODEL_OVERRIDE", () => {
    const PRIOR = process.env["CURATOR_MODEL_OVERRIDE"];
    afterEach(() => {
      if (PRIOR === undefined) delete process.env["CURATOR_MODEL_OVERRIDE"];
      else process.env["CURATOR_MODEL_OVERRIDE"] = PRIOR;
    });

    async function captureModel(): Promise<string> {
      const captured: MessagesParseArgs[] = [];
      const client = new AnthropicCurationClient({
        outputFormat: { type: "stub" },
        messagesParse: async (args): Promise<MessagesParseResult> => {
          captured.push(args);
          return {
            parsed_output: {
              items: [
                {
                  id: "a",
                  category: "Tools & Launches",
                  relevanceScore: 0.5,
                  keep: true,
                  description:
                    "A valid description that meets the minimum-length requirement for Zod parse in curation.",
                },
              ],
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      });
      await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
      return captured[0]!.model;
    }

    it("falls back to MODEL_PIN when unset", async () => {
      delete process.env["CURATOR_MODEL_OVERRIDE"];
      expect(await captureModel()).toBe(MODEL_PIN);
    });

    it("flows an alt-provider model id through to the model call", async () => {
      process.env["CURATOR_MODEL_OVERRIDE"] = "anthropic/claude-sonnet-4.5";
      expect(await captureModel()).toBe("anthropic/claude-sonnet-4.5");
    });

    it("opts.env scopes the override lookup (ignores process.env)", async () => {
      // process.env has no override; the scoped env map does. The scoped map
      // must win so a parallel-run caller can isolate config from globals.
      delete process.env["CURATOR_MODEL_OVERRIDE"];
      const captured: MessagesParseArgs[] = [];
      const client = new AnthropicCurationClient({
        env: { CURATOR_MODEL_OVERRIDE: "scoped-only/model-id" },
        outputFormat: { type: "stub" },
        messagesParse: async (args): Promise<MessagesParseResult> => {
          captured.push(args);
          return {
            parsed_output: {
              items: [
                {
                  id: "a",
                  category: "Tools & Launches",
                  relevanceScore: 0.5,
                  keep: true,
                  description:
                    "A valid description that meets the minimum-length requirement for Zod parse in curation.",
                },
              ],
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      });
      await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
      expect(captured[0]!.model).toBe("scoped-only/model-id");
    });

    it("opts.env with no override falls back to MODEL_PIN even when process.env has one", async () => {
      process.env["CURATOR_MODEL_OVERRIDE"] = "anthropic/claude-sonnet-4.5";
      const captured: MessagesParseArgs[] = [];
      const client = new AnthropicCurationClient({
        env: {}, // scoped map has no override
        outputFormat: { type: "stub" },
        messagesParse: async (args): Promise<MessagesParseResult> => {
          captured.push(args);
          return {
            parsed_output: {
              items: [
                {
                  id: "a",
                  category: "Tools & Launches",
                  relevanceScore: 0.5,
                  keep: true,
                  description:
                    "A valid description that meets the minimum-length requirement for Zod parse in curation.",
                },
              ],
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      });
      await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
      expect(captured[0]!.model).toBe(MODEL_PIN);
    });

    it("an explicit opts.model still wins over the env override", async () => {
      process.env["CURATOR_MODEL_OVERRIDE"] = "anthropic/claude-sonnet-4.5";
      const captured: MessagesParseArgs[] = [];
      const client = new AnthropicCurationClient({
        model: "explicit-opts-model",
        outputFormat: { type: "stub" },
        messagesParse: async (args): Promise<MessagesParseResult> => {
          captured.push(args);
          return {
            parsed_output: {
              items: [
                {
                  id: "a",
                  category: "Tools & Launches",
                  relevanceScore: 0.5,
                  keep: true,
                  description:
                    "A valid description that meets the minimum-length requirement for Zod parse in curation.",
                },
              ],
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      });
      await client.call({ systemPrompt: "SYS", rawItems: [raw("a")] });
      expect(captured[0]!.model).toBe("explicit-opts-model");
    });
  });
});
