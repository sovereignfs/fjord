import { describe, expect, it } from "vitest";
import { totp } from "./totp";

/** The test generator is only worth anything if it agrees with the standard. RFC 6238 Appendix B. */
describe("the test authenticator", () => {
  // The RFC's secret is the ASCII string "12345678901234567890", in base32.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("gives the RFC 6238 code for t=%i", (seconds, expected) => {
    expect(totp(secret, seconds * 1000)).toBe(expected);
  });
});
