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

export function isPublicHttpUrl(candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") return false;
  if (host.endsWith(".localhost")) return false;
  // IPv6 loopback / link-local / unique-local
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1);
    if (inner === "::1" || inner === "::") return false;
    if (inner.startsWith("fe80:") || inner.startsWith("fc") || inner.startsWith("fd")) return false;
  }
  // IPv4 private/loopback/link-local
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false; // multicast + reserved
  }
  return true;
}

export async function resolveRedirects(
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolvedUrl> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!isPublicHttpUrl(input)) return { url: input };
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
    if (!isPublicHttpUrl(resolved)) break; // SSRF guard: reject private/loopback/link-local
    visited.add(resolved);
    current = resolved;
    hops += 1;
  }
  if (current === input) return { url: input };
  return { url: current, sourceUrl: input };
}
