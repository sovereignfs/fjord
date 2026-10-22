import { describe, expect, it } from "vitest";
import { exampleDocument, features, principles, questions, steps } from "./content";

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("landing content", () => {
  it.each([
    ["principles", principles],
    ["features", features],
    ["steps", steps],
    ["questions", questions],
  ])("%s have unique ids and no empty text", (_name, items) => {
    expect(new Set(ids(items)).size).toBe(items.length);
    for (const item of items) {
      for (const value of Object.values(item)) {
        if (typeof value === "string") expect(value.trim()).not.toBe("");
      }
    }
  });

  it("says which principle is not available yet, and no other", () => {
    expect(principles.filter((p) => p.later).map((p) => p.id)).toEqual(["encryption"]);
  });

  it("has a question that ends with a question mark each time", () => {
    for (const { question } of questions) expect(question).toMatch(/\?$/);
  });

  it("shows a Fjord document that is valid: a lowercase ULID id, in a .fj.md file", () => {
    // Spec §8.3: 26 characters of Crockford base32, lowercase, so no i, l, o or u.
    const id = /^id: (\S+)$/m.exec(exampleDocument.source)?.[1];
    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    // Spec §8.1: `created` is an RFC 3339 UTC timestamp, not a bare date.
    expect(/^created: (\S+)$/m.exec(exampleDocument.source)?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(exampleDocument.path).toMatch(/\.fj\.md$/);
    expect(exampleDocument.source.startsWith("---\n")).toBe(true);
  });
});
