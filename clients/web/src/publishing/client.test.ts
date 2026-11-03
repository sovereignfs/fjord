import { describe, expect, it } from "vitest";
import { endedFrom, publishedFrom, statusFrom } from "./client";

describe("what the publishing answers mean to the panel", () => {
  it("hands on the address from publishing, and the server's words from a refusal", () => {
    expect(publishedFrom(201, { url: "https://fjord.example.com/p/abc" })).toEqual({ ok: true, url: "https://fjord.example.com/p/abc" });
    expect(publishedFrom(404, { error: { message: "That document is not in this repository." } })).toEqual({ ok: false, message: "That document is not in this repository." });
    expect(publishedFrom(401, undefined)).toMatchObject({ ok: false, message: expect.stringMatching(/signed out/i) });
    expect(publishedFrom(201, {})).toMatchObject({ ok: false });
    expect(publishedFrom(502, undefined)).toMatchObject({ ok: false, message: expect.stringMatching(/nothing was changed/i) });
  });

  it("reads whether a Doc is published", () => {
    expect(statusFrom(200, { published: true, publishedAt: 5 })).toEqual({ ok: true, published: true, publishedAt: 5 });
    expect(statusFrom(200, { published: false, publishedAt: null })).toEqual({ ok: true, published: false, publishedAt: null });
    expect(statusFrom(500, undefined)).toMatchObject({ ok: false });
  });

  it("is ended on a 200, and told in words otherwise", () => {
    expect(endedFrom(200, { unpublished: true })).toEqual({ ok: true });
    expect(endedFrom(404, undefined)).toMatchObject({ ok: false });
  });
});

import { copyOf } from "./client";

describe("what is handed over as a copy", () => {
  it("is the text without its header, titled by the header, else the first heading, else the name", () => {
    expect(copyOf("---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: The plan\n---\n\n# Other\n\nBody\n", "Plan.md")).toEqual({ title: "The plan", body: "\n# Other\n\nBody\n" });
    expect(copyOf("# A heading\n\nBody\n", "Plan.md").title).toBe("A heading");
    expect(copyOf("just words\n", "Plan.md")).toEqual({ title: "Plan", body: "just words\n" });
    expect(copyOf("---\ntitle: \"Quoted: yes\"\n---\nx\n", "p.md").title).toBe("Quoted: yes");
  });

  it("never sends a title that is more than a line or longer than the server takes", () => {
    expect(copyOf("---\ntitle: a\u0007b\n---\nx", "p.md").title).toBe("a b");
    expect(copyOf(`# ${"x".repeat(500)}\n`, "p.md").title.length).toBeLessThanOrEqual(200);
    expect(copyOf("", ".md").title).not.toBe("");
  });
});
