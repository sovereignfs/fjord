import { describe, expect, it } from "vitest";
import { MAX_NAME_CHARS, cleanGuestName } from "./guest-name";

/** The name someone gives before they edit through a link (ROADMAP 1c.6): what is one, and how it is tidied. */
describe("a display name", () => {
  it("is one line of 1 to 40 characters, with white space made single", () => {
    expect(cleanGuestName("Grace Hopper")).toBe("Grace Hopper");
    expect(cleanGuestName("  Grace   \t Hopper  ")).toBe("Grace Hopper");
    expect(cleanGuestName("G")).toBe("G");
    expect(cleanGuestName("a".repeat(MAX_NAME_CHARS))).toBe("a".repeat(MAX_NAME_CHARS));
    expect(cleanGuestName("日本語の名前 🌊")).toBe("日本語の名前 🌊");
  });

  it("counts characters, not bytes or code units", () => {
    expect(cleanGuestName("🌊".repeat(MAX_NAME_CHARS))).toBe("🌊".repeat(MAX_NAME_CHARS));
    expect(cleanGuestName("🌊".repeat(MAX_NAME_CHARS + 1))).toBeUndefined();
  });

  it("is refused if it is empty, too long, not text, has half a character, a control character or an angle bracket", () => {
    for (const bad of ["", "   ", "a".repeat(MAX_NAME_CHARS + 1), 7, null, undefined, ["Grace"], "Grace\ud800", "Gra\u0000ce", "Gra\u0007ce", "<script>", "Grace <grace@example.com>", "a > b"]) {
      expect(cleanGuestName(bad), String(bad)).toBeUndefined();
    }
  });

  it("cannot be made into a second line: a line break is white space", () => {
    expect(cleanGuestName("Grace\nCo-authored-by: Mallory")).toBe("Grace Co-authored-by: Mallory");
  });
});
