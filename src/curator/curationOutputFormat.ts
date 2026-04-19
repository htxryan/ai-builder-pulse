// Hand-authored output format for messages.parse. Replaces the SDK's
// `zodOutputFormat()` helper, which imports `zod/v4` internals and throws
// `Cannot read properties of undefined (reading 'def')` when passed a Zod v3
// schema (this project pins Zod v3). The SDK only requires an object with
// `{ type: 'json_schema', schema, parse? }` — see `lib/parser.mjs` — so we
// supply the JSON Schema directly and use the project's Zod v3 schema for
// the parse callback.
//
// Kept intentionally tight to CurationResponseSchema rather than generic; a
// full Zod v3 → JSON Schema converter would reintroduce the same surface
// area that bit us from the SDK side.

import { CATEGORIES } from "../types.js";
import {
  CurationResponseSchema,
  type CurationResponse,
} from "./claudeCurator.js";

export interface CurationOutputFormat {
  readonly type: "json_schema";
  readonly schema: Record<string, unknown>;
  parse(content: string): CurationResponse;
}

// Mirrors CurationResponseSchema. `additionalProperties: false` matches the
// SDK's `transformJSONSchema` output so behavior is identical to a working
// `zodOutputFormat()` call.
const CURATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "relevanceScore", "keep", "description"],
        properties: {
          id: { type: "string", minLength: 1 },
          category: { type: "string", enum: [...CATEGORIES] },
          relevanceScore: { type: "number", minimum: 0, maximum: 1 },
          keep: { type: "boolean" },
          description: { type: "string", minLength: 1, maxLength: 600 },
        },
      },
    },
  },
};

export function curationOutputFormat(): CurationOutputFormat {
  return {
    type: "json_schema",
    schema: CURATION_JSON_SCHEMA,
    parse(content: string): CurationResponse {
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch (err) {
        throw new Error(
          `Failed to parse structured output as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const result = CurationResponseSchema.safeParse(raw);
      if (!result.success) {
        const issues = result.error.issues
          .slice(0, 5)
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        const more =
          result.error.issues.length > 5
            ? `\n  ... and ${result.error.issues.length - 5} more issue(s)`
            : "";
        throw new Error(
          `Failed to parse structured output: ${result.error.message}\nValidation issues:\n${issues}${more}`,
        );
      }
      return result.data;
    },
  };
}
