import { describe, expect, it } from "vitest";
import config from "../next.config";
import { SECURITY_HEADERS } from "./security/csp";

/** Pages send `Referrer-Policy: no-referrer` (DESIGN.md §12, ROADMAP 1c.4), and the other security headers (§15, ROADMAP 1d.5). */
describe("the headers every page is sent with", () => {
  it("say where a link followed from it came from: nowhere, and the other security headers", async () => {
    const rules = await config.headers?.();
    expect(rules).toEqual([{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, ...SECURITY_HEADERS] }]);
  });
});
