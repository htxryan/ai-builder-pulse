// HN thread suffix for rendered item headers. Derives the HN discussion URL
// from the item id (`hn-<objectID>` per `mapHnHitToRawItem` in collectors/hn.ts)
// and emits a parenthesized markdown link that appends to the primary title
// link: `### [Title](source-url) ([HN](hn-thread-url))`.
//
// Shared between the daily renderer and the weekly digest so both outgoing
// surfaces stay in lockstep (see epic ai-builder-pulse-acr, AC-1/2/3).

import type { ScoredItem } from "../types.js";

const HN_ID_PATTERN = /^hn-(.+)$/;
const HN_ITEM_URL_BASE = "https://news.ycombinator.com/item?id=";

export function hnThreadSuffix(item: ScoredItem): string {
  if (item.source !== "hn") return "";
  const match = HN_ID_PATTERN.exec(item.id);
  if (!match || !match[1]) return "";
  return ` ([HN](${HN_ITEM_URL_BASE}${match[1]}))`;
}
