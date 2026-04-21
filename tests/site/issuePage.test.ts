// Unit tests for `scripts/lib/issuePage.ts`.
//
// Covers the per-issue HTML renderer surface exercised by T3:
//   - canonical + og:url + title metadata
//   - single `<h1>` in the body region
//   - sidebar metadata (stats + category names)
//   - prev/next navigation presence and absence
//   - sanitation pass-through (script tags in the source markdown do not
//     leak into the output — relies on renderMarkdown from T2)
//
// All cases build a minimal `IssuePageInput` directly so these don't
// depend on the real archive tree.

import { describe, it, expect } from "vitest";

import { renderIssuePage } from "../../scripts/lib/issuePage.js";

const CANONICAL = "https://pulse.ryanhenderson.dev";

const SAMPLE_MARKDOWN = [
  "# AI Builder Pulse — 2026-04-19",
  "",
  "Intro paragraph summarising the day.",
  "",
  "## Tools & Launches",
  "",
  "### [Tool A](https://example.com/a)",
  "*GitHub Trending*",
  "",
  "First tool description.",
  "",
  "## Techniques & Patterns",
  "",
  "### [Paper B](https://example.com/b)",
  "*RSS*",
  "",
  "Technique description.",
  "",
  "### [Project C](https://example.com/c)",
  "*Hacker News*",
  "",
  "Project description.",
  "",
].join("\n");

const SAMPLE_ITEMS: readonly unknown[] = [
  {
    id: "a",
    source: "github-trending",
    title: "Tool A",
    url: "https://example.com/a",
    category: "Tools & Launches",
    keep: true,
    relevanceScore: 0.9,
    description: "First tool description.",
  },
  {
    id: "b",
    source: "rss",
    title: "Paper B",
    url: "https://example.com/b",
    category: "Techniques & Patterns",
    keep: true,
    relevanceScore: 0.7,
    description: "Technique description.",
  },
  {
    id: "c",
    source: "hn",
    title: "Project C",
    url: "https://example.com/c",
    category: "Techniques & Patterns",
    keep: true,
    relevanceScore: 0.6,
    description: "Project description.",
  },
];

function countH1s(html: string): number {
  const matches = html.match(/<h1\b/gi);
  return matches ? matches.length : 0;
}

describe("renderIssuePage — metadata", () => {
  it("emits canonical link with the absolute issue URL", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain(
      `<link rel="canonical" href="${CANONICAL}/issues/2026-04-19/" />`,
    );
  });

  it("emits og:url matching the canonical URL", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain(
      `<meta property="og:url" content="${CANONICAL}/issues/2026-04-19/" />`,
    );
  });

  it("emits a single <h1> in the body region", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(countH1s(html)).toBe(1);
  });

  it("uses the markdown H1 as the page title", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain("AI Builder Pulse — 2026-04-19");
  });

  it("falls back to a derived H1 when markdown has no H1", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: "No heading here, just text.",
      items: [],
      canonicalOrigin: CANONICAL,
    });
    // Derived title uses the human-formatted date.
    expect(html).toMatch(/<h1[^>]*>AI Builder Pulse · [A-Za-z]+, [A-Za-z]+ \d+, 2026<\/h1>/);
  });
});

describe("renderIssuePage — sidebar", () => {
  it("shows '3 stories · 2 categories' and both category names", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain("3 stories · 2 categories");
    expect(html).toContain("Tools &amp; Launches");
    expect(html).toContain("Techniques &amp; Patterns");
  });

  it("shows the top pick title linked to its URL", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    // Tool A has the highest relevanceScore.
    expect(html).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">Tool A</a>',
    );
  });

  it("renders the inline signup form with id=signup-issue", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain('id="signup-issue"');
    expect(html).toContain('id="signup-issue-email"');
  });
});

describe("renderIssuePage — prev/next", () => {
  it("renders both anchors when prev and next are provided", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      prev: { date: "2026-04-18" },
      next: { date: "2026-04-20" },
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain('href="/issues/2026-04-18/"');
    expect(html).toContain('href="/issues/2026-04-20/"');
    expect(html).toContain('class="issue-nav__prev"');
    expect(html).toContain('class="issue-nav__next"');
  });

  it("omits prev anchor when prev is undefined", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      next: { date: "2026-04-20" },
      canonicalOrigin: CANONICAL,
    });
    expect(html).not.toContain('class="issue-nav__prev"');
    expect(html).toContain('class="issue-nav__next"');
  });

  it("omits next anchor when next is undefined", () => {
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      prev: { date: "2026-04-18" },
      canonicalOrigin: CANONICAL,
    });
    expect(html).toContain('class="issue-nav__prev"');
    expect(html).not.toContain('class="issue-nav__next"');
  });
});

describe("renderIssuePage — sanitation", () => {
  it("does not leak <script> from markdown source", () => {
    const malicious = [
      "# Title",
      "",
      "<script>alert(1)</script>",
      "",
      "## Section",
      "Safe content.",
    ].join("\n");
    const html = renderIssuePage({
      date: "2026-04-19",
      markdown: malicious,
      items: SAMPLE_ITEMS,
      canonicalOrigin: CANONICAL,
    });
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain("alert(1)");
  });
});

describe("renderIssuePage — determinism", () => {
  it("produces identical output for identical inputs", () => {
    const input = {
      date: "2026-04-19",
      markdown: SAMPLE_MARKDOWN,
      items: SAMPLE_ITEMS,
      prev: { date: "2026-04-18" },
      next: { date: "2026-04-20" },
      canonicalOrigin: CANONICAL,
    };
    expect(renderIssuePage(input)).toBe(renderIssuePage(input));
  });
});
