#!/usr/bin/env node
// Type-safety gate. Counts occurrences of `as unknown`, `as unknown as`,
// `@ts-ignore`, and `@ts-nocheck` across src/ and fails if the total exceeds
// a committed baseline. Surviving casts MUST carry an inline justification
// comment on the same or preceding line — the grep itself doesn't parse
// comments, so the baseline is the authoritative ceiling.
//
// Bump the BASELINE only when you've reviewed the new cast and recorded a
// single-line reason in the code.
//
// Usage: `node scripts/check-unchecked-casts.mjs` (runs under `pnpm check:casts`).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");

// PATTERNS intentionally match the textual forms callers use. `as unknown`
// catches `as unknown`, `as unknown as X`, and `as unknown[]`; the other
// two match the line-level escape hatches TS offers.
const PATTERNS = [/\bas unknown\b/, /@ts-ignore\b/, /@ts-nocheck\b/];

// Ceiling:
//   1. `as unknown as MessagesParseFn` in anthropicClient.ts — the SDK's
//      generic `messages.parse` does not structurally simplify to the
//      testable adapter shape.
//   2. `as unknown as InteropZodType<...>` in deepagent/adapter.ts — zod
//      v3 declares `description: string | undefined` (explicit-union)
//      while LangChain's `InteropZodType` / `ZodV3Like` declares
//      `description?: string` (implicit-optional). With
//      `exactOptionalPropertyTypes: true` the two do not unify. Runtime
//      is correct; the cast is documented inline at the call site.
//   3-4. Two `as unknown as InteropZodObject` on the M4 tool schemas
//      (fetchUrlStatus, readRawItem) — same root cause as #2. The `tool()`
//      factory's schema parameter resolves to the same `ZodV3Like` bound.
// Any additional occurrence fails CI.
const BASELINE = 4;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = walk(SRC_DIR);
const hits = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PATTERNS.some((p) => p.test(line))) {
      hits.push({ file: path.relative(path.resolve(__dirname, ".."), f), line: i + 1, text: line.trim() });
    }
  }
}

const count = hits.length;
console.log(`[check:casts] found ${count} occurrence(s); baseline = ${BASELINE}`);
for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);

if (count > BASELINE) {
  console.error(
    `\n[check:casts] FAIL: ${count} > ${BASELINE}. Either remove the new cast or, if unavoidable, ` +
      `add a single-line comment explaining the external type-system constraint and bump BASELINE.`,
  );
  process.exit(1);
}
process.exit(0);
