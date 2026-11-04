import { type Page, expect, test as base } from "@playwright/test";
import { totp } from "../src/auth/totp";

export const PASSWORD = "correct horse battery staple";

let counter = 0;
export const uniqueEmail = () => `person${Date.now()}${++counter}@example.com`;

/**
 * Every test is a visitor of its own. Sign-in is rate limited per address, and the instance
 * sees every test as 127.0.0.1, so without this the tests would limit one another. The worker's
 * index is in the address because a worker that is restarted (after a failure, for a retry) starts
 * its counter again, and the instance remembers what it has counted: without it a retry would
 * arrive from an address that has already been limited, and fail for that reason.
 */
export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    const n = ++counter;
    await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${testInfo.workerIndex % 200}.${(n >> 8) & 255}.${n & 255}` });
    await use(context);
  },
});
export { expect };

/**
 * The page's own alert. Next also puts a `role="alert"` outside `<main>` on every page, the route
 * announcer, which has text after a client-side navigation, so an alert is looked for inside `<main>`.
 */
export const alertOn = (page: Page) => page.getByRole("main").getByRole("alert");

export async function signUp(page: Page, email = uniqueEmail(), name = "Ada Lovelace") {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: `Hello, ${name}` })).toBeVisible();
  return { email, name };
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Put a one-time code into the boxes of the second sign-in step, one box at a time. Typing it with
 * `keyboard.type` is not used: it sends the keys faster than a person can, and the next one can arrive
 * before focus has moved on, which is a test of the keyboard and not of the form.
 */
export async function enterCode(page: Page, code: string) {
  for (const [at, digit] of [...code].entries()) await page.getByLabel(`Digit ${at + 1}`).fill(digit);
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: /Documents and notes/ })).toBeVisible();
}

/** Turn on two-factor from the security page, the way a person does: returns the key and backup codes. */
export async function enableTwoFactor(page: Page) {
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Turn on" }).click();
  await page.getByLabel("Confirm your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  const secret = (await page.locator("code").first().innerText()).replace(/\s/g, "");
  await page.getByLabel("Code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();

  // Wait for the codes themselves. "Two-factor is on" alone is not enough: the previous step's hint
  // ("Two-factor is on only once a code works") matches it, so it is true before anything has happened.
  await expect(page.getByText("Two-factor is on. Keep your backup codes")).toBeVisible();
  const codes = page.getByRole("list", { name: "Backup codes" }).locator("code");
  await expect(codes).toHaveCount(10);
  const backupCodes = await codes.allInnerTexts();
  await page.getByRole("button", { name: "I have saved them" }).click();
  return { secret, backupCodes };
}

/**
 * The addresses of places in a repository (workstream 0003): `/repo/<repo>/v/<vault>/[<folder>/]<file>` by handle, or `…/[<folder>/]d/<doc>` for a Doc, never a path.
 * `PLACE` is any of them, a vault's too, `DOC_PLACE` only a Doc's, `FILE_PLACE` only a file or folder's by its handle.
 */
/** A repository's public id in an address: eight characters of Crockford's base32, lower case. */
const REPO = "[0-9a-hjkmnp-tv-z]{8}";
const ULID = "[0-9a-hjkmnp-tv-z]{26}";
const HANDLE = "[0-9a-z]{16}";
export const DOC_PLACE = new RegExp(`/repo/${REPO}/v/${ULID}/(?:${HANDLE}/)?d/${ULID}$`);
export const FILE_PLACE = new RegExp(`/repo/${REPO}/v/${ULID}/(?:${HANDLE}/)?${HANDLE}$`);
export const PLACE = new RegExp(`/repo/${REPO}/v/${ULID}(?:/(?:${HANDLE}/)?(?:d/${ULID}|${HANDLE}))?$`);
/** A Doc's address inside its repository, with its id: where the owner's `/d/<id>` leads. */
export const docPlace = (id: string) => new RegExp(`/repo/${REPO}/v/${ULID}/(?:${HANDLE}/)?d/${id}$`);
/** A site's post inside its repository (workstream 0003): `/repo/<repo>/post/<id>`. */
export const POST_PLACE = new RegExp(`/repo/${REPO}/post/(?:${ULID}|${HANDLE})$`);
/** A journal's note inside its repository (workstream 0003): `/repo/<repo>/n/<id>`, or by handle when its id is in the ciphertext. */
export const NOTE_PLACE = new RegExp(`/repo/${REPO}/n/(?:${ULID}|${HANDLE})$`);

/** What a connection (by the number the API calls it) is called in an address: its public id, `/repo/<repo>`. */
export async function repoOf(page: import("@playwright/test").Page, id: number): Promise<string> {
  const listed = (await (await page.request.get("/api/connections")).json()) as { connections: { id: number; publicId: string }[] };
  const found = listed.connections.find((connection) => connection.id === id);
  if (!found) throw new Error(`connection ${id} is not there`);
  return found.publicId;
}
