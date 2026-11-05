import { PASSWORD, enableTwoFactor, enterCode, expect, signIn, signOut, signUp, test, uniqueEmail, alertOn } from "./helpers";
import { totp } from "../src/auth/totp";

test.describe("an account", () => {
  test("is created, lands on the home page at /, and survives a reload", async ({ page }) => {
    await signUp(page);
    await expect(page).toHaveURL("/");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Hello, Ada Lovelace" })).toBeVisible();
  });

  test("signs out, and then the protected pages send the visitor to sign in", async ({ page }) => {
    await signUp(page);
    await signOut(page);
    await page.goto("/home");
    await expect(page).toHaveURL(/\/sign-in(\?next=.*)?$/);
    await page.goto("/account/security");
    await expect(page).toHaveURL(/\/sign-in(\?next=.*)?$/);
  });

  test("signs in again with the password", async ({ page }) => {
    const { email } = await signUp(page);
    await signOut(page);
    await signIn(page, email);
    await expect(page.getByRole("heading", { name: "Hello, Ada Lovelace" })).toBeVisible();
  });

  test("is told the same thing for a wrong password and for an address with no account", async ({ page }) => {
    const { email } = await signUp(page);
    await signOut(page);

    await signIn(page, email, "not the right password");
    const wrong = await alertOn(page).innerText();
    await signIn(page, "nobody-at-all@example.com", "not the right password");
    const unknown = await alertOn(page).innerText();

    expect(wrong).toBe(unknown);
    expect(wrong).toMatch(/do not match/);
    await expect(page).toHaveURL(/\/sign-in(\?next=.*)?$/);
  });

  test("does not offer a password reset when the instance cannot send email", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveCount(0);
    expect((await page.goto("/forgot-password"))?.status()).toBe(404);
  });

  test("changes its password, and then only the new one works", async ({ page, browser }) => {
    const { email } = await signUp(page);
    const elsewhere = await browser.newContext({ baseURL: page.url().replace(/\/$/, ""), extraHTTPHeaders: { "x-forwarded-for": "10.77.77.2" } });
    const other = await elsewhere.newPage();
    await signIn(other, email);
    await expect(other.getByRole("heading", { name: /Hello/ })).toBeVisible();

    await page.goto("/account/security");
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill("a different long passphrase");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Your password is changed")).toBeVisible();

    // The other browser was signed out by the change.
    await other.reload();
    await expect(other).toHaveURL(/\/sign-in(\?next=.*)?$/);
    await elsewhere.close();

    await signOut(page);
    await signIn(page, email);
    await expect(alertOn(page)).toBeVisible();
    await signIn(page, email, "a different long passphrase");
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
  });
});

test.describe("two-factor", () => {
  test("is turned on from the QR code, then asked for at sign-in and let through with a code", async ({ page }) => {
    const { email } = await signUp(page);
    const { secret } = await enableTwoFactor(page);
    await signOut(page);

    await signIn(page, email);
    await expect(page).toHaveURL(/\/sign-in\/two-factor$/);
    await expect(page.getByRole("heading", { name: "Two-factor verification" })).toBeVisible();

    await enterCode(page, "000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(alertOn(page)).toContainText("not right");
    await expect(page).toHaveURL(/\/sign-in\/two-factor$/);

    await enterCode(page, totp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
  });

  test("is recovered from with a backup code, which then works only once", async ({ page, browser }) => {
    const { email } = await signUp(page);
    const { backupCodes } = await enableTwoFactor(page);
    await signOut(page);

    await signIn(page, email);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(backupCodes[0]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
    await signOut(page);

    // The same code again, from a new sign-in.
    await signIn(page, email);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(backupCodes[0]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(alertOn(page)).toContainText("used already");

    // A different one still works.
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await signIn(page, email);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(backupCodes[1]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
    void browser;
  });

  test("is turned off with the password, after which sign-in asks for no code", async ({ page }) => {
    const { email } = await signUp(page);
    await enableTwoFactor(page);

    await page.goto("/account/security");
    await page.getByRole("button", { name: "Turn off" }).click();
    await page.getByLabel("Confirm your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Off. Turn it on")).toBeVisible();

    await signOut(page.context().pages()[0]!);
    await signIn(page, email);
    await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
  });
});

test("an address that already has an account gets a clear message, not a second account", async ({ page }) => {
  const email = uniqueEmail();
  await signUp(page, email);
  await signOut(page);
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Someone Else");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alertOn(page)).toContainText("already an account");
});

test("a link followed while signed out comes back after signing in, and another site's never does", async ({ page }) => {
  const { email } = await signUp(page);
  await signOut(page);

  await page.goto("/account?section=preferences");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount%3Fsection%3Dpreferences$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account\?section=preferences$/);

  await signOut(page);
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  await signOut(page);
  await page.goto("/sign-in?next=%2F%2Fevil.example%2F");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  expect(new URL(page.url()).host).toBe("localhost:3201");
});

test("a person deletes their own account: it needs the address and the password, ends the session, and frees the address", async ({ page }) => {
  const { email } = await signUp(page);
  await page.goto("/account");
  await page.getByRole("button", { name: "Delete my account…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account" });
  const go = dialog.getByRole("button", { name: "Delete my account", exact: true });
  await expect(go).toBeDisabled();
  await dialog.getByLabel(`Type ${email} to confirm`).fill(email);
  await dialog.getByLabel("Your password").fill("not the password at all");
  await go.click();
  await expect(dialog.getByRole("alert")).toContainText("That is not your password");

  await dialog.getByLabel("Your password").fill(PASSWORD);
  await go.click();
  await expect(page.getByRole("heading", { name: /Documents and notes/ })).toBeVisible();

  await page.goto("/account");
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, email);
  await expect(alertOn(page)).toBeVisible();

  await signUp(page, email, "Ada Again");
});
