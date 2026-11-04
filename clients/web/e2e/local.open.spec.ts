import type { Page } from "@playwright/test";
import { expect, signUp, test, NOTE_PLACE } from "./helpers";
import { type TwoGitHubs, startTwoGitHubs } from "./two-github";

/**
 * Repositories kept on this server until they are connected to git (ROADMAP 3i), in a browser: made from the first page and the rail, written in with the
 * ordinary editors, limited per account with words that say what to do, and moved to a git repository, which is added to and never overwritten and which
 * frees the allowance. The instance has the default limits (3 repositories) and a fake GitHub with real git behind it (see playwright.config.ts).
 */
test.describe.configure({ mode: "serial" });

const GOOD = "github_pat_e2egoodtoken0123456789abcdefghijklmnopqrstuvwx";
let hubs: TwoGitHubs;

test.beforeAll(async () => {
  hubs = await startTwoGitHubs(3192, { [GOOD]: { push: true } });
  // Somebody's repository with a README of its own, and one that is already a Fjord repository.
  await hubs.more.commitFiles({ "README.md": "# Mine\n" }, { replace: true });
  await hubs.notes.commitFiles({ "fjord.json": "{}", "Public/plan.md": "theirs" }, { replace: true });
});
test.afterAll(async () => hubs.stop());

const createForm = (page: Page) => page.getByRole("region", { name: /Create (a|your first) repository/ });

async function create(page: Page, name: string, kind: "Drive" | "Journal") {
  const form = createForm(page);
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await form.getByText(kind, { exact: true }).click();
  await form.getByRole("button", { name: "Create", exact: true }).click();
}

test("a repository is made from the first page, as a journal, and written in with the ordinary editor", async ({ page }) => {
  await signUp(page);
  await page.goto("/open");
  await expect(page.getByRole("heading", { name: "Create your first repository" })).toBeVisible();
  await create(page, "Diary", "Journal");
  await expect(page).toHaveURL(/\/journal\/[0-9a-hjkmnp-tv-z]{8}$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Diary", level: 1 })).toBeVisible();
  await expect(page.getByText("On this server")).toBeVisible();

  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page).toHaveURL(NOTE_PLACE, { timeout: 30_000 });
  await expect(page.getByTestId("more")).toBeVisible();
});

test("how much of the allowance is used is shown, and the limit on repositories is told in words that say what to do", async ({ page }) => {
  await signUp(page);
  await page.goto("/open");
  await create(page, "One", "Drive");
  await expect(page).toHaveURL(/\/drive\/[0-9a-hjkmnp-tv-z]{8}$/, { timeout: 30_000 });
  await page.goto("/repositories");
  await expect(page.getByLabel("Space on this server")).toContainText("1 of 3 repositories");
  await expect(page.getByLabel("Space on this server")).toContainText("of 2000 files");
  await expect(page.getByLabel("Space on this server")).toContainText("of 50 MiB");

  for (const name of ["Two", "Three"]) {
    await create(page, name, "Drive");
    await expect(page).toHaveURL(/\/drive\/[0-9a-hjkmnp-tv-z]{8}$/, { timeout: 30_000 });
    await page.goto("/repositories");
  }
  await expect(page.getByLabel("Space on this server")).toContainText("3 of 3 repositories");
  await create(page, "Four", "Drive");
  await expect(createForm(page).getByRole("alert")).toContainText("You can keep 3 repositories on this server");
  await expect(createForm(page).getByRole("alert")).toContainText(/connect one to a git repository/i);
  await expect(page).toHaveURL(/\/repositories$/);
  // Another name for one that is taken is refused too.
  await page.reload();
  await create(page, "one", "Drive");
  await expect(createForm(page).getByRole("alert")).toBeVisible();
});

test("the rail's + offers to create one here as well as to connect one", async ({ page }) => {
  await signUp(page);
  await page.goto("/open");
  await page.getByRole("button", { name: "Add a repository", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a repository" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeVisible();
  await dialog.getByText("Connect from GitHub").click();
  await expect(dialog.getByRole("textbox", { name: "Repository" })).toBeVisible();
  await dialog.getByText("Create one here").click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("From the rail");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Your repositories" }).getByRole("link", { name: "From the rail" })).toBeVisible();
});

test("connecting it to a git repository adds its files in one commit, keeps what was there, and removes it from the server", async ({ page }) => {
  await signUp(page);
  await page.goto("/open");
  await create(page, "Notes", "Drive");
  await expect(page).toHaveURL(/\/drive\/[0-9a-hjkmnp-tv-z]{8}$/, { timeout: 30_000 });
  const before = (await hubs.more.branchHead())!;

  await page.getByRole("button", { name: "Repository settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Repository settings" });
  await expect(dialog.getByText("Stored on this server")).toBeVisible();
  await expect(dialog.getByLabel("Space on this server")).toContainText("1 of 3 repositories");
  const form = dialog.getByRole("form", { name: "Connect this repository to git" });
  await form.getByRole("textbox", { name: "Git repository" }).fill("acme/more");
  await form.getByLabel("Access token").fill(GOOD);
  await form.getByRole("button", { name: "Move to git" }).click();
  await page.getByRole("button", { name: "Move it", exact: true }).click();
  await expect(dialog.getByText("Moved to git")).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Open it" }).click();

  // It is acme/more now, the same repository page, and no longer on this server.
  await expect(page.getByRole("heading", { name: "acme/more", level: 1 })).toBeVisible({ timeout: 30_000 });
  const head = (await hubs.more.branchHead())!;
  expect(await hubs.more.show(head, "%P")).toBe(before);
  const files = await hubs.more.filesAt(head);
  expect(files["README.md"]).toBe("# Mine\n");
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["fjord.json", ".gitattributes"]));
  expect(Object.keys(files).some((path) => path.startsWith("Public/"))).toBe(true);
  const listed = (await (await page.request.get("/api/connections")).json()) as { connections: { provider: string; owner: string; name: string }[] };
  expect(listed.connections).toMatchObject([{ provider: "github", owner: "acme", name: "more" }]);
  const usage = (await (await page.request.get("/api/connections/local")).json()) as { usage: { repositories: number; files: number; bytes: number } };
  expect(usage.usage).toMatchObject({ repositories: 0, files: 0, bytes: 0 });
  await hubs.more.fsck();
});

test("a git repository that has a file by the same name is never overwritten: it says which and nothing is moved", async ({ page }) => {
  await signUp(page);
  await page.goto("/open");
  await create(page, "Notes", "Drive");
  await expect(page).toHaveURL(/\/drive\/[0-9a-hjkmnp-tv-z]{8}$/, { timeout: 30_000 });
  const before = (await hubs.notes.branchHead())!;

  await page.getByRole("button", { name: "Repository settings" }).click();
  const form = page.getByRole("dialog", { name: "Repository settings" }).getByRole("form", { name: "Connect this repository to git" });
  await form.getByRole("textbox", { name: "Git repository" }).fill("https://github.com/acme/notes");
  await form.getByLabel("Access token").fill(GOOD);
  await form.getByRole("button", { name: "Move to git" }).click();
  await page.getByRole("button", { name: "Move it", exact: true }).click();

  await expect(form.getByRole("alert")).toContainText("fjord.json");
  await expect(form.getByRole("alert")).toContainText("Nothing was deleted from this server");
  expect(await hubs.notes.branchHead()).toBe(before);
  expect((await hubs.notes.filesAt(before))["Public/plan.md"]).toBe("theirs");
  const listed = (await (await page.request.get("/api/connections")).json()) as { connections: { provider: string }[] };
  expect(listed.connections).toMatchObject([{ provider: "local" }]);
});
