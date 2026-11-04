import { describe, expect, it } from "vitest";
import { renameProblem } from "./names";

describe("a new name, as typed", () => {
  it("is refused with a slash of either kind, which would otherwise be taken as a place", () => {
    for (const name of ["sla/sh", "a\\b", "../../escape", "/top"]) expect(renameProblem(name), name).toMatch(/slash/);
  });

  it("is refused for a dot at either end", () => {
    expect(renameProblem(".hidden")).toMatch(/start with a dot/);
    expect(renameProblem("..")).toMatch(/start with a dot/);
    expect(renameProblem("trail.")).toMatch(/end with a dot/);
  });

  it("is what it is otherwise, however odd, and the format has the rest of the say", () => {
    for (const name of ["plan", "Weird #name 100% & b", "ünï çødé", "a.b", " spaced "]) expect(renameProblem(name), name).toBeNull();
  });
});
