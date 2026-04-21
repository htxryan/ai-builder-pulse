// AI Builder Pulse — brochure site client
// ---------------------------------------
// One-shot JS: read issues/latest.json, then the referenced items.json,
// populate the hero preview. localStorage cache with a 15min TTL. Every
// fetch path has a graceful fallback linking to the on-site archive.

const ARCHIVE_FALLBACK_URL = "/archive/";
const CACHE_KEY = "abp:latest:v1";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const POINTER_PATH = "./latest.json"; // served from the artifact root

// --- utilities -------------------------------------------------------------

function now() {
  return Date.now();
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.ts !== "number") return null;
    if (now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(pointer, items) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: now(), pointer, items }),
    );
  } catch {
    // quota exceeded or private mode — non-fatal
  }
}

// Narrow zod-style validation without shipping zod. Returns null on invalid.
// The `path` field is interpolated into a fetch URL (`./${path}items.json`),
// so we defend against path traversal here — a crafted `latest.json` could
// otherwise escape the archive subtree. Same-origin makes this low-risk in
// practice, but the guard keeps the contract tight.
function parsePointer(obj) {
  if (!obj || typeof obj !== "object") return null;
  const { date, path, publishId, publishedAt } = obj;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof path !== "string" || !path.startsWith("issues/") || !path.endsWith("/")) return null;
  if (path.includes("..") || path.includes("//")) return null;
  if (typeof publishId !== "string" || publishId.length === 0) return null;
  if (typeof publishedAt !== "string") return null;
  return { date, path, publishId, publishedAt };
}

// Accept only plain http(s) URLs for anything we interpolate into an `href`.
// `javascript:` / `data:` URLs in a curated item (or a poisoned items.json)
// would otherwise become executable when a visitor clicks through.
function safeExternalHref(url) {
  if (typeof url !== "string" || url.length === 0) return "#";
  try {
    const u = new URL(url, "https://example.invalid/");
    if (u.protocol !== "http:" && u.protocol !== "https:") return "#";
    return url;
  } catch {
    return "#";
  }
}

function parseItemsJson(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!Array.isArray(obj.items)) return null;
  return obj;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function pickTopPick(items) {
  const kept = items.filter((i) => i && i.keep === true);
  if (kept.length === 0) return null;
  // Sort by relevanceScore desc, break ties by score desc. Matches how the
  // renderer tends to present the top pick (the structured record doesn't
  // carry an explicit flag, so this is a best-effort preview).
  kept.sort((a, b) => {
    const ra = typeof a.relevanceScore === "number" ? a.relevanceScore : 0;
    const rb = typeof b.relevanceScore === "number" ? b.relevanceScore : 0;
    if (rb !== ra) return rb - ra;
    const sa = typeof a.score === "number" ? a.score : 0;
    const sb = typeof b.score === "number" ? b.score : 0;
    return sb - sa;
  });
  return kept[0];
}

