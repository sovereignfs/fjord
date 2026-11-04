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
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Encryption identity" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "General" })).toHaveCount(0);
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

// What Sovereign tells the app when a person's session there ends, or they delete their account (ROADMAP H3). The fake signs the notice
// with the key it publishes, as Sovereign does, and the test posts it where the manifest says to.
type Wrong = "signature" | "audience" | "expired" | "type";

async function noticeFrom(page: Page, kind: "logout" | "account-deleted", sub: string, wrong?: Wrong): Promise<string> {
  const reply = await page.request.post("http://localhost:3191/notice", { data: { kind, sub, sid: "core-session-1", wrong } });
  expect(reply.ok()).toBe(true);
  return reply.text();
}

const sendLogout = (page: Page, token: string) => page.request.post("/api/sovereign/backchannel-logout", { form: { logout_token: token } });
const sendDeletion = (page: Page, token: string) => page.request.post("/api/sovereign/account-deleted", { form: { account_deleted_token: token } });

async function signInAs(page: Page, who: { sub: string; email: string; name?: string }) {
  await nextPersonIs(page, who);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with Sovereign" }).click();
  await expect(page.getByRole("heading", { name: `Hello, ${who.name}` })).toBeVisible();
}

test("signing out at Sovereign signs the person out here, wherever they are signed in", async ({ page, browser }) => {
  await signInAs(page, first);
  const other = await browser.newContext({ baseURL: "http://localhost:3204" });
  const elsewhere = await other.newPage();
  await signInAs(elsewhere, first);

  const reply = await sendLogout(page, await noticeFrom(page, "logout", first.sub));
  expect(reply.status()).toBe(200);

  for (const tab of [page, elsewhere]) {
    await tab.goto("/home");
    await expect(tab).toHaveURL(/\/sign-in/);
  }
  await other.close();
  // And they can sign in again: the account is theirs still.
  await signInAs(page, first);
});

test("a notice that is wrong, or is sent twice, is refused and ends nothing", async ({ page }) => {
  await signInAs(page, first);
  for (const wrong of ["signature", "audience", "expired", "type"] as const) {
    const reply = await sendLogout(page, await noticeFrom(page, "logout", first.sub, wrong));
    expect(reply.status(), wrong).toBe(400);
    expect(await reply.json()).toEqual({ error: "invalid_request" });
  }
  // A deletion token is not a logout token, nor the reverse.
  expect((await sendLogout(page, await noticeFrom(page, "account-deleted", first.sub))).status()).toBe(400);
  expect((await sendDeletion(page, await noticeFrom(page, "logout", first.sub))).status()).toBe(400);
  // Nothing at all, and not a form.
  expect((await page.request.post("/api/sovereign/backchannel-logout", { form: {} })).status()).toBe(400);
  expect((await page.request.post("/api/sovereign/account-deleted", { data: { account_deleted_token: "x.y.z" } })).status()).toBe(400);
  // They are still signed in.
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: `Hello, ${first.name}` })).toBeVisible();

  // The same good notice twice: the first ends the session, the second is a replay.
  const token = await noticeFrom(page, "logout", first.sub);
  expect((await sendLogout(page, token)).status()).toBe(200);
  expect((await sendLogout(page, token)).status()).toBe(400);
});

test("these addresses answer only a POST, and no one who asks for them is shown anything", async ({ page }) => {
  for (const path of ["/api/sovereign/backchannel-logout", "/api/sovereign/account-deleted"]) {
    expect((await page.request.get(path)).status(), path).toBe(405);
  }
});

test("a person who deletes their account at Sovereign is deleted here, and the first-account rule is open again", async ({ page }) => {
  await signInAs(page, first);
  const reply = await sendDeletion(page, await noticeFrom(page, "account-deleted", first.sub));
  expect(reply.status()).toBe(200);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in/);

  // They had the only account, and it is gone, so the instance is empty and the next person to sign in is its first.
  await signInAs(page, second);
  await expect(page.getByText(second.email)).toBeVisible();
  // Said again (a retry that was not needed), it is a notice already seen.
  expect((await sendDeletion(page, await noticeFrom(page, "account-deleted", first.sub))).status()).toBe(200);
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: `Hello, ${second.name}` })).toBeVisible();
});
