import { describe, expect, it } from "vitest";
import { PUBLIC_ID_LENGTH, isLegacyId, isPublicId, newPublicId } from "./public-id";

describe("a repository's public id", () => {
  it("is eight lower-case characters, from the bytes it is given", () => {
    expect(newPublicId(new Uint8Array(PUBLIC_ID_LENGTH))).toBe("00000000");
    expect(newPublicId(Uint8Array.from([31, 30, 29, 28, 27, 26, 25, 24]))).toBe("zyxwvtsr");
    for (let i = 0; i < 50; i++) expect(isPublicId(newPublicId())).toBe(true);
  });

  it("is told from other things in an address before anything is looked up", () => {
    expect(isPublicId("k3x9m2qa")).toBe(true);
    for (const no of ["", "k3x9m2q", "k3x9m2qaa", "K3X9M2QA", "k3x9m2qu", "k3x9m2q-", "12345678".slice(1), "0123456789abcdef"]) expect(isPublicId(no)).toBe(false);
  });

  it("tells the number a repository used to be called by, which still leads to it", () => {
    for (const yes of ["1", "42", "1234567"]) expect(isLegacyId(yes)).toBe(true);
    for (const no of ["", "k3x9m2qa", "12345678", "-1", "1a", "v"]) expect(isLegacyId(no)).toBe(false);
    // A public id that happens to be all digits is a public id, never a number.
    expect(isLegacyId("12345678")).toBe(false);
    expect(isPublicId("12345678")).toBe(true);
  });
});
