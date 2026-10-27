import { describe, expect, it } from "vitest";
import { hasConflictMarkers } from "./markers";

describe("hasConflictMarkers", () => {
  it("sees the conflict a combine writes, with either line ending", () => {
    const text = "a\n<<<<<<< Your changes\nmine\n=======\ntheirs\n>>>>>>> In the repository\nz\n";
    expect(hasConflictMarkers(text)).toBe(true);
    expect(hasConflictMarkers(text.replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("does not see a text without one, or one that is only partly there", () => {
    for (const text of ["", "plain\n", "a\n=======\nb\n", "<<<<<<< x\nonly the start\n", "text <<<<<<< x\n=======\n>>>>>>> y\n", "a\n<<<<<<< x\n=======\n", "<<<<<<< x\nmine\n>>>>>>> y\n", "a\n=======\nb\n>>>>>>> y\n"]) {
      expect(hasConflictMarkers(text), JSON.stringify(text)).toBe(false);
    }
  });

  it("stops seeing it when a person has removed the markers", () => {
    expect(hasConflictMarkers("a\n<<<<<<< x\nmine\n=======\ntheirs\n>>>>>>> y\n")).toBe(true);
    expect(hasConflictMarkers("a\nmine and theirs\n")).toBe(false);
  });
});
