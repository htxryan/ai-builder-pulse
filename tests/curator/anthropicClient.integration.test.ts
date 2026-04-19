// Integration test for AC #3 on ai-builder-pulse-368: exercises the real
// AnthropicCurationClient against a mocked global fetch (not a stubbed
// messagesParse) so we assert the output_config.format payload the SDK
// sends is well-formed JSON Schema. This is the surface that regressed when
// the SDK's `zodOutputFormat()` helper was fed a Zod v3 schema.

import { describe, it, expect, afterEach, vi } from "vitest";
import { AnthropicCurationClient } from "../../src/curator/anthropicClient.js";
import { CATEGORIES, type RawItem } from "../../src/types.js";

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

describe("AnthropicCurationClient (mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a valid json_schema output_config.format without invoking zodOutputFormat", async () => {
    const captured: { url: string; body: Record<string, unknown> }[] = [];
    const fakeResponse = {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              {
                id: "a",
                category: "Tools & Launches",
                relevanceScore: 0.8,
                keep: true,
                description:
                  "A valid description that passes Zod minLength validation in the curation schema.",
              },
            ],
          }),
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(fakeResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicCurationClient({ apiKey: "sk-test-fake" });

    const result = await client.call({
      systemPrompt: "SYS",
      rawItems: [raw("a")],
    });

    expect(captured.length).toBe(1);
    const { body } = captured[0]!;

    // The output_config.format must round-trip to a JSON schema the API
    // expects. Before the fix, `zodOutputFormat(CurationResponseSchema)`
    // threw inside `new AnthropicCurationClient(...).call(...)` with
    // "Cannot read properties of undefined (reading 'def')" — the call
    // never reached this fetch.
    const outputConfig = body["output_config"] as {
      format?: { type?: string; schema?: Record<string, unknown> };
    };
    expect(outputConfig).toBeDefined();
    expect(outputConfig.format?.type).toBe("json_schema");
    const schema = outputConfig.format?.schema;
    expect(schema).toBeDefined();
    expect(schema?.type).toBe("object");
    const props = schema?.properties as Record<string, unknown>;
    expect(props?.items).toBeDefined();
    const itemsProp = props.items as {
      type: string;
      items: { properties: Record<string, { enum?: string[] }> };
    };
    expect(itemsProp.type).toBe("array");
    // Category enum must match the project's CATEGORIES source of truth.
    expect(itemsProp.items.properties.category?.enum).toEqual([...CATEGORIES]);
    // Required fields line up with CurationRecordSchema.
    const innerRequired = (itemsProp.items as unknown as { required: string[] })
      .required;
    expect(innerRequired.sort()).toEqual(
      ["category", "description", "id", "keep", "relevanceScore"].sort(),
    );

    // End-to-end: records returned, usage propagated.
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.id).toBe("a");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});
