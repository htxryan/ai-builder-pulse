import type { RawItem } from "../types.js";
import type { Collector, CollectorContext } from "./types.js";

export interface TwitterStubStatus {
  readonly enabled: boolean;
  readonly reason: "flag_disabled" | "not_implemented_v2";
}

export class TwitterCollector implements Collector {
  readonly source = "twitter";
  async fetch(ctx: CollectorContext): Promise<RawItem[]> {
    const enabled = ctx.env.ENABLE_TWITTER === "1";
    if (!enabled) {
      return [];
    }
    // v2 surface — intentionally not implemented in v1 per O-01.
    throw new Error(
      "twitter collector enabled but not implemented in v1 (O-01 defers to v2)",
    );
  }
}

export function twitterStubStatus(env: NodeJS.ProcessEnv): TwitterStubStatus {
  if (env.ENABLE_TWITTER === "1") {
    return { enabled: true, reason: "not_implemented_v2" };
  }
  return { enabled: false, reason: "flag_disabled" };
}
