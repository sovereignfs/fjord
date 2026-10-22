import { PASSWORD, expect, signOut, signUp, test } from "./helpers";

test("the first account can be made, and then sign-up is closed", async ({ page }) => {
  await signUp(page);
  await signOut(page);

  // The sign-up page says so, and the sign-in page no longer offers it.
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Sign-up is closed" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await page.goto("/sign-in");
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
});

test("a direct request to sign up is refused by the server too, not only hidden by the page", async ({ page }) => {
  const response = await page.request.post("/api/auth/sign-up/email", {
    data: { name: "Intruder", email: "intruder@example.com", password: PASSWORD },
    headers: { origin: "http://localhost:3202" },
  });
  expect(response.status()).toBe(403);
});
