// Unit tests for `scripts/lib/archivePage.ts`.
//
// Covers the archive index renderer surface:
//   - populated list renders each entry in the given order with the
//     right href, title, and count,
//   - empty array renders the empty-state block (and no `<ul>`),
//   - canonical + og:url both resolve to `<canonicalOrigin>/archive/`.
//
// All cases build `ArchiveEntry[]` directly so these don't depend on
// the real archive tree.

import { describe, it, expect } from "vitest";

import {
  renderArchivePage,
  type ArchiveEntry,
} from "../../scripts/lib/archivePage.js";

const CANONICAL = "https://pulse.ryanhenderson.dev";

describe("renderArchivePage — populated", () => {
  // Caller-sorted newest-first — renderArchivePage preserves order.
  const entries: readonly ArchiveEntry[] = [
    { date: "2026-04-20", title: "AI Builder Pulse — 2026-04-20", keptCount: 18 },
    { date: "2026-04-19", title: "AI Builder Pulse — 2026-04-19", keptCount: 23 },
    { date: "2026-04-18", title: "AI Builder Pulse — 2026-04-18", keptCount: 1 },
  ];

  it("renders each date's anchor with the right href", () => {
    const html = renderArchivePage(entries, CANONICAL);
    expect(html).toContain('href="/issues/2026-04-20/"');
    expect(html).toContain('href="/issues/2026-04-19/"');
    expect(html).toContain('href="/issues/2026-04-18/"');
  });

  it("preserves the caller-provided order (newest-first)", () => {
    const html = renderArchivePage(entries, CANONICAL);
    const i20 = html.indexOf('href="/issues/2026-04-20/"');
    const i19 = html.indexOf('href="/issues/2026-04-19/"');
    const i18 = html.indexOf('href="/issues/2026-04-18/"');
    expect(i20).toBeGreaterThan(-1);
    expect(i19).toBeGreaterThan(i20);
    expect(i18).toBeGreaterThan(i19);
  });

  it("renders the kept-count label for each entry (story/stories pluralization)", () => {
    const html = renderArchivePage(entries, CANONICAL);
    expect(html).toContain("18 stories");
    expect(html).toContain("23 stories");
    expect(html).toContain("1 story");
  });

  it("renders the title text for each entry (HTML-escaped)", () => {
    const tricky: readonly ArchiveEntry[] = [
      { date: "2026-04-20", title: "A <script>alert(1)</script> Title", keptCount: 5 },
    ];
    const html = renderArchivePage(tricky, CANONICAL);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("does not render the empty-state block when entries are present", () => {
    const html = renderArchivePage(entries, CANONICAL);
    expect(html).not.toContain("No issues archived yet.");
    expect(html).toContain("<ul");
  });

  it("is deterministic — same input → identical bytes", () => {
    const a = renderArchivePage(entries, CANONICAL);
    const b = renderArchivePage(entries, CANONICAL);
    expect(a).toBe(b);
  });
});

describe("renderArchivePage — empty", () => {
  it("renders the empty-state block and NOT the list", () => {
    const html = renderArchivePage([], CANONICAL);
    expect(html).toContain("No issues archived yet.");
    expect(html).not.toContain("<ul");
    // CTA points at the Buttondown subscribe landing page so the cold-
    // start page is still useful.
    expect(html).toContain('href="https://buttondown.com/ai-builder-pulse"');
  });
});

describe("renderArchivePage — metadata", () => {
  it("canonical + og:url both point at <canonicalOrigin>/archive/", () => {
    const html = renderArchivePage([], CANONICAL);
    expect(html).toContain(
      `<link rel="canonical" href="${CANONICAL}/archive/" />`,
    );
    expect(html).toContain(
      `<meta property="og:url" content="${CANONICAL}/archive/" />`,
    );
  });

  it('title is "AI Builder Pulse — Archive"', () => {
    const html = renderArchivePage([], CANONICAL);
    expect(html).toContain("<title>AI Builder Pulse \u2014 Archive</title>");
  });

  it("topnav archive link resolves to /archive/ (not Buttondown)", () => {
    const html = renderArchivePage([], CANONICAL);
    expect(html).toMatch(/class="topnav__archive"\s+href="\/archive\/"/);
    expect(html).not.toContain("buttondown.com/ai-builder-pulse/archive");
  });
});
