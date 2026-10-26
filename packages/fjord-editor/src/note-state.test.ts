// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { lineSeparatorOf, minimalChange } from "./note-state.js";

const apply = (text: string, change: { from: number; to: number; insert: string } | null) => (change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text);

describe("lineSeparatorOf", () => {
  it("is LF unless every line break is CRLF", () => {
    expect(lineSeparatorOf("")).toBe("\n");
    expect(lineSeparatorOf("no breaks")).toBe("\n");
    expect(lineSeparatorOf("a\nb\n")).toBe("\n");
    expect(lineSeparatorOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineSeparatorOf("a\r\nb")).toBe("\r\n");
  });

  it("is LF for a text that mixes them, or has a lone carriage return, so that nothing is rewritten", () => {
    expect(lineSeparatorOf("a\r\nb\nc")).toBe("\n");
    expect(lineSeparatorOf("a\nb\r\nc")).toBe("\n");
    expect(lineSeparatorOf("a\r\nb\rc")).toBe("\n");
    expect(lineSeparatorOf("a\rb\rc")).toBe("\n");
  });
});

describe("minimalChange", () => {
  it("is nothing for equal texts", () => {
    expect(minimalChange("same", "same")).toBeNull();
    expect(minimalChange("", "")).toBeNull();
  });

  it("is what lies between the common beginning and the common end", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("hello brave world", "hello world")).toEqual({ from: 6, to: 12, insert: "" });
    expect(minimalChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
    expect(minimalChange("", "new")).toEqual({ from: 0, to: 0, insert: "new" });
    expect(minimalChange("old", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
  });

  it("never starts or ends a change inside a surrogate pair", () => {
    // 😀 is U+D83D U+DE00 and 😁 is U+D83D U+DE01: they share their first half.
    const change = minimalChange("a😀b", "a😁b");
    expect(change).toEqual({ from: 1, to: 3, insert: "😁" });
    // Sharing the second half does not split either.
    expect(minimalChange("a\u{1F600}b", "a\u{1F700}b")).toEqual({ from: 1, to: 3, insert: "\u{1F700}" });
  });

  it("turns one text into the other, whatever they are", () => {
    // A small deterministic generator (SplitMix64) over an alphabet of awkward pieces.
    let state = 0x00f10edn;
    const next = () => {
      state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
      let z = state;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
      return Number((z ^ (z >> 31n)) % 1000003n);
    };
    const pieces = ["a", "b", "ab", " ", "\n", "\r\n", "😀", "😁", "é", "e\u0301", "\u200d", "👨‍👩‍👧", "\t", ""];
    const make = () => Array.from({ length: next() % 9 }, () => pieces[next() % pieces.length]).join("");
    for (let i = 0; i < 3000; i++) {
      const from = make();
      const to = make();
      const change = minimalChange(from, to);
      expect(apply(from, change), JSON.stringify([from, to])).toBe(to);
      if (change) {
        // Neither end of the change is between the halves of a pair, in either text.
        const unpaired = (text: string, at: number) => at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;
        expect(unpaired(from, change.from) || unpaired(to, change.from), JSON.stringify([from, to, change])).toBe(false);
      }
    }
  });
});
