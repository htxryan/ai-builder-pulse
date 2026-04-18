import type { RawItem, RunContext } from "../types.js";

export interface CollectorContext {
  readonly runDate: string;
  readonly cutoffMs: number;
  readonly abortSignal: AbortSignal;
  readonly env: NodeJS.ProcessEnv;
}

export interface Collector {
  readonly source: string;
  fetch(ctx: CollectorContext): Promise<RawItem[]>;
}

export function cutoffForRunDate(runDate: string): number {
  const midnight = Date.parse(`${runDate}T00:00:00.000Z`);
  return midnight - 24 * 60 * 60 * 1000;
}

export function makeCollectorContext(
  parent: RunContext,
  abortSignal: AbortSignal,
  env: NodeJS.ProcessEnv,
): CollectorContext {
  return {
    runDate: parent.runDate,
    cutoffMs: cutoffForRunDate(parent.runDate),
    abortSignal,
    env,
  };
}
