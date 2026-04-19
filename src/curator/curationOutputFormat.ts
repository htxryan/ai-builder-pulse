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

// Numeric/length constraints duplicated from CurationRecordSchema. Exported
// so a unit test can assert the JSON Schema on the wire matches the Zod
// source of truth — see tests/curator/curationOutputFormat.test.ts. If you
// edit CurationRecordSchema, update these too (the test will fail loudly).
export const CURATION_SCHEMA_CONSTRAINTS = {
  idMinLength: 1,
  relevanceScoreMin: 0,
  relevanceScoreMax: 1,
  descriptionMinLength: 1,
  descriptionMaxLength: 600,
} as const;

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
          id: {
            type: "string",
            minLength: CURATION_SCHEMA_CONSTRAINTS.idMinLength,
          },
          category: { type: "string", enum: [...CATEGORIES] },
          relevanceScore: {
            // Anthropic's structured-output schema validator rejects minimum/maximum
            // on number types ("For 'number' type, properties maximum, minimum are not
            // supported"). The [0.0, 1.0] range is enforced by the SYSTEM_PROMPT and
            // the Zod post-parse in parseCurationContent; both are sufficient because
            // the model almost never emits out-of-range floats when the prompt says
            // "float in [0.0, 1.0]". If a value ever drifts out of range the Zod
            // validator fails the chunk, which retries via DA-E-05.
            type: "number",
          },
          keep: { type: "boolean" },
          description: {
            type: "string",
            minLength: CURATION_SCHEMA_CONSTRAINTS.descriptionMinLength,
            maxLength: CURATION_SCHEMA_CONSTRAINTS.descriptionMaxLength,
          },
        },
      },
    },
  },
};

function parseCurationContent(content: string): CurationResponse {
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
}

// Frozen module-level singleton — schema and parse closure don't vary
// between calls, so there's no reason to allocate a new object per
// messages.parse() invocation.
const CURATION_OUTPUT_FORMAT: CurationOutputFormat = Object.freeze({
  type: "json_schema" as const,
  schema: CURATION_JSON_SCHEMA,
  parse: parseCurationContent,
});

export function curationOutputFormat(): CurationOutputFormat {
  return CURATION_OUTPUT_FORMAT;
}
