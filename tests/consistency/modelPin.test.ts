import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Prevents silent drift between the stack declaration in CLAUDE.md and the
// hardcoded DEFAULT_MODEL in anthropicClient.ts. Either side changing alone
// fails the build — the operator must align both.
describe("model pin consistency (CLAUDE.md ↔ anthropicClient.ts)", () => {
  const root = path.resolve(__dirname, "../..");

  it("DEFAULT_MODEL in anthropicClient.ts matches the model named in CLAUDE.md", () => {
    const claudeMd = readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const client = readFileSync(
      path.join(root, "src/curator/anthropicClient.ts"),
      "utf8",
    );

    const clientMatch = client.match(/DEFAULT_MODEL\s*=\s*"([^"]+)"/);
    expect(
      clientMatch,
      "DEFAULT_MODEL literal not found in anthropicClient.ts",
    ).not.toBeNull();
    const pinned = clientMatch![1]!;

    // Any `claude-sonnet-*` or `claude-opus-*` or `claude-haiku-*` literal in
    // the stack guidance counts as a declared pin. We require at least one
    // match and that the DEFAULT_MODEL appears among them.
    const modelsInMd = new Set(
      (claudeMd.match(/claude-(?:sonnet|opus|haiku)-[0-9a-zA-Z\-]+/g) ?? []),
    );
    expect(
      modelsInMd.size,
      "expected CLAUDE.md to mention at least one claude-* model id",
    ).toBeGreaterThan(0);
    expect(
      modelsInMd.has(pinned),
      `DEFAULT_MODEL "${pinned}" does not match any model named in CLAUDE.md (${[...modelsInMd].join(", ")})`,
    ).toBe(true);
  });
});
