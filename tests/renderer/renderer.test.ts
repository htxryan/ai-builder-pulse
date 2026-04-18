import { describe, it, expect } from "vitest";
import {
  renderIssue,
  NEWSLETTER_ARCHIVE_URL,
  NEWSLETTER_HOME_URL,
  RENDERER_TEMPLATE_URL_PATTERNS,
} from "../../src/renderer/index.js";
import { verifyLinkIntegrity } from "../../src/curator/linkIntegrity.js";
import type { RawItem, ScoredItem, Category } from "../../src/types.js";

function makeScored(
  id: string,
  opts: {
    title?: string;
    url?: string;
    category?: Category;
    relevanceScore?: number;
    description?: string;
    keep?: boolean;
  } = {},
): ScoredItem {
  return {
    id,
    source: "hn",
    title: opts.title ?? `Title ${id}`,
    url: opts.url ?? `https://example.com/${id}`,
    score: 10,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" },
    category: opts.category ?? "Tools & Launches",
    relevanceScore: opts.relevanceScore ?? 0.5,
    keep: opts.keep ?? true,
    description:
      opts.description ??
      "A descriptive summary for this item that is long enough to satisfy the schema minimum.",
  };
}

function makeRaw(id: string, url: string): RawItem {
  return {
    id,
    source: "hn",
    title: `Title ${id}`,
    url,
    score: 10,
    publishedAt: "2026-04-18T05:00:00.000Z",
    metadata: { source: "hn" },
  };
}

describe("renderIssue (C5)", () => {
  it("produces subject with runDate and newsletter name", () => {
    const r = renderIssue("2026-04-18", [makeScored("a")]);
    expect(r.subject).toBe("AI Builder Pulse — 2026-04-18");
    expect(r.subject.length).toBeLessThanOrEqual(80);
  });

  it("renders H1 title, story count intro, category headings, footer", () => {
    const r = renderIssue("2026-04-18", [makeScored("a")]);
    expect(r.body).toContain("# AI Builder Pulse — 2026-04-18");
    expect(r.body).toContain("Today: 1 story across 1 category");
    expect(r.body).toContain("## Tools & Launches");
    expect(r.body).toContain("### [Title a](https://example.com/a)");
    expect(r.body).toContain(NEWSLETTER_HOME_URL);
    expect(r.body).toContain(NEWSLETTER_ARCHIVE_URL);
    expect(r.body).toContain("{{unsubscribe_url}}");
  });

  it("pluralizes story and category counts correctly", () => {
    const r = renderIssue("2026-04-18", [
      makeScored("a", { category: "Tools & Launches" }),
      makeScored("b", { category: "Model Releases" }),
    ]);
    expect(r.body).toContain("Today: 2 stories across 2 categories");
  });

  it("groups by category in declared order (U-05)", () => {
    const items = [
      makeScored("n1", { category: "News in Brief" }),
      makeScored("t1", { category: "Tools & Launches" }),
      makeScored("m1", { category: "Model Releases" }),
    ];
    const body = renderIssue("2026-04-18", items).body;
    const toolsIdx = body.indexOf("## Tools & Launches");
    const modelIdx = body.indexOf("## Model Releases");
    const newsIdx = body.indexOf("## News in Brief");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeGreaterThan(toolsIdx);
    expect(newsIdx).toBeGreaterThan(modelIdx);
  });

  it("sorts within category by relevance DESC, id ASC ties (U-05)", () => {
    const items = [
      makeScored("low", { relevanceScore: 0.3 }),
      makeScored("hi-b", { relevanceScore: 0.9 }),
      makeScored("hi-a", { relevanceScore: 0.9 }),
    ];
    const body = renderIssue("2026-04-18", items).body;
    const idxHiA = body.indexOf("Title hi-a");
    const idxHiB = body.indexOf("Title hi-b");
    const idxLow = body.indexOf("Title low");
    expect(idxHiA).toBeGreaterThan(-1);
    expect(idxHiA).toBeLessThan(idxHiB);
    expect(idxHiB).toBeLessThan(idxLow);
  });

  it("omits empty categories", () => {
    const r = renderIssue("2026-04-18", [
      makeScored("a", { category: "Tools & Launches" }),
    ]);
    expect(r.body).not.toContain("## Model Releases");
    expect(r.body).not.toContain("## News in Brief");
  });

  it("handles zero items (renders header + footer only)", () => {
    // S-02 prevents this reaching production, but renderer must be total.
    const r = renderIssue("2026-04-18", []);
    expect(r.body).toContain("no items met the relevance bar");
    expect(r.body).toContain(NEWSLETTER_HOME_URL);
  });

  it("golden-file: deterministic snapshot for fixture input", () => {
    const items = [
      makeScored("t1", {
        title: "Tool One",
        url: "https://example.com/tool1",
        category: "Tools & Launches",
        relevanceScore: 0.9,
        description: "Short description of the first tool.",
      }),
      makeScored("m1", {
        title: "Model X Release",
        url: "https://example.com/model-x",
        category: "Model Releases",
        relevanceScore: 0.8,
        description: "A new model with interesting properties.",
      }),
    ];
    const r = renderIssue("2026-04-18", items);
    expect(r).toMatchSnapshot();
  });

  it("Un-01: rendered body passes link-integrity with allowlist", () => {
    const raws = [makeRaw("a", "https://example.com/a")];
    const scoreds = [makeScored("a")];
    const integrity = verifyLinkIntegrity(
      scoreds,
      raws,
      RENDERER_TEMPLATE_URL_PATTERNS,
    );
    expect(integrity.ok).toBe(true);
  });

  it("escapes `[` and `]` inside titles to keep markdown link syntax intact", () => {
    const r = renderIssue("2026-04-18", [
      makeScored("a", { title: "React [beta] release [PDF]" }),
    ]);
    // The header uses `### [LABEL](URL)`. Unescaped inner `]` would terminate
    // the label early. Escaped form keeps the literal title in the label.
    expect(r.body).toContain(
      "### [React \\[beta\\] release \\[PDF\\]](https://example.com/a)",
    );
  });

  it("percent-encodes `)` in URLs so the markdown link destination is balanced", () => {
    const r = renderIssue("2026-04-18", [
      makeScored("a", { url: "https://en.wikipedia.org/wiki/Foo_(bar)" }),
    ]);
    expect(r.body).toContain(
      "(https://en.wikipedia.org/wiki/Foo_(bar%29)",
    );
  });

  it("allowlist matches newsletter home and archive URLs", () => {
    const matchesAny = (url: string): boolean =>
      RENDERER_TEMPLATE_URL_PATTERNS.some((p) => p.test(url));
    expect(matchesAny(NEWSLETTER_HOME_URL)).toBe(true);
    expect(matchesAny(NEWSLETTER_ARCHIVE_URL)).toBe(true);
    expect(
      matchesAny(
        "https://buttondown.com/emails/abc-123-token/unsubscribe",
      ),
    ).toBe(true);
    expect(matchesAny("https://evil.example.com/hijack")).toBe(false);
  });
});
