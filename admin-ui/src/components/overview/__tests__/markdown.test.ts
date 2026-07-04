import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

describe("renderMarkdown — safety", () => {
  it("escapes raw HTML tags so they can't execute", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralizes an img/onerror injection by escaping the tag", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    // The tag is escaped to inert text, so "onerror=" only survives inside
    // &lt;img&gt; — never as a live attribute on a real element.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("only autolinks http(s) URLs — never a javascript: scheme", () => {
    const html = renderMarkdown("javascript:alert(1) and http://ok.test/x");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="http://ok.test/x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("renderMarkdown — formatting", () => {
  it("renders headings, bold, italic, code and lists", () => {
    const html = renderMarkdown("# Title\n\n**bold** and *em* and `code`\n\n- one\n- two");
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