function categoryCounts(items) {
  const counts = new Map();
  for (const it of items) {
    if (!it || it.keep !== true) continue;
    const cat = typeof it.category === "string" ? it.category : "Uncategorized";
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function sourceLabel(item) {
  const s = item.source;
  if (s === "hn") return "Hacker News";
  if (s === "github-trending") return "GitHub Trending";
  if (s === "reddit") {
    const sub = item.metadata && item.metadata.subreddit;
    return sub ? `r/${sub}` : "Reddit";
  }
  if (s === "rss") return "RSS";
  if (s === "twitter") return "Twitter";
  return s || "";
}

function formatDateHuman(iso) {
  try {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

// --- rendering -------------------------------------------------------------

function $(selector, root = document) {
  return root.querySelector(selector);
}

function renderPreview(pointer, payload) {
  const skeleton = document.querySelector("[data-latest-skeleton]");
  const content = document.querySelector("[data-latest-content]");
  const fallback = document.querySelector("[data-latest-fallback]");
  const meta = document.querySelector("[data-latest-meta]");

  const items = payload.items || [];
  const top = pickTopPick(items);
  const counts = categoryCounts(items);

  if (meta) {
    const kept = (payload.itemCount && payload.itemCount.kept) || items.filter((i) => i && i.keep).length;
    meta.textContent = `${formatDateHuman(pointer.date)} · ${kept} stories · ${counts.length} categories`;
  }

  if (top) {
    const linkEl = document.querySelector("[data-latest-toppick-link]");
    const sourceEl = document.querySelector("[data-latest-toppick-source]");
    const descEl = document.querySelector("[data-latest-toppick-desc]");
    if (linkEl) {
      linkEl.textContent = top.title || "(untitled)";
      linkEl.href = safeExternalHref(top.url);
      linkEl.setAttribute("target", "_blank");
      linkEl.setAttribute("rel", "noopener noreferrer");
    }
    if (sourceEl) sourceEl.textContent = sourceLabel(top);
    if (descEl) descEl.textContent = top.description || "";
  }

  const list = document.querySelector("[data-latest-categories]");
  if (list) {
    list.innerHTML = "";
    for (const [name, count] of counts) {
      const li = document.createElement("li");
      const lhs = document.createElement("span");
      lhs.textContent = name;
      const rhs = document.createElement("span");
      rhs.textContent = String(count);
      li.appendChild(lhs);
      li.appendChild(rhs);
      list.appendChild(li);
    }
  }

  const readFull = document.querySelector("[data-latest-read-full]");
  if (readFull) {
    // Same-origin link into the deployed issues tree. The artifact assembler
    // copies `issues/<date>/` under `/issues/<date>/` so this resolves to the
    // rendered issue page (T2/T3 convert the markdown to HTML). Using a
    // relative path keeps the brochure portable across preview deploys.
    readFull.href = `/${pointer.path}`;
  }

  if (skeleton) skeleton.hidden = true;
  if (fallback) fallback.hidden = true;
  if (content) content.hidden = false;
}

function renderFallback() {
  const skeleton = document.querySelector("[data-latest-skeleton]");
  const content = document.querySelector("[data-latest-content]");
  const fallback = document.querySelector("[data-latest-fallback]");
  const meta = document.querySelector("[data-latest-meta]");
  if (skeleton) skeleton.hidden = true;
  if (content) content.hidden = true;
  if (fallback) fallback.hidden = false;
  if (meta) meta.textContent = "browse the archive for the latest issue";
}

// --- main flow -------------------------------------------------------------

export async function loadLatest() {
  const cached = readCache();
  if (cached) {
    try {
      renderPreview(cached.pointer, cached.items);
      return { source: "cache", pointer: cached.pointer };
    } catch {
      // fall through to network
    }
  }

  try {
    const pointerRaw = await fetchJson(POINTER_PATH);
    const pointer = parsePointer(pointerRaw);
    if (!pointer) throw new Error("invalid pointer shape");

    const itemsRaw = await fetchJson(`./${pointer.path}items.json`);
    const items = parseItemsJson(itemsRaw);
    if (!items) throw new Error("invalid items.json shape");

    renderPreview(pointer, items);
    writeCache(pointer, items);
    return { source: "network", pointer };
  } catch (err) {
    // Intentional: fail soft and show the archive fallback. Log at debug
    // level so devtools surfaces the reason without spamming users.
    if (typeof console !== "undefined" && console.debug) {
      console.debug("[abp] latest fetch failed:", err && err.message);
    }
    renderFallback();
    return { source: "fallback", error: err };
  }
}

// --- signup form wiring ----------------------------------------------------

export function wireSignupForms(root = document) {
  const forms = root.querySelectorAll(
    'form[action^="https://buttondown.com/api/emails/embed-subscribe/"]',
  );
  forms.forEach((form) => {
    form.addEventListener("submit", (e) => {
      // Let Buttondown's target="popupwindow" behavior handle the open; we
      // only surface the inline success line once the browser has handed
      // off. If native validity blocks submission, this handler won't fire.
      const success = form.querySelector("[data-signup-success]");
      if (!success) return;
      // Delay the reveal by one frame so the popup has time to open.
      requestAnimationFrame(() => {
        success.hidden = false;
      });
    });
  });
}

// --- auto-init -------------------------------------------------------------

if (typeof window !== "undefined") {
  // Defer until after parse; script is `type=module` so this fires after DOM.
  wireSignupForms();
  loadLatest();
}

// Also export internals for testing.
export const __test = {
  parsePointer,
  parseItemsJson,
  pickTopPick,
  categoryCounts,
  sourceLabel,
  safeExternalHref,
  ARCHIVE_FALLBACK_URL,
  CACHE_KEY,
  CACHE_TTL_MS,
  POINTER_PATH,
};
