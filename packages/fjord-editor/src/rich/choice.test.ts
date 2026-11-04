// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { forgetChoice, readChoice, rememberChoice } from "./choice.js";

const memory = () => {
  const data: Record<string, string> = {};
  return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value), removeItem: (key: string) => void delete data[key] };
};

describe("what a person chose for a document", () => {
  it("is kept for that document, and for no other, and can be forgotten", () => {
    const store = memory();
    expect(readChoice("1:a.md", store)).toBeNull();
    rememberChoice("1:a.md", "markdown", store);
    expect(readChoice("1:a.md", store)).toBe("markdown");
    expect(readChoice("1:b.md", store)).toBeNull();
    rememberChoice("1:a.md", "reformat", store);
    expect(readChoice("1:a.md", store)).toBe("reformat");
    forgetChoice("1:a.md", store);
    expect(readChoice("1:a.md", store)).toBeNull();
  });

  it("reads only what it wrote, and is never an error when storage is refused", () => {
    const store = memory();
    store.data["fjord-editor:choice:x"] = "something else";
    expect(readChoice("x", store)).toBeNull();
    const refusing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readChoice("x", refusing)).toBeNull();
    expect(() => rememberChoice("x", "markdown", refusing)).not.toThrow();
    expect(() => forgetChoice("x", refusing)).not.toThrow();
    expect(readChoice("x", undefined)).toBeNull();
  });
});
