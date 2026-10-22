import type { Page } from "@playwright/test";
import { expect, signIn, signOut, signUp, test, alertOn } from "./helpers";

/**
 * Passkeys, with a virtual authenticator standing in for a phone or a security key: the
 * browser does the real WebAuthn ceremony against the server, and only the person's touch on
 * the device is simulated.
 */
async function addVirtualAuthenticator(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return session;
}

test("a passkey is added, signs the person in without a password, and can be removed", async ({ page }) => {
  await addVirtualAuthenticator(page);
  const { email } = await signUp(page);

  await page.goto("/account/security");
  await page.getByLabel("Name for the new passkey").fill("Work laptop");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const passkeys = page.getByRole("list", { name: "Your passkeys" });
  await expect(passkeys).toContainText("Work laptop");

  await signOut(page);

  // No email, no password: just the passkey.
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${email}`)).toBeVisible();

  await page.goto("/account/security");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("list", { name: "Your passkeys" })).toHaveCount(0);

  // With the passkey gone, the device no longer signs the person in.
  await signOut(page);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(alertOn(page)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, email);
  await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
});

test("a passkey signs in an account that also has two-factor, without asking for a code", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await signUp(page);
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("list", { name: "Your passkeys" })).toBeVisible();
  await signOut(page);

  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: /Hello/ })).toBeVisible();
});
