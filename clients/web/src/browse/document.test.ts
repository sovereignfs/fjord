import { describe, expect, it } from "vitest";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { bodyStartOf } from "./document";

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
