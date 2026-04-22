// HN thread suffix for rendered item headers. Derives the HN discussion URL
// from the item id (`hn-<objectID>` per `mapHnHitToRawItem` in collectors/hn.ts)
// and emits a parenthesized markdown link that appends to the primary title
// link: `### [Title](source-url) ([HN](hn-thread-url))`.
//
// Shared between the daily renderer and the weekly digest so both outgoing
// surfaces stay in lockstep (see epic ai-builder-pulse-acr, AC-1/2/3).

import type { ScoredItem } from "../types.js";

// Restricted to URL-safe chars only. HN Algolia objectIDs are numeric strings
// in practice, but `z.string()` in the collector schema does not enforce that.
// A `)` inside an unescaped objectID would terminate the markdown link
// destination early and corrupt the rendered body. By allowing only
// `[A-Za-z0-9_-]+` here, malformed ids fall through to R5's no-suffix path
// rather than emitting broken markdown.
const HN_ID_PATTERN = /^hn-([A-Za-z0-9_-]+)$/;

export function hnThreadSuffix(item: ScoredItem): string {
  if (item.source !== "hn") return "";
  const match = HN_ID_PATTERN.exec(item.id);
  if (!match || !match[1]) return "";
  return ` ([HN](https://news.ycombinator.com/item?id=${match[1]}))`;
}
