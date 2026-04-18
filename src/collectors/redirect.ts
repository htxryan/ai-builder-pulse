export const MAX_REDIRECT_HOPS = 3;

export interface ResolvedUrl {
  readonly url: string;
  readonly sourceUrl?: string;
}

export interface ResolveOptions {
  readonly signal?: AbortSignal;
  readonly maxHops?: number;
  readonly fetchImpl?: typeof fetch;
}

function shouldFollow(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export async function resolveRedirects(
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolvedUrl> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const visited = new Set<string>([input]);
  let current = input;
  let hops = 0;
  while (hops < maxHops) {
    let res: Response;
    const init: RequestInit = {
      method: "HEAD",
      redirect: "manual",
    };
    if (opts.signal) init.signal = opts.signal;
    try {
      res = await fetchImpl(current, init);
    } catch {
      break;
    }
    if (!shouldFollow(res.status)) break;
    const next = res.headers.get("location");
    if (!next) break;
    let resolved: string;
    try {
      resolved = new URL(next, current).toString();
    } catch {
      break;
    }
    if (visited.has(resolved)) break; // loop detected
    visited.add(resolved);
    current = resolved;
    hops += 1;
  }
  if (current === input) return { url: input };
  return { url: current, sourceUrl: input };
}
