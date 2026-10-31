import { describe, expect, it } from "vitest";
import { editDistance, isLike } from "./similar";

/** Whether an edited quote is still like the old one (ROADMAP 1d.2). */
describe("the distance between two quotes", () => {
  it("counts insertions, deletions and changed characters, by character and not by code unit", () => {
    expect(editDistance("kitten", "sitting", 10)).toBe(3);
    expect(editDistance("same", "same", 10)).toBe(0);
    expect(editDistance("", "abc", 10)).toBe(3);
    expect(editDistance("a😀b", "a🙂b", 10)).toBe(1);
  });

  it("stops once it is past the limit, saying only that it is past", () => {
    expect(editDistance("abcdefghij", "zyxwvutsrq", 3)).toBe(4);
    expect(editDistance("short", "a much much longer quote than that", 3)).toBe(4);
  });
});

describe("being like the words that were", () => {
  it("allows an edit of a few words, and the same words", () => {
    expect(isLike("The quick brown fox jumps over the lazy dog.", "The quick red fox jumps over the lazy dog.")).toBe(true);
    expect(isLike("The quick brown fox", "The quick brown fox")).toBe(true);
  });

  it("refuses words that are not like them: a thread is not moved onto other text in one step", () => {
    expect(isLike("The quick brown fox jumps over the lazy dog.", "Fjord keeps your notes in a repository.")).toBe(false);
    expect(isLike("The quick brown fox jumps over the lazy dog.", "x")).toBe(false);
  });
});
