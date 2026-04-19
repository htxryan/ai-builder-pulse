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

  it("relevanceScore numeric bounds match Zod .min(0).max(1)", () => {
    const props = getItemProps();
    expect(props.relevanceScore!.minimum).toBe(
      CURATION_SCHEMA_CONSTRAINTS.relevanceScoreMin,
    );
    expect(props.relevanceScore!.maximum).toBe(
      CURATION_SCHEMA_CONSTRAINTS.relevanceScoreMax,
    );
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(-0.01).success).toBe(
      false,
    );
    expect(CurationRecordSchema.shape.relevanceScore.safeParse(1.01).success).toBe(
      false,
    );
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
