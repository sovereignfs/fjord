// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, it } from "vitest";
import { analyse } from "./marks.js";
import { MIN_FUZZY_QUOTE, anchorAt, findAnchor } from "./reanchor.js";
import type { TextQuoteAnchor } from "./types.js";

/** Finding a thread's text again after the document changed (ROADMAP 1d.2): each kind of edit, and the fate of the thread it was made around. */
const ORIGINAL = "Fjord keeps your notes in a repository you already own. The quick brown fox jumps over the lazy dog. Nothing else is needed.";
const QUOTE = "The quick brown fox jumps over the lazy dog.";

/** The anchor a thread on `quote` would have been made with in `text`. */
function anchorOn(text: string, quote = QUOTE): TextQuoteAnchor {
  const start = text.indexOf(quote);
  return anchorAt(text, start, start + quote.length);
}
const anchor = anchorOn(ORIGINAL);

/** What happens to the thread when `text` is what the document says now: its fate, and the text it marks. */
function fateIn(text: string, from: TextQuoteAnchor = anchor) {
  const found = findAnchor(text, from);
  return found ? { fate: found.fate, marks: text.slice(found.start, found.end) } : { fate: "outdated" as const, marks: undefined };
}

describe("an edit around the anchored text", () => {
  it("before it: the thread is intact and still on its words, wherever they moved to", () => {
    expect(fateIn(`A new first paragraph, a long one.\n${ORIGINAL}`)).toEqual({ fate: "intact", marks: QUOTE });
  });

  it("after it: intact", () => {
    expect(fateIn(`${ORIGINAL} And a closing remark.`)).toEqual({ fate: "intact", marks: QUOTE });
  });

  it("on both sides of it, even in the very words that were its context: intact", () => {
    const text = ORIGINAL.replace("Nothing else is needed.", "Something else.").replace("Fjord keeps", "Fjord stores");
    expect(fateIn(text)).toEqual({ fate: "intact", marks: QUOTE });
  });

  it("when the same words are said again elsewhere, the one by its old surroundings", () => {
    const text = `The quick brown fox jumps over the lazy dog. ${ORIGINAL}`;
    const found = findAnchor(text, anchor)!;
    expect(found.start).toBe(text.lastIndexOf(QUOTE));
  });
});

describe("an edit inside the anchored text", () => {
  it("of a word: the thread follows the edit (edited), now on the text as it reads", () => {
    const text = ORIGINAL.replace("brown fox", "red fox");
    expect(fateIn(text)).toEqual({ fate: "edited", marks: "The quick red fox jumps over the lazy dog." });
  });

  it("of a word added: edited, the whole new sentence", () => {
    const text = ORIGINAL.replace("jumps over", "jumps swiftly over");
    expect(fateIn(text)).toEqual({ fate: "edited", marks: "The quick brown fox jumps swiftly over the lazy dog." });
  });

  it("of words taken out: edited, what is left", () => {
    expect(fateIn(ORIGINAL.replace("quick brown ", ""))).toEqual({ fate: "edited", marks: "The fox jumps over the lazy dog." });
  });

  it("is followed again by the next edit, once the app keeps the new anchor", () => {
    const once = ORIGINAL.replace("brown fox", "red fox");
    const first = findAnchor(once, anchor)!;
    const kept = anchorAt(once, first.start, first.end);
    const twice = once.replace("lazy dog", "sleepy dog");
    expect(fateIn(twice, kept)).toEqual({ fate: "edited", marks: "The quick red fox jumps over the sleepy dog." });
  });

  it("when two places are alike, the one nearer where it was", () => {
    const other = "The quick green fox jumps over the lazy cat.";
    const text = `${ORIGINAL.replace("brown fox", "red fox")} ${other}`;
    expect(fateIn(text).marks).toBe("The quick red fox jumps over the lazy dog.");
  });
});

describe("an edit over the anchored text", () => {
  it("that deletes it: the thread is outdated", () => {
    expect(fateIn(ORIGINAL.replace(QUOTE, "").replace("  ", " ")).fate).toBe("outdated");
  });

  it("that replaces it with something else: outdated", () => {
    expect(fateIn(ORIGINAL.replace(QUOTE, "A sentence about something altogether different, like boats.")).fate).toBe("outdated");
  });

  it("that cuts most of it away: outdated, and not a mark on what is left", () => {
    expect(fateIn(ORIGINAL.replace(QUOTE, "The quick").replace("  ", " "))).toEqual({ fate: "outdated", marks: undefined });
  });

  it("comes back when the text does: the same anchor finds it again, intact", () => {
    const gone = ORIGINAL.replace(QUOTE, "Something else entirely, about boats and the sea.");
    expect(fateIn(gone).fate).toBe("outdated");
    expect(fateIn(ORIGINAL)).toEqual({ fate: "intact", marks: QUOTE });
  });
});

describe("what is not tried", () => {
  it("a short quote is found word for word or not at all: a few characters are alike everywhere", () => {
    const short = "lazy dog";
    expect(short.length).toBeLessThan(MIN_FUZZY_QUOTE);
    expect(fateIn(ORIGINAL, anchorOn(ORIGINAL, short)).fate).toBe("intact");
    expect(fateIn(ORIGINAL.replace("lazy dog", "lazy cat"), anchorOn(ORIGINAL, short)).fate).toBe("outdated");
  });

  it("an empty quote is nowhere", () => {
    expect(findAnchor(ORIGINAL, { ...anchor, quote: "" })).toBeUndefined();
  });

  it("a very large document is searched near where the quote was, without stalling", () => {
    const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(30_000);
    const text = `${filler}${ORIGINAL.replace("brown fox", "red fox")}${filler}`;
    const hint = filler.length + ORIGINAL.indexOf(QUOTE);
    const started = Date.now();
    const found = findAnchor(text, { ...anchor, position: hint })!;
    expect(text.slice(found.start, found.end)).toBe("The quick red fox jumps over the lazy dog.");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("the page", () => {
  afterEach(() => void (document.body.innerHTML = ""));
  const page = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  it("tells each thread's fate, marks what it found, and gives the anchor to keep for an edited one", () => {
    const around = anchorOn(ORIGINAL);
    const inside = anchorOn(ORIGINAL, "Fjord keeps your notes in a repository");
    const over = anchorOn(ORIGINAL, "Nothing else is needed.");
    const root = page("<p>Intro added. Fjord keeps your notes in a repository you already own. The quick brown fox jumps over the lazy dog.</p><p>Fjord stores your notes in a repository</p>");
    const marking = analyse(root, [
      { id: "around", anchor: around, resolved: false },
      { id: "inside", anchor: inside, resolved: false },
      { id: "over", anchor: over, resolved: false },
    ]);
    expect(Object.fromEntries(marking.fates)).toEqual({ around: "intact", inside: "intact", over: "outdated" });
    expect(marking.ranges.get("around")?.toString()).toBe(QUOTE);
    expect(marking.ranges.has("over")).toBe(false);
    expect(marking.reanchored).toEqual([]);

    const edited = page("<p>Fjord stores your notes in a repository you already own.</p>");
    const second = analyse(edited, [{ id: "inside", anchor: inside, resolved: false }]);
    expect(second.fates.get("inside")).toBe("edited");
    expect(second.ranges.get("inside")?.toString()).toBe("Fjord stores your notes in a repository");
    expect(second.reanchored).toHaveLength(1);
    expect(second.reanchored[0]).toMatchObject({ id: "inside", from: inside, to: { type: "text-quote", quote: "Fjord stores your notes in a repository", position: 0 } });
  });
});
