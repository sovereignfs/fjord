import { describe, expect, it } from "vitest";
import { routes, site } from "./site";

describe("site", () => {
  it("names the product and describes it", () => {
    expect(site.name).toBe("Fjord");
    expect(site.title.startsWith(`${site.name}: `)).toBe(true);
    expect(site.description).toMatch(/plain Markdown/);
  });

  it("links to the source and the specification on GitHub", () => {
    expect(site.repository).toMatch(/^https:\/\/github\.com\/sovereignfs\/fjord$/);
    expect(site.specification).toBe(`${site.repository}/blob/main/docs/specs/Fjord.spec.md`);
  });

  it("sends visitors to two different pages", () => {
    expect(routes.signIn).not.toBe(routes.signUp);
    expect(routes.signIn).toMatch(/^\//);
  });
});
