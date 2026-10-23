import type { Page } from "@playwright/test";
import { alertOn, expect, test } from "./helpers";

/**
 * An instance that signs people in only through Sovereign (a fake one, e2e/fake-sovereign-server.ts),
 * and takes only the first account. The tests share the instance's database and run in order.
 */
test.describe.configure({ mode: "serial" });

const first = { sub: "e2e-first", email: "first@sovereign.test", name: "Grace Hopper" };
const second = { sub: "e2e-second", email: "second@sovereign.test", name: "Alan Turing" };

async function nextPersonIs(page: Page, who: { sub: string; email: string; name?: string }) {
  const reply = await page.request.post("http://localhost:3191/sign-in-as", { data: who });
  expect(reply.ok()).toBe(true);
}

test("the sign-in page offers Sovereign and nothing local", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Sign in with Sovereign" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /passkey/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
});

test("there is no local sign-up or security page to find", async ({ page }) => {
  expect((await page.goto("/sign-up"))?.status()).toBe(404);
  expect((await page.goto("/forgot-password"))?.status()).toBe(404);
});

test("the first person signs in through Sovereign, as who Sovereign says they are", async ({ page }) => {
  await nextPersonIs(page, first);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();

  await expect(page.getByRole("heading", { name: `Hello, ${first.name}` })).toBeVisible();
  await expect(page.getByText(first.email)).toBeVisible();
  // Nothing of the local methods to manage.
  await expect(page.getByRole("link", { name: "Security" })).toHaveCount(0);
  expect((await page.goto("/account/security"))?.status()).toBe(404);
});

test("signing out leaves them signed out of Fjord, and signing in again is the same account", async ({ page }) => {
  await nextPersonIs(page, first);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
  await expect(page.getByRole("heading", { name: `Hello, ${first.name}` })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: /Documents and notes/ })).toBeVisible();
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
  await expect(page.getByRole("heading", { name: `Hello, ${first.name}` })).toBeVisible();
});

test("a second person is turned back to the sign-in page, and told why", async ({ page }) => {
  await nextPersonIs(page, second);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();

  await expect(page).toHaveURL(/\/sign-in/);
  await expect(alertOn(page)).toContainText("Sign-up is closed");
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in/);
});
