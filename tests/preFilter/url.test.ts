import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/preFilter/url.js";

describe("normalizeUrl", () => {
  it("returns null for non-http(s) schemes", () => {
    expect(normalizeUrl("ftp://example.com/x")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });

  it("lowercases the host but preserves the path case", () => {
    expect(normalizeUrl("https://EXAMPLE.com/Foo/Bar")).toBe(
      "https://example.com/Foo/Bar",
    );
  });

  it("strips default ports", () => {
    expect(normalizeUrl("http://example.com:80/x")).toBe("http://example.com/x");
    expect(normalizeUrl("https://example.com:443/x")).toBe(
      "https://example.com/x",
    );
  });

  it("preserves non-default ports", () => {
    expect(normalizeUrl("https://example.com:8443/x")).toBe(
      "https://example.com:8443/x",
    );
  });

  it("strips utm_* tracking params", () => {
    expect(
      normalizeUrl(
        "https://example.com/post?utm_source=hn&utm_medium=link&utm_campaign=foo",
      ),
    ).toBe("https://example.com/post");
  });

  it("strips fbclid, gclid, mc_eid, mc_cid, ref, ref_src", () => {
    expect(
      normalizeUrl(
        "https://example.com/post?fbclid=A&gclid=B&mc_eid=C&mc_cid=D&ref=E&ref_src=F",
      ),
    ).toBe("https://example.com/post");
  });

  it("preserves non-tracking params and sorts them deterministically", () => {
    expect(
      normalizeUrl("https://example.com/post?b=2&a=1&utm_source=x&c=3"),
    ).toBe("https://example.com/post?a=1&b=2&c=3");
    expect(
      normalizeUrl("https://example.com/post?c=3&a=1&b=2&utm_source=x"),
    ).toBe("https://example.com/post?a=1&b=2&c=3");
  });

  it("removes trailing slashes from non-root paths", () => {
    expect(normalizeUrl("https://example.com/post/")).toBe(
      "https://example.com/post",
    );
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("strips fragments", () => {
    expect(normalizeUrl("https://example.com/post#section")).toBe(
      "https://example.com/post",
    );
  });

  it("is idempotent — applying twice equals applying once", () => {
    const inputs = [
      "https://EXAMPLE.com/Foo?utm_source=x&b=2&a=1",
      "https://example.com/post/#hash",
      "http://example.com:80/abc",
      "https://example.com/?keep=this",
    ];
    for (const i of inputs) {
      const once = normalizeUrl(i);
      expect(once).not.toBeNull();
      const twice = normalizeUrl(once!);
      expect(twice).toBe(once);
    }
  });

  it("strips userinfo (username/password) from the canonical form", () => {
    expect(normalizeUrl("https://user:pw@example.com/x")).toBe(
      "https://example.com/x",
    );
    expect(normalizeUrl("https://user@example.com/x")).toBe(
      "https://example.com/x",
    );
  });

  it("strips additional newsletter/ad tracking params (gbraid, _hsenc, mkt_tok)", () => {
    expect(
      normalizeUrl(
        "https://example.com/p?gbraid=A&wbraid=B&_hsenc=C&_hsmi=D&mkt_tok=E&vero_id=F",
      ),
    ).toBe("https://example.com/p");
  });

  it("collapses two URLs that differ only in tracking + casing to the same key", () => {
    const a = normalizeUrl(
      "https://blog.example.com/article-x?utm_source=hn&utm_medium=link",
    );
    const b = normalizeUrl(
      "https://Blog.Example.com/article-x?utm_campaign=foo",
    );
    expect(a).toBe(b);
  });
});
