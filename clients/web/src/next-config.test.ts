import { describe, expect, it } from "vitest";
import config from "../next.config";

/** Pages send `Referrer-Policy: no-referrer` (DESIGN.md §12, ROADMAP 1c.4). */
describe("the headers every page is sent with", () => {
  it("say where a link followed from it came from: nowhere", async () => {
    const rules = await config.headers?.();
    expect(rules).toEqual([{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }]);
  });
});
