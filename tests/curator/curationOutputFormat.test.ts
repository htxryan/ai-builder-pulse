// Schema-drift guard. The hand-authored JSON Schema in
// curationOutputFormat.ts mirrors constraints from CurationRecordSchema.
// These assertions fail loudly if one side is edited without the other so
// Claude never receives a wire schema that disagrees with what we validate.

import { describe, it, expect } from "vitest";
import {
  curationOutputFormat,
  CURATION_SCHEMA_CONSTRAINTS,
} from "../../src/curator/curationOutputFormat.js";
import { CurationRecordSchema } from "../../src/curator/claudeCurator.js";
import { CATEGORIES } from "../../src/types.js";

function getItemProps(): Record<string, Record<string, unknown>> {
  const fmt = curationOutputFormat();
  const schema = fmt.schema as {
    properties: {
      items: {
        items: { properties: Record<string, Record<string, unknown>> };
      };
    };
  };
  return schema.properties.items.items.properties;
}

describe("curationOutputFormat — JSON Schema matches CurationRecordSchema", () => {
  it("id.minLength matches Zod .min(1)", () => {
    const props = getItemProps();
    expect(props.id!.minLength).toBe(CURATION_SCHEMA_CONSTRAINTS.idMinLength);
    // Confirm the Zod source is also .min(1) so the constants stay honest.
    expect(CurationRecordSchema.shape.id.safeParse("").success).toBe(false);
    expect(CurationRecordSchema.shape.id.safeParse("x").success).toBe(true);
  });

  it("relevanceScore has NO minimum/maximum on JSON Schema (Anthropic rejects them); Zod still enforces [0,1]", () => {
    // Regression guard. Anthropic's structured-output validator rejects
    // minimum/maximum on number-typed properties with
    //   "For 'number' type, properties maximum, minimum are not supported".
    // The first live production run on 2026-04-19 hit a 400 on every chunk
    // because these were present. A future cleanup refactor could easily
    // re-add them from CurationRecordSchema — this test catches that.
    const props = getItemProps();
    expect(props.relevanceScore!.type).toBe("number");
    expect(props.relevanceScore).not.toHaveProperty("minimum");
    expect(props.relevanceScore).not.toHaveProperty("maximum");
    // Zod remains the enforcement point for the [0,1] range.
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(-0.01).success).toBe(
      false,
    );
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(1.01).success).toBe(
      false,
    );
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(0).success).toBe(
      true,
    );
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(1).success).toBe(
      true,
    );
  });

  it("no number-typed property anywhere in the JSON Schema has minimum/maximum", () => {
    // Generalization of the regression guard above: walk the entire schema
    // tree and assert that every {type:"number"} node lacks min/max. Covers
    // any future numeric field that might be added.
    const fmt = curationOutputFormat();
    const violations: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "number") {
        if ("minimum" in obj) violations.push(`${path}.minimum`);
        if ("maximum" in obj) violations.push(`${path}.maximum`);
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, path === "" ? k : `${path}.${k}`);
      }
    };
    walk(fmt.schema, "");
    expect(violations).toEqual([]);
  });

  it("description.minLength / maxLength match Zod .min(1).max(600)", () => {
    const props = getItemProps();
    expect(props.description!.minLength).toBe(
      CURATION_SCHEMA_CONSTRAINTS.descriptionMinLength,
    );
    expect(props.description!.maxLength).toBe(
      CURATION_SCHEMA_CONSTRAINTS.descriptionMaxLength,
    );
    expect(CurationRecordSchema.shape.description.safeParse("").success).toBe(
      false,
    );
    expect(
      CurationRecordSchema.shape.description.safeParse("x".repeat(600)).success,
    ).toBe(true);
    expect(
      CurationRecordSchema.shape.description.safeParse("x".repeat(601)).success,
    ).toBe(false);
  });

  it("category enum matches the CATEGORIES source of truth", () => {
    const props = getItemProps();
    expect(props.category!.enum).toEqual([...CATEGORIES]);
  });

  it("required fields list all five record properties", () => {
    const fmt = curationOutputFormat();
    const schema = fmt.schema as {
      properties: { items: { items: { required: string[] } } };
    };
    expect([...schema.properties.items.items.required].sort()).toEqual(
      ["category", "description", "id", "keep", "relevanceScore"].sort(),
    );
  });

  it("returns the same frozen singleton across calls (no per-call allocation)", () => {
    const a = curationOutputFormat();
    const b = curationOutputFormat();
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe("curationOutputFormat — Anthropic validator stub (integration)", () => {
  // Mimics the subset of Anthropic's structured-output schema validator that
  // bit us on 2026-04-19: reject `minimum` / `maximum` on number-typed
  // nodes. String-length constraints (`minLength` / `maxLength`) ARE
  // supported and must pass through. End-to-end guard that the real
  // `curationOutputFormat()` output would not be 400'd by the API.
  function anthropicValidate(schema: unknown): string[] {
    const errors: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "number") {
        const unsupported = ["minimum", "maximum"].filter((k) => k in obj);
        if (unsupported.length > 0) {
          errors.push(
            `${path || "<root>"}: For 'number' type, properties ${unsupported.join(", ")} are not supported`,
          );
        }
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, path === "" ? k : `${path}.${k}`);
      }
    };
    walk(schema, "");
    return errors;
  }

  it("control: stub fails a schema that includes minimum/maximum on a number", () => {
    const bad = {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 1 },
      },
    };
    const errors = anthropicValidate(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(
      /For 'number' type, properties .* are not supported/,
    );
  });

  it("control: stub accepts minLength/maxLength on a string", () => {
    const ok = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 10 },
      },
    };
    expect(anthropicValidate(ok)).toEqual([]);
  });

  it("real curationOutputFormat() schema passes the Anthropic stub validator", () => {
    const fmt = curationOutputFormat();
    expect(anthropicValidate(fmt.schema)).toEqual([]);
  });
});

describe("curationOutputFormat — parse callback", () => {
  it("throws on non-JSON content", () => {
    const fmt = curationOutputFormat();
    expect(() => fmt.parse("not json")).toThrow(
      /Failed to parse structured output as JSON/,
    );
  });

  it("throws on JSON that violates CurationResponseSchema", () => {
    const fmt = curationOutputFormat();
    const badPayload = JSON.stringify({
      items: [
        {
          id: "a",
          category: "Not A Real Category",
          relevanceScore: 2,
          keep: true,
          description: "",
        },
      ],
    });
    expect(() => fmt.parse(badPayload)).toThrow(
      /Failed to parse structured output/,
    );
  });

  it("returns validated data on a well-formed payload", () => {
    const fmt = curationOutputFormat();
    const good = JSON.stringify({
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
    });
    const parsed = fmt.parse(good);
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0]!.id).toBe("a");
  });
});
