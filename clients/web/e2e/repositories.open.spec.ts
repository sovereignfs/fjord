import { expect, signUp, test } from "./helpers";
import { type TwoGitHubs, startTwoGitHubs } from "./two-github";

/**
 * Connecting a repository by token, in a browser, on an instance that has an encryption key and
 * whose GitHub is a fake with a real git repository behind it (port 3192; see playwright.config.ts).
 */
test.describe.configure({ mode: "serial" });

const GOOD = "github_pat_e2egoodtoken0123456789abcdefghijklmnopqrstuvwx";
const READ_ONLY = "github_pat_e2ereadonlytoken0123456789abcdefghijklmnopqrs";
const BASE = "http://localhost:3201";

let hubs: TwoGitHubs;
test.beforeAll(async () => {
  hubs = await startTwoGitHubs(3192, { [GOOD]: { push: true }, [READ_ONLY]: { push: false } });
  await hubs.notes.commitFiles({ "fjord.json": "{}" }, { replace: true });
  await hubs.more.commitFiles({ "fjord.json": "{}" }, { replace: true });
});
test.afterAll(async () => hubs.stop());

async function connect(page: import("@playwright/test").Page, repository: string) {
  await page.getByRole("textbox", { name: "Repository" }).fill(repository);
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

test("nobody who is not signed in can list, connect or disconnect", async ({ request }) => {
  expect((await request.get("/api/connections")).status()).toBe(401);
  expect((await request.post("/api/connections", { headers: { origin: BASE }, data: { repository: "acme/notes", token: GOOD } })).status()).toBe(401);
  expect((await request.delete("/api/connections/1", { headers: { origin: BASE } })).status()).toBe(401);
});

test("a read-only token is refused with a clear message, and nothing is kept", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await expect(page.getByText("No repositories are connected yet.")).toBeVisible();

  await page.getByRole("textbox", { name: "Repository" }).fill("https://github.com/acme/notes");
  await page.getByLabel("Access token").fill(READ_ONLY);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("can read this repository but not write to it");
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Contents: Read and write");
  await expect(page.getByText("No repositories are connected yet.")).toBeVisible();
  // What was typed stays in its own field, so it can be corrected and sent again; nothing the page
  // says back repeats it.
  expect(await page.getByRole("alert").filter({ hasText: /\S/ }).innerText()).not.toContain(READ_ONLY);
  expect(await page.getByRole("main").innerText()).not.toContain(READ_ONLY);
});

test("a token that works connects the repository, and the page never shows it again", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await page.getByRole("textbox", { name: "Repository" }).fill("acme/notes");
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  const list = page.getByRole("list", { name: "Connected repositories" });
  await expect(list).toContainText("acme/notes");
  await expect(list).toContainText("branch main");
  // The form is empty again, and the token is nowhere in what the browser has.
  await expect(page.getByLabel("Access token")).toHaveValue("");
  expect(await page.content()).not.toContain(GOOD);
  await page.reload();
  await expect(list).toContainText("acme/notes");
  expect(await page.content()).not.toContain(GOOD);
  // The repository was only looked at, not changed.
  await hubs.notes.fsck();
});

test("the same repository twice is refused, and another person does not see it", async ({ page, browser }) => {
  const { email } = await signUp(page);
  await page.goto("/repositories");
  await page.getByRole("textbox", { name: "Repository" }).fill("acme/notes");
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.getByRole("textbox", { name: "Repository" }).fill("https://github.com/acme/notes.git");
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("already connected");

  // Someone else, in their own browser.
  const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.2" } });
  const otherPage = await other.newPage();
  await signUp(otherPage, `other-${email}`, "Grace Hopper");
  await otherPage.goto("/repositories");
  await expect(otherPage.getByText("No repositories are connected yet.")).toBeVisible();
  const listed = await otherPage.request.get("/api/connections");
  expect(await listed.json()).toEqual({ connections: [] });
  // Their attempt at disconnecting someone else's is "not found", not "forbidden": it is not theirs to know about.
  const mine = (await (await page.request.get("/api/connections")).json()).connections[0];
  const attempt = await otherPage.request.delete(`/api/connections/${mine.id}`, { headers: { origin: BASE } });
  expect(attempt.status()).toBe(404);
  await page.reload();
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");
  await other.close();
});

test("a page on another site cannot connect a repository for a signed-in person", async ({ page }) => {
  await signUp(page);
  const response = await page.request.post("/api/connections", { headers: { origin: "https://evil.example" }, data: { repository: "acme/notes", token: GOOD } });
  expect(response.status()).toBe(403);
  expect((await (await page.request.get("/api/connections")).json()).connections).toEqual([]);
});

test("disconnecting forgets the repository", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await page.getByRole("textbox", { name: "Repository" }).fill("acme/notes");
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("No repositories are connected yet.")).toBeVisible();
});

test("a new account is prompted to connect a repository, and the first one becomes where / lands", async ({ page }) => {
  await signUp(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect your first repository" })).toBeVisible();

  await connect(page, "acme/notes");
  // The same page, now the repository: its name, its branch, and that it is the default.
  await expect(page.getByRole("heading", { name: "acme/notes", level: 1 })).toBeVisible();
  await expect(page.getByText("Branch main")).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toBeVisible();

  // The second visit lands there with no prompt.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "acme/notes", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your first repository" })).toHaveCount(0);
});

test("with two repositories, the first stays the default until another is chosen, and disconnecting moves it", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");
  await connect(page, "acme/more");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/more");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "acme/notes", level: 1 })).toBeVisible();

  // Move to the other one, which is not the default, and make it so.
  const switcher = page.getByRole("list", { name: "Your repositories" });
  await switcher.getByRole("link", { name: "acme/more" }).click();
  await expect(page.getByRole("heading", { name: "acme/more", level: 1 })).toBeVisible();
  await expect(page.getByText("Default", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Make this my default" }).click();
  await expect(page.getByRole("button", { name: "Make this my default" })).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "acme/more", level: 1 })).toBeVisible();

  // Disconnect the default: / falls to the one that is left.
  await page.goto("/repositories");
  const more = page.getByRole("listitem").filter({ hasText: "acme/more" });
  page.once("dialog", (dialog) => void dialog.accept());
  await more.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("list", { name: "Connected repositories" })).not.toContainText("acme/more");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "acme/notes", level: 1 })).toBeVisible();
});

test("another person's repository page is not found, and they cannot make it their default", async ({ page, browser }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");
  const mine = (await (await page.request.get("/api/connections")).json()).connections[0];

  const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.3" } });
  const otherPage = await other.newPage();
  await signUp(otherPage, `visitor-${Date.now()}@example.com`, "Grace Hopper");
  expect((await otherPage.goto(`/p/${mine.id}`))?.status()).toBe(404);
  expect((await otherPage.request.post(`/api/connections/${mine.id}/default`, { headers: { origin: BASE } })).status()).toBe(404);
  expect((await page.goto(`/p/${mine.id}`))?.status()).toBe(200);
  await other.close();
});
