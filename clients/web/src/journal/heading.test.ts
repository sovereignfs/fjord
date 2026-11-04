import { describe, expect, it } from "vitest";
import { entryHeading, isFiledName } from "./heading";

describe("an entry with no title", () => {
  it("is known by a title that is only the name it was filed by", () => {
    for (const name of ["00-03", "23-59", "00-03-2"]) expect(isFiledName(name), name).toBe(true);
    for (const name of ["First day", "2026-11-05", "00-03 notes", "0-3"]) expect(isFiledName(name), name).toBe(false);
  });

  it("is headed by when, as the writer read it", () => {
    expect(entryHeading("2026-11-05T00:03:00+01:00")).toBe("5 November 2026, 00:03");
    expect(entryHeading("2026-01-31")).toBe("31 January 2026");
  });

  it("has no such heading without a moment", () => {
    for (const date of [null, undefined, "", "soon", "2026-13-01"]) expect(entryHeading(date), String(date)).toBeNull();
  });
});
