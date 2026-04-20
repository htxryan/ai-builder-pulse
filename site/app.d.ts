// Type surface for site/app.js. The runtime module is plain vanilla JS
// (no build step), so this hand-written declaration file keeps TypeScript
// consumers (specifically the vitest suite under `tests/site/`) honest.

export interface LatestPointerLite {
  date: string;
  path: string;
  publishId: string;
  publishedAt: string;
}

export interface ItemsPayloadLite {
  runDate?: string;
  publishId?: string;
  publishedAt?: string;
  itemCount?: { total?: number; kept?: number };
  items: unknown[];
}

export function loadLatest(): Promise<{
  source: "cache" | "network" | "fallback";
  pointer?: LatestPointerLite;
  error?: unknown;
}>;

export function wireSignupForms(root?: Document | Element): void;

export const __test: {
  parsePointer: (obj: unknown) => LatestPointerLite | null;
  parseItemsJson: (obj: unknown) => ItemsPayloadLite | null;
  pickTopPick: (items: unknown[]) => Record<string, unknown> | null;
  categoryCounts: (items: unknown[]) => Array<[string, number]>;
  sourceLabel: (item: { source?: string; metadata?: { subreddit?: string } }) => string;
  safeExternalHref: (url: unknown) => string;
  ARCHIVE_FALLBACK_URL: string;
  CACHE_KEY: string;
  CACHE_TTL_MS: number;
  POINTER_PATH: string;
};
