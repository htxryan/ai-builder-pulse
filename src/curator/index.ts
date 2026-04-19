export type { Curator } from "./mockCurator.js";
export { MockCurator } from "./mockCurator.js";
export {
  ClaudeCurator,
  CountInvariantError,
  CostCeilingError,
  CurationRecordSchema,
  CurationResponseSchema,
  chunkItems,
} from "./claudeCurator.js";
export type {
  CurationCallResult,
  CurationClient,
  ClaudeCuratorOptions,
  CurationRecord,
  CurationResponse,
} from "./claudeCurator.js";
export { AnthropicCurationClient } from "./anthropicClient.js";
export type {
  AnthropicClientOptions,
  MessagesParseArgs,
  MessagesParseFn,
  MessagesParseResult,
} from "./anthropicClient.js";
export {
  verifyLinkIntegrity,
} from "./linkIntegrity.js";
export type {
  LinkIntegrityResult,
  LinkIntegrityOptions,
  LinkViolation,
  LinkViolationKind,
  LinkViolationLocation,
} from "./linkIntegrity.js";
export { SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";

import type { Curator } from "./mockCurator.js";

/** Inputs the factory needs beyond the env map — per-run identifiers. */
export interface SelectCuratorContext {
  readonly runId: string;
  readonly runDate: string;
}

/**
 * Curator backend selection (DC1 routing + DC8 rollback toggle).
 *
 * Priority is:
 *   1. `CURATOR=mock` (or any non-"claude" value) → MockCurator.
 *   2. `CURATOR=claude` + `CURATOR_BACKEND=legacy` → preserved ClaudeCurator
 *      (direct @anthropic-ai/sdk path; sunsets 14 days post-merge).
 *   3. `CURATOR=claude` + (anything else) → DeepAgents-backed curator.
 *
 * **Lazy loading (DA-S-02 / DA-S-03):** The DeepAgents module is imported
 * only when the factory actually selects it. Keeping this factory out of
 * the `src/curator/index.ts` top-level re-exports is what makes the lazy
 * path real — tests can `await selectCurator(...)` with `CURATOR=mock` and
 * observe zero LangChain modules in the require graph.
 */
export async function selectCurator(
  env: NodeJS.ProcessEnv,
  ctx: SelectCuratorContext,
): Promise<Curator> {
  const which = (env.CURATOR ?? "mock").toLowerCase();

  if (which !== "claude") {
    const { MockCurator } = await import("./mockCurator.js");
    return new MockCurator();
  }

  const backend = (env.CURATOR_BACKEND ?? "").toLowerCase();
  if (backend === "legacy") {
    const [{ ClaudeCurator }, { AnthropicCurationClient }] = await Promise.all([
      import("./claudeCurator.js"),
      import("./anthropicClient.js"),
    ]);
    return new ClaudeCurator({
      client: new AnthropicCurationClient(),
      chunkThreshold: parseOptionalPositiveInt(
        env.CURATOR_CHUNK_THRESHOLD,
        50,
        "CURATOR_CHUNK_THRESHOLD",
      ),
      maxUsd: parseOptionalPositiveNumber(
        env.CURATOR_MAX_USD,
        1.0,
        "CURATOR_MAX_USD",
      ),
    });
  }

  // Default Claude path → DeepAgents. Importing this module runs the
  // version-guard (DA-Un-05) synchronously at module init — a version-pin
  // drift will surface here, not mid-chunk.
  const { DeepAgentCurator, parseDeepAgentConfig } = await import(
    "./deepagent/index.js"
  );
  return new DeepAgentCurator({
    runId: ctx.runId,
    runDate: ctx.runDate,
    config: parseDeepAgentConfig(env),
  });
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid env ${name}=${raw} (expected positive integer)`);
  }
  return n;
}

function parseOptionalPositiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid env ${name}=${raw} (expected positive number > 0)`,
    );
  }
  return n;
}
