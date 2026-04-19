// DA-Un-05 runtime version-drift check.
//
// The DeepAgents curator depends on four packages whose APIs churn between
// minor versions (deepagents, @langchain/langgraph, @langchain/anthropic,
// @langchain/core). The Phase-2 spec pins them to exact versions in
// package.json. This guard verifies at module load that the *installed*
// versions actually match the pins — if a developer or CI resolves a
// different tree (pnpm patch, yanked upstream, manual hack), we fail fast
// with an actionable error instead of failing mid-chunk in a mysterious way.
//
// Implementation notes (per advisory P2-4):
//   - We use `import.meta.resolve` to find each package's `package.json` on
//     disk. Under pnpm's content-addressed store this returns the real path
//     (not a symlink), so version reads are unambiguous.
//   - We read the file with `fs.readFileSync` rather than `import` to avoid
//     pulling the package into the module graph — this keeps the guard cheap
//     and side-effect free.
//
// Adjust PINNED_VERSIONS whenever package.json pins change. A consistency
// test enforces parity between the two so drift can't silently pass review.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Prefer native `import.meta.resolve` (ESM, Node 20+). Fall back to
// `createRequire` so the guard also works under Vitest's SSR transform
// (which doesn't polyfill `import.meta.resolve`) and in any classic CJS
// harness that might ever import this file.
const requireFromHere = createRequire(import.meta.url);

function defaultResolve(specifier: string): string {
  // `import.meta.resolve` may be absent under some test runners.
  const metaResolve = (import.meta as { resolve?: (s: string) => string })
    .resolve;
  if (typeof metaResolve === "function") {
    return metaResolve(specifier);
  }
  // CJS fallback — returns an absolute filesystem path. Normalize to file:
  // URL so downstream code can handle both uniformly.
  const absPath = requireFromHere.resolve(specifier);
  return `file://${absPath}`;
}

export const PINNED_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  deepagents: "1.9.0",
  "@langchain/langgraph": "1.2.9",
  "@langchain/anthropic": "1.3.26",
  "@langchain/core": "1.1.40",
});

export class VersionDriftError extends Error {
  constructor(public readonly mismatches: readonly string[]) {
    super(
      `DeepAgents dep version drift:\n  - ${mismatches.join("\n  - ")}\n` +
        `Fix: run \`pnpm install\` to restore pinned versions, or update ` +
        `src/curator/deepagent/version-guard.ts PINNED_VERSIONS and ` +
        `package.json together.`,
    );
    this.name = "VersionDriftError";
  }
}

/**
 * Read the `version` field from an installed package's `package.json`.
 * Uses `import.meta.resolve` + `fs.readFileSync` so we don't trigger the
 * package's ESM entry (side-effect-free).
 */
export function readInstalledVersion(
  pkg: string,
  resolve: (spec: string) => string = defaultResolve,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  const specifier = `${pkg}/package.json`;
  let url: string;
  try {
    url = resolve(specifier);
  } catch (err) {
    throw new Error(
      `Cannot resolve ${specifier}: ${(err as Error).message}. ` +
        `Is the package installed?`,
    );
  }
  const path = url.startsWith("file:") ? fileURLToPath(url) : url;
  const raw = read(path);
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${pkg}/package.json is missing a string "version" field`);
  }
  return parsed.version;
}

/**
 * Verify every pin in `pins` matches the installed version. Throws
 * `VersionDriftError` listing all mismatches (never silently returns).
 *
 * Accepts optional resolve/read hooks so tests can simulate drift or
 * a missing package without mutating the real filesystem.
 */
export function assertPinnedVersions(
  pins: Readonly<Record<string, string>> = PINNED_VERSIONS,
  resolve?: (spec: string) => string,
  read?: (path: string) => string,
): void {
  const mismatches: string[] = [];
  for (const [pkg, expected] of Object.entries(pins)) {
    let actual: string;
    try {
      actual = readInstalledVersion(pkg, resolve, read);
    } catch (err) {
      mismatches.push(`${pkg}: ${(err as Error).message}`);
      continue;
    }
    if (actual !== expected) {
      mismatches.push(`${pkg}: expected ${expected}, got ${actual}`);
    }
  }
  if (mismatches.length > 0) {
    throw new VersionDriftError(mismatches);
  }
}
