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
import { parsePositiveInt, parsePositiveNumber } from "../env.js";
import { log } from "../log.js";
import { MODEL_PIN, resolveCuratorModel } from "./prompt.js";

/** Inputs the factory needs beyond the env map — per-run identifiers. */
export interface SelectCuratorContext {
  readonly runId: string;
  readonly runDate: string;
}

/**
 * Curator backend selection (DC1 routing + DC8 rollback toggle).
 *
 * Priority is:
 *   1. `CURATOR=mock` (or any non-"claude" value, including unset) → MockCurator.
 *   2. `CURATOR=claude` (default backend) → `ClaudeCurator`. This preserves
 *      the pre-M1 behavior; the direct `@anthropic-ai/sdk` path remains the
 *      default until the DeepAgents path is promoted in M5.
 *   3. `CURATOR=claude` + `CURATOR_BACKEND=deepagents` → opt-in DeepAgents
 *      curator. Throws `NotYetImplementedError` in M1; real implementation
 *      lands in M2.
 *
 * **Lazy loading (DA-S-02 / DA-S-03):** The DeepAgents module is imported
 * only when the factory actually selects it. Tests can `await selectCurator`
 * with `CURATOR=mock` or the default Claude path and observe zero LangChain
 * modules in the require graph.
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

  // One-shot operator-visible warn when a model override is active. Cost
  // rates + prompt-cache keys assume the pinned model; the override is a
  // dev/demo-only escape hatch and operators running it in prod should see
  // it in the run log before any curator call happens.
  const resolvedModel = resolveCuratorModel(env);
  if (resolvedModel !== MODEL_PIN) {
    log.warn("curator model override active (dev/demo only)", {
      pinned: MODEL_PIN,
      override: resolvedModel,
    });
  }

  const backend = (env.CURATOR_BACKEND ?? "").toLowerCase();
  if (backend === "deepagents") {
    // Opt-in DeepAgents path. Importing this module runs the version-guard
    // (DA-Un-05) synchronously at module init — a version-pin drift will
    // surface here, not mid-chunk.
    const { DeepAgentCurator, parseDeepAgentConfig } = await import(
      "./deepagent/index.js"
    );
    return new DeepAgentCurator({
      runId: ctx.runId,
      runDate: ctx.runDate,
      config: parseDeepAgentConfig(env),
    });
  }

  // Default Claude path → preserved ClaudeCurator (legacy/direct SDK).
  // `CURATOR_BACKEND=legacy` is also accepted as an explicit opt-in for the
  // same path so existing ops runbooks keep working.
  const [{ ClaudeCurator }, { AnthropicCurationClient }] = await Promise.all([
    import("./claudeCurator.js"),
    import("./anthropicClient.js"),
  ]);
  return new ClaudeCurator({
    client: new AnthropicCurationClient({ env }),
    chunkThreshold: parsePositiveInt(
      env.CURATOR_CHUNK_THRESHOLD,
      50,
      "CURATOR_CHUNK_THRESHOLD",
    ),
    maxUsd: parsePositiveNumber(
      env.CURATOR_MAX_USD,
      1.0,
      "CURATOR_MAX_USD",
    ),
  });
}
