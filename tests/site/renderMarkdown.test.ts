// Unit tests for `scripts/lib/renderMarkdown.ts`.
//
// Covers both the happy path (basic markdown → HTML) and the
// sanitation surface that the epic spec calls out explicitly:
//   - S18 / AC-15: `<script>` stripped.
//   - S19 / AC-16: `javascript:` href neutralized.
//   - raw-HTML `on*` handlers stripped.
//   - `data:` URL schemes neutralized.
//   - safe schemes (http, https, mailto) and relative/fragment URLs
//     preserved verbatim.
//   - `extractH1` returns first H1 text, or `null` when absent.

import { describe, it, expect } from "vitest";
import { renderMarkdown, extractH1 } from "../../scripts/lib/renderMarkdown.js";

describe("renderMarkdown — happy path", () => {
  it("renders a basic heading and paragraph", () => {
    const out = renderMarkdown("# Hello\n\nworld");
    // Assert on semantics, not whitespace — marked emits a trailing
    // newline after block elements and that's fine either way.
    expect(out).toContain("<h1>Hello</h1>");
    expect(out).toContain("<p>world</p>");
  });

  it("renders inline emphasis and code", () => {
    const out = renderMarkdown("this is **bold** and `code`");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
  });

  it("is deterministic for the same input", () => {
    const src = "# Title\n\nHello *there*.";
    expect(renderMarkdown(src)).toBe(renderMarkdown(src));
  });
});

describe("renderMarkdown — sanitation", () => {
  it("AC-15 / S18: strips <script> tags (and their content)", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("AC-15: strips case-variant <SCRIPT> tags", () => {
    const out = renderMarkdown("<SCRIPT>alert(1)</SCRIPT>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("strips <style>, <iframe>, <object>, <embed>, <link>, <meta>, <base>, <form>", () => {
    const forbidden = [
      "<style>body{}</style>",
      '<iframe src="x"></iframe>',
      '<object data="x"></object>',
      '<embed src="x">',
      '<link rel="stylesheet" href="x">',
      '<meta http-equiv="x">',
      '<base href="x">',
      "<form action=\"/x\"><input></form>",
    ];
    for (const snippet of forbidden) {
      const out = renderMarkdown(snippet).toLowerCase();
      // Tag name should not appear as a tag in output.
      const tagName = /<([a-z]+)/.exec(snippet.toLowerCase())?.[1];
      expect(tagName, `could not derive tag from ${snippet}`).toBeTruthy();
      expect(out).not.toContain(`<${tagName!}`);
    }
  });

  it("AC-16 / S19: rewrites javascript: hrefs from markdown links", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    // Anchor still exists, just defanged.
    expect(out).toContain("<a ");
    expect(out).toContain('href="#"');
  });

  it("strips on* attributes from raw HTML", () => {
    const out = renderMarkdown('<img src="x" onerror="bad()">');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).not.toContain("bad()");
  });

  it("strips on* attributes case-insensitively", () => {
    const out = renderMarkdown('<img src="x" ONCLICK="bad()" OnLoad=\'x\'>');
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out.toLowerCase()).not.toContain("onload");
  });

  it("neutralizes data: URL schemes in markdown image/link hrefs", () => {
    const out = renderMarkdown("[png](data:image/png;base64,AAAA)");
    expect(out).not.toMatch(/href\s*=\s*["']?data:/i);
    expect(out).toContain('href="#"');
  });

  it("neutralizes whitespace-prefixed javascript: hrefs in raw HTML", () => {
    // Browsers tolerate leading whitespace in URL attributes; an
    // attacker using `\tjavascript:...` should still land on `#`.
    const out = renderMarkdown('<a href=" \tjavascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('href="#"');
  });

  it("preserves https:// URLs untouched", () => {
    const out = renderMarkdown("[docs](https://example.com/path?q=1)");
    expect(out).toContain('href="https://example.com/path?q=1"');
  });

  it("preserves relative URLs untouched", () => {
    const out = renderMarkdown("[local](./page.html)");
    expect(out).toContain('href="./page.html"');
  });

  it("preserves fragment URLs untouched", () => {
    const out = renderMarkdown("[jump](#section-2)");
    expect(out).toContain('href="#section-2"');
  });

  it("preserves mailto: URLs untouched", () => {
    const out = renderMarkdown("[mail](mailto:a@b.com)");
    expect(out).toContain('href="mailto:a@b.com"');
  });

  it("does not mutate inner text of allowed tags", () => {
    const out = renderMarkdown("# Don't strip *this* text");
    expect(out).toContain("Don");
    expect(out).toContain("strip");
    expect(out).toContain("text");
  });
});

describe("extractH1", () => {
  it("returns the text of the first H1", () => {
    expect(extractH1("# Title\n\nbody")).toBe("Title");
  });

  it("returns null when no H1 is present", () => {
    expect(extractH1("no heading")).toBeNull();
  });

  it("returns null when only lower-level headings exist", () => {
    expect(extractH1("## Sub\n\n### Deeper")).toBeNull();
  });

  it("returns the first H1 when multiple H1s exist", () => {
    expect(extractH1("# First\n\n# Second")).toBe("First");
  });

  it("skips leading prose and returns the first subsequent H1", () => {
    expect(extractH1("some intro\n\n# Real Title\n\nbody")).toBe("Real Title");
  });

  it("trims surrounding whitespace in heading text", () => {
    expect(extractH1("#   Spaced Out   \n\nbody")).toBe("Spaced Out");
  });
});
