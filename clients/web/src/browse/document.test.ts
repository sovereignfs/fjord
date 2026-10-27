import { describe, expect, it } from "vitest";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { bodyStartOf, headerOf } from "./document";

/** Where a document's body begins, from the real format module. Needs it built, as the other tests of it do. */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const HEADER = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Q4 plan\ncreated: 2026-10-16T09:34:00Z\n---\n";

describe.skipIf(!available)("where a document's body starts", () => {
  const split = (text: string) => {
    const start = bodyStartOf(fjord(), text);
    return start === undefined ? undefined : [text.slice(0, start), text.slice(start)];
  };

  it("is after the closing fence, so that the header and the body make the text again", () => {
    const text = `${HEADER}\n# Plan\n\nBody.\n`;
    expect(split(text)).toEqual([HEADER, "\n# Plan\n\nBody.\n"]);
  });

  it("counts characters, not bytes, when the header has some that are wider", () => {
    const header = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: 日本語 💧 ñ\ncreated: 2026-10-16T09:34:00Z\n---\n";
    const text = `${header}\n日本語の本文\n`;
    expect(split(text)).toEqual([header, "\n日本語の本文\n"]);
  });

  it("keeps keys it does not know, and CRLF, in the header it does not touch", () => {
    const header = "---\r\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\r\nx-future:\r\n  - a\r\n  - b\r\ntitle: T\r\n---\r\n";
    expect(split(`${header}body\r\n`)).toEqual([header, "body\r\n"]);
  });

  it("is the start of a file with no header, and of one whose rule is further down", () => {
    expect(split("# Just a body\n")).toEqual(["", "# Just a body\n"]);
    expect(split("")).toEqual(["", ""]);
    expect(split("Intro\n\n---\n\nAfter the rule.\n")).toEqual(["", "Intro\n\n---\n\nAfter the rule.\n"]);
  });

  it("is the end of a header with nothing after it", () => {
    expect(split(HEADER)).toEqual([HEADER, ""]);
  });

  it("is nowhere for a header that cannot be read: it is not ours to split", () => {
    expect(split("---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nnever closed\n")).toBeUndefined();
    expect(split("---\n- a\n- list\n---\nbody\n")).toBeUndefined();
    expect(split("---\nkey: [unclosed\n---\nbody\n")).toBeUndefined();
  });
});

describe.skipIf(!available)("a note's or a document's header, for the page", () => {
  const NOW = Date.UTC(2026, 9, 27, 3, 15);
  const random = new Uint8Array(16).fill(7);

  it("lists the properties Fjord knows and, in the order written, every other key as it is", () => {
    const text = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Q4 plan\ncreated: 2026-10-16T09:34:00Z\nx-future:\n  - a\n  - b\ntags: plain\n---\nBody\n";
    const info = headerOf(fjord(), text, "Q4 plan.fj.md", NOW, random);
    expect(info?.properties).toEqual({
      id: "01jagc4k7pt8y3wqnmzv5xrb8j",
      title: "Q4 plan",
      created: "2026-10-16T09:34:00Z",
      others: [
        { key: "zeta", value: "1" },
        { key: "x-future", value: '["a","b"]' },
        { key: "tags", value: "plain" },
      ],
    });
    expect(info?.promotion).toBeUndefined();
    expect(text.slice(info?.bodyStart)).toBe("Body\n");
  });

  it("prepares, for a text with no header, the header it is given on its first edit, and leaves the text itself alone", () => {
    const text = "# The plan\n\nBody\n";
    const info = headerOf(fjord(), text, "notes.md", NOW, random);
    expect(info?.bodyStart).toBe(0);
    expect(info?.properties).toBeUndefined();
    const promoted = `${info?.promotion?.header}${text}`;
    const read = fjord().parseDocument(promoted);
    expect(read).toMatchObject({ status: "present", title: "The plan", created: "2026-10-27T03:15:00Z" });
    expect(read.docId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    // The module puts a blank line between the header and the body it is given, as `fjord` does; the text is after it, whole.
    expect(info?.promotion?.header.endsWith("---\n\n")).toBe(true);
    expect(info?.promotion?.properties).toMatchObject({ id: read.docId, title: "The plan", created: "2026-10-27T03:15:00Z", others: [] });
    expect(promoted.slice(bodyStartOf(fjord(), promoted))).toBe(`\n${text}`);
  });

  it("names a document with no header by its file name without .fj.md, and a rule further down is not a header", () => {
    const info = headerOf(fjord(), "Just text\n\n---\n\nmore\n", "Q4 plan.fj.md", NOW, random);
    expect(fjord().parseDocument(`${info?.promotion?.header}x`).title).toBe("Q4 plan");
    expect(info?.bodyStart).toBe(0);
  });

  it("does not prepare a header for a text with carriage returns or a byte order mark: it would mix endings or move the mark", () => {
    for (const text of ["# Windows\r\n\r\nbody\r\n", "unix\nold mac\rend", "\uFEFF# With a BOM\n"]) {
      expect(headerOf(fjord(), text, "n.md", NOW, random)).toEqual({ bodyStart: 0 });
    }
  });

  it("has nothing to say about a header that cannot be read", () => {
    expect(headerOf(fjord(), "---\nid: [\n---\nbody\n", "a.md", NOW, random)).toBeUndefined();
    expect(headerOf(fjord(), "---\nnever closed\n", "a.md", NOW, random)).toBeUndefined();
  });
});
