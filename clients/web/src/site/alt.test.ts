import { describe, expect, it } from "vitest";
import { canInsert } from "./alt";

/** Alt text is required (RFC 0004): a picture is inserted with words, or on purpose without. */
describe("when a picture may be inserted", () => {
  it("needs a picture chosen", () => {
    expect(canInsert(false, "A red square", false)).toBe(false);
    expect(canInsert(false, "", true)).toBe(false);
  });
  it("needs words, or the choice to have none", () => {
    expect(canInsert(true, "", false)).toBe(false);
    expect(canInsert(true, "   ", false)).toBe(false);
    expect(canInsert(true, "A red square", false)).toBe(true);
    expect(canInsert(true, "", true)).toBe(true);
  });
});
