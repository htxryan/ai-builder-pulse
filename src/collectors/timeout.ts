export const DEFAULT_COLLECTOR_TIMEOUT_MS = 60_000;

export class CollectorTimeoutError extends Error {
  constructor(source: string, ms: number) {
    super(`collector ${source} timed out after ${ms}ms`);
    this.name = "CollectorTimeoutError";
  }
}

export async function withTimeout<T>(
  source: string,
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort(parent?.reason);
  if (parent?.aborted) {
    ac.abort(parent.reason);
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    ac.abort(new CollectorTimeoutError(source, ms));
  }, ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
