import { describe, expect, it } from "vitest";
import { site } from "./site";

describe("site", () => {
  it("names the product and says it is not usable yet", () => {
    expect(site.name).toBe("Fjord");
    expect(site.status).toMatch(/nothing here is usable/i);
  });
});
