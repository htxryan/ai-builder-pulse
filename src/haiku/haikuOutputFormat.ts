// Hand-authored output format for the Haiku pre-filter `messages.parse`
// call. Mirrors the curator's `curationOutputFormat.ts` approach:
// supply a JSON Schema directly (the SDK's `zodOutputFormat()` helper
// imports `zod/v4` internals that crash on this project's Zod v3 schemas)
// and a parse callback that runs the Zod v3 schema as the source of truth.

import { z } from "zod";

export const HaikuRecordSchema = z.object({
  id: z.string().min(1),
  keep: z.boolean(),
});
export type HaikuRecord = z.infer<typeof HaikuRecordSchema>;

export const HaikuResponseSchema = z.object({
  items: z.array(HaikuRecordSchema),
});
export type HaikuResponse = z.infer<typeof HaikuResponseSchema>;

export interface HaikuOutputFormat {
  readonly type: "json_schema";
  readonly schema: Record<string, unknown>;
  parse(content: string): HaikuResponse;
}

const HAIKU_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "keep"],
        properties: {
          id: { type: "string", minLength: 1 },
          keep: { type: "boolean" },
        },
      },
    },
  },
};

function parseHaikuContent(content: string): HaikuResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse Haiku structured output as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = HaikuResponseSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Failed to parse Haiku structured output:\n${issues}`,
    );
  }
  return result.data;
}

const HAIKU_OUTPUT_FORMAT: HaikuOutputFormat = Object.freeze({
  type: "json_schema" as const,
  schema: HAIKU_JSON_SCHEMA,
  parse: parseHaikuContent,
});

export function haikuOutputFormat(): HaikuOutputFormat {
  return HAIKU_OUTPUT_FORMAT;
}
