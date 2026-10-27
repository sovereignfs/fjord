// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type HighlightApi, type MarkedThread, flatten, locate, paintMarks, rangesFor, threadAt } from "./marks.js";
import type { TextQuoteAnchor } from "./types.js";

/** Marking threads in the text (ROADMAP 1d.1): finding a quote again, drawing it, and finding the thread under a click. */
const anchor = (quote: string, prefix = "", suffix = "", position = 0): TextQuoteAnchor => ({ type: "text-quote", quote, prefix, suffix, position });
const thread = (id: string, a: TextQuoteAnchor, resolved = false): MarkedThread => ({ id, anchor: a, resolved });

function page(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
afterEach(() => void (document.body.innerHTML = ""));

describe("finding a quote in a text", () => {
  it("finds it where it is, and nothing for what is not there", () => {
    expect(locate("Hello world", anchor("world"))).toBe(6);
    expect(locate("Hello world", anchor("planet"))).toBeUndefined();
    expect(locate("Hello world", anchor(""))).toBeUndefined();
  });

  it("chooses, among several, the place whose surroundings are most like the anchor's", () => {
    const text = "the cat sat. a dog saw the cat run. the cat slept.";
    expect(locate(text, anchor("the cat", "a dog saw ", " run."))).toBe(text.indexOf("the cat run") + 0);
    expect(locate(text, anchor("the cat", ". ", " slept."))).toBe(text.lastIndexOf("the cat"));
    expect(locate(text, anchor("the cat", "", " sat."))).toBe(0);
  });

  it("breaks a tie by the hint of where it was", () => {
    const text = "x one x two x three";
    expect(locate(text, anchor("x", "", "", 10))).toBe(12);
    expect(locate(text, anchor("x", "", "", 7))).toBe(6);
    expect(locate(text, anchor("x", "", "", 1))).toBe(0);
  });
});

describe("the text of a page", () => {
  it("is its text nodes in order, a line break between blocks, and where each node starts", () => {
    const root = page("<p>One <b>two</b></p><p>Three</p><ul><li>Four</li></ul>");
    const { text, segments } = flatten(root);
    expect(text).toBe("One two\nThree\nFour");
    expect(segments.map((segment) => [segment.node.data, segment.start])).toEqual([["One ", 0], ["two", 4], ["Three", 8], ["Four", 14]]);
  });
});

describe("the ranges of threads", () => {
  it("covers exactly the quote, across formatting inside a paragraph", () => {
    const root = page("<p>Hello <b>big</b> world, it is fine.</p>");
    const ranges = rangesFor(root, [thread("a", anchor("big world")), thread("b", anchor("fine"))]);
    expect(ranges.get("a")?.toString()).toBe("big world");
    expect(ranges.get("b")?.toString()).toBe("fine");
  });

  it("leaves out a thread whose quote is not in the text, rather than marking the wrong place", () => {
    const root = page("<p>Hello world</p>");
    const ranges = rangesFor(root, [thread("a", anchor("world")), thread("gone", anchor("no longer here"))]);
    expect([...ranges.keys()]).toEqual(["a"]);
  });

  it("finds a quote at the very start and the very end of the text, and in the second paragraph", () => {
    const root = page("<p>start of it</p><p>and the end</p>");
    const ranges = rangesFor(root, [thread("s", anchor("start")), thread("e", anchor("end")), thread("p", anchor("and the", "", " end"))]);
    expect(ranges.get("s")?.toString()).toBe("start");
    expect(ranges.get("e")?.toString()).toBe("end");
    expect(ranges.get("p")?.toString()).toBe("and the");
  });

  it("is nothing for a page with no text", () => {
    expect(rangesFor(page("<p></p>"), [thread("a", anchor("x"))]).size).toBe(0);
  });
});

function fakeApi() {
  const registry = new Map<string, Range[]>();
  const api: HighlightApi = {
    registry: { set: (name, highlight) => registry.set(name, highlight as Range[]), delete: (name) => registry.delete(name) },
    make: (...ranges) => ranges,
  };
  return { api, registry };
}

describe("drawing the marks", () => {
  it("draws the open threads, the resolved ones apart, and the one looked at over both", () => {
    const root = page("<p>one two three four</p>");
    const { api, registry } = fakeApi();
    paintMarks(root, [thread("a", anchor("one")), thread("b", anchor("two"), true), thread("c", anchor("three"))], "c", api);
    expect(registry.get("fe-thread")?.map(String)).toEqual(["one", "three"]);
    expect(registry.get("fe-thread-resolved")?.map(String)).toEqual(["two"]);
    expect(registry.get("fe-thread-active")?.map(String)).toEqual(["three"]);
  });

  it("draws again from nothing each time, and takes them off when asked", () => {
    const root = page("<p>one two</p>");
    const { api, registry } = fakeApi();
    paintMarks(root, [thread("a", anchor("one"))], "a", api);
    expect(registry.has("fe-thread-active")).toBe(true);
    const second = paintMarks(root, [thread("b", anchor("two"))], null, api);
    expect(registry.get("fe-thread")?.map(String)).toEqual(["two"]);
    expect(registry.has("fe-thread-active")).toBe(false);
    second.clear();
    expect([...registry.keys()]).toEqual([]);
  });

  it("does nothing, and says where the marks would be, where the browser cannot draw them", () => {
    const root = page("<p>one two</p>");
    const painted = paintMarks(root, [thread("a", anchor("one"))], null, undefined);
    expect(painted.ranges.get("a")?.toString()).toBe("one");
    expect(() => painted.clear()).not.toThrow();
  });
});

describe("the thread under a click", () => {
  it("is the one whose mark holds that place, and the innermost where marks overlap", () => {
    const root = page("<p>one two three</p>");
    const ranges = rangesFor(root, [thread("outer", anchor("one two three")), thread("inner", anchor("two"))]);
    const text = root.firstElementChild!.firstChild!;
    expect(threadAt(ranges, text, 1)).toBe("outer");
    expect(threadAt(ranges, text, 5)).toBe("inner");
    expect(threadAt(ranges, text, 12)).toBe("outer");
  });

  it("is none for a place no mark holds", () => {
    const root = page("<p>one two three</p>");
    const ranges = rangesFor(root, [thread("a", anchor("two"))]);
    expect(threadAt(ranges, root.firstElementChild!.firstChild!, 0)).toBeUndefined();
    expect(threadAt(new Map(), root, 0)).toBeUndefined();
  });

  it("does not throw for a place in another tree", () => {
    const root = page("<p>one two</p>");
    const other = page("<p>elsewhere</p>");
    const ranges = rangesFor(root, [thread("a", anchor("one"))]);
    expect(() => threadAt(ranges, other.firstElementChild!.firstChild!, 0)).not.toThrow();
    vi.restoreAllMocks();
  });
});
