import type { Page } from "@playwright/test";
import { PASSWORD, alertOn, expect, signOut, signUp, test, uniqueEmail } from "./helpers";

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

async function nextPersonIs(page: Page, who: { sub: string; email: string; name?: string }) {
  expect((await page.request.post("http://localhost:3191/sign-in-as", { data: who })).ok()).toBe(true);
}

let subs = 0;
const sub = () => `e2e-link-${Date.now()}-${++subs}`;

test.describe("linking Sovereign", () => {
  test("a local account links Sovereign from its security page, then signs in with it as the same account", async ({ page }) => {
    const { email, name } = await signUp(page);
    await nextPersonIs(page, { sub: sub(), email, name: "Someone Else At Sovereign" });
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Link Sovereign" }).click();

    await expect(page).toHaveURL(/\/account\/security/);
    await expect(page.getByText("Sovereign is linked")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink Sovereign" })).toBeEnabled();

    await page.goto("/");
    await signOut(page);
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
    // The account is the local one: its name, not the name Sovereign has for the person.
    await expect(page.getByRole("heading", { name: `Hello, ${name}` })).toBeVisible();
  });

  test("a Sovereign account with a different email address is refused, with the reason, and nothing is linked", async ({ page }) => {
    await signUp(page);
    await nextPersonIs(page, { sub: sub(), email: uniqueEmail(), name: "Not The Same" });
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Link Sovereign" }).click();

    await expect(page).toHaveURL(/\/account\/security/);
    await expect(alertOn(page)).toContainText("different email address");
    await expect(page.getByRole("button", { name: "Link Sovereign" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlink Sovereign" })).toHaveCount(0);
  });

  test("can be unlinked, after which the same Sovereign login is turned back with what to do", async ({ page }) => {
    const { email } = await signUp(page);
    const who = { sub: sub(), email, name: "Same Person" };
    await nextPersonIs(page, who);
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Link Sovereign" }).click();
    await expect(page.getByText("Sovereign is linked")).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Unlink Sovereign" }).click();
    await expect(page.getByText("Sovereign is unlinked")).toBeVisible();
    await expect(page.getByRole("button", { name: "Link Sovereign" })).toBeVisible();

    await page.goto("/");
    await signOut(page);
    await nextPersonIs(page, who);
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(alertOn(page)).toContainText("already an account here");
  });

  test("an account that came in through Sovereign has no password to manage, and cannot unlink its only way in", async ({ page }) => {
    await nextPersonIs(page, { sub: sub(), email: uniqueEmail(), name: "Sovereign Only" });
    await page.goto("/sign-in");
    await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
    await expect(page.getByRole("heading", { name: "Hello, Sovereign Only" })).toBeVisible();

    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "You sign in with Sovereign" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Passkeys" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unlink Sovereign" })).toBeDisabled();
    await expect(page.getByText("only way you can sign in")).toBeVisible();
  });
});
