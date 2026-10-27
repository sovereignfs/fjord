import { afterEach, describe, expect, it } from "vitest";
import { type TestAuth, makeAuth } from "./test-support";
import { findAccountByEmail } from "./users";

/** Finding an account by its exact address, over the real auth store. */
let t: TestAuth | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("finding an account by its address", () => {
  it("finds the account that has exactly that address, whatever its letter case or the spaces around it", async () => {
    t = await makeAuth({ signUp: "open" });
    const made = await t.client().post("/api/auth/sign-up/email", { name: "Grace Hopper", email: "Grace@Example.com", password: "correct horse battery staple" });
    expect(made.status).toBe(200);
    for (const asked of ["grace@example.com", "GRACE@EXAMPLE.COM", "  grace@example.com  "]) {
      expect(await findAccountByEmail(t.database, asked)).toMatchObject({ name: "Grace Hopper", email: expect.stringMatching(/^grace@example\.com$/i) });
    }
  });

  it("finds nothing for an address that is not one, for part of one, and for a pattern", async () => {
    t = await makeAuth({ signUp: "open" });
    await t.client().post("/api/auth/sign-up/email", { name: "Grace", email: "grace@example.com", password: "correct horse battery staple" });
    for (const asked of ["ada@example.com", "grace", "grace@example", "grace@example.co", "%@example.com", "grace@example.com%", "_race@example.com", "", "*"]) {
      expect(await findAccountByEmail(t.database, asked), asked).toBeUndefined();
    }
  });
});
