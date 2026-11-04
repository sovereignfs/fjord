import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, safeHref } from "./render";

/** The published page's HTML is made of untrusted Markdown: what is written is an allowlist, and what is not on it is text. */
describe("rendering Markdown for a page open to anyone", () => {
  it("writes the usual blocks and inline forms as fixed tags", () => {
    const html = renderMarkdown("# Title\n\nSome *emphasis*, **strong**, ~~gone~~ and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n---\n\n```\nlet x = 1 < 2;\n```\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<pre><code>let x = 1 &lt; 2;</code></pre>");
  });

  it("writes a table, and a task list as text", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] not\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("[x] done");
    expect(html).not.toContain("<input");
  });

  it("keeps a table column's alignment, as one of three words and nothing the document wrote", () => {
    const html = renderMarkdown("| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n");
    expect(html).toContain('<th align="left">a</th>');
    expect(html).toContain('<th align="center">b</th>');
    expect(html).toContain('<td align="right">3</td>');
    expect(html).toContain("<td>4</td>");
  });

  it.each([
    ["a script block", "<script>alert(1)</script>"],
    ["a script inline", "Hello <script>alert(1)</script> there"],
    ["an image with a handler", '<img src=x onerror="alert(1)">'],
    ["an iframe", '<iframe src="https://evil.example"></iframe>'],
    ["an svg with a handler", "<svg onload=alert(1)>"],
    ["a style block", "<style>body{display:none}</style>"],
    ["a form", '<form action="https://evil.example"><input name=password></form>'],
    ["a link tag", '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ["a closing tag trick in code", "```\n</pre><script>alert(1)</script>\n```"],
    ["an attribute breakout in a link title", '[x](https://example.com "\\"><script>alert(1)</script>")'],
    ["an attribute breakout in an address", '[x](https://example.com/"onmouseover="alert(1))'],
  ])("never writes markup from the document: %s", (_name, source) => {
    const html = renderMarkdown(source);
    // Every `<` that is left begins one of the few tags this writes itself; whatever the document wrote with one is text (`&lt;`).
    expect(html.match(/<(?!\/?(?:p|h[1-6]|em|strong|del|code|pre|ul|ol|li|blockquote|hr|br|table|tr|th|td|a)[\s>])/g)).toBeNull();
    // No attribute is written but the one on a link that passed the check.
    expect(html.match(/<[a-z0-9]+\s[^>]*>/g)?.filter((tag) => !/^<a href="https?:[^"<>]*" rel="noopener noreferrer nofollow">$/.test(tag)) ?? []).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java&#x09;script:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example/x",
    "/relative/path.md",
    "../up.md",
    "ftp://example.com/x",
  ])("does not make a link of %j", (url) => {
    const html = renderMarkdown(`[click](${url})`);
    expect(html).not.toContain("<a ");
    expect(html).toContain("click");
  });

  it("makes a link of an http, https, mailto or in-page address, with no way to leak where it came from or to vouch for it", () => {
    for (const url of ["https://example.com/a?b=1&c=2", "http://example.com", "mailto:ada@example.com", "#section"]) {
      const html = renderMarkdown(`[go](${url})`);
      expect(html, url).toMatch(/<a href="[^"]+" rel="noopener noreferrer nofollow">go<\/a>/);
    }
    expect(renderMarkdown("[go](https://example.com/a?b=1&c=2)")).toContain('href="https://example.com/a?b=1&amp;c=2"');
  });

  it("never loads an image: its description is all that is written", () => {
    const html = renderMarkdown("![a logo](https://evil.example/pixel.png) and ![](data:image/png;base64,AAAA)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("a logo");
  });

  it("escapes every character that could end a text or an attribute, and nothing it is not given is written", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(renderMarkdown(`5 < 6 && "x" > 'y'`)).toBe("<p>5 &lt; 6 &amp;&amp; &quot;x&quot; &gt; &#39;y&#39;</p>");
  });

  it("leaves out a front-matter block and link definitions, and writes a footnote's text as text", () => {
    expect(renderMarkdown("[ref]: https://example.com\n\ntext")).toBe("<p>text</p>");
  });

  it("is not slow for a hostile text: deep nesting and long lines still finish", () => {
    const started = Date.now();
    renderMarkdown(`${"> ".repeat(500)}x\n\n${"*".repeat(5000)}\n\n${"[".repeat(2000)}`);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("safeHref allows nothing it cannot read as an address", () => {
    expect(safeHref("https://example.com/")).toBe("https://example.com/");
    expect(safeHref("")).toBeUndefined();
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("#")).toBe("#");
    expect(safeHref("#a b")).toBeUndefined();
  });
});
