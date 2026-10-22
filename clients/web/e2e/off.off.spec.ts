import { expect, test } from "@playwright/test";

/** An instance on which FJORD_AUTH_LOCAL is not set: there is no local sign-in, not a disabled one. */
test.describe("with local sign-in off", () => {
  test("the landing page still renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Documents and notes/ })).toBeVisible();
  });

  for (const path of ["/sign-in", "/sign-up", "/sign-in/two-factor", "/forgot-password", "/reset-password", "/home", "/account/security"]) {
    test(`${path} is not found`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
    });
  }

  for (const path of ["/api/auth/ok", "/api/auth/get-session", "/api/auth/passkey/generate-authenticate-options"]) {
    test(`${path} is not found`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(404);
    });
  }

  test("signing up through the API is not found either", async ({ request }) => {
    const response = await request.post("/api/auth/sign-up/email", {
      data: { name: "X", email: "x@example.com", password: "correct horse battery" },
      headers: { origin: "http://localhost:3203" },
    });
    expect(response.status()).toBe(404);
  });
});
