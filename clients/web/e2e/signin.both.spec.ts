import { PASSWORD, expect, test, uniqueEmail } from "./helpers";

/** An instance with both ways in, open to anyone: the page offers both, and each works. */
test.describe.configure({ mode: "serial" });

test("the sign-in page offers a password, a passkey and Sovereign", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Sovereign" })).toBeVisible();
});

test("a person signs in through Sovereign and has the security page of the local methods", async ({ page }) => {
  const who = { sub: "e2e-both-sov", email: uniqueEmail(), name: "Katherine Johnson" };
  expect((await page.request.post("http://localhost:3191/sign-in-as", { data: who })).ok()).toBe(true);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
  await expect(page.getByRole("heading", { name: `Hello, ${who.name}` })).toBeVisible();
  await expect(page.getByRole("link", { name: "Security", exact: true })).toBeVisible();
});

test("a person with a local account still signs in with their password", async ({ page }) => {
  const email = uniqueEmail();
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Local Ada");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Hello, Local Ada" })).toBeVisible();
});
