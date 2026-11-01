import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ROUTES } from "../src/access/routes";
import { alertOn, expect, signUp, test } from "./helpers";
import { wasmDirectory } from "../src/format/wasm";
import { type TwoGitHubs, startTwoGitHubs } from "./two-github";

/**
 * Connecting a repository by token, in a browser, on an instance that has an encryption key and
 * whose GitHub is a fake with a real git repository behind it (port 3192; see playwright.config.ts).
 */
test.describe.configure({ mode: "serial" });

const GOOD = "github_pat_e2egoodtoken0123456789abcdefghijklmnopqrstuvwx";
const READ_ONLY = "github_pat_e2ereadonlytoken0123456789abcdefghijklmnopqrs";
const BASE = "http://localhost:3201";

/**
 * A note's text after its first edit here: the first edit of a note with no header gives it one (spec §8.1, ROADMAP 1b.5),
 * with a new identifier, the title it implies and the time, then a blank line (which is part of the body, so a person can
 * select it away) and the text as typed.
 */
const promoted = (title: string, text: string) => {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expect.stringMatching(new RegExp(`^---\\nid: [0-9a-hjkmnp-tv-z]{26}\\ntitle: \"?${escape(title)}\"?\\ncreated: \"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\"\\n---\\n(?:\\n)?${escape(text)}$`));
};

/** The connect form's own alert, never the route announcer that Next puts outside `<main>`. */
const connectAlert = (page: Page) => page.getByRole("region", { name: "Connect a repository" }).getByRole("alert");

let hubs: TwoGitHubs;
test.beforeAll(async () => {
  hubs = await startTwoGitHubs(3192, { [GOOD]: { push: true }, [READ_ONLY]: { push: false } });
  await hubs.notes.commitFiles(
    {
      "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3md", name: "Notes", createdAt: "2026-10-16T09:34:00Z", vaults: [{ path: "Public", id: "01jagc4k7pr9tbm3ykwx6zq2hv" }, { path: "Private", id: "01jagc4k7pr9tbm3ykwx6zq2hw" }] }),
      "Public/fjord.vault.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Public notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" }),
      "Public/plan.fj.md": "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\n---\n# Plan\n",
      "Public/idea.md": "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8k\n---\n# Idea\n",
      "Public/photo.png": "png",
      "Public/Q4/report.fj.md": "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8m\n---\n# Report\n",
      "Public/Q4/data.csv": "a,b",
      "Private/fjord.vault.json": JSON.stringify({
        fjord: 1,
        id: "01jagc4k7pr9tbm3ykwx6zq2hw",
        name: "Private",
        createdAt: "2026-10-16T09:34:00Z",
        encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "none", armor: false },
        fileNaming: "plain",
      }),
      "Private/recipients.txt": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n",
      "Private/secret.md.age": "age-encryption.org/v1",
    },
    { replace: true },
  );
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

  await expect(connectAlert(page)).toContainText("can read this repository but not write to it");
  await expect(connectAlert(page)).toContainText("Contents: Read and write");
  await expect(page.getByText("No repositories are connected yet.")).toBeVisible();
  // What was typed stays in its own field, so it can be corrected and sent again; nothing the page
  // says back repeats it.
  expect(await connectAlert(page).innerText()).not.toContain(READ_ONLY);
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
  await expect(connectAlert(page)).toContainText("already connected");

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
  expect((await otherPage.goto(`/repo/${mine.id}`))?.status()).toBe(404);
  // Nor a place inside it: nothing of it is shown to someone it is not connected to.
  expect((await otherPage.goto(`/repo/${mine.id}/Public`))?.status()).toBe(404);
  expect((await otherPage.request.post(`/api/connections/${mine.id}/default`, { headers: { origin: BASE } })).status()).toBe(404);
  expect((await page.goto(`/repo/${mine.id}`))?.status()).toBe(200);
  await other.close();
});

test("the repository page lists its vaults and what is in each, from names alone", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.goto("/");
  const vaults = page.getByRole("list", { name: "Vaults" });
  const publicVault = vaults.getByRole("listitem").filter({ hasText: "Public notes" });
  await expect(publicVault).toContainText("2 documents, 1 note, 2 other files");
  const privateVault = vaults.getByRole("listitem").filter({ hasText: "Private" });
  await expect(privateVault).toContainText("Encrypted");
  await expect(privateVault).toContainText("1 encrypted file");
});

test("looking at a repository again reads no tree and no document from the host", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.goto("/");
  await expect(page.getByRole("list", { name: "Vaults" })).toBeVisible();
  hubs.notes.requests.length = 0;
  await page.reload();
  await expect(page.getByRole("list", { name: "Vaults" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Vaults" })).toBeVisible();

  // The head is asked for each time; the commit's tree and the vaults' manifests were kept.
  const asked = hubs.notes.requests.map((request) => `${request.method} ${request.path.replace("/repos/acme/notes", "")}`);
  expect(asked.filter((path) => path.startsWith("GET /git/trees/"))).toEqual([]);
  expect(asked.filter((path) => path.startsWith("GET /git/blobs/"))).toEqual([]);
  expect(asked.filter((path) => path.startsWith("GET /git/ref/"))).not.toEqual([]);
});

test("when GitHub stops accepting the token, the page says so and what to do", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  hubs.notes.fail(/git\/ref\/heads/, { status: 401, body: { message: "Bad credentials" }, times: 1 });
  await page.goto("/");
  await expect(alertOn(page)).toContainText("no longer accepts this repository's token");
  expect(await page.getByRole("main").innerText()).not.toContain("Bad credentials");
});

test("a vault is opened to its folders and files, and what can be opened is told from what cannot by name alone", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.goto("/");
  await page.getByRole("list", { name: "Vaults" }).getByRole("link", { name: "Public notes" }).click();
  await expect(page).toHaveURL(/\/repo\/\d+\/Public$/);

  const contents = page.getByRole("list", { name: "Folder contents" });
  // A folder first, with how many files are in it; then the files.
  await expect(contents.getByRole("listitem").first()).toContainText("Q4");
  await expect(contents.getByRole("listitem").first()).toContainText("2 files");
  await expect(contents.getByRole("link", { name: "plan.fj.md" })).toBeVisible();
  await expect(contents.getByRole("listitem").filter({ hasText: "plan.fj.md" })).toContainText("Document");
  await expect(contents.getByRole("listitem").filter({ hasText: "idea.md" })).toContainText("Note");
  // Any other file is greyed out: named, not a link.
  await expect(contents.getByText("photo.png")).toBeVisible();
  await expect(contents.getByRole("link", { name: "photo.png" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText("acme/notes");

  await contents.getByRole("link", { name: "Q4" }).click();
  await expect(page).toHaveURL(/\/Public\/Q4$/);
  const inside = page.getByRole("list", { name: "Folder contents" });
  await expect(inside.getByRole("link", { name: "report.fj.md" })).toBeVisible();
  await expect(inside.getByRole("link", { name: "data.csv" })).toHaveCount(0);

  await inside.getByRole("link", { name: "report.fj.md" }).click();
  await expect(page).toHaveURL(/\/Public\/Q4\/report\.fj\.md$/);
  await expect(page.getByRole("heading", { name: "report.fj.md", level: 2 })).toBeVisible();
  await expect(noteEditor(page, "report.fj.md")).toContainText("Report"); // a document opens in its editor
  // The way back is in the path above it.
  await page.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "Public notes" }).click();
  await expect(page).toHaveURL(/\/repo\/\d+\/Public$/);
});

async function connected(page: import("@playwright/test").Page): Promise<number> {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");
  return (await (await page.request.get("/api/connections")).json()).connections[0].id;
}

test("a repository opens on the first vault its fjord.json lists, not the first by name", async ({ page }) => {
  const id = await connected(page);
  for (const path of ["/", `/repo/${id}`]) {
    await page.goto(path);
    const vaults = page.getByRole("list", { name: "Vaults" });
    // The directories sort Private before Public; fjord.json lists Public first.
    await expect(vaults.getByRole("listitem").filter({ hasText: "Public notes" })).toContainText("Opens first");
    await expect(vaults.getByRole("listitem").filter({ hasText: "Private" })).not.toContainText("Opens first");
    await expect(page.getByRole("list", { name: "Folder contents" }).getByRole("link", { name: "plan.fj.md" })).toBeVisible();
  }
});

test("choosing another vault changes where the repository opens, and the choice is kept", async ({ page }) => {
  await connected(page);
  await page.goto("/");
  const vaults = page.getByRole("list", { name: "Vaults" });
  await vaults.getByRole("listitem").filter({ hasText: "Private" }).getByRole("button", { name: "Open this one first" }).click();

  await expect(vaults.getByRole("listitem").filter({ hasText: "Private" })).toContainText("Opens first");
  await expect(vaults.getByRole("listitem").filter({ hasText: "Public notes" })).not.toContainText("Opens first");
  await expect(page.getByRole("list", { name: "Folder contents" }).getByText("secret.md")).toBeVisible();
  // Only the vault that is not already first offers the button.
  await expect(vaults.getByRole("listitem").filter({ hasText: "Private" }).getByRole("button")).toHaveCount(0);

  await page.reload();
  await expect(vaults.getByRole("listitem").filter({ hasText: "Private" })).toContainText("Opens first");
});

test("who may choose a repository's vault, and which", async ({ page, browser }) => {
  const id = await connected(page);
  const put = (vault: unknown, headers: Record<string, string> = { origin: BASE }) => page.request.put(`/api/connections/${id}/vault`, { headers, data: { vault } });

  expect((await put("Private", { origin: "https://evil.example" })).status()).toBe(403);
  expect((await put("Nope")).status()).toBe(422);
  expect((await put("Private/secret.md.age")).status()).toBe(422);
  expect((await put("Private")).status()).toBe(204);
  expect((await (await page.request.get("/api/connections")).json()).connections[0].defaultVault).toBe("Private");
  // Nothing was stored by the refusals; and null forgets the choice.
  expect((await put(null)).status()).toBe(204);
  expect((await (await page.request.get("/api/connections")).json()).connections[0].defaultVault).toBeNull();

  const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.4" } });
  const other = await stranger.newPage();
  expect((await other.request.put(`/api/connections/${id}/vault`, { headers: { origin: BASE }, data: { vault: "Private" } })).status()).toBe(401);
  await signUp(other);
  expect((await other.request.put(`/api/connections/${id}/vault`, { headers: { origin: BASE }, data: { vault: "Private" } })).status()).toBe(404);
  expect((await other.request.put(`/api/connections/${id}/vault`, { headers: { origin: BASE }, data: { vault: null } })).status()).toBe(404);
  await stranger.close();
});

test("an encrypted vault's files are shown by name, with a lock, and open to an identity", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.goto("/");
  await page.getByRole("list", { name: "Vaults" }).getByRole("link", { name: "Private" }).click();
  const contents = page.getByRole("list", { name: "Folder contents" });
  // The name without the `.age` it is stored under, a lock, and a way to its page, which asks for the identity that opens it (2b.2).
  await expect(contents.getByRole("link", { name: "secret.md" })).toBeVisible();
  await expect(contents.getByLabel("Encrypted")).toBeVisible();
});

test("browsing reads no tree and no file from the host, and a path that is not there is a 404", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");
  const id = (await (await page.request.get("/api/connections")).json()).connections[0].id;

  await page.goto(`/repo/${id}/Public`);
  await expect(page.getByRole("list", { name: "Folder contents" })).toBeVisible();
  hubs.notes.requests.length = 0;
  await page.goto(`/repo/${id}/Public/Q4`);
  await expect(page.getByRole("list", { name: "Folder contents" })).toBeVisible();
  const reads = () => hubs.notes.requests.map((request) => `${request.method} ${request.path.replace("/repos/acme/notes", "")}`).filter((path) => path.startsWith("GET /git/trees/") || path.startsWith("GET /git/blobs/"));
  // Looking at folders reads nothing...
  expect(reads()).toEqual([]);
  // ...and opening a file reads that file, once, and no tree.
  await page.goto(`/repo/${id}/Public/Q4/report.fj.md`);
  await expect(noteEditor(page, "report.fj.md")).toContainText("Report");
  expect(reads().filter((path) => path.startsWith("GET /git/blobs/"))).toHaveLength(1);
  expect(reads().filter((path) => path.startsWith("GET /git/trees/"))).toEqual([]);

  for (const path of ["Public/nope", "Nope", "Public/Q4/nope.md", "Public/%2e%2e%2fPrivate", "Public/a%5Cb"]) {
    expect((await page.goto(`/repo/${id}/${path}`))?.status(), path).toBe(404);
  }
});

// --- A repository that is not a Fjord repository (ROADMAP 1a.10) ----------------------------------------------

const PLAIN_FILES = {
  "README.md": "# My code\n",
  "src/main.rs": "fn main() {}\n",
  ".gitattributes": "* text=auto\n*.png binary\n",
};

/** `acme/more` as somebody's code repository, connected by a new account, whose page is open. Put back by `restoreMore`. */
async function plainRepository(page: import("@playwright/test").Page): Promise<{ id: number; before: string }> {
  const before = await hubs.more.commitFiles(PLAIN_FILES, { replace: true });
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/more");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/more");
  const id = (await (await page.request.get("/api/connections")).json()).connections[0].id as number;
  await page.goto(`/repo/${id}`);
  return { id, before };
}

const restoreMore = () => hubs.more.commitFiles({ "fjord.json": "{}" }, { replace: true });

test("a repository that is not a Fjord repository is offered the setup, which writes nothing until the button, and is one after", async ({ page }) => {
  try {
    const { before } = await plainRepository(page);

    await expect(page.getByRole("heading", { name: "This is not a Fjord repository yet" })).toBeVisible();
    const files = page.getByRole("list", { name: "What would be added" });
    await expect(files.getByRole("listitem")).toHaveCount(4);
    await expect(files.getByRole("listitem").filter({ hasText: "fjord.json" }).first()).toContainText("New");
    await expect(files.getByRole("listitem").filter({ hasText: ".gitattributes" })).toContainText("One line added");
    await expect(files.getByRole("listitem").filter({ hasText: "Public/welcome.md" })).toContainText("New");
    // The page says it changes one line of a file that is there, and the README and .gitignore are not touched.
    await expect(page.getByText("one line is added to the end of your .gitattributes")).toBeVisible();
    expect(await files.innerText()).not.toContain("README");

    // Looking is not writing: the branch has not moved.
    expect(await hubs.more.branchHead()).toBe(before);

    await page.getByRole("button", { name: "Set up Fjord here" }).click();
    await expect(page.getByRole("list", { name: "Vaults" })).toContainText("Public");
    await expect(page.getByRole("heading", { name: "This is not a Fjord repository yet" })).toHaveCount(0);

    // One commit on top of what was there, adding only what the page said, and leaving the rest as it was.
    const after = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(after, "%P")).toBe(before);
    expect(await hubs.more.show(after, "%B")).toContain("Set up Fjord");
    const written = await hubs.more.filesAt(after);
    expect(Object.keys(written).sort()).toEqual([".gitattributes", "Public/fjord.vault.json", "Public/welcome.md", "README.md", "fjord.json", "src/main.rs"]);
    expect(written["README.md"]).toBe(PLAIN_FILES["README.md"]);
    expect(written["src/main.rs"]).toBe(PLAIN_FILES["src/main.rs"]);
    expect(written[".gitattributes"]?.startsWith(PLAIN_FILES[".gitattributes"])).toBe(true);
    expect(written[".gitattributes"]).toContain("*.age binary -diff -merge");
    expect(JSON.parse(written["fjord.json"] as string)).toMatchObject({ fjord: 1, name: "more", vaults: [{ path: "Public" }] });
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("the setup cannot be done twice, and a name is the person's to choose", async ({ page }) => {
  try {
    const { id } = await plainRepository(page);

    await page.getByLabel("Vault name").fill("My notes");
    // The list follows the name.
    await expect(page.getByRole("list", { name: "What would be added" })).toContainText("My notes/welcome.md");
    await page.getByRole("button", { name: "Set up Fjord here" }).click();
    await expect(page.getByRole("list", { name: "Vaults" })).toContainText("My notes");

    // Now it is a Fjord repository: no offer, and the API will not do it again.
    await page.goto(`/repo/${id}`);
    await expect(page.getByRole("heading", { name: "This is not a Fjord repository yet" })).toHaveCount(0);
    const again = await page.request.post(`/api/connections/${id}/setup`, { headers: { origin: BASE }, data: { vault: "Other" } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe("already_fjord");
  } finally {
    await restoreMore();
  }
});

test("a name that is taken or cannot be a directory is refused, with the reason, and nothing is written", async ({ page }) => {
  try {
    const { id, before } = await plainRepository(page);
    const post = (vault: string) => page.request.post(`/api/connections/${id}/setup`, { headers: { origin: BASE }, data: { vault } });

    const taken = await post("SRC");
    expect(taken.status()).toBe(422);
    expect((await taken.json()).error.code).toBe("vault_name_taken");
    const hidden = await post(".hidden");
    expect(hidden.status()).toBe(422);
    expect((await hidden.json()).error.code).toBe("invalid_vault_name");
    expect((await hidden.json()).error.message).toContain("hidden");
    expect(await hubs.more.branchHead()).toBe(before);

    // From the page, the same words.
    await page.getByLabel("Vault name").fill("src");
    await page.getByRole("button", { name: "Set up Fjord here" }).click();
    await expect(alertOn(page).filter({ hasText: "already used" })).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(before);
  } finally {
    await restoreMore();
  }
});

test("when the repository changes while the person looks, nothing is written, and looking again works", async ({ page }) => {
  try {
    await plainRepository(page);
    // Somebody commits just as the setup is about to move the branch.
    hubs.more.before(/\/git\/commits$/, async () => void (await hubs.more.commitFiles({ "someone-else.txt": "landed in between" })), "POST");

    await page.getByRole("button", { name: "Set up Fjord here" }).click();
    await expect(alertOn(page).filter({ hasText: "changed while you were looking" })).toBeVisible();
    const head = (await hubs.more.branchHead()) as string;
    const files = await hubs.more.filesAt(head);
    expect(files["someone-else.txt"]).toBe("landed in between");
    expect(files["fjord.json"]).toBeUndefined();

    await page.getByRole("button", { name: "Set up Fjord here" }).click();
    await expect(page.getByRole("list", { name: "Vaults" })).toContainText("Public");
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["someone-else.txt"]).toBe("landed in between");
  } finally {
    await restoreMore();
  }
});

test("who may set a repository up: a signed-in person, from this site, for their own repository", async ({ page, browser }) => {
  try {
    const { id } = await plainRepository(page);
    const url = `/api/connections/${id}/setup`;

    expect((await page.request.post(url, { headers: { origin: "https://evil.example" }, data: { vault: "Public" } })).status()).toBe(403);
    expect((await page.request.post(url, { headers: { origin: BASE }, data: {} })).status()).toBe(400);
    expect((await page.request.get(url)).status()).toBe(405);

    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.5" } });
    const other = await stranger.newPage();
    expect((await other.request.post(url, { headers: { origin: BASE }, data: { vault: "Public" } })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.post(url, { headers: { origin: BASE }, data: { vault: "Public" } })).status()).toBe(404);
    await stranger.close();

    // None of those wrote anything.
    expect(await hubs.more.filesAt((await hubs.more.branchHead()) as string).then((f) => f["fjord.json"])).toBeUndefined();
  } finally {
    await restoreMore();
  }
});

// --- Encrypted files, edited in the browser (ROADMAP 2b.3) ---

const PASSPHRASE = "a passphrase of some length";
const vaultManifest = (id: string, naming: string, container: string) =>
  JSON.stringify({ fjord: 1, id, name: id, createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container, armor: false }, fileNaming: naming });

/** A repository with a plain-named and an id-named encrypted vault, an identity brought into the browser, and a record of everything sent and said. */
async function encryptedWorkbench(page: Page, files: (recipient: string) => Record<string, string | Uint8Array>) {
  const secret = wasm.generateIdentity();
  const recipient = wasm.identityRecipient(secret);
  const id = await repositoryWith(page, {
    "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3me", name: "Secrets", createdAt: "2026-10-16T09:34:00Z", vaults: [{ path: "Open", id: "01jagc4k7pr9tbm3ykwx6zq2hx" }, { path: "Sealed", id: "01jagc4k7pr9tbm3ykwx6zq2hy" }] }),
    "Open/fjord.vault.json": vaultManifest("01jagc4k7pr9tbm3ykwx6zq2hx", "plain", "none"),
    "Open/recipients.txt": `${recipient}\n`,
    "Sealed/fjord.vault.json": vaultManifest("01jagc4k7pr9tbm3ykwx6zq2hy", "id", "tar"),
    "Sealed/recipients.txt": `${recipient}\n`,
    ...files(recipient),
  });
  const record: string[] = [];
  page.on("request", (request) => record.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`));
  page.on("response", async (response) => {
    if (response.url().includes("/api/")) record.push(`${response.url()} ${(await response.body().catch(() => Buffer.alloc(0))).toString("latin1")}`);
  });
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  await page.goto("/account/keys");
  await page.getByRole("button", { name: "I already have one" }).click();
  await page.getByLabel("Your secret key").fill(`# an identity file\n${new TextDecoder().decode(secret)}\n`);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Keep this identity" }).click();
  await expect(page.getByTestId("recipient")).toHaveText(recipient, { timeout: 60_000 });
  return { id, secret, recipient, record };
}

/** Open an encrypted file and unlock the identity (each page load starts locked). */
async function openEncrypted(page: Page, path: string, name: string) {
  await page.goto(path);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock and open" }).click();
  const editor = noteEditor(page, name);
  await expect(editor).toBeVisible({ timeout: 60_000 });
  return editor;
}

const decryptedAt = (secret: Uint8Array, bytes: Uint8Array) => wasm.decrypt(bytes, secret);
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("an encrypted file is edited in the browser: the draft is ciphertext, the version is committed with no key, and it opens again", async ({ page }) => {
  test.setTimeout(300_000);
  const PLAIN = "# Plain-named secret\n\nstarts like this";
  const TYPED = " AND THEN TYPED SECRET WORDS";
  try {
    const { id, secret, record } = await encryptedWorkbench(page, (recipient) => ({ "Open/note.md.age": wasm.encrypt(bytes(PLAIN), recipient, false) }));
    const before = await hubs.more.branchHead();

    const editor = await openEncrypted(page, `/repo/${id}/Open/note.md.age`, "note.md");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(TYPED);
    await expect(status(page)).toHaveText("Changes kept as an encrypted draft.", { timeout: 30_000 });

    // What the server was sent is ciphertext, flagged: it begins as an age file does, and holds no word that was typed.
    const drafts = record.filter((line) => line.startsWith("PUT ") && line.includes("/working-copy"));
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft).toContain('"encrypted":true');
      expect(draft).toContain("YWdlLWVuY3J5cHRpb24ub3JnL3Yx"); // base64 of "age-encryption.org/v1"
      expect(draft).not.toContain("SECRET WORDS");
    }
    // Typing is not a commit.
    expect(await hubs.more.branchHead()).toBe(before);

    // Opened again: locked, it says there are changes; unlocked, they are there, decrypted from the draft.
    await page.goto(`/repo/${id}/Open/note.md.age`);
    await expect(page.getByText("Changes you made earlier are kept on this server as an encrypted draft")).toBeVisible();
    await page.getByLabel("Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock and open" }).click();
    await expect(noteEditor(page, "note.md")).toContainText("TYPED SECRET WORDS", { timeout: 60_000 });

    // Hidden and opened again within the page: what was typed is still what comes back.
    await page.getByRole("button", { name: "Hide" }).click();
    await expect(noteEditor(page, "note.md")).toHaveCount(0);
    await page.getByRole("button", { name: "Open" }).click();
    await expect(noteEditor(page, "note.md")).toContainText("TYPED SECRET WORDS");

    // A version: the draft's bytes, committed.
    await page.getByLabel("Message").fill("Reword the secret");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible({ timeout: 30_000 });
    const head = (await hubs.more.branchHead())!;
    expect(head).not.toBe(before);
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%B")).toBe("Reword the secret");
    const stored = await hubs.more.fileBytesAt(head, "Open/note.md.age");
    expect(textOf(decryptedAt(secret, stored))).toBe(PLAIN + TYPED);
    expect(Buffer.from(stored).toString("latin1")).not.toContain("TYPED SECRET");
    expect(Object.keys(await hubs.more.filesAt(head)).sort()).toEqual(["Open/fjord.vault.json", "Open/note.md.age", "Open/recipients.txt", "Sealed/fjord.vault.json", "Sealed/recipients.txt", "fjord.json"]);
    await hubs.more.fsck();

    // And the page now shows the saved file, not a draft.
    await expect(page.getByText("Changes you made earlier")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
    for (const forbidden of ["TYPED SECRET", "starts like this", PASSPHRASE, textOf(secret).slice(0, 24)]) expect(record.join("\n"), forbidden).not.toContain(forbidden);
  } finally {
    await restoreMore();
  }
});

test("an id-named encrypted file keeps its name inside the container when edited, and a change from elsewhere is chosen about, never combined", async ({ page }) => {
  test.setTimeout(300_000);
  const name = "01jagc4k7pr9tbm3ykwx6zq2hz";
  const path = `Sealed/${name}.age`;
  const MINE = " MINE, TYPED HERE";
  try {
    const { id, secret, recipient } = await encryptedWorkbench(page, (recipient) => ({ [path]: wasm.encrypt(wasm.wrapContainer("Plan.md", bytes("# Plan\n\nfirst")), recipient, false) }));

    const editor = await openEncrypted(page, `/repo/${id}/${path}`, "Plan.md");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(MINE);
    await expect(status(page)).toHaveText("Changes kept as an encrypted draft.", { timeout: 30_000 });

    // Someone saves another version from elsewhere (the CLI, say): the draft's base is no longer the file.
    const theirs = await hubs.more.commitFiles({ [path]: wasm.encrypt(wasm.wrapContainer("Plan.md", bytes("# Plan\n\nsecond, from elsewhere")), recipient, false) });
    await openEncrypted(page, `/repo/${id}/${path}`, "Plan.md");
    await expect(page.getByText("This file changed in the repository after you started")).toBeVisible();
    await expect(noteEditor(page, "Plan.md")).toHaveAttribute("contenteditable", "false");
    await expect(page.getByRole("button", { name: "Combine" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(0);

    // Keep mine: the draft moves onto the file as it is. Nothing is written to the repository by that.
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(page.getByText("This file changed in the repository after you started")).toHaveCount(0, { timeout: 30_000 });
    expect(await hubs.more.branchHead()).toBe(theirs);
    await openEncrypted(page, `/repo/${id}/${path}`, "Plan.md");
    await expect(noteEditor(page, "Plan.md")).toContainText("MINE, TYPED HERE");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible({ timeout: 30_000 });

    // The version is on top of theirs, which stays in the history; its container still holds the name, and its text is ours.
    const head = (await hubs.more.branchHead())!;
    expect(await hubs.more.show(head, "%P")).toBe(theirs);
    const unwrapped = wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(head, path)));
    expect(unwrapped.name).toBe("Plan.md");
    expect(textOf(unwrapped.contents)).toBe(`# Plan\n\nfirst${MINE}`);
    expect(textOf(wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(theirs, path))).contents)).toContain("second, from elsewhere");
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("taking the repository's version drops an encrypted draft", async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { id, recipient } = await encryptedWorkbench(page, (recipient) => ({ "Open/note.md.age": wasm.encrypt(bytes("original"), recipient, false) }));
    const editor = await openEncrypted(page, `/repo/${id}/Open/note.md.age`, "note.md");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" draft words");
    await expect(status(page)).toHaveText("Changes kept as an encrypted draft.", { timeout: 30_000 });

    await hubs.more.commitFiles({ "Open/note.md.age": wasm.encrypt(bytes("changed elsewhere"), recipient, false) });
    await openEncrypted(page, `/repo/${id}/Open/note.md.age`, "note.md");
    await page.getByRole("button", { name: "Take theirs" }).click();
    await expect(page.getByText("This file changed in the repository after you started")).toHaveCount(0, { timeout: 30_000 });
    await openEncrypted(page, `/repo/${id}/Open/note.md.age`, "note.md");
    await expect(noteEditor(page, "note.md")).toContainText("changed elsewhere");
    await expect(noteEditor(page, "note.md")).not.toContainText("draft words");
  } finally {
    await restoreMore();
  }
});

// --- Creating files in encrypted vaults (ROADMAP 2b.4) ---

test("a note and a document are made in an encrypted vault, encrypted in the browser, in both namings, and the server is sent no plaintext", async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { id, secret, record } = await encryptedWorkbench(page, (recipient) => ({ "Open/seed.md.age": wasm.encrypt(bytes("seed"), recipient, false), "Sealed/01jagc4k7pr9tbm3ykwx6zq2hz.age": wasm.encrypt(wasm.wrapContainer("Seed.md", bytes("seed")), recipient, false) }));
    const before = await hubs.more.branchHead();

    // A plain-named vault: the title names the file (that is public), and the text is encrypted before it is sent.
    await page.goto(`/repo/${id}/Open`);
    await page.getByRole("button", { name: "New note" }).click();
    await expect(page.getByText("Its name is public")).toBeVisible();
    await page.getByLabel("Title").fill("Plain titled");
    await page.getByRole("button", { name: "Create note" }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Plain%20titled\\.md\\.age$"), { timeout: 30_000 });
    const afterNote = (await hubs.more.branchHead())!;
    expect(await hubs.more.show(afterNote, "%P")).toBe(before);
    expect(await hubs.more.show(afterNote, "%B")).toBe("Create Plain titled");
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt(afterNote, "Open/Plain titled.md.age")))).toBe("# Plain titled\n");

    // It opens like any encrypted file (the identity is locked on this page load).
    await page.getByLabel("Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock and open" }).click();
    await expect(noteEditor(page, "Plain titled.md")).toContainText("Plain titled", { timeout: 60_000 });

    // A document, made with the identity locked: encrypting needs only the recipients' public keys.
    await page.goto(`/repo/${id}/Open`);
    await page.getByRole("button", { name: "New document" }).click();
    await page.getByLabel("Title").fill("Q4 plan");
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Q4%20plan\\.fj\\.md\\.age$"), { timeout: 30_000 });
    const afterDocument = (await hubs.more.branchHead())!;
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt(afterDocument, "Open/Q4 plan.fj.md.age")))).toMatch(/^---\nid: [0-9a-hjkmnp-tv-z]{26}\ntitle: Q4 plan\n/);

    // An id-named vault: the file is a new identifier, its real name is inside, and nothing of it is sent.
    await page.goto(`/repo/${id}/Sealed`);
    await page.getByRole("button", { name: "New document" }).click();
    await expect(page.getByText("Its name is kept inside it")).toBeVisible();
    await page.getByLabel("Title").fill("Hidden budget");
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(page).toHaveURL(new RegExp("/Sealed/[0-9a-hjkmnp-tv-z]{26}\\.age$"), { timeout: 30_000 });
    const afterSealed = (await hubs.more.branchHead())!;
    expect(await hubs.more.show(afterSealed, "%B")).toBe("Create an encrypted file");
    const created = Object.keys(await hubs.more.filesAt(afterSealed)).filter((path) => path.startsWith("Sealed/") && !path.includes("0000") && path.endsWith(".age") && !path.includes("01jagc4k7pr9tbm3ykwx6zq2hz"));
    expect(created).toHaveLength(1);
    const unwrapped = wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(afterSealed, created[0]!)));
    expect(unwrapped.name).toBe("Hidden budget.fj.md");
    expect(textOf(unwrapped.contents)).toContain("title: Hidden budget");
    await hubs.more.fsck();

    // The server was sent ciphertext only: what the id-named vault's file says of itself is in no request, and no text is in any.
    const sent = record.filter((line) => line.startsWith("POST ") && line.includes("/files/encrypted"));
    expect(sent).toHaveLength(3);
    for (const line of sent) {
      expect(line).toContain("YWdlLWVuY3J5cHRpb24ub3JnL3Yx");
      expect(line).not.toContain("# Plain titled");
      expect(line).not.toContain("title: Q4 plan");
    }
    expect(sent[2]).not.toContain("Hidden budget");
    expect(record.join("\n")).not.toContain("Hidden budget");

    // Anything but ciphertext is refused by the server, and a plaintext vault's way still refuses an encrypted vault.
    const refused = await page.request.post(`/api/connections/${id}/files/encrypted`, {
      headers: { origin: BASE },
      data: { vault: "Open", folder: "", kind: "note", title: "Sneaky", localMinute: { year: 2026, month: 10, day: 22, hour: 14, minute: 30 }, ciphertext: Buffer.from("# plain").toString("base64") },
      failOnStatusCode: false,
    });
    expect(refused.status()).toBe(422);
    const plainWay = await page.request.post(`/api/connections/${id}/files`, {
      headers: { origin: BASE },
      data: { vault: "Open", folder: "", kind: "note", title: "Sneaky", localMinute: { year: 2026, month: 10, day: 22, hour: 14, minute: 30 } },
      failOnStatusCode: false,
    });
    expect(plainWay.status()).toBe(422);
    expect(await hubs.more.branchHead()).toBe(afterSealed);
  } finally {
    await restoreMore();
  }
});

// --- Renaming, moving and deleting in encrypted vaults (ROADMAP 2b.5) ---

test("encrypted files are renamed, moved, deleted and put back as the bytes they are, in a plain-named vault, and the server needs no key", async ({ page }) => {
  test.setTimeout(300_000);
  try {
    const { id, secret, record } = await encryptedWorkbench(page, (recipient) => ({
      "Open/note.md.age": wasm.encrypt(bytes("SECRET PLAINTEXT a note"), recipient, false),
      "Open/Sub/other.md.age": wasm.encrypt(bytes("SECRET PLAINTEXT other"), recipient, false),
    }));
    const blobAt = async (commit: string, path: string) => (await hubs.more.fileBytesAt(commit, path)).join(",");
    const original = await blobAt((await hubs.more.branchHead())!, "Open/note.md.age");

    // Rename: the name before .md.age changes, and the same ciphertext is at the new name.
    await page.goto(`/repo/${id}/Open/note.md.age`);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByText("It stays .md.age.")).toBeVisible();
    await page.getByLabel("New name").fill("Renamed");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Renamed\\.md\\.age$"), { timeout: 30_000 });
    let head = (await hubs.more.branchHead())!;
    expect(await hubs.more.show(head, "%B")).toBe("Rename note to Renamed");
    expect(await blobAt(head, "Open/Renamed.md.age")).toBe(original);
    expect(Object.keys(await hubs.more.filesAt(head))).not.toContain("Open/note.md.age");

    // Move into a folder of the same vault (only that vault's folders are offered).
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const places = await page.getByLabel("Move to").locator("option").allTextContents();
    expect(places.every((place) => place === "Open" || place.startsWith("Open/"))).toBe(true);
    await page.getByLabel("Move to").selectOption("Open/Sub");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Sub/Renamed\\.md\\.age$"), { timeout: 30_000 });
    head = (await hubs.more.branchHead())!;
    expect(await blobAt(head, "Open/Sub/Renamed.md.age")).toBe(original);

    // Delete, then Undo: the same bytes come back.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Deleted “Renamed”")).toBeVisible({ timeout: 30_000 });
    expect(Object.keys(await hubs.more.filesAt((await hubs.more.branchHead())!))).not.toContain("Open/Sub/Renamed.md.age");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("link", { name: "Renamed.md" })).toBeVisible({ timeout: 30_000 });
    head = (await hubs.more.branchHead())!;
    expect(await blobAt(head, "Open/Sub/Renamed.md.age")).toBe(original);
    await hubs.more.fsck();

    // A folder is renamed with its files as they are.
    await page.goto(`/repo/${id}/Open/Sub`);
    await page.getByRole("button", { name: "Rename folder" }).click();
    await page.getByLabel("New name").fill("Archive");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Archive$"), { timeout: 30_000 });
    expect(Object.keys(await hubs.more.filesAt((await hubs.more.branchHead())!)).filter((path) => path.startsWith("Open/Archive/")).sort()).toEqual(["Open/Archive/Renamed.md.age", "Open/Archive/other.md.age"]);

    // The server was never sent a key or a word of the text, and it opens with the identity as before.
    expect(record.join("\n")).not.toContain("SECRET PLAINTEXT");
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt((await hubs.more.branchHead())!, "Open/Archive/other.md.age")))).toBe("SECRET PLAINTEXT other");

    // Out of its vault, and a kind changed, are refused by the server whatever the page says.
    const moveVia = (destination: string, path = "Open/Archive/other.md.age") =>
      page.request.post(`/api/connections/${id}/files/move`, { headers: { origin: BASE }, data: { vault: "Open", type: "file", path, blob: "0".repeat(40), destination }, failOnStatusCode: false });
    expect((await moveVia("Sealed/other.md.age")).status()).toBe(422);
    expect((await (await moveVia("Open/other.fj.md.age")).json()).error.code).toBe("extension_changed");
  } finally {
    await restoreMore();
  }
});

test("a file of an id-named encrypted vault is renamed by the name inside it, keeping its identifier, and moved by its identifier", async ({ page }) => {
  test.setTimeout(300_000);
  const name = "01jagc4k7pr9tbm3ykwx6zq2hz";
  try {
    const { id, secret, record } = await encryptedWorkbench(page, (recipient) => ({
      [`Sealed/${name}.age`]: wasm.encrypt(wasm.wrapContainer("Plan.md", bytes("# Plan\n\nSECRET PLAINTEXT")), recipient, false),
      "Sealed/Sub/01jagc4k7pr9tbm3ykwx6zq2h0.age": wasm.encrypt(wasm.wrapContainer("Other.md", bytes("o")), recipient, false),
    }));
    const before = (await hubs.more.branchHead())!;

    // The page offers no rename by path (the name is the identifier), and the server would refuse one.
    await page.goto(`/repo/${id}/Sealed/${name}.age`);
    await expect(page.getByRole("button", { name: "Move", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0); // not until it is opened: the real name is inside
    const refused = await page.request.post(`/api/connections/${id}/files/move`, {
      headers: { origin: BASE },
      data: { vault: "Sealed", type: "file", path: `Sealed/${name}.age`, blob: "0".repeat(40), destination: "Sealed/Plan.age" },
      failOnStatusCode: false,
    });
    expect((await refused.json()).error.code).toBe("id_named");

    // Opened, it can be renamed: the container is rewritten, the file keeps its identifier, and the new name is inside.
    await page.getByLabel("Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock and open" }).click();
    await expect(noteEditor(page, "Plan.md")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByLabel("New name").fill("Roadmap");
    await page.getByRole("form", { name: "Rename" }).getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByText("Version saved")).toBeVisible({ timeout: 30_000 });
    const head = (await hubs.more.branchHead())!;
    expect(head).not.toBe(before);
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%B")).toBe("Rename an encrypted file");
    expect(Object.keys(await hubs.more.filesAt(head)).filter((path) => path.endsWith(".age")).sort()).toEqual([`Sealed/${name}.age`, "Sealed/Sub/01jagc4k7pr9tbm3ykwx6zq2h0.age"]);
    const unwrapped = wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(head, `Sealed/${name}.age`)));
    expect(unwrapped.name).toBe("Roadmap.md");
    expect(textOf(unwrapped.contents)).toBe("# Plan\n\nSECRET PLAINTEXT");
    await hubs.more.fsck();

    // Moved to a folder: the identifier and the bytes are the same.
    await page.goto(`/repo/${id}/Sealed/${name}.age`);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByLabel("Move to").selectOption("Sealed/Sub");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/Sealed/Sub/${name}\\.age$`), { timeout: 30_000 });
    const moved = (await hubs.more.branchHead())!;
    expect(textOf(wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(moved, `Sealed/Sub/${name}.age`))).contents)).toBe("# Plan\n\nSECRET PLAINTEXT");

    // Nothing the server saw holds the old or the new name, or the text.
    for (const forbidden of ["SECRET PLAINTEXT", "Roadmap", "Plan.md"]) expect(record.join("\n"), forbidden).not.toContain(forbidden);
  } finally {
    await restoreMore();
  }
});

// --- Moving files in and out of encrypted vaults (ROADMAP 2b.6) ---

test("a file is encrypted on the way into an encrypted vault, decrypted on the way out after asking, and re-encrypted between two, all in the browser", async ({ page }) => {
  test.setTimeout(300_000);
  const sealedId = "01jagc4k7pr9tbm3ykwx6zq2hz";
  try {
    const { id, secret, record } = await encryptedWorkbench(page, (recipient) => ({
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Plan.md": "# Plan\n\nSECRET PLAINTEXT of the plan",
      "Notes/Other.md": "SECRET PLAINTEXT other",
      "Open/Enc.md.age": wasm.encrypt(bytes("SECRET PLAINTEXT encrypted note"), recipient, false),
      [`Sealed/${sealedId}.age`]: wasm.encrypt(wasm.wrapContainer("Inner.md", bytes("SECRET PLAINTEXT inner")), recipient, false),
    }));
    const filesAt = async () => Object.keys(await hubs.more.filesAt((await hubs.more.branchHead())!));
    const choose = (page2: Page, option: string) => page2.getByLabel("Move to", { exact: true }).selectOption({ label: option });

    // Into a plain-named encrypted vault: asked first, and the new commit holds no plaintext of the file.
    await page.goto(`/repo/${id}/Notes/Plan.md`);
    await page.getByRole("button", { name: "Move to another vault" }).click();
    const options = await page.getByLabel("Move to", { exact: true }).locator("option").allTextContents();
    expect(options).toEqual(expect.arrayContaining(["Open (encrypted)", "Sealed (encrypted)"]));
    expect(options.some((option) => option.startsWith("Notes"))).toBe(false); // plaintext to plaintext is Move
    await choose(page, "Open (encrypted)");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("The plain text stays in the history")).toBeVisible();
    const before = await hubs.more.branchHead();
    expect(await hubs.more.branchHead()).toBe(before); // asking is not doing
    await page.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Plan\\.md\\.age$"), { timeout: 30_000 });
    let head = (await hubs.more.branchHead())!;
    expect(await hubs.more.show(head, "%B")).toBe("Move Plan into the encrypted vault Open");
    expect(await filesAt()).not.toContain("Notes/Plan.md");
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt(head, "Open/Plan.md.age")))).toBe("# Plan\n\nSECRET PLAINTEXT of the plan");
    for (const [path, text] of Object.entries(await hubs.more.filesAt(head))) if (path.startsWith("Open/") || path.startsWith("Sealed/")) expect(text, path).not.toContain("SECRET PLAINTEXT");

    // Into an id-named one: a new identifier, the real name inside.
    await page.goto(`/repo/${id}/Notes/Other.md`);
    await page.getByRole("button", { name: "Move to another vault" }).click();
    await choose(page, "Sealed (encrypted)");
    await expect(page.getByLabel("Name")).toHaveCount(0); // the name is kept inside
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page).toHaveURL(new RegExp("/Sealed/[0-7][0-9a-hjkmnp-tv-z]{25}\\.age$"), { timeout: 30_000 });
    head = (await hubs.more.branchHead())!;
    const made = (await filesAt()).find((path) => path.startsWith("Sealed/") && path.endsWith(".age") && !path.includes(sealedId))!;
    const inside = wasm.unwrapContainer(decryptedAt(secret, await hubs.more.fileBytesAt(head, made)));
    expect([inside.name, textOf(inside.contents)]).toEqual(["Other.md", "SECRET PLAINTEXT other"]);
    expect(await hubs.more.show(head, "%B")).toBe("Move Other into the encrypted vault Sealed");

    // Out of an encrypted vault: it needs the identity, says what it does, and does nothing until told.
    await page.goto(`/repo/${id}/Open/Enc.md.age`);
    await page.getByLabel("Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock and open" }).click();
    await expect(noteEditor(page, "Enc.md")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Move to another vault" }).click();
    await choose(page, "Notes");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("This decrypts the file")).toBeVisible();
    const asked = await hubs.more.branchHead();
    expect(await filesAt()).toContain("Open/Enc.md.age"); // nothing yet
    await page.getByRole("button", { name: "Yes, decrypt and move" }).click();
    await expect(page).toHaveURL(new RegExp("/Notes/Enc\\.md$"), { timeout: 30_000 });
    head = (await hubs.more.branchHead())!;
    expect(head).not.toBe(asked);
    expect((await hubs.more.filesAt(head))["Notes/Enc.md"]).toBe("SECRET PLAINTEXT encrypted note");
    expect(await filesAt()).not.toContain("Open/Enc.md.age");
    expect(await hubs.more.show(head, "%B")).toBe("Move Enc out of the encrypted vault Open");

    // Between two encrypted vaults, the id-named one's real name comes out of the container.
    await page.goto(`/repo/${id}/Sealed/${sealedId}.age`);
    await page.getByLabel("Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock and open" }).click();
    await expect(noteEditor(page, "Inner.md")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Move to another vault" }).click();
    await choose(page, "Open (encrypted)");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page).toHaveURL(new RegExp("/Open/Inner\\.md\\.age$"), { timeout: 30_000 });
    head = (await hubs.more.branchHead())!;
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt(head, "Open/Inner.md.age")))).toBe("SECRET PLAINTEXT inner");
    expect(await filesAt()).not.toContain(`Sealed/${sealedId}.age`);
    await hubs.more.fsck();

    // No request carried the text of any file; the server refuses plain text for an encrypted vault, whatever the page says.
    const transfers = record.filter((line) => line.startsWith("POST ") && line.includes("/files/transfer"));
    expect(transfers.length).toBe(4);
    expect(transfers.slice(0, 2).join("\n")).not.toContain("SECRET PLAINTEXT");
    const refused = await page.request.post(`/api/connections/${id}/files/transfer`, {
      headers: { origin: BASE },
      data: { path: "Notes/Enc.md", blob: "0".repeat(40), destination: "Open/Enc.md.age", content: Buffer.from("SECRET PLAINTEXT").toString("base64") },
      failOnStatusCode: false,
    });
    expect((await refused.json()).error.code).toBe("wrong_form");
    expect(await hubs.more.branchHead()).toBe(head);
  } finally {
    await restoreMore();
  }
});

// --- Sealed link shares of encrypted files (ROADMAP 2c.1) ---

test("an encrypted file is shared by a sealed link: the server holds a copy it cannot read, a private window opens it, and revoking ends it", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const TEXT = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Budget\n---\n\n# Budget\n\nSECRET PLAINTEXT of the budget\n";
  const SHARE_PASSWORD = "a password for sharing";
  try {
    const { id, record } = await encryptedWorkbench(page, (recipient) => ({ "Open/Budget.fj.md.age": wasm.encrypt(bytes(TEXT), recipient, false) }));
    await openEncrypted(page, `/repo/${id}/Open/Budget.fj.md.age`, "Budget.fj.md");
    const panel = page.getByTestId("sealed-shares");

    // A link with the key in it.
    await panel.getByRole("button", { name: "Make a sealed link" }).click();
    await panel.getByRole("button", { name: "Make link" }).click();
    const keyLink = (await panel.getByTestId("sealed-link").textContent())!;
    expect(keyLink).toMatch(/^http:\/\/localhost:3201\/s\/[A-Za-z0-9_-]{43}#key=AGE-SECRET-KEY-1[A-Z0-9]+$/);
    const [keyAddress, key] = keyLink.split("#key=") as [string, string];
    const token = keyAddress.split("/s/")[1]!;

    // A private window reads it: no account, no cookies, and nothing it sent or was sent holds the key or the text.
    const visitor = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.91" } });
    const guest = await visitor.newPage();
    const seen: string[] = [];
    guest.on("request", (request) => seen.push(`${request.method()} ${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ""}`));
    guest.on("response", async (response) => seen.push(`${response.url()} ${(await response.body().catch(() => Buffer.alloc(0))).toString("latin1")}`));
    await guest.goto(keyLink);
    await expect(noteEditor(guest, "Budget.fj.md")).toContainText("SECRET PLAINTEXT of the budget", { timeout: 60_000 });
    await guest.waitForLoadState("networkidle");
    expect(seen.some((line) => line.includes(`/api/sealed/${token}`))).toBe(true);
    for (const forbidden of [key, key.slice(0, 20), "SECRET PLAINTEXT"]) expect(seen.join("\n"), forbidden).not.toContain(forbidden);
    expect(JSON.stringify(await visitor.cookies())).not.toContain(token);

    // What the server was sent and says: the copy, sealed, and neither the key nor the text.
    const made = record.filter((line) => line.startsWith("POST ") && line.includes("/sealed-shares"));
    expect(made).toHaveLength(1);
    expect(made[0]).toContain("YWdlLWVuY3J5cHRpb24ub3JnL3Yx");
    for (const forbidden of [key, "SECRET PLAINTEXT", PASSPHRASE]) expect(record.join("\n"), forbidden).not.toContain(forbidden);
    const served = await visitor.request.get(`/api/sealed/${token}`);
    expect(served.status()).toBe(200);
    expect(JSON.stringify(await served.json())).not.toContain("SECRET PLAINTEXT");

    // The link without its key says so; a made-up token is the same 404 as a revoked one.
    const incomplete = await visitor.newPage();
    await incomplete.goto(keyAddress);
    await expect(incomplete.getByText("the key that opens the copy is missing")).toBeVisible({ timeout: 30_000 });
    expect((await visitor.request.get(`/api/sealed/${"A".repeat(43)}`, { failOnStatusCode: false })).status()).toBe(404);

    // A link with a password: the password is not in the link, and is typed by the viewer.
    await panel.getByRole("button", { name: "Make a sealed link" }).click();
    await panel.getByLabel("A password opens it").check();
    await panel.getByRole("textbox", { name: "Password" }).fill(SHARE_PASSWORD);
    await panel.getByRole("button", { name: "Make link" }).click();
    await expect(panel.getByTestId("sealed-link")).toHaveText(/^http:\/\/localhost:3201\/s\/[A-Za-z0-9_-]{43}$/, { timeout: 60_000 });
    const passwordLink = (await panel.getByTestId("sealed-link").textContent())!;
    const secondVisitor = await visitor.newPage();
    await secondVisitor.goto(passwordLink);
    await secondVisitor.getByLabel("Password").fill("not the password at all");
    await secondVisitor.getByRole("button", { name: "Open" }).click();
    await expect(secondVisitor.getByText("That password does not open it.")).toBeVisible({ timeout: 60_000 });
    await secondVisitor.getByLabel("Password").fill(SHARE_PASSWORD);
    await secondVisitor.getByRole("button", { name: "Open" }).click();
    await expect(noteEditor(secondVisitor, "Budget.fj.md")).toContainText("SECRET PLAINTEXT of the budget", { timeout: 60_000 });
    expect(record.join("\n")).not.toContain(SHARE_PASSWORD);

    // Revoking deletes the copy: the link stops working, and the list says there is one less.
    await expect(panel.getByRole("list", { name: "Sealed links" }).getByRole("listitem")).toHaveCount(2);
    await panel.getByRole("listitem").filter({ hasText: "Key in the link" }).getByRole("button", { name: "Revoke" }).click();
    await expect(panel.getByRole("list", { name: "Sealed links" }).getByRole("listitem")).toHaveCount(1, { timeout: 30_000 });
    expect((await visitor.request.get(`/api/sealed/${token}`, { failOnStatusCode: false })).status()).toBe(404);
    const again = await visitor.newPage();
    await again.goto(keyLink);
    await expect(again.getByText("This link does not work")).toBeVisible({ timeout: 30_000 });
    await visitor.close();

    // Only the owner makes or revokes a share; the plain file of a plaintext vault is not shared this way.
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.92" } });
    expect((await stranger.request.get(`/api/connections/${id}/sealed-shares?path=Open/Budget.fj.md.age`, { failOnStatusCode: false })).status()).toBe(401);
    expect((await stranger.request.post(`/api/connections/${id}/sealed-shares`, { headers: { origin: BASE }, data: {}, failOnStatusCode: false })).status()).toBe(401);
    await stranger.close();
    const plainFile = await page.request.post(`/api/connections/${id}/sealed-shares`, {
      headers: { origin: BASE },
      data: { path: "Open/recipients.txt", mode: "key", ciphertext: Buffer.from("age-encryption.org/v1\n-> X25519 x\nbody").toString("base64") },
      failOnStatusCode: false,
    });
    expect(plainFile.status()).toBe(422);
    expect((await page.request.post(`/api/connections/${id}/sealed-shares`, { headers: { origin: BASE }, data: { path: "Open/Budget.fj.md.age", mode: "key", ciphertext: Buffer.from("# plain").toString("base64") }, failOnStatusCode: false })).status()).toBe(422);
  } finally {
    await restoreMore();
  }
});

// --- Security review of phase 2 (ROADMAP 2c.2, docs/security-review-phase-2.md) ---

test("review of phase 2: nothing but ciphertext can be made to land in an encrypted vault, by any route, whatever is sent, and another account reaches none of it", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const MARK = "SECRET PLAINTEXT MARK";
  const AGE_B64 = (bytesIn: Uint8Array) => Buffer.from(bytesIn).toString("base64");
  const minute = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
  try {
    const { id, secret } = await encryptedWorkbench(page, (recipient) => ({
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Plan.md": `# Plan ${MARK}`,
      "Notes/Gone.md": `gone ${MARK}`,
      "Open/Enc.md.age": wasm.encrypt(bytes("encrypted"), recipient, false),
    }));
    const post = (path: string, data: unknown, method: "POST" | "PUT" = "POST") => page.request.fetch(`/api/connections/${id}${path}`, { method, headers: { origin: BASE }, data, failOnStatusCode: false });
    const code = async (response: Awaited<ReturnType<typeof post>>) => (await response.json().catch(() => ({}))).error?.code as string | undefined;
    const plain = bytes(MARK);
    const cipher = wasm.encrypt(bytes("x"), wasm.identityRecipient(wasm.generateIdentity()), false);
    const NOTE_BLOB = createHash("sha1").update(`blob ${Buffer.byteLength(`# Plan ${MARK}`)}\0`).update(`# Plan ${MARK}`).digest("hex");

    // A deletion to put back from: a plaintext file whose record the restore route can be asked about.
    const deleted = await post("/files/delete", { vault: "Notes", type: "file", path: "Notes/Gone.md", blob: gitBlobId(`gone ${MARK}`) });
    expect(deleted.status()).toBe(200);
    const deletionIds = (await deleted.json()).deletions as number[];
    const before = (await hubs.more.branchHead())!;

    const refused: [string, Awaited<ReturnType<typeof post>>, number, string | undefined][] = [
      ["a plain note made in an encrypted vault", await post("/files", { vault: "Open", folder: "", kind: "note", title: "Sneaky", localMinute: minute }), 422, "encrypted_vault"],
      ["plain text sent as a new encrypted file", await post("/files/encrypted", { vault: "Open", folder: "", kind: "note", title: "Sneaky", localMinute: minute, ciphertext: AGE_B64(plain) }), 422, "not_ciphertext"],
      ["a plain draft of an encrypted file", await post("/working-copy", { path: "Open/Enc.md.age", baseBlob: "0".repeat(40), content: MARK }, "PUT"), 422, "not_editable"],
      ["plain text as an encrypted draft", await post("/working-copy", { path: "Open/Enc.md.age", baseBlob: "0".repeat(40), content: AGE_B64(plain), encrypted: true }, "PUT"), 422, "unstorable"],
      ["an encrypted draft of a plaintext note", await post("/working-copy", { path: "Notes/Plan.md", baseBlob: NOTE_BLOB, content: AGE_B64(cipher), encrypted: true }, "PUT"), 422, "not_editable"],
      ["a plaintext note moved into an encrypted vault", await post("/files/move", { vault: "Notes", type: "file", path: "Notes/Plan.md", blob: NOTE_BLOB, destination: "Open/Plan.md" }), 422, "encrypted_vault"],
      ["an encrypted file moved to a plaintext vault by Move", await post("/files/move", { vault: "Open", type: "file", path: "Open/Enc.md.age", blob: "0".repeat(40), destination: "Notes/Enc.md.age" }), 422, "other_vault"],
      ["plain text transferred into an encrypted vault", await post("/files/transfer", { path: "Notes/Plan.md", blob: NOTE_BLOB, destination: "Open/Plan.md.age", content: AGE_B64(plain) }), 422, "wrong_form"],
      ["ciphertext transferred into a plaintext vault", await post("/files/transfer", { path: "Open/Enc.md.age", blob: "0".repeat(40), destination: "Notes/Enc.md", content: AGE_B64(cipher) }), 422, "wrong_form"],
      ["a vault's recipients file deleted", await post("/files/delete", { vault: "Open", type: "file", path: "Open/recipients.txt", blob: "0".repeat(40) }), 422, "protected"],
      ["a vault's recipients file moved", await post("/files/move", { vault: "Open", type: "file", path: "Open/recipients.txt", blob: "0".repeat(40), destination: "Open/keys.txt" }), 422, "protected"],
      ["a plaintext deletion put back into an encrypted vault", await post("/files/restore", { ids: deletionIds, path: "Open/Gone.md" }), 422, "bad_path"],
      ["plain text kept as a sealed copy", await post("/sealed-shares", { path: "Open/Enc.md.age", mode: "key", ciphertext: AGE_B64(plain) }), 422, "not_ciphertext"],
      ["a plaintext note shared as a sealed copy", await post("/sealed-shares", { path: "Notes/Plan.md", mode: "key", ciphertext: AGE_B64(cipher) }), 422, "not_encrypted"],
    ];
    const wrong = [];
    for (const [what, response, status, expected] of refused) if (response.status() !== status || (await code(response)) !== expected) wrong.push(`${what}: ${response.status()} ${await code(response)}`);
    expect(wrong).toEqual([]);

    // Nothing was written by any of it, and no file of an encrypted vault holds a word of plain text.
    expect(await hubs.more.branchHead()).toBe(before);
    for (const [path, text] of Object.entries(await hubs.more.filesAt(before))) if (path.startsWith("Open/")) expect(text, path).not.toContain(MARK);
    expect(textOf(decryptedAt(secret, await hubs.more.fileBytesAt(before, "Open/Enc.md.age")))).toBe("encrypted");

    // Another account reaches none of it: the same answer as for something that is not there.
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.95" } });
    const other = await stranger.newPage();
    await signUp(other, `mallory-${Date.now()}@example.com`, "Mallory");
    const theirs = (path: string, method = "GET", data?: unknown) => other.request.fetch(`/api/connections/${id}${path}`, { method, headers: { origin: BASE }, ...(data === undefined ? {} : { data }), failOnStatusCode: false });
    const sees = [
      await theirs("/ciphertext?path=Open/Enc.md.age"),
      await theirs("/recipients?vault=Open"),
      await theirs("/sealed-shares?path=Open/Enc.md.age"),
      await theirs("/sealed-shares?share=1", "DELETE"),
      await theirs("/sealed-shares", "POST", { path: "Open/Enc.md.age", mode: "key", ciphertext: AGE_B64(cipher) }),
      await theirs("/files/transfer", "POST", { path: "Open/Enc.md.age", blob: "0".repeat(40), destination: "Notes/x.md", content: AGE_B64(plain) }),
      await theirs("/files/encrypted", "POST", { vault: "Open", folder: "", kind: "note", title: "x", localMinute: minute, ciphertext: AGE_B64(cipher) }),
    ];
    expect(sees.map((response) => response.status())).toEqual(sees.map(() => 404));
    await stranger.close();
    expect(await hubs.more.branchHead()).toBe(before);
  } finally {
    await restoreMore();
  }
});

test("review of phase 2: a sealed link from someone hostile is shown as text and does nothing, its page is sent with the policy and no referrer, and a copy asking for ruinous work is not opened", async ({ page, browser }) => {
  test.setTimeout(300_000);
  try {
    const { id, record } = await encryptedWorkbench(page, (recipient) => ({ "Open/Enc.md.age": wasm.encrypt(bytes("x"), recipient, false) }));
    void record;
    // The hostile sharer is a person with a link, so the copy is made here with the same module that makes ours.
    const hostileName = `<img src=x onerror="window.__owned=1"><script>window.__owned=2</script>.md`;
    const hostileText = `<script>window.__owned=3</script>\n<iframe src="https://evil.example/frame"></iframe>\n[click](javascript:window.__owned=4)\n![remote](https://evil.example/pixel.png)\n`;
    const identity = wasm.generateIdentity();
    const payload = bytes(JSON.stringify({ v: 1, name: hostileName, text: hostileText }));
    const sealed = wasm.encrypt(payload, `${wasm.identityRecipient(identity)}\n`, false);
    const made = await page.request.post(`/api/connections/${id}/sealed-shares`, { headers: { origin: BASE }, data: { path: "Open/Enc.md.age", mode: "key", ciphertext: Buffer.from(sealed).toString("base64") } });
    expect(made.status()).toBe(201);
    const token = (await made.json()).token as string;
    const link = `${BASE}/s/${token}#key=${new TextDecoder().decode(identity)}`;

    const visitor = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.96" } });
    const guest = await visitor.newPage();
    const requested: string[] = [];
    guest.on("request", (request) => requested.push(request.url()));
    await guest.addInitScript(() => {
      (window as unknown as { __violations: string[] }).__violations = [];
      document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(event.violatedDirective));
    });
    const loaded = await guest.goto(link);
    // The page is sent with the policy (with a nonce of its own), no referrer, and no leave to be framed or kept.
    const headers = loaded!.headers();
    expect(headers["content-security-policy"]).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=_-]+'/);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(await guest.locator('meta[name="robots"]').getAttribute("content")).toContain("noindex");
    const served = await visitor.request.get(`/api/sealed/${token}`);
    expect(served.headers()["cache-control"]).toContain("no-store");

    // The copy opens, and what is in it is only text: nothing ran, nothing was fetched from another site.
    await expect(guest.getByRole("heading", { name: hostileName })).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByRole("textbox", { name: hostileName, exact: true })).toContainText("<script>window.__owned=3</script>");
    await guest.waitForLoadState("networkidle");
    expect(await guest.evaluate(() => (window as unknown as { __owned?: number }).__owned)).toBeUndefined();
    expect(await guest.locator("iframe, img[src*='evil'], script:not([src]):has-text('__owned')").count()).toBe(0);
    expect(requested.filter((url) => !url.startsWith(BASE))).toEqual([]);
    expect(await guest.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);

    // A password copy that asks for far more work than the identity's own is refused before any is done.
    const costly = wasm.sealWithPassphrase(payload, bytes("a password of some length"), 10);
    const rewritten = Buffer.from(Buffer.from(costly).toString("latin1").replace(/^(-> scrypt \S+ )10$/m, "$120"), "latin1");
    const second = await page.request.post(`/api/connections/${id}/sealed-shares`, { headers: { origin: BASE }, data: { path: "Open/Enc.md.age", mode: "password", ciphertext: rewritten.toString("base64") } });
    expect(second.status()).toBe(201);
    const costlyPage = await visitor.newPage();
    await costlyPage.goto(`${BASE}/s/${(await second.json()).token as string}`);
    await costlyPage.getByLabel("Password").fill("a password of some length");
    const asked = Date.now();
    await costlyPage.getByRole("button", { name: "Open" }).click();
    await expect(costlyPage.getByText("asks for far more work")).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - asked).toBeLessThan(5_000);
    await visitor.close();
  } finally {
    await restoreMore();
  }
});

// --- A note in the note editor (ROADMAP 1b.2) -----------------------------------------------------------------

/** `acme/more` holding these files, connected by a new account. */
async function repositoryWith(page: import("@playwright/test").Page, files: Record<string, string | Uint8Array>, who?: { email: string; name: string }): Promise<number> {
  await hubs.more.commitFiles(files, { replace: true });
  await signUp(page, who?.email, who?.name);
  await page.goto("/repositories");
  await connect(page, "acme/more");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/more");
  return (await (await page.request.get("/api/connections")).json()).connections[0].id as number;
}

const VAULT_MANIFEST = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const noteEditor = (page: import("@playwright/test").Page, name: string) => page.getByRole("textbox", { name, exact: true });

test("a note opens in the note editor, and reads the file once", async ({ page }) => {
  const id = await connected(page);
  await page.goto(`/repo/${id}/Public`);
  hubs.notes.requests.length = 0;
  await page.goto(`/repo/${id}/Public/idea.md`);

  const editor = noteEditor(page, "idea.md");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("# Idea");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(page.getByTestId("draft-status")).toHaveText("No changes yet. What you type is kept as a draft.");

  // The file was read, once, by its blob; nothing else was (finding a draft asks our own database, not the host).
  const blobReads = hubs.notes.requests.filter((request) => request.path.includes("/git/blobs/"));
  expect(blobReads).toHaveLength(1);
  expect(hubs.notes.requests.filter((request) => request.path.includes("/git/trees/"))).toEqual([]);
});

// --- Working copies (ROADMAP 1b.8) ----------------------------------------------------------------------------

const status = (page: import("@playwright/test").Page) => page.getByTestId("draft-status");

test("what is typed in a note is kept as a draft, found again on opening it, and never committed", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "# Title\n\nbody\n" });
    const head = await hubs.more.branchHead();

    await page.goto(`/repo/${id}/Notes/n.md`);
    const editor = noteEditor(page, "n.md");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("more words, kept");
    await expect(status(page)).toHaveText("Changes kept as a draft.");

    // Opened again, it is the draft that is shown, and it is said to be one.
    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(noteEditor(page, "n.md")).toContainText("more words, kept");
    await expect(page.getByText("Your changes were kept")).toBeVisible();

    // The repository was not touched: typing is not a commit.
    expect(await hubs.more.branchHead()).toBe(head);
    await hubs.more.fsck();

    // Discarding goes back to the note as the repository has it.
    await page.getByRole("button", { name: "Discard changes" }).click();
    await page.getByRole("button", { name: "Yes, discard" }).click();
    await expect(noteEditor(page, "n.md")).not.toContainText("more words, kept");
    await expect(noteEditor(page, "n.md")).toContainText("# Title");
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("typing and deleting it again leaves no draft", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "x\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await noteEditor(page, "n.md").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("abc");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(2500);
    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("drafts are kept only for the caller's own repository, from this site, for notes", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "x\n", "Notes/d.fj.md": "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8m\n---\nbody\n", "Notes/pic.png": "png" });
    const url = `/api/connections/${id}/working-copy`;
    const blob = "a".repeat(40);
    const put = (data: unknown, origin: string = BASE) => page.request.put(url, { headers: { origin }, data });

    expect((await put({ path: "Notes/n.md", baseBlob: blob, content: "ok" }, "https://evil.example")).status()).toBe(403);
    expect((await put({ path: "../escape.md", baseBlob: blob, content: "ok" })).status()).toBe(400);
    expect((await put({ path: "Notes/n.md", baseBlob: "main", content: "ok" })).status()).toBe(400);
    // A file that is not a note or a document in a plaintext vault: a picture, a file that is not there, a folder.
    for (const path of ["Notes/pic.png", "Notes/missing.md", "Notes"]) {
      const response = await put({ path, baseBlob: blob, content: "ok" });
      expect([path, response.status()]).toEqual([path, 422]);
      expect((await response.json()).error.code).toBe("not_editable");
    }
    const kept = await put({ path: "Notes/n.md", baseBlob: blob, content: "ok" });
    expect(kept.status()).toBe(200);
    expect(Object.keys((await kept.json()).workingCopy).sort()).toEqual(["baseBlob", "createdAt", "lastEdit"]);
    // Another version's text is not mixed into the draft.
    const mismatch = await put({ path: "Notes/n.md", baseBlob: "b".repeat(40), content: "other" });
    expect(mismatch.status()).toBe(409);
    expect((await mismatch.json()).error.baseBlob).toBe(blob);
    // A text that cannot be kept in the database is refused and does not replace the draft.
    expect((await put({ path: "Notes/n.md", baseBlob: blob, content: "a\u0000b" })).status()).toBe(422);

    // Nobody else can touch it: signed out, it is 401; another account's, 404.
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.9" } });
    const other = await stranger.newPage();
    expect((await other.request.put(url, { headers: { origin: BASE }, data: { path: "Notes/n.md", baseBlob: blob, content: "mine now" } })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.put(url, { headers: { origin: BASE }, data: { path: "Notes/n.md", baseBlob: blob, content: "mine now" } })).status()).toBe(404);
    expect((await other.request.delete(`${url}?path=Notes/n.md`, { headers: { origin: BASE } })).status()).toBe(404);
    await stranger.close();

    // ...so the draft is still the owner's (its base was made up above, so the page says the note is not the one it was started from).
    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByText("This note changed in the repository while you were editing it")).toBeVisible();
    await expect(noteEditor(page, "Your version of n.md")).toHaveText("ok");

    // Disconnecting takes the drafts with it.
    expect((await page.request.delete(`/api/connections/${id}`, { headers: { origin: BASE } })).status()).toBe(204);
    expect((await page.request.put(url, { headers: { origin: BASE }, data: { path: "Notes/n.md", baseBlob: blob, content: "x" } })).status()).toBe(404);
  } finally {
    await restoreMore();
  }
});

// --- Versions (ROADMAP 1b.9) ----------------------------------------------------------------------------------

test("Save version makes one commit of the draft, authored by the person, and the note is then the repository's", async ({ page }) => {
  try {
    const who = { email: `grace-${Date.now()}@example.com`, name: "Grace Hopper" };
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "# Title\n", "Notes/other.md": "untouched" }, who);
    const before = (await hubs.more.branchHead()) as string;

    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(0); // nothing to save yet
    await noteEditor(page, "n.md").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("A new line, saved at once.");
    // No wait for the debounce: saving a version keeps what is on screen first.
    await page.getByLabel("Message").fill("Add a line");
    await expect(page.getByRole("button", { name: "Save version" })).toBeVisible();
    await page.getByRole("button", { name: "Save version" }).click();

    await expect(page.getByText("Version saved")).toBeVisible();
    const head = (await hubs.more.branchHead()) as string;
    expect(head).not.toBe(before);
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%an <%ae>")).toBe(`Grace Hopper <${who.email}>`);
    expect(await hubs.more.show(head, "%B")).toBe("Add a line");
    expect(await hubs.more.filesAt(head)).toMatchObject({ "Notes/n.md": promoted("Title", "# Title\nA new line, saved at once."), "Notes/other.md": "untouched" });
    await hubs.more.fsck();

    // The draft is gone: the note is what the repository has, and nothing says there are unsaved changes.
    await expect(noteEditor(page, "n.md")).toContainText("A new line, saved at once.");
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
    // And it is said once.
    await page.reload();
    await expect(page.getByText("Version saved")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("a version without a message is called Edit and the note's name", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Meeting notes.md": "x\n" });
    await page.goto(`/repo/${id}/Notes/Meeting notes.md`);
    await noteEditor(page, "Meeting notes.md").click();
    await page.keyboard.type("y");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    expect(await hubs.more.show((await hubs.more.branchHead()) as string, "%B")).toBe("Edit Meeting notes");
  } finally {
    await restoreMore();
  }
});

test("a version is not made on top of a note that changed in the repository: both versions are shown instead", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "original\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await noteEditor(page, "n.md").click();
    await page.keyboard.type("MINE ");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "changed elsewhere\n" });

    await page.getByRole("button", { name: "Save version" }).click();
    // Nothing was written; the page looks again and shows both.
    await expect(page.getByText("This note changed in the repository while you were editing it")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs);
    await expect(noteEditor(page, "Your version of n.md")).toContainText("MINE");
    await expect(noteEditor(page, "n.md in the repository now")).toContainText("changed elsewhere");
    await expect(page.getByRole("button", { name: "Save version" })).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("who may make a version: a signed-in person, from this site, of their own draft", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "x\n" });
    const url = `/api/connections/${id}/working-copy/version`;
    const head = (await hubs.more.branchHead()) as string;
    const post = (data: unknown, origin: string = BASE) => page.request.post(url, { headers: { origin }, data });

    expect((await post({ path: "Notes/n.md" }, "https://evil.example")).status()).toBe(403);
    expect((await post({ path: "../x.md" })).status()).toBe(400);
    expect((await post({ path: "Notes/n.md", message: "x".repeat(1001) })).status()).toBe(400);
    expect((await page.request.get(url)).status()).toBe(405);
    const none = await post({ path: "Notes/n.md" });
    expect(none.status()).toBe(409);
    expect((await none.json()).error.code).toBe("no_draft");

    // A draft that is another person's draft cannot be turned into a version by someone else.
    await page.request.put(`/api/connections/${id}/working-copy`, { headers: { origin: BASE }, data: { path: "Notes/n.md", baseBlob: "a".repeat(40), content: "draft" } });
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.11" } });
    const other = await stranger.newPage();
    expect((await other.request.post(url, { headers: { origin: BASE }, data: { path: "Notes/n.md" } })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.post(url, { headers: { origin: BASE }, data: { path: "Notes/n.md" } })).status()).toBe(404);
    await stranger.close();

    // Nothing above wrote anything; and the owner's draft, of a made-up base, is refused rather than committed.
    expect(await hubs.more.branchHead()).toBe(head);
    const refused = await post({ path: "Notes/n.md" });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe("upstream_changed");
    expect(await hubs.more.branchHead()).toBe(head);
  } finally {
    await restoreMore();
  }
});

// --- Going on after the file changed (ROADMAP 1b.10) ---------------------------------------------------------

/** What git calls a blob with this text, which is what a draft's base is. */
const gitBlobId = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/** Open the note, type at the very start, and wait until the draft is kept. */
async function typeAtStart(page: import("@playwright/test").Page, id: number, name: string, text: string) {
  await page.goto(`/repo/${id}/Notes/${name}`);
  await noteEditor(page, name).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(text);
  await expect(status(page)).toHaveText("Changes kept as a draft.");
}

const FIVE = "one\ntwo\nthree\nfour\nfive\n";

test("when the note changed in the repository, both versions are shown, and taking theirs throws the draft away", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "original\n" });
    await typeAtStart(page, id, "n.md", "MINE ");
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "changed elsewhere\n" });

    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByText("This note changed in the repository while you were editing it")).toBeVisible();
    const mine = noteEditor(page, "Your version of n.md");
    const other = noteEditor(page, "n.md in the repository now");
    await expect(mine).toContainText("MINE original");
    await expect(other).toContainText("changed elsewhere");
    for (const editor of [mine, other]) await expect(editor).toHaveAttribute("aria-readonly", "true");
    await expect(page.getByTestId("combine-preview")).toContainText("touch the same lines in 1 place");

    await page.getByRole("button", { name: "Take theirs" }).click();
    await page.getByRole("button", { name: "Yes, discard mine" }).click();
    await expect(noteEditor(page, "n.md")).toContainText("changed elsewhere");
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
    expect(await hubs.more.branchHead()).toBe(theirs);
  } finally {
    await restoreMore();
  }
});

test("keeping mine puts the draft on their version, and the next version is on top of theirs, which stays in the history", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "original\n" });
    await typeAtStart(page, id, "n.md", "MINE ");
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "changed elsewhere\n" });

    await page.goto(`/repo/${id}/Notes/n.md`);
    await page.getByRole("button", { name: "Keep mine" }).click();
    await expect(noteEditor(page, "n.md")).toContainText("MINE original");
    await expect(page.getByText("Your changes were kept")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs); // nothing written yet

    await page.getByLabel("Message").fill("Mine, over theirs");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(theirs);
    expect(await hubs.more.filesAt(head)).toMatchObject({ "Notes/n.md": promoted("n", "MINE original\n") });
    expect(await hubs.more.filesAt(theirs)).toMatchObject({ "Notes/n.md": "changed elsewhere\n" });
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("combining edits in different places keeps both, as a draft, and the version has both", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": FIVE });
    await typeAtStart(page, id, "n.md", "ZERO ");
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": FIVE.replace("five", "FIVE") });

    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByTestId("combine-preview")).toContainText("can be combined without a conflict");
    await page.getByRole("button", { name: "Combine", exact: true }).click();

    const editor = noteEditor(page, "n.md");
    await expect(editor).toContainText("ZERO one");
    await expect(editor).toContainText("FIVE");
    await expect(page.getByText("There are conflicts to settle")).toHaveCount(0);
    expect(await hubs.more.branchHead()).toBe(theirs);

    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(theirs);
    expect(await hubs.more.filesAt(head)).toMatchObject({ "Notes/n.md": promoted("n", "ZERO one\ntwo\nthree\nfour\nFIVE\n") });
  } finally {
    await restoreMore();
  }
});

test("combining edits of the same line keeps both between markers, which the person settles before saving", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "a\nsame\nz\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await noteEditor(page, "n.md").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("a\nmine\nz\n");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "a\ntheirs\nz\n" });

    await page.goto(`/repo/${id}/Notes/n.md`);
    await page.getByRole("button", { name: "Combine", exact: true }).click();
    const editor = noteEditor(page, "n.md");
    await expect(editor).toContainText("<<<<<<< Your changes");
    await expect(editor).toContainText(">>>>>>> In the repository");
    await expect(editor).toContainText("mine");
    await expect(editor).toContainText("theirs");
    await expect(page.getByText("There are conflicts to settle in this text")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save version anyway" })).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs);

    // Settled by hand: the warning goes, and the version is what was decided.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("a\nmine and theirs\nz\n");
    await expect(page.getByText("There are conflicts to settle in this text")).toHaveCount(0);
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(theirs);
    expect(await hubs.more.filesAt(head)).toMatchObject({ "Notes/n.md": promoted("n", "a\nmine and theirs\nz\n") });
  } finally {
    await restoreMore();
  }
});

test("a note deleted in the repository does not lose the draft: it is shown, and can be thrown away", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "original\n", "Notes/keep.md": "k" });
    await typeAtStart(page, id, "n.md", "UNSAVED ");
    await hubs.more.commitFiles({ "Notes/n.md": null });

    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(page.getByText("This note is no longer in the repository")).toBeVisible();
    await expect(noteEditor(page, "Your unsaved changes to n.md")).toContainText("UNSAVED original");

    await page.getByRole("button", { name: "Discard changes" }).click();
    await page.getByRole("button", { name: "Yes, discard" }).click();
    await expect.poll(async () => (await page.request.get(`/repo/${id}/Notes/n.md`)).status()).toBe(404);
  } finally {
    await restoreMore();
  }
});

test("who may go on from a changed note: a signed-in person, from this site, about the version they were shown", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "x\n" });
    const url = `/api/connections/${id}/working-copy/resolve`;
    const post = (data: unknown, origin: string = BASE) => page.request.post(url, { headers: { origin }, data });
    const theirsText = "y\n";
    const body = { path: "Notes/n.md", choice: "mine", upstreamBlob: gitBlobId(theirsText) };

    expect((await post(body, "https://evil.example")).status()).toBe(403);
    expect((await post({ ...body, choice: "theirs" })).status()).toBe(400);
    expect((await post({ ...body, upstreamBlob: "main" })).status()).toBe(400);
    expect((await page.request.get(url)).status()).toBe(405);
    expect(((await (await post(body)).json()).error.code)).toBe("no_draft");

    expect((await page.request.put(`/api/connections/${id}/working-copy`, { headers: { origin: BASE }, data: { path: "Notes/n.md", baseBlob: gitBlobId("x\n"), content: "mine\n" } })).status()).toBe(200);
    expect(((await (await post(body)).json()).error.code)).toBe("up_to_date"); // the file is still the one it is of

    const head = await hubs.more.commitFiles({ "Notes/n.md": theirsText });
    const wrong = await post({ ...body, upstreamBlob: gitBlobId("something else\n") });
    expect(wrong.status()).toBe(409);
    expect((await wrong.json()).error.code).toBe("upstream_moved");

    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.12" } });
    const other = await stranger.newPage();
    expect((await other.request.post(url, { headers: { origin: BASE }, data: body })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.post(url, { headers: { origin: BASE }, data: body })).status()).toBe(404);
    await stranger.close();

    // None of that wrote anything to the repository, or moved the draft; the right call moves it, and still writes nothing.
    expect(await hubs.more.branchHead()).toBe(head);
    const moved = await post(body);
    expect(moved.status()).toBe(200);
    expect((await moved.json()).conflicts).toBe(0);
    expect(await hubs.more.branchHead()).toBe(head);
    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(noteEditor(page, "n.md")).toContainText("mine");
    await expect(page.getByText("This note changed in the repository while you were editing it")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

// --- Creating notes and documents (ROADMAP 1b.7) ----------------------------------------------------------------

const ENCRYPTED_MANIFEST = JSON.stringify({
  fjord: 1,
  id: "01jagc4k7pr9tbm3ykwx6zq2hw",
  name: "Secret",
  createdAt: "2026-10-16T09:34:00Z",
  encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "none", armor: false },
  fileNaming: "plain",
});
const RECIPIENTS = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n";

test("a note is made from a title: one commit, by the person, named by fjord-core, and it opens in the editor", async ({ page }) => {
  try {
    const who = { email: `grace-${Date.now()}@example.com`, name: "Grace Hopper" };
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/other.md": "untouched", "Notes/Projects/a.md": "a" }, who);
    const before = (await hubs.more.branchHead()) as string;

    await page.goto(`/repo/${id}/Notes`);
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Title").fill("Weekly review: what went well?");
    await page.getByRole("button", { name: "Create note" }).click();

    // The name is fjord-core's: what a file name cannot hold becomes a space.
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/Weekly%20review%20what%20went%20well.md`);
    await expect(noteEditor(page, "Weekly review what went well.md")).toContainText("# Weekly review: what went well?");
    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%an <%ae>")).toBe(`Grace Hopper <${who.email}>`);
    expect(await hubs.more.show(head, "%B")).toBe("Create Weekly review what went well");
    expect(await hubs.more.filesAt(head)).toEqual({ ...(await hubs.more.filesAt(before)), "Notes/Weekly review what went well.md": "# Weekly review: what went well?\n" });
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a note without a title is named after the date and time and is empty, and a name that is taken is numbered", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.md": "p" });
    await page.goto(`/repo/${id}/Notes`);
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByRole("button", { name: "Create note" }).click();
    await expect(page).toHaveURL(new RegExp(`/repo/${id}/Notes/\\d{4}-\\d{2}-\\d{2}%20\\d{4}\\.md$`));
    const head = (await hubs.more.branchHead()) as string;
    const [name] = Object.keys(await hubs.more.filesAt(head)).filter((path) => /^Notes\/\d{4}-\d{2}-\d{2} \d{4}\.md$/.test(path));
    expect((await hubs.more.filesAt(head))[name!]).toBe("");

    await page.goto(`/repo/${id}/Notes`);
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Title").fill("plan");
    await page.getByRole("button", { name: "Create note" }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/plan%202.md`);
  } finally {
    await restoreMore();
  }
});

test("a document is made with a header, in a folder, and a note of the same name does not stop it", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Projects/Q4 plan.md": "a note", "Notes/Projects/x.md": "x" });
    await page.goto(`/repo/${id}/Notes/Projects`);
    await page.getByRole("button", { name: "New document" }).click();
    await expect(page.getByRole("button", { name: "Create document" })).toBeVisible();
    await page.getByLabel("Title").fill("Q4 plan");
    await page.getByRole("button", { name: "Create document" }).click();

    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/Projects/Q4%20plan.fj.md`);
    const head = (await hubs.more.branchHead()) as string;
    const text = (await hubs.more.filesAt(head))["Notes/Projects/Q4 plan.fj.md"]!;
    expect(text).toMatch(/^---\nid: [0-9a-hjkmnp-tv-z]{26}\ntitle: Q4 plan\ncreated: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"\n---\n\n# Q4 plan\n$/);
    expect(await hubs.more.show(head, "%B")).toBe("Create Q4 plan");
  } finally {
    await restoreMore();
  }
});

test("a document needs a title, and says so, and nothing is made", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST });
    const head = (await hubs.more.branchHead()) as string;
    await page.goto(`/repo/${id}/Notes`);
    await page.getByRole("button", { name: "New document" }).click();
    await page.getByLabel("Title").fill("***");
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(page.getByText("A document needs a title with some letters or digits")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(head);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  } finally {
    await restoreMore();
  }
});

test("an encrypted vault is offered the encrypted way only, and the plaintext way refuses it if asked", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Secret/fjord.vault.json": ENCRYPTED_MANIFEST, "Secret/recipients.txt": RECIPIENTS, "Secret/x.md.age": "age-encryption.org/v1", "Notes/fjord.vault.json": VAULT_MANIFEST });
    await page.goto(`/repo/${id}/Secret`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Offered, but it encrypts in the browser: the form says so.
    await page.getByRole("button", { name: "New note" }).click();
    await expect(page.getByText("The file is encrypted here, in this browser.")).toBeVisible();
    await page.goto(`/repo/${id}/Notes`);
    await expect(page.getByRole("button", { name: "New note" })).toBeVisible();

    const head = (await hubs.more.branchHead()) as string;
    const response = await page.request.post(`/api/connections/${id}/files`, {
      headers: { origin: BASE },
      data: { vault: "Secret", folder: "", kind: "note", title: "leak", localMinute: { year: 2026, month: 10, day: 22, hour: 14, minute: 30 } },
    });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe("encrypted_vault");
    expect(await hubs.more.branchHead()).toBe(head);
  } finally {
    await restoreMore();
  }
});

test("who may make a file: a signed-in person, from this site, in their own repository, in a folder that is there", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/a.md": "a" });
    const url = `/api/connections/${id}/files`;
    const head = (await hubs.more.branchHead()) as string;
    const minute = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
    const good = { vault: "Notes", folder: "", kind: "note", title: "Idea", localMinute: minute };
    const post = (data: unknown, origin: string = BASE) => page.request.post(url, { headers: { origin }, data });

    expect((await post(good, "https://evil.example")).status()).toBe(403);
    expect((await post({ ...good, vault: "../Other" })).status()).toBe(400);
    expect((await post({ ...good, folder: "../x" })).status()).toBe(400);
    expect((await post({ ...good, title: "one\ntwo" })).status()).toBe(400);
    expect((await post({ ...good, localMinute: { ...minute, month: 13 } })).status()).toBe(400);
    expect((await page.request.get(url)).status()).toBe(405);
    expect(((await (await post({ ...good, vault: "Nowhere" })).json()).error.code)).toBe("unknown_vault");
    const gone = await post({ ...good, folder: "Missing" });
    expect(gone.status()).toBe(409);
    expect((await gone.json()).error.code).toBe("folder_gone");
    expect(((await (await post({ ...good, kind: "document", title: "---" })).json()).error.code)).toBe("bad_title");

    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.13" } });
    const other = await stranger.newPage();
    expect((await other.request.post(url, { headers: { origin: BASE }, data: good })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.post(url, { headers: { origin: BASE }, data: good })).status()).toBe(404);
    await stranger.close();

    // None of that wrote anything; the right call writes exactly one file.
    expect(await hubs.more.branchHead()).toBe(head);
    const made = await post(good);
    expect(made.status()).toBe(201);
    expect(await made.json()).toEqual({ path: "Notes/Idea.md", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  } finally {
    await restoreMore();
  }
});

// --- Deleting and putting back (ROADMAP 1b.12) ----------------------------------------------------------------

test("a note is deleted after asking, in one commit, and Undo puts back exactly what was there", async ({ page }) => {
  try {
    const who = { email: `grace-${Date.now()}@example.com`, name: "Grace Hopper" };
    const text = "\ufeff# Weekly\r\n\r\ntrailing  \r\n日本語 💧";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Weekly review.md": text, "Notes/other.md": "untouched" }, who);
    const before = (await hubs.more.branchHead()) as string;

    await page.goto(`/repo/${id}/Notes/Weekly review.md`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("It stays in the repository's history")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(before); // asked, not done
    await page.getByRole("button", { name: "Yes, delete" }).click();

    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);
    await expect(page.getByText("Deleted “Weekly review”")).toBeVisible();
    const deleted = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(deleted, "%P")).toBe(before);
    expect(await hubs.more.show(deleted, "%an <%ae>")).toBe(`Grace Hopper <${who.email}>`);
    expect(await hubs.more.show(deleted, "%B")).toBe("Delete Weekly review");
    expect(Object.keys(await hubs.more.filesAt(deleted)).sort()).toEqual(["Notes/fjord.vault.json", "Notes/other.md"]);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("list", { name: "Folder contents" })).toContainText("Weekly review");
    const restored = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(restored, "%P")).toBe(deleted);
    expect((await hubs.more.filesAt(restored))["Notes/Weekly review.md"]).toBe(text);
    await hubs.more.fsck();
    // Said once.
    await page.reload();
    await expect(page.getByText("Deleted “Weekly review”")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("Recently deleted lists what went, and a file is put back where it was or somewhere else", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/a.md": "first", "Notes/b.md": "second", "Notes/Sub/keep.md": "k" });
    for (const name of ["a", "b"]) {
      await page.goto(`/repo/${id}/Notes/${name}.md`);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Yes, delete" }).click();
      await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);
    }

    await page.goto(`/deleted/${id}`);
    const list = page.getByRole("list", { name: "Recently deleted" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").first()).toContainText("Notes/b.md"); // newest first

    // Where it was.
    await list.getByRole("listitem").filter({ hasText: "Notes/a.md" }).getByRole("button", { name: "Put back" }).click();
    await expect(page.getByRole("link", { name: "Notes/a.md" })).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/a.md"]).toBe("first");

    // Somewhere else, in a folder that is there, with the same bytes.
    const second = list.getByRole("listitem").filter({ hasText: "Notes/b.md" });
    await second.getByLabel("Put Notes/b.md back at").fill("Notes/Sub/Renamed b.md");
    await second.getByRole("button", { name: "Put back" }).click();
    await expect(page.getByRole("link", { name: "Notes/Sub/Renamed b.md" })).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Sub/Renamed b.md"]).toBe("second");

    await page.reload();
    await expect(page.getByText("Nothing was deleted in the last 30 days")).toBeVisible();
  } finally {
    await restoreMore();
  }
});

test("a folder is deleted with everything in it after naming how many, and put back together", async ({ page }) => {
  try {
    const files = { "Notes/Projects/a.md": "a", "Notes/Projects/2026/b.md": "b", "Notes/Projects/2026/c.csv": "x,y" };
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, ...files, "Notes/keep.md": "k" });
    await page.goto(`/repo/${id}/Notes/Projects`);
    await page.getByRole("button", { name: "Delete folder" }).click();
    await expect(page.getByText("the folder “Projects” and the 3 files in it")).toBeVisible();
    await page.getByRole("button", { name: "Yes, delete" }).click();

    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);
    const deleted = (await hubs.more.branchHead()) as string;
    expect(Object.keys(await hubs.more.filesAt(deleted)).sort()).toEqual(["Notes/fjord.vault.json", "Notes/keep.md"]);
    expect((await hubs.more.show(deleted, "%B")).split("\n")[0]).toBe("Delete Projects");

    await page.goto(`/deleted/${id}`);
    const list = page.getByRole("list", { name: "Recently deleted" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("3 files");
    await list.getByRole("button", { name: "Put all back" }).click();
    await expect(page.getByText("3 files, where they were.")).toBeVisible();
    expect(await hubs.more.filesAt((await hubs.more.branchHead()) as string)).toMatchObject(files);
  } finally {
    await restoreMore();
  }
});

test("only what was confirmed is deleted: a folder that gained a file since is left alone", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Projects/a.md": "a", "Notes/Projects/b.md": "b" });
    await page.goto(`/repo/${id}/Notes/Projects`);
    await page.getByRole("button", { name: "Delete folder" }).click();
    const theirs = await hubs.more.commitFiles({ "Notes/Projects/c.md": "arrived meanwhile" });
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Nothing was deleted", { exact: true })).toBeVisible();
    await expect(page.getByText("now holds 3 files")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs);
    await page.getByRole("button", { name: "Look again" }).click();
    await expect(page.getByText("the 3 files in it")).toHaveCount(0);
    await page.getByRole("button", { name: "Delete folder" }).click();
    await expect(page.getByText("the 3 files in it")).toBeVisible();
  } finally {
    await restoreMore();
  }
});

test("a note changed in the repository since it was shown is not deleted", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "mine\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "changed elsewhere\n" });
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("changed in the repository after you looked at it")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs);
    expect((await hubs.more.filesAt(theirs))["Notes/n.md"]).toBe("changed elsewhere\n");
  } finally {
    await restoreMore();
  }
});

test("unsaved changes are saved as a version before a note is deleted, so putting it back has them", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "original\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await noteEditor(page, "n.md").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("typed, never saved");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    const before = (await hubs.more.branchHead()) as string;

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);

    const deleted = (await hubs.more.branchHead()) as string;
    const version = (await hubs.more.show(deleted, "%P")) as string;
    expect(await hubs.more.show(version, "%P")).toBe(before);
    expect((await hubs.more.filesAt(version))["Notes/n.md"]).toEqual(promoted("n", "original\ntyped, never saved"));
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("list", { name: "Folder contents" })).toContainText("n"); // put back, and the page read again
    await page.goto(`/repo/${id}/Notes/n.md`);
    await expect(noteEditor(page, "n.md")).toContainText("typed, never saved");
    await expect(page.getByText("Your changes were kept")).toHaveCount(0); // it is the repository's now, not a draft
  } finally {
    await restoreMore();
  }
});

test("putting back is never over anything: a path that is taken is named, and what is there stays", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "the deleted one\n" });
    await page.goto(`/repo/${id}/Notes/n.md`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);
    const theirs = await hubs.more.commitFiles({ "Notes/n.md": "made since\n" });

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Something is already at that path")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(theirs);
    expect((await hubs.more.filesAt(theirs))["Notes/n.md"]).toBe("made since\n");

    // Somewhere free it goes.
    await page.goto(`/deleted/${id}`);
    await page.getByLabel("Put Notes/n.md back at").fill("Notes/n restored.md");
    await page.getByRole("button", { name: "Put back" }).click();
    await expect(page.getByRole("link", { name: "Notes/n restored.md" })).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/n restored.md"]).toBe("the deleted one\n");
  } finally {
    await restoreMore();
  }
});

test("who may delete and put back: a signed-in person, from this site, in their own repository, never a vault's own files", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Secret/fjord.vault.json": ENCRYPTED_MANIFEST, "Secret/recipients.txt": RECIPIENTS, "Secret/x.md.age": "age-encryption.org/v1", "Notes/n.md": "x\n" });
    const del = `/api/connections/${id}/files/delete`;
    const res = `/api/connections/${id}/files/restore`;
    const head = (await hubs.more.branchHead()) as string;
    const blob = gitBlobId("x\n");
    const file = { vault: "Notes", type: "file", path: "Notes/n.md", blob };
    const post = (url: string, data: unknown, origin: string = BASE) => page.request.post(url, { headers: { origin }, data });

    expect((await post(del, file, "https://evil.example")).status()).toBe(403);
    expect((await post(res, { ids: [1] }, "https://evil.example")).status()).toBe(403);
    expect((await post(del, { ...file, blob: "main" })).status()).toBe(400);
    expect((await post(del, { ...file, path: "../x.md" })).status()).toBe(400);
    expect((await post(res, { ids: [] })).status()).toBe(400);
    expect((await page.request.get(del)).status()).toBe(405);
    expect(((await (await post(del, { vault: "Notes", type: "file", path: "Notes/fjord.vault.json", blob })).json()).error.code)).toBe("upstream_changed"); // not its blob
    expect(((await (await post(del, { vault: "Notes", type: "folder", path: "Notes", files: 2 })).json()).error.code)).toBe("protected");
    // An encrypted vault this version writes is deleted from like any other (ROADMAP 2b.5): the blob given is not that file's.
    expect(((await (await post(del, { vault: "Secret", type: "file", path: "Secret/x.md.age", blob })).json()).error.code)).toBe("upstream_changed");
    expect(((await (await post(res, { ids: [999] })).json()).error.code)).toBe("not_found");

    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.14" } });
    const other = await stranger.newPage();
    expect((await other.request.post(del, { headers: { origin: BASE }, data: file })).status()).toBe(401);
    await signUp(other);
    expect((await other.request.post(del, { headers: { origin: BASE }, data: file })).status()).toBe(404);
    expect((await other.request.post(res, { headers: { origin: BASE }, data: { ids: [1] } })).status()).toBe(404);
    expect((await other.request.get(`/deleted/${id}`)).status()).toBe(404);
    await stranger.close();

    // None of that wrote anything; the right call deletes exactly one file.
    expect(await hubs.more.branchHead()).toBe(head);
    const done = await post(del, file);
    expect(done.status()).toBe(200);
    const { deletions } = await done.json();
    expect(deletions).toHaveLength(1);
    // A record is another account's to see or use only if it is theirs: it is not.
    await expect.poll(async () => (await hubs.more.branchHead()) !== head).toBe(true);
  } finally {
    await restoreMore();
  }
});

test("an encrypted file asks for an identity, and a document opens in its editor", async ({ page }) => {
  const id = await connected(page);
  await page.goto(`/repo/${id}/Private/secret.md.age`);
  await expect(page.getByText("No identity in this browser")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.goto(`/repo/${id}/Public/plan.fj.md`);
  await expect(noteEditor(page, "plan.fj.md")).toContainText("Plan");
});

// --- The document editor (ROADMAP 1b.3) --------------------------------------------------------------------------

/**
 * Put the caret at the end of an element's text, and type there. Home and End are not used: in a content-editable area
 * (the visual editor's) the browser decides what they do, and on macOS they scroll the page instead of moving the caret;
 * the caret is placed through the selection, which behaves the same everywhere.
 */
async function typeAtEndOf(page: import("@playwright/test").Page, element: import("@playwright/test").Locator, text: string) {
  await element.click();
  await element.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let next = walker.nextNode(); next; next = walker.nextNode()) last = next;
    if (!last) throw new Error("there is no text to put the caret in");
    const range = document.createRange();
    range.setStart(last, last.textContent?.length ?? 0);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.type(text);
}

const DOC_HEADER = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Q4 plan\nx-future:\n  - kept\n  - as is\ncreated: 2026-10-16T09:34:00Z\n---\n";

test("a document opens in the visual editor, an edit is kept as a draft, and a version leaves the header as it was", async ({ page }) => {
  try {
    const body = "\n# Plan\n\nThe quick brown fox.\n\n- one\n- two\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Q4 plan.fj.md": DOC_HEADER + body });
    await page.goto(`/repo/${id}/Notes/Q4 plan.fj.md`);

    const editor = noteEditor(page, "Q4 plan.fj.md");
    await expect(editor).toContainText("The quick brown fox.");
    await expect(page.getByRole("toolbar").filter({ hasText: "Block type" })).toBeVisible(); // the formatting toolbar (the comments have their own)
    // The header is not in the editor: it is kept by the app, whatever the person types.
    await expect(editor).not.toContainText("x-future");
    await expect(page.getByRole("note")).toHaveCount(0);

    await typeAtEndOf(page, editor.locator("p", { hasText: "The quick brown fox." }), " Jumps higher.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");

    await page.getByLabel("Message").fill("Extend the fox");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const saved = (await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Q4 plan.fj.md"]!;
    expect(saved.startsWith(DOC_HEADER)).toBe(true); // byte for byte, unknown key and all
    expect(saved.slice(DOC_HEADER.length)).toContain("The quick brown fox. Jumps higher.");
    expect(saved.endsWith("\n")).toBe(true);
    expect(await hubs.more.show((await hubs.more.branchHead()) as string, "%B")).toBe("Extend the fox");
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("the house style: a document written the same way is edited line for line, and one written another way says which lines would change and waits for the person to choose", async ({ page }) => {
  try {
    const styled = "\n# Plan\n\nThe quick brown fox.\n\n- one\n- two\n\n1. first\n1. second\n";
    const elsewhere = "\nPlan\n====\n\nThe quick brown fox.\n\n* one\n* two\n\n1. first\n2. second\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Styled.fj.md": DOC_HEADER + styled, "Notes/Elsewhere.fj.md": DOC_HEADER + elsewhere });

    // In the house style: nothing is asked, and the version differs from the file in the edited line alone.
    await page.goto(`/repo/${id}/Notes/Styled.fj.md`);
    const editor = noteEditor(page, "Styled.fj.md");
    await expect(editor).toContainText("The quick brown fox.");
    await page.waitForTimeout(800);
    await expect(page.getByRole("region", { name: "Reformatting" })).toHaveCount(0);
    await typeAtEndOf(page, editor.locator("p", { hasText: "The quick brown fox." }), " Jumps higher.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Styled.fj.md"]).toBe(DOC_HEADER + styled.replace("fox.", "fox. Jumps higher."));

    // Written another way: the lines are listed, nothing can be typed, and nothing is kept until the person chooses.
    await page.goto(`/repo/${id}/Notes/Elsewhere.fj.md`);
    const notice = page.getByRole("region", { name: "Reformatting" });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toContainText("Editing it here will reformat it");
    await notice.getByText("See what would change").click();
    const lines = notice.getByLabel("Lines that would change");
    for (const line of ["- Plan", "- ====", "+ # Plan", "- * one", "+ - one", "- 2. second", "+ 1. second"]) await expect(lines).toContainText(line);
    await expect(page.getByRole("textbox", { name: "Elsewhere.fj.md", exact: true })).toHaveAttribute("contenteditable", "false");
    await expect(status(page)).not.toHaveText("Changes kept as a draft.");

    await notice.getByRole("button", { name: "Reformat and edit here" }).click();
    await expect(notice).toHaveCount(0);
    const other = noteEditor(page, "Elsewhere.fj.md");
    await expect(other).toHaveAttribute("contenteditable", "true");
    await typeAtEndOf(page, other.locator("p", { hasText: "The quick brown fox." }), " Jumps higher.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Elsewhere.fj.md"]).toBe(DOC_HEADER + styled.replace("fox.", "fox. Jumps higher."));
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a document the visual editor cannot keep as written is shown as Markdown, and edited byte for byte", async ({ page }) => {
  try {
    const body = "\nSome text first.\n\n<details>\n<summary>Raw HTML</summary>\n\nInside.\n\n</details>\n\nA footnote[^1] too.\n\n[^1]: The note.\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Raw.fj.md": DOC_HEADER + body });
    await page.goto(`/repo/${id}/Notes/Raw.fj.md`);

    await expect(page.getByRole("note")).toContainText("shown as Markdown");
    const editor = noteEditor(page, "Raw.fj.md");
    await expect(editor).toContainText("<details>");
    await expect(page.getByRole("toolbar").filter({ hasText: "Block type" })).toHaveCount(0); // no formatting toolbar (the comments have their own)

    await editor.getByText("Some text first.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Added.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const saved = (await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Raw.fj.md"]!;
    expect(saved).toBe(DOC_HEADER + body.replace("Some text first.", "Some text first. Added."));
  } finally {
    await restoreMore();
  }
});

test("a document whose header cannot be read is shown whole as Markdown, because the header is not ours to split", async ({ page }) => {
  try {
    const text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: never closed\n\n# Body\n\nText.\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Broken.fj.md": text });
    await page.goto(`/repo/${id}/Notes/Broken.fj.md`);
    const editor = noteEditor(page, "Broken.fj.md");
    await expect(editor).toContainText("title: never closed"); // the header is in it: it is the file, whole
    await expect(page.getByRole("toolbar").filter({ hasText: "Block type" })).toHaveCount(0); // no formatting toolbar (the comments have their own)
    await editor.getByText("Text.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" More.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Broken.fj.md"]).toBe(text.replace("Text.", "Text. More."));
  } finally {
    await restoreMore();
  }
});

test("a document made from a title opens ready to edit, and edits in the toolbar's formats are Markdown in the repository", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/other.md": "x" });
    await page.goto(`/repo/${id}/Notes`);
    await page.getByRole("button", { name: "New document" }).click();
    await page.getByLabel("Title").fill("Fresh document");
    await page.getByRole("button", { name: "Create document" }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/Fresh%20document.fj.md`);

    const editor = noteEditor(page, "Fresh document.fj.md");
    await expect(editor).toContainText("Fresh document");
    await typeAtEndOf(page, editor.locator("h1"), "");
    await page.keyboard.press("Enter");
    // Markdown shortcuts, as the toolbar's formats write them.
    await page.keyboard.type("- first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const saved = (await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Fresh document.fj.md"]!;
    expect(saved).toMatch(/^---\nid: [0-9a-z]{26}\ntitle: Fresh document\ncreated: .+\n---\n\n# Fresh document\n\n- first\n- second\n$/);
  } finally {
    await restoreMore();
  }
});

test("a note from another tool is shown as it is: line endings and a byte order mark are not rewritten", async ({ page }) => {
  try {
    const crlf = "# Windows note\r\n\r\n- one\r\n- two\r\n";
    const mixed = "unix\nwindows\r\nold mac\rend";
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/crlf.md": crlf,
      "Notes/mixed.md": mixed,
      "Notes/bom.md": "﻿# With a BOM\n",
    });

    // Every line break is CRLF: nothing is shown that is not text, and the lines are the lines.
    await page.goto(`/repo/${id}/Notes/crlf.md`);
    const lines = noteEditor(page, "crlf.md").locator(".cm-line");
    await expect(lines).toHaveCount(5);
    await expect(lines.first()).toHaveText("# Windows note");
    await expect(page.locator(".cm-specialChar")).toHaveCount(0);

    // A note that mixes them shows each carriage return as the control character it is: two of them here, in three lines
    // (the lines end at the line feeds; the carriage returns are characters).
    await page.goto(`/repo/${id}/Notes/mixed.md`);
    await expect(noteEditor(page, "mixed.md").locator(".cm-line")).toHaveCount(3);
    await expect(page.locator(".cm-specialChar")).toHaveCount(2);

    // A byte order mark is kept, and shown as one.
    await page.goto(`/repo/${id}/Notes/bom.md`);
    await expect(noteEditor(page, "bom.md")).toContainText("# With a BOM");
    await expect(page.locator(".cm-specialChar")).toHaveCount(1);
  } finally {
    await restoreMore();
  }
});

test("a file that is not text, or is too large, is not shown as a note", async ({ page }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/binary.md": Uint8Array.from([0x68, 0x69, 0xff, 0xfe, 0x0a]),
      "Notes/huge.md": "x".repeat(1024 * 1024 + 1),
    });
    await page.goto(`/repo/${id}/Notes/binary.md`);
    await expect(page.getByText("This file is not valid UTF-8 text")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);

    await page.goto(`/repo/${id}/Notes/huge.md`);
    await expect(page.getByText("This note is larger than 1 MB")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("the editor wears the design system's tokens, in light and in dark", async ({ page }) => {
  const id = await connected(page);
  const surfaces = async () =>
    page.evaluate(() => {
      const editor = document.querySelector(".cm-editor") as HTMLElement;
      return { editor: getComputedStyle(editor).backgroundColor, page: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(editor).color, font: getComputedStyle(editor.querySelector(".cm-scroller") as HTMLElement).fontFamily };
    });

  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`/repo/${id}/Public/idea.md`);
  await expect(noteEditor(page, "idea.md")).toBeVisible();
  const light = await surfaces();
  // The editor's surface is the page's: it took the token and not its own default (which is white in both).
  expect(light.editor).toBe(light.page);
  // Its font is the design system's monospace, not the browser's.
  expect(light.font).toMatch(/mono/i);

  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(noteEditor(page, "idea.md")).toBeVisible();
  const dark = await surfaces();
  expect(dark.editor).toBe(dark.page);
  expect(dark.editor).not.toBe(light.editor);
  expect(dark.text).not.toBe(light.text);
});

// --- Document properties (ROADMAP 1b.5) ----------------------------------------------------------------------------------

test("the properties panel shows the header, keys Fjord does not know included, and a note's body edit leaves the header byte for byte", async ({ page }) => {
  try {
    const header = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\n# a comment the writer left\nzeta: 1\ntitle: Weekly\nx-future:\n  - kept\n  - as is\ncreated: 2026-10-16T09:34:00Z\n---\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/weekly.md": `${header}\nThe plan.\n` });
    await page.goto(`/repo/${id}/Notes/weekly.md`);

    // The header is beside the editor and not in it.
    const editor = noteEditor(page, "weekly.md");
    await expect(editor).toContainText("The plan.");
    await expect(editor).not.toContainText("x-future");
    const panel = page.getByTestId("document-properties");
    await panel.getByText("Properties", { exact: true }).click();
    await expect(panel.getByText("01jagc4k7pt8y3wqnmzv5xrb8j")).toBeVisible();
    await expect(panel.getByText("2026-10-16T09:34:00Z")).toBeVisible();
    await expect(panel.getByLabel("Title")).toHaveValue("Weekly");
    await expect(panel.getByTestId("other-property")).toHaveCount(2);
    await expect(panel.getByTestId("other-property").first()).toContainText("zeta");
    await expect(panel.getByTestId("other-property").last()).toContainText('["kept","as is"]');
    await expect(panel.getByText("no header yet")).toHaveCount(0);

    // Opening it changed nothing: there is no draft, and a body edit keeps the header as written, comment and all.
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" More.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();
    const saved = (await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/weekly.md"]!;
    // The header is as written, the comment in it too (only a change to the title has the module write it again); the typing is after the body.
    expect(saved).toBe(`${header}\nThe plan.\n More.`);
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("the title is changed from the panel: it is the only thing in the header that changes, and the file keeps its name", async ({ page }) => {
  try {
    const header = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nzeta: 1\ntitle: Weekly\nx-future:\n  - kept\ncreated: 2026-10-16T09:34:00Z\n---\n";
    const body = "\nThe plan.\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Weekly.fj.md": header + body });
    await page.goto(`/repo/${id}/Notes/Weekly.fj.md`);

    const panel = page.getByTestId("document-properties");
    await panel.getByText("Properties", { exact: true }).click();
    await panel.getByLabel("Title").fill("Plan: the sequel");
    await panel.getByRole("button", { name: "Set title" }).click();
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const head = (await hubs.more.branchHead()) as string;
    const files = await hubs.more.filesAt(head);
    expect(Object.keys(files).filter((path) => path.endsWith(".md"))).toEqual(["Notes/Weekly.fj.md"]);
    const saved = files["Notes/Weekly.fj.md"]!;
    expect(saved.endsWith(body)).toBe(true);
    // The module wrote the header: the title as written safely, and every other key where it was.
    expect(saved).toBe("---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nzeta: 1\ntitle: \"Plan: the sequel\"\nx-future:\n- kept\ncreated: \"2026-10-16T09:34:00Z\"\n---\n" + body);
    await hubs.more.fsck();

    // And the page shows it, after it was read again.
    await panel.getByText("Properties", { exact: true }).click();
    await expect(panel.getByLabel("Title")).toHaveValue("Plan: the sequel");
  } finally {
    await restoreMore();
  }
});

test("the first edit of a note with no header gives it one, and opening it, or editing back to what it was, does not", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/plain.md": "# A plain note\n\nText.\n" });
    await page.goto(`/repo/${id}/Notes/plain.md`);
    const editor = noteEditor(page, "plain.md");
    const panel = page.getByTestId("document-properties");
    await panel.getByText("Properties", { exact: true }).click();
    await expect(panel.getByText(/no header yet/i)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Set title" })).toBeDisabled();

    // Typing and deleting it again: no header, no draft.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("x");
    await expect(panel.getByText(/no header yet/i)).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await expect(panel.getByText(/no header yet/i)).toBeVisible();

    await page.keyboard.type(" And more.");
    await expect(status(page)).toHaveText("Changes kept as a draft.");
    await expect(panel.getByLabel("Title")).toHaveValue("A plain note");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const saved = (await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/plain.md"]!;
    expect(saved).toEqual(promoted("A plain note", "# A plain note\n\nText.\n And more."));
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a note's header that cannot be read is not split or rewritten: it is shown whole, with no properties", async ({ page }) => {
  try {
    const text = "---\nid: [\n---\nbody\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/broken.md": text });
    await page.goto(`/repo/${id}/Notes/broken.md`);
    await expect(noteEditor(page, "broken.md")).toContainText("id: [");
    await expect(page.getByTestId("document-properties")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

// --- Routes by id (ROADMAP 1b.6) -----------------------------------------------------------------------------------------

const ID_DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const ID_NOTE = "01jagc4k7pt8y3wqnmzv5xrb9k";
const withId = (id: string, body: string) => `---\nid: ${id}\ntitle: T\n---\n\n${body}\n`;

test("a document opens at /doc/<id> and a note at /note/<id>, wherever they are, and the other route sends to the right one", async ({ page }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Deep/Plan.fj.md": withId(ID_DOC, "The plan."),
      "Notes/Deep/idea.md": withId(ID_NOTE, "The idea."),
      "Notes/plain.md": "# no header\n",
    });

    // Nothing has been opened, so the first lookup searches; the address stays the one that was asked for.
    expect((await page.goto(`/doc/${ID_DOC}`))?.status()).toBe(200);
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("The plan.");
    await expect(page).toHaveURL(`${BASE}/doc/${ID_DOC}`);
    await expect(page.getByRole("heading", { name: "acme/more" })).toBeVisible();

    await page.goto(`/note/${ID_NOTE}`);
    await expect(noteEditor(page, "idea.md")).toContainText("The idea.");
    await expect(page).toHaveURL(`${BASE}/note/${ID_NOTE}`);

    // A note asked for as a document, and a document as a note, are sent to the address that is theirs.
    await page.goto(`/doc/${ID_NOTE}`);
    await expect(page).toHaveURL(`${BASE}/note/${ID_NOTE}`);
    await expect(noteEditor(page, "idea.md")).toBeVisible();
    await page.goto(`/note/${ID_DOC}`);
    await expect(page).toHaveURL(`${BASE}/doc/${ID_DOC}`);

    // The page of a file by its path says the address by id, and it is the one that works.
    await page.goto(`/repo/${id}/Notes/Deep/idea.md`);
    await expect(page.getByRole("link", { name: `/note/${ID_NOTE}` })).toHaveAttribute("href", `/note/${ID_NOTE}`);
    await page.goto(`/repo/${id}/Notes/plain.md`);
    await expect(page.getByText("Address by id")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

test("an id that is not there, is not an id, or is another person's is a 404 that says nothing about which", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/idea.md": withId(ID_NOTE, "mine") });
    await page.goto(`/note/${ID_NOTE}`);
    await expect(noteEditor(page, "idea.md")).toBeVisible();

    for (const path of ["/note/01jagc4k7pt8y3wqnmzv5xrbzz", "/doc/01jagc4k7pt8y3wqnmzv5xrbzz", "/note/not-an-id", `/note/${ID_NOTE.toUpperCase()}`, `/doc/${ID_NOTE}%2F..`, `/note/${ID_NOTE}0`]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }

    // Someone else, with no repository of their own, is told the same as for an id that was never made.
    const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.9" } });
    const otherPage = await other.newPage();
    await signUp(otherPage, `visitor-${Date.now()}@example.com`, "Grace Hopper");
    expect((await otherPage.goto(`/note/${ID_NOTE}`))?.status()).toBe(404);
    expect((await otherPage.goto(`/note/01jagc4k7pt8y3wqnmzv5xrbzz`))?.status()).toBe(404);
    await other.close();

    // And nobody signed out is shown anything.
    const signedOut = await browser.newContext({ baseURL: BASE });
    const anonymous = await signedOut.newPage();
    await anonymous.goto(`/note/${ID_NOTE}`);
    await expect(anonymous).toHaveURL(/\/sign-in/);
    await signedOut.close();
    expect(id).toBeGreaterThan(0);
  } finally {
    await restoreMore();
  }
});

test("a file that moves is still found by its id, and one that is deleted is not", async ({ page }) => {
  try {
    await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/idea.md": withId(ID_NOTE, "the idea") });
    await page.goto(`/note/${ID_NOTE}`);
    await expect(noteEditor(page, "idea.md")).toBeVisible();

    // Moved and changed from another tool: the index still says the old place, and is not believed.
    await hubs.more.commitFiles({ "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Archive/old idea.md": withId(ID_NOTE, "the idea, moved") }, { replace: true });
    await page.goto(`/note/${ID_NOTE}`);
    await expect(noteEditor(page, "old idea.md")).toContainText("the idea, moved");
    await expect(page).toHaveURL(`${BASE}/note/${ID_NOTE}`);

    await hubs.more.commitFiles({ "Notes/fjord.vault.json": VAULT_MANIFEST }, { replace: true });
    expect((await page.goto(`/note/${ID_NOTE}`))?.status()).toBe(404);
  } finally {
    await restoreMore();
  }
});

test("an id that two files have is not guessed at: the person chooses", async ({ page }) => {
  try {
    await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/idea.md": withId(ID_NOTE, "the first"),
      "Notes/copy of idea.md": withId(ID_NOTE, "the second"),
    });
    await page.goto(`/note/${ID_NOTE}`);
    await expect(page.getByRole("heading", { name: "More than one file has this id" })).toBeVisible();
    const choices = page.getByRole("list", { name: "Files with this id" }).getByRole("link");
    await expect(choices).toHaveText(["Notes/copy of idea.md", "Notes/idea.md"]);

    await choices.last().click();
    await expect(noteEditor(page, "idea.md")).toContainText("the first");
    await expect(page).toHaveURL(/\/repo\/\d+\/Notes\/idea\.md$/);
  } finally {
    await restoreMore();
  }
});

test("an id in an encrypted vault is not looked for: nothing of one is read", async ({ page }) => {
  try {
    const encrypted = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });
    await repositoryWith(page, { "Secret/fjord.vault.json": encrypted, "Secret/readme.md": withId(ID_NOTE, "stray plaintext in an encrypted vault") });
    hubs.more.requests.length = 0;
    expect((await page.goto(`/note/${ID_NOTE}`))?.status()).toBe(404);
    // Only the vault manifests are ever read, never the stray note in the encrypted vault (a manifest is at most one blob).
    expect(hubs.more.requests.filter((request) => request.path.includes("/git/blobs/")).length).toBeLessThanOrEqual(1);
  } finally {
    await restoreMore();
  }
});

// --- Rename and move (ROADMAP 1b.11) -------------------------------------------------------------------------------------

const MOVE_DOC_HEADER = `---\nid: ${ID_DOC}\ntitle: Plan\nx-future:\n  - kept\n# a comment\n---\n`;
const MOVE_ENCRYPTED = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });

test("a note is renamed in one commit, byte for byte, keeping its extension", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/idea.md": "# Idea\r\n\r\nmixed\nendings\r\n", "Notes/other.md": "untouched" });
    const before = (await hubs.more.branchHead()) as string;
    await page.goto(`/repo/${id}/Notes/idea.md`);
    await expect(noteEditor(page, "idea.md")).toBeVisible();

    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByText("It stays .md.")).toBeVisible();
    await page.getByLabel("New name").fill("A better idea");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/A%20better%20idea.md`);
    await expect(noteEditor(page, "A better idea.md")).toContainText("Idea");

    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%B")).toBe("Rename idea to A better idea");
    const files = await hubs.more.filesAt(head);
    expect(files["Notes/A better idea.md"]).toBe("# Idea\r\n\r\nmixed\nendings\r\n"); // every byte, line endings included
    expect(files["Notes/idea.md"]).toBeUndefined();
    expect(files["Notes/other.md"]).toBe("untouched");
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a document moved to another folder is still found by its id, and its header is untouched", async ({ page }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Other/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Plan.fj.md": `${MOVE_DOC_HEADER}\n# Plan\n`,
      "Notes/Archive/old.md": "old",
    });
    await page.goto(`/doc/${ID_DOC}`);
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("Plan");

    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const place = page.getByLabel("Move to");
    // Folders of plaintext vaults, the top of each first, and not where it already is.
    await expect(place.locator("option")).toHaveText(["Other", "Notes/Archive"]);
    await place.selectOption("Other");
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Other/Plan.fj.md`);

    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%B")).toBe("Move Plan to Other");
    expect((await hubs.more.filesAt(head))["Other/Plan.fj.md"]).toBe(`${MOVE_DOC_HEADER}\n# Plan\n`);

    // The address by id follows the file: nothing about it said where it was.
    await page.goto(`/doc/${ID_DOC}`);
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("Plan");
    await expect(page.getByRole("link", { name: `/doc/${ID_DOC}` })).toBeVisible();
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a folder is renamed with everything in it, in one commit", async ({ page }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Old/a.md": "a",
      "Notes/Old/Deep/b.fj.md": `${MOVE_DOC_HEADER}\nb\n`,
      "Notes/keep.md": "k",
    });
    const before = (await hubs.more.branchHead()) as string;
    await page.goto(`/repo/${id}/Notes/Old`);
    await page.getByRole("button", { name: "Rename folder" }).click();
    await page.getByLabel("New name").fill("Older");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/Older`);
    await expect(page.getByRole("list", { name: "Folder contents" })).toContainText("Deep");

    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%B")).toBe("Rename Old to Older\n\nMoves 2 files.");
    expect(Object.keys(await hubs.more.filesAt(head)).sort()).toEqual(["Notes/Older/Deep/b.fj.md", "Notes/Older/a.md", "Notes/fjord.vault.json", "Notes/keep.md"]);
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("a name that is taken, or taken but for letter case, is refused and says so, and nothing changes", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/a.md": "a", "Notes/Taken.md": "t" });
    const before = (await hubs.more.branchHead()) as string;
    await page.goto(`/repo/${id}/Notes/a.md`);
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    for (const name of ["Taken", "taken", "bad:name", "CON"]) {
      await page.getByLabel("New name").fill(name);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "The file was not changed" })).toBeVisible();
      await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/a.md`);
    }
    await expect(page.getByRole("alert").filter({ hasText: "not a name or a place" })).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(before);
  } finally {
    await restoreMore();
  }
});

test("what is typed and not yet saved is saved as a version first, then moved with the file", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/n.md": "# Title\n" });
    const before = (await hubs.more.branchHead()) as string;
    await page.goto(`/repo/${id}/Notes/n.md`);
    await noteEditor(page, "n.md").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("typed, not saved");
    await expect(status(page)).toHaveText("Changes kept as a draft.");

    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByLabel("New name").fill("renamed");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes/renamed.md`);

    const head = (await hubs.more.branchHead()) as string;
    const version = (await hubs.more.show(head, "%P")) as string;
    expect(await hubs.more.show(version, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%B")).toBe("Rename n to renamed");
    expect((await hubs.more.filesAt(head))["Notes/renamed.md"]).toMatch(/typed, not saved$/);
    // The draft went with the version; the renamed note opens clean.
    await expect(page.getByText("Your changes were kept")).toHaveCount(0);
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

test("nothing is moved into an encrypted vault, and who may move is the owner, from this site", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Secret/fjord.vault.json": MOVE_ENCRYPTED,
      "Notes/Sub/a.md": "a",
    });
    // The page offers plaintext vaults only.
    await page.goto(`/repo/${id}/Notes/Sub/a.md`);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByLabel("Move to").locator("option")).toHaveText(["Notes"]);

    // And the server holds to that whatever the page sends.
    const sent = { vault: "Notes", type: "file", path: "Notes/Sub/a.md", blob: "a".repeat(40), destination: "Secret/a.md" };
    const move = (context: { post: typeof page.request.post }, origin: string | null = BASE) =>
      context.post(`/api/connections/${id}/files/move`, { headers: origin === null ? {} : { origin }, data: sent });
    const refused = await move(page.request);
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.code).toBe("encrypted_vault");
    expect((await move(page.request, "https://evil.example")).status()).toBe(403);

    const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.1.17" } });
    const otherPage = await other.newPage();
    await signUp(otherPage, `visitor-${Date.now()}@example.com`, "Grace Hopper");
    expect((await move(otherPage.request)).status()).toBe(404);
    await other.close();
    const anonymous = await browser.newContext({ baseURL: BASE });
    expect((await move(anonymous.request)).status()).toBe(401);
    await anonymous.close();
  } finally {
    await restoreMore();
  }
});

test("a document is not put back while another file has its id, and is once that file is gone", async ({ page }) => {
  try {
    const original = `---\nid: ${ID_DOC}\ntitle: Plan\n---\n\n# Plan\n`;
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": original });
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page).toHaveURL(`${BASE}/repo/${id}/Notes`);

    // Meanwhile a copy appears from another tool, with the same id.
    await hubs.more.commitFiles({ "Notes/Copy of plan.md": `---\nid: ${ID_DOC}\ntitle: Copy\n---\n\ncopy\n` });
    const head = (await hubs.more.branchHead()) as string;

    await page.goto(`/deleted/${id}`);
    await page.getByRole("button", { name: "Put back" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Nothing was put back" });
    await expect(alert).toContainText("already has the id");
    await expect(alert.getByText("Notes/Copy of plan.md")).toBeVisible();
    expect(await hubs.more.branchHead()).toBe(head);

    // With the copy gone it can be.
    await hubs.more.commitFiles({ "Notes/Copy of plan.md": null });
    await page.reload();
    await page.getByRole("button", { name: "Put back" }).click();
    await expect(page.getByRole("link", { name: "Notes/Plan.fj.md" })).toBeVisible();
    expect((await hubs.more.filesAt((await hubs.more.branchHead()) as string))["Notes/Plan.fj.md"]).toBe(original);
    await hubs.more.fsck();
  } finally {
    await restoreMore();
  }
});

// --- Sharing with named accounts (ROADMAP 1c.2) --------------------------------------------------------------------------

const SHARE_DOC = `---\nid: ${ID_DOC}\ntitle: Q4 plan\nx-secret: not for the reader\n---\n\n# Q4 plan\n\nThe plan, for reading.\n`;

test("a document shared with a named account opens for them to read, and for no one else, and stops when the share does", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Deep/Plan.fj.md": SHARE_DOC, "Notes/idea.md": withId(ID_NOTE, "a note"), "Notes/other.fj.md": withId("01jagc4k7pt8y3wqnmzv5xrbzz", "private") });
    const share = (request: typeof page.request, data: unknown, origin: string | null = BASE) =>
      request.post(`/api/connections/${id}/shares`, { headers: origin === null ? {} : { origin }, data });
    const unshare = (request: typeof page.request, data: unknown) => request.delete(`/api/connections/${id}/shares`, { headers: { origin: BASE }, data });

    const graceEmail = `grace-${Date.now()}@example.com`;
    const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.2.5" } });
    const grace = await other.newPage();
    await signUp(grace, graceEmail, "Grace Hopper");
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.2.6" } });
    const mallory = await stranger.newPage();
    await signUp(mallory, `mallory-${Date.now()}@example.com`, "Mallory");

    // Nobody has been given anything yet.
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(404);

    // The owner shares it with an address that has an account, and with one that has none: the same answer, word for word.
    const known = await share(page.request, { doc: ID_DOC, email: graceEmail, role: "view" });
    const unknown = await share(page.request, { doc: ID_DOC, email: `nobody-${Date.now()}@example.com`, role: "view" });
    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(200);
    expect(await unknown.text()).toBe(await known.text());

    // Grace reads it, at the plain address; the header and the file's place are not shown to her.
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(200);
    await expect(grace.getByRole("heading", { name: "Q4 plan" })).toBeVisible();
    await expect(grace.getByText("Shared with you by Ada Lovelace")).toBeVisible();
    await expect(grace.getByText("Can view")).toBeVisible();
    const editor = grace.getByRole("textbox", { name: "Q4 plan" });
    await expect(editor).toContainText("The plan, for reading.");
    await expect(editor).toHaveAttribute("contenteditable", "false");
    const text = await grace.locator("main").innerText();
    expect(text).not.toMatch(/x-secret|not for the reader|Deep|Plan\.fj\.md|acme\/more/);
    await expect(grace).toHaveURL(`${BASE}/doc/${ID_DOC}`);

    // Nothing else of the owner's is hers: not the repository, not another document, not the note, nor the owner's routes.
    for (const path of [`/repo/${id}`, `/repo/${id}/Notes/Deep/Plan.fj.md`, `/doc/01jagc4k7pt8y3wqnmzv5xrbzz`, `/note/${ID_NOTE}`, `/note/${ID_DOC}`]) expect((await grace.goto(path))?.status(), path).toBe(404);
    expect((await share(grace.request, { doc: ID_DOC, email: graceEmail, role: "edit" })).status()).toBe(404);
    expect((await grace.request.get(`/api/connections/${id}/shares?doc=${ID_DOC}`)).status()).toBe(404);
    // And not a person with no share.
    expect((await mallory.goto(`/doc/${ID_DOC}`))?.status()).toBe(404);

    // The owner sees who it is shared with; it follows the file when it is moved; and taking the share away ends it at once.
    const listed = await (await page.request.get(`/api/connections/${id}/shares?doc=${ID_DOC}`)).json();
    expect(listed.shares).toEqual([{ accountId: expect.any(String), name: "Grace Hopper", email: graceEmail, role: "view" }]);
    await hubs.more.commitFiles({ "Notes/Deep/Plan.fj.md": null, "Notes/Moved/Q4 plan.fj.md": SHARE_DOC });
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(200);
    await expect(grace.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");

    const gone = await unshare(page.request, { doc: ID_DOC, accountId: listed.shares[0].accountId });
    expect(await gone.json()).toEqual({ removed: true });
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(404);
    await other.close();
    await stranger.close();
  } finally {
    await restoreMore();
  }
});

test("only a document can be shared, only by its owner, from this site", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": withId(ID_NOTE, "a note") });
    const send = (request: typeof page.request, data: unknown, origin: string | null = BASE) => request.post(`/api/connections/${id}/shares`, { headers: origin === null ? {} : { origin }, data });
    const good = { doc: ID_DOC, email: "someone@example.com", role: "view" };

    expect((await send(page.request, { ...good, doc: ID_NOTE })).status()).toBe(422); // a note
    expect((await send(page.request, { ...good, doc: "01jagc4k7pt8y3wqnmzv5xrbzz" })).status()).toBe(404); // not there
    for (const bad of [{ ...good, role: "owner" }, { ...good, email: "no-at-sign" }, { ...good, doc: "nope" }]) expect((await send(page.request, bad)).status(), JSON.stringify(bad)).toBe(400);
    expect((await send(page.request, good, "https://evil.example")).status()).toBe(403);
    expect((await send(page.request, good, null)).status()).toBe(403);

    const anonymous = await browser.newContext({ baseURL: BASE });
    expect((await send(anonymous.request, good)).status()).toBe(401);
    await anonymous.close();
  } finally {
    await restoreMore();
  }
});

// --- Share links (ROADMAP 1c.3) --------------------------------------------------------------------------------------------

test("a link opens a document for anyone who has it, until it expires or is revoked, and for no other document", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Deep/Plan.fj.md": SHARE_DOC, "Notes/Other.fj.md": withId("01jagc4k7pt8y3wqnmzv5xrbzz", "private") });
    const make = async (data: Record<string, unknown>) => {
      const response = await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, ...data } });
      expect(response.status()).toBe(201);
      return (await response.json()) as { id: number; token: string; url: string };
    };
    const reader = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.3.4" } });
    const visitor = await reader.newPage();

    const link = await make({ role: "view" });
    expect(link.url).toBe(`${BASE}/doc/${ID_DOC}?token=${link.token}`);

    // Someone with no account and no session reads it: the title and the text, read-only, and nothing of where it is.
    expect((await visitor.goto(link.url))?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { name: "Q4 plan" }).first()).toBeVisible();
    await expect(visitor.getByText("Can view")).toBeVisible();
    const editor = visitor.getByRole("textbox", { name: "Q4 plan" });
    await expect(editor).toContainText("The plan, for reading.");
    await expect(editor).toHaveAttribute("contenteditable", "false");
    expect(await visitor.locator("main").innerText()).not.toMatch(/x-secret|not for the reader|Deep|Plan\.fj\.md|acme\/more|Ada/);

    // It is for that document only; without the token, or with a wrong one, the page is what it is for anyone: the sign-in.
    // (Someone who has not been given the link, so a context with no cookie of its own.)
    const cold = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.3.5" } });
    const outsider = await cold.newPage();
    for (const url of [`/doc/01jagc4k7pt8y3wqnmzv5xrbzz?token=${link.token}`, `/doc/${ID_DOC}`, `/doc/${ID_DOC}?token=${"A".repeat(43)}`, `/doc/${ID_DOC}?token=short`, `/note/${ID_DOC}?token=${link.token}`]) {
      await outsider.goto(url);
      await expect(outsider, url).toHaveURL(/\/sign-in/);
      await expect(outsider.getByRole("heading", { name: "Q4 plan" }), url).toHaveCount(0);
    }
    await cold.close();

    // The owner's list says what links there are, with no token; it follows the file when it moves.
    const listed = await (await page.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).json();
    expect(listed.links).toEqual([{ id: link.id, role: "view", expiresAt: null, revokedAt: null, createdAt: expect.any(Number), status: "active", passwordProtected: false }]);
    expect(JSON.stringify(listed)).not.toContain(link.token);
    await hubs.more.commitFiles({ "Notes/Deep/Plan.fj.md": null, "Notes/Moved/Q4 plan.fj.md": SHARE_DOC });
    expect((await visitor.goto(link.url))?.status()).toBe(200);
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");

    // Several at once, each its own: revoking one ends that one at once and not the other.
    const second = await make({ role: "comment" });
    expect((await (await page.request.delete(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, linkId: link.id } })).json())).toEqual({ revoked: true });
    await visitor.goto(link.url);
    await expect(visitor.getByRole("heading", { name: "Q4 plan" })).toHaveCount(0);
    expect((await visitor.goto(second.url))?.status()).toBe(200);
    await expect(visitor.getByText("Can comment")).toBeVisible();
    expect((await (await page.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).json()).links.map((entry: { status: string }) => entry.status)).toEqual(["active", "revoked"]);

    // One with an expiry works until it, and is refused after.
    const brief = await make({ role: "view", expiresAt: Date.now() + 3000 });
    expect((await visitor.goto(brief.url))?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { name: "Q4 plan" }).first()).toBeVisible();
    await visitor.waitForTimeout(3300);
    await visitor.goto(brief.url);
    await expect(visitor.getByRole("heading", { name: "Q4 plan" })).toHaveCount(0);
    await reader.close();
  } finally {
    await restoreMore();
  }
});

test("only the owner makes links, only for a document, from this site, and the token is shown once", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": withId(ID_NOTE, "a note") });
    const send = (request: typeof page.request, data: unknown, origin: string | null = BASE) => request.post(`/api/connections/${id}/links`, { headers: origin === null ? {} : { origin }, data });
    const good = { doc: ID_DOC, role: "view" };

    expect((await send(page.request, { ...good, doc: ID_NOTE })).status()).toBe(422);
    expect((await send(page.request, { ...good, doc: "01jagc4k7pt8y3wqnmzv5xrbzz" })).status()).toBe(404);
    for (const bad of [{ ...good, role: "owner" }, { ...good, expiresAt: Date.now() - 1000 }, { ...good, expiresAt: "tomorrow" }, { ...good, doc: "nope" }]) expect((await send(page.request, bad)).status(), JSON.stringify(bad)).toBe(400);
    expect((await send(page.request, good, "https://evil.example")).status()).toBe(403);
    expect((await send(page.request, good, null)).status()).toBe(403);

    const anonymous = await browser.newContext({ baseURL: BASE });
    expect((await send(anonymous.request, good)).status()).toBe(401);
    await anonymous.close();
    const other = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.3.9" } });
    const stranger = await other.newPage();
    await signUp(stranger, `visitor-${Date.now()}@example.com`, "Mallory");
    expect((await send(stranger.request, good)).status()).toBe(404);
    expect((await stranger.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).status()).toBe(404);
    await other.close();

    // The token is in the answer to making the link and in nothing after it.
    const made = await (await send(page.request, good)).json();
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await page.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).text()).not.toContain(made.token);
  } finally {
    await restoreMore();
  }
});

test("a link's token is swapped for a cookie of that document and gone from the address, and ends when the link does", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/Other.fj.md": withId("01jagc4k7pt8y3wqnmzv5xrbzz", "private") });
    const make = async (data: Record<string, unknown>) => {
      const response = await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, ...data } });
      return (await response.json()) as { id: number; token: string; url: string };
    };
    const link = await make({ role: "view" });
    const reader = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.4.4" } });
    const visitor = await reader.newPage();

    // The first request is not a page: it is answered with a redirect to the clean address, and the cookie.
    const final = await visitor.goto(link.url);
    expect(final?.status()).toBe(200);
    expect(visitor.url()).toBe(`${BASE}/doc/${ID_DOC}`);
    expect(visitor.url()).not.toContain(link.token);
    const first = final!.request().redirectedFrom()!;
    const redirect = (await first.response())!;
    expect(redirect.status()).toBe(303);
    expect(redirect.headers()["location"]).toBe(`/doc/${ID_DOC}`);
    expect(JSON.stringify(redirect.headers())).not.toContain(link.token); // not in a header either: Next puts a rewrite there
    expect(redirect.headers()["referrer-policy"]).toBe("no-referrer");
    expect(final?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    // Nothing of the token is left in the page that is shown, nor in the history that was made.
    expect(await visitor.content()).not.toContain(link.token);
    expect(await visitor.evaluate(() => performance.getEntriesByType("navigation").map((entry) => entry.name).join(" "))).not.toContain("token=");

    // The cookie: that document's path only, out of reach of the page's script, short-lived, and the only place the token is.
    const cookies = await reader.cookies(`${BASE}/doc/${ID_DOC}`);
    const share = cookies.find((cookie) => cookie.name === "fjord_share")!;
    expect(share).toMatchObject({ value: link.token, httpOnly: true, sameSite: "Lax", path: `/doc/${ID_DOC}` });
    expect(share.expires - Date.now() / 1000).toBeGreaterThan(3500);
    expect(share.expires - Date.now() / 1000).toBeLessThanOrEqual(3600);
    expect(await visitor.evaluate(() => document.cookie)).not.toContain("fjord_share");
    expect((await reader.cookies(`${BASE}/doc/01jagc4k7pt8y3wqnmzv5xrbzz`)).some((cookie) => cookie.name === "fjord_share")).toBe(false);
    expect((await reader.cookies(`${BASE}/repo/${id}`)).some((cookie) => cookie.name === "fjord_share")).toBe(false);

    // It goes on working at the clean address, with the cookie, and for that document only.
    await visitor.reload();
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    expect((await visitor.goto(`/doc/01jagc4k7pt8y3wqnmzv5xrbzz`))?.status()).toBe(200);
    await expect(visitor).toHaveURL(/\/sign-in/);

    // Taking the link away ends it for the holder of the cookie on their next request.
    await visitor.goto(`/doc/${ID_DOC}`);
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toBeVisible();
    await page.request.delete(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, linkId: link.id } });
    await visitor.reload();
    await expect(visitor).toHaveURL(/\/sign-in/);

    // A link that ends in a minute gives a cookie that ends with it.
    const brief = await make({ role: "view", expiresAt: Date.now() + 60_000 });
    await visitor.goto(brief.url);
    await expect(visitor).toHaveURL(`${BASE}/doc/${ID_DOC}`);
    const short = (await reader.cookies(`${BASE}/doc/${ID_DOC}`)).find((cookie) => cookie.name === "fjord_share")!;
    expect(short.value).toBe(brief.token);
    expect(short.expires - Date.now() / 1000).toBeLessThanOrEqual(60);

    // A link that does not work gets the same redirect, and no cookie.
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.4.5" } });
    const other = await stranger.newPage();
    await other.goto(`/doc/${ID_DOC}?token=${link.token}`); // the revoked one
    await expect(other).toHaveURL(/\/sign-in/);
    expect((await stranger.cookies()).some((cookie) => cookie.name === "fjord_share")).toBe(false);
    await stranger.close();
    await reader.close();
  } finally {
    await restoreMore();
  }
});

test("every page says where a link followed from it came from: nowhere", async ({ request }) => {
  for (const path of ["/", "/sign-in", "/sign-up", "/api/health"]) expect((await request.get(path)).headers()["referrer-policy"], path).toBe("no-referrer");
});

// --- Password links (ROADMAP 1c.5) ---------------------------------------------------------------------------------------------

test("a link with a password lets nobody in with the token alone, slows wrong tries, and opens for the right one", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const PASSWORD = "correct horse battery staple";
    const made = await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "view", password: PASSWORD } });
    expect(made.status()).toBe(201);
    const link = (await made.json()) as { id: number; token: string; url: string; passwordProtected: boolean };
    expect(link.passwordProtected).toBe(true);
    expect(JSON.stringify(link)).not.toContain(PASSWORD);

    // The owner's list says it has a password, and shows neither it nor its hash.
    const listed = await (await page.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).text();
    expect(JSON.parse(listed).links[0]).toMatchObject({ id: link.id, passwordProtected: true });
    expect(listed).not.toMatch(/argon|hash|correct horse|failures|lockedUntil/i);

    const reader = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.5.5" } });
    const visitor = await reader.newPage();
    const open = async () => {
      await visitor.goto(link.url);
      await expect(visitor).toHaveURL(`${BASE}/doc/${ID_DOC}`);
    };

    // The token alone shows a question, not the document; and the cookie it left opens nothing.
    await open();
    await expect(visitor.getByRole("heading", { name: "This document needs a password" })).toBeVisible();
    await expect(visitor.getByText("The plan, for reading.")).toHaveCount(0);
    const names = async () => (await reader.cookies(`${BASE}/doc/${ID_DOC}`)).map((cookie) => cookie.name);
    expect(await names()).toContain("fjord_share_pending");
    expect(await names()).not.toContain("fjord_share");
    expect(await visitor.content()).not.toContain(link.token);

    // A wrong password is said to be wrong; one straight after, even the right one, is "too soon" and is not checked.
    const give = async (password: string) => {
      await visitor.getByLabel("Password").fill(password);
      await visitor.getByRole("button", { name: "Open" }).click();
    };
    await give("not the password at all");
    await expect(visitor.getByText("That was not the password")).toBeVisible();
    expect(visitor.url()).not.toContain("not the password");
    await give(PASSWORD);
    await expect(visitor.getByText("Too soon")).toBeVisible();
    await expect(visitor.getByText("The plan, for reading.")).toHaveCount(0);

    // After the wait, the right one opens it: the cookie that opens carries the proof as well as the token, and the pending one is gone.
    await visitor.waitForTimeout(1300);
    await give(PASSWORD);
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    await expect(visitor).toHaveURL(`${BASE}/doc/${ID_DOC}`);
    const share = (await reader.cookies(`${BASE}/doc/${ID_DOC}`)).find((cookie) => cookie.name === "fjord_share")!;
    expect(share.value.startsWith(`${link.token}.`)).toBe(true);
    expect(share).toMatchObject({ httpOnly: true, sameSite: "Lax", path: `/doc/${ID_DOC}` });
    expect(await names()).not.toContain("fjord_share_pending");
    await visitor.reload();
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");

    // Revoking ends it for the holder of the cookie on the next request.
    await page.request.delete(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, linkId: link.id } });
    await visitor.reload();
    await expect(visitor).toHaveURL(/\/sign-in/);

    // Someone who has the link and sets the cookie for themselves, with the token and no proof, is not let in.
    const live = await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "view", password: PASSWORD } })).json();
    const forger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.5.6" } });
    await forger.addCookies([{ name: "fjord_share", value: live.token, url: `${BASE}/doc/${ID_DOC}` }]);
    const forged = await forger.newPage();
    await forged.goto(`/doc/${ID_DOC}`);
    await expect(forged).toHaveURL(/\/sign-in/);
    await forger.addCookies([{ name: "fjord_share", value: `${live.token}.${"A".repeat(43)}`, url: `${BASE}/doc/${ID_DOC}` }]);
    await forged.goto(`/doc/${ID_DOC}`);
    await expect(forged).toHaveURL(/\/sign-in/);
    await forger.close();
    await reader.close();
  } finally {
    await restoreMore();
  }
});

test("a link's password is checked when the link is made: text of a fit length, or none", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const send = (data: unknown) => page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "view", ...(data as object) } });
    for (const password of ["short", "x".repeat(201), 12345678, ["abcdefgh"]]) expect((await send({ password })).status(), JSON.stringify(password)).toBe(400);
    expect((await send({ password: null })).status()).toBe(201);
    expect((await send({})).status()).toBe(201);
    expect((await (await send({ password: "long enough password" })).json()).passwordProtected).toBe(true);
  } finally {
    await restoreMore();
  }
});

// --- Editing through a link (ROADMAP 1c.6) -------------------------------------------------------------------------------------

test("someone with an edit link gives a name, edits the working copy, and the owner's next version credits them", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const made = await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "edit" } });
    const link = (await made.json()) as { id: number; token: string; url: string };
    const before = (await hubs.more.branchHead()) as string;

    const guest = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.6.6" } });
    const visitor = await guest.newPage();
    await visitor.goto(link.url);
    await expect(visitor).toHaveURL(`${BASE}/doc/${ID_DOC}`);
    await expect(visitor.getByText("Can edit")).toBeVisible();

    // A name comes first: until it is given the document can only be read.
    const editor = visitor.getByRole("textbox", { name: "Q4 plan" });
    await expect(editor).toContainText("The plan, for reading.");
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(visitor.getByLabel("Your name")).toBeVisible();
    await expect(visitor.getByRole("button", { name: "Start editing" })).toBeDisabled();
    await visitor.getByLabel("Your name").fill("Grace   Hopper");
    await visitor.getByRole("button", { name: "Start editing" }).click();
    await expect(visitor.getByTestId("guest-name")).toHaveText("Grace Hopper");
    await expect(editor).toHaveAttribute("contenteditable", "true");

    // What is typed is kept as the document's working copy, and nothing is committed.
    await typeAtEndOf(visitor, editor.locator("p", { hasText: "The plan, for reading." }), " A guest's line.");
    await expect(visitor.getByTestId("guest-status")).toHaveText("Changes kept for the owner to save.");
    expect(await hubs.more.branchHead()).toBe(before);

    // They find it again, under the same name, without being asked.
    await visitor.reload();
    await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toContainText("A guest's line.");
    await expect(visitor.getByTestId("guest-name")).toHaveText("Grace Hopper");

    // The owner sees it in the draft, who made it, and saves a version that credits them.
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect(page.getByText(/made by you and by Grace Hopper through a link/)).toBeVisible();
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("A guest's line.");
    await page.getByLabel("Message").fill("Take the guest's line");
    await page.getByRole("button", { name: "Save version" }).click();
    await expect(page.getByText("Version saved")).toBeVisible();

    const head = (await hubs.more.branchHead()) as string;
    expect(await hubs.more.show(head, "%P")).toBe(before);
    expect(await hubs.more.show(head, "%an <%ae>")).toMatch(/^Ada Lovelace </);
    expect(await hubs.more.show(head, "%(trailers:key=Co-authored-by,valueonly)")).toMatch(new RegExp(`^Grace Hopper <link-${link.id}-[0-9a-f]{8}@users\\.noreply\\.fjord\\.invalid>`));
    const saved = (await hubs.more.filesAt(head))["Notes/Plan.fj.md"]!;
    expect(saved.startsWith(SHARE_DOC.slice(0, SHARE_DOC.indexOf("---\n\n") + 4))).toBe(true); // the header, byte for byte, with what a guest cannot touch
    expect(saved).toContain("A guest's line.");
    await hubs.more.fsck();
    await guest.close();
  } finally {
    await restoreMore();
  }
});

test("a view link or a comment link cannot edit, and an edit link that is revoked stops at once", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const make = async (role: string) => (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role } })).json()) as { id: number; token: string; url: string };
    const put = (request: import("@playwright/test").APIRequestContext, data: unknown, origin: string | null = BASE) =>
      request.put(`/doc/${ID_DOC}/draft`, { headers: origin === null ? {} : { origin }, data });
    const before = (await hubs.more.branchHead()) as string;

    for (const role of ["view", "comment"]) {
      const link = await make(role);
      const reader = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": `10.99.6.${role === "view" ? 7 : 8}` } });
      const visitor = await reader.newPage();
      await visitor.goto(link.url);
      await expect(visitor.getByRole("textbox", { name: "Q4 plan" })).toHaveAttribute("contenteditable", "false");
      await expect(visitor.getByLabel("Your name")).toHaveCount(0);
      const refused = await put(reader.request, { name: "Grace", body: "\nvandalised\n" });
      expect(refused.status(), role).toBe(403);
      expect((await refused.json()).error.code).toBe("read_only");
      await reader.close();
    }

    // An edit link: from this site only, with a name, and not without the cookie.
    const link = await make("edit");
    const guest = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.6.9" } });
    const visitor = await guest.newPage();
    await visitor.goto(link.url);
    await expect(visitor.getByLabel("Your name")).toBeVisible();
    expect((await put(guest.request, { name: "Grace", body: "\nx\n" }, "https://evil.example")).status()).toBe(403);
    expect((await put(guest.request, { name: "", body: "\nx\n" })).status()).toBe(400);
    expect((await put(guest.request, { name: "Grace <b>", body: "\nx\n" })).status()).toBe(400);
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.6.10" } });
    expect((await put(stranger.request, { name: "Grace", body: "\nx\n" })).status()).toBe(404);
    await stranger.close();
    expect((await put(guest.request, { name: "Grace", body: "\nfrom the api\n" })).status()).toBe(200);

    // Revoked: the next save is refused and the page says its changes are not being kept.
    await visitor.getByLabel("Your name").fill("Grace");
    await visitor.getByRole("button", { name: "Start editing" }).click();
    await page.request.delete(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, linkId: link.id } });
    expect((await put(guest.request, { name: "Grace", body: "\nafter the revoke\n" })).status()).toBe(404);
    await typeAtEndOf(visitor, visitor.getByRole("textbox", { name: "Q4 plan" }).locator("p").last(), " more");
    await expect(visitor.getByText("Your changes are not being kept")).toBeVisible({ timeout: 15_000 });
    await guest.close();
    expect(await hubs.more.branchHead()).toBe(before);
  } finally {
    await restoreMore();
  }
});

// --- Managing shares (ROADMAP 1c.7) ----------------------------------------------------------------------------------------------

test("the owner sees and controls every share of a document from its page: people, roles, links, copy, change, revoke", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": withId(ID_NOTE, "a note") });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });

    const graceEmail = `grace-${Date.now()}@example.com`;
    const graceContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.7.7" } });
    const grace = await graceContext.newPage();
    await signUp(grace, graceEmail, "Grace Hopper");

    // A note has no sharing; a document has the panel, closed, with nothing shared.
    await page.goto(`/repo/${id}/Notes/idea.md`);
    await expect(page.getByTestId("share-panel")).toHaveCount(0);
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    const panel = page.getByTestId("share-panel");
    await panel.getByText("Sharing", { exact: true }).click();
    await expect(panel.getByText("Not shared with anyone.")).toBeVisible();
    await expect(panel.getByText("No links.")).toBeVisible();

    // People: an address with an account and one with none are told the same, and only the account is listed.
    await panel.getByLabel("Share with").fill(graceEmail);
    await panel.getByRole("button", { name: "Share", exact: true }).click();
    const known = await panel.getByText(/If that address has an account here/).textContent();
    const row = panel.getByRole("list", { name: "People with access" }).getByRole("listitem");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Grace Hopper");
    await expect(row).toContainText(graceEmail);
    await panel.getByLabel("Share with").fill(`nobody-${Date.now()}@example.com`);
    await panel.getByRole("button", { name: "Share", exact: true }).click();
    await expect(panel.getByText(/If that address has an account here/)).toHaveText(known!);
    await expect(row).toHaveCount(1);

    // She reads it; the owner makes it comment, and she is told; then stops sharing, and she is not.
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(200);
    await expect(grace.getByText("Can view")).toBeVisible();
    await panel.getByLabel("Role of Grace Hopper").selectOption("comment");
    await expect.poll(async () => (await page.request.get(`/api/connections/${id}/shares?doc=${ID_DOC}`).then((r) => r.json())).shares[0].role).toBe("comment");
    await grace.reload();
    await expect(grace.getByText("Can comment")).toBeVisible();
    await page.reload();
    await page.getByTestId("share-panel").getByText("Sharing", { exact: true }).click();
    await expect(page.getByTestId("share-panel").getByLabel("Role of Grace Hopper")).toHaveValue("comment"); // what the page shows is what is kept
    await page.getByTestId("share-panel").getByRole("button", { name: "Stop sharing" }).click();
    await expect(page.getByTestId("share-panel").getByText("Not shared with anyone.")).toBeVisible();
    expect((await grace.goto(`/doc/${ID_DOC}`))?.status()).toBe(404);

    // Links: made with a role and a password; the address is shown once and can be copied; it asks for the password.
    const links = page.getByTestId("share-panel");
    await links.getByLabel("What the new link allows").selectOption("edit");
    await links.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
    await links.getByRole("button", { name: "Make a link" }).click();
    const fresh = links.getByTestId("new-link");
    await expect(fresh).toContainText("This is the only time its address is shown.");
    const address = await fresh.getByLabel("The new link's address").inputValue();
    expect(address).toMatch(new RegExp(`^${BASE}/doc/${ID_DOC}\\?token=[A-Za-z0-9_-]{43}$`));
    await fresh.getByRole("button", { name: "Copy link" }).click();
    await expect(fresh.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
    const linkRow = links.getByTestId("link-row");
    await expect(linkRow).toHaveCount(1);
    await expect(linkRow).toContainText("Can edit");
    await expect(linkRow).toContainText("Active");
    await expect(linkRow).toContainText("Password");
    await expect(linkRow).toContainText("Does not expire");

    const visitorContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.7.8" } });
    const visitor = await visitorContext.newPage();
    await visitor.goto(address);
    await expect(visitor.getByRole("heading", { name: "This document needs a password" })).toBeVisible();

    // Changing it: a past expiry is refused in words; a role and no password take effect for a new visitor at once.
    await linkRow.getByRole("button", { name: "Change" }).click();
    await linkRow.getByLabel("Expires").fill("2020-01-01T10:00");
    await linkRow.getByRole("button", { name: "Save" }).click();
    await expect(linkRow.getByText(/time in the future/)).toBeVisible();
    await linkRow.getByLabel("Expires").fill("");
    await linkRow.getByLabel("What the link allows").selectOption("view");
    await linkRow.getByLabel("Remove the password").check();
    await linkRow.getByRole("button", { name: "Save" }).click();
    await expect(linkRow).toContainText("Can view");
    await expect(linkRow).not.toContainText("Password");
    const open = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.7.9" } });
    const reader = await open.newPage();
    await reader.goto(address);
    await expect(reader.getByText("Can view")).toBeVisible();
    await expect(reader.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");

    // Revoking asks first, then ends it at once, and the list says so.
    await linkRow.getByRole("button", { name: "Revoke" }).click();
    await linkRow.getByRole("button", { name: "Keep" }).click();
    await expect(linkRow).toHaveAttribute("data-status", "active");
    await linkRow.getByRole("button", { name: "Revoke" }).click();
    await linkRow.getByRole("button", { name: "Yes, revoke" }).click();
    await expect(linkRow).toHaveAttribute("data-status", "revoked");
    await expect(linkRow.getByRole("button", { name: "Change" })).toHaveCount(0);
    await reader.reload();
    await expect(reader).toHaveURL(/\/sign-in/);

    for (const context of [graceContext, visitorContext, open]) await context.close();
  } finally {
    await restoreMore();
  }
});

// --- Comments (ROADMAP 1d.1) -------------------------------------------------------------------------------------------------

/** Select `text` where it is in the page, as a person dragging across it would. */
async function selectText(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0 || !node.parentElement?.closest('[role="textbox"]')) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error(`no text ${wanted}`);
  }, text);
}

/** What the page has drawn as marks, by name, as the text each covers. */
const marks = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const name of ["fe-thread", "fe-thread-resolved", "fe-thread-active"]) {
      const highlight = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(name);
      if (highlight) out[name] = [...highlight].map((range) => range.toString());
    }
    return out;
  });

test("threads, replies, resolving, editing and deleting, by role, in the editor and in view mode, with the owner's moderation", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const make = async (role: string) => (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role } })).json()) as { id: number; url: string };
    const comment = await make("comment");
    const viewing = await make("view");

    // The owner comments on a selection, in the editor: the thread is in the panel and marked in the text.
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    const panel = page.getByTestId("comments-panel");
    await expect(panel.getByText("No comments yet.")).toBeVisible();
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("The plan, for reading.");
    await selectText(page, "plan, for");
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await panel.getByLabel("New comment").fill("Is this the plan we agreed?");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(1);
    await expect(panel.getByTestId("comment-count")).toHaveText("1 open");
    await expect.poll(() => marks(page)).toMatchObject({ "fe-thread": ["plan, for"] });

    // Someone with a comment link sees the thread, marked, in a document they cannot change; they are asked for a name once.
    const guestContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.1" } });
    const guest = await guestContext.newPage();
    await guest.goto(comment.url);
    const guestPanel = guest.getByTestId("comments-panel");
    await expect(guestPanel.getByTestId("comment-thread")).toHaveCount(1);
    await expect(guestPanel.getByText("Is this the plan we agreed?")).toBeVisible();
    await expect(guest.getByRole("textbox", { name: "Q4 plan" })).toHaveAttribute("contenteditable", "false");
    await expect.poll(() => marks(guest)).toMatchObject({ "fe-thread": ["plan, for"] });
    await guestPanel.getByRole("button", { name: "Reply" }).click();
    await guestPanel.getByLabel("Reply").fill("Yes, I think so.");
    await guestPanel.getByRole("button", { name: "Reply", exact: true }).last().click();
    await expect(guestPanel.getByLabel("Your name")).toBeVisible();
    await guestPanel.getByLabel("Your name").fill("Grace Hopper");
    await guestPanel.getByRole("button", { name: "Continue" }).click();
    await expect(guestPanel.getByTestId("comment-reply")).toHaveCount(1);
    await expect(guestPanel.getByTestId("comment-reply")).toContainText("Grace Hopper");
    await expect(guestPanel.getByTestId("comment-reply")).toContainText("Guest");

    // She starts a thread of her own on other text, without being asked her name again, and resolves the owner's thread.
    await selectText(guest, "reading");
    await guest.getByRole("button", { name: "Comment on selection" }).click();
    await guestPanel.getByLabel("New comment").fill("Reading what, exactly?");
    await guestPanel.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(guestPanel.getByTestId("comment-thread")).toHaveCount(2);
    await expect(guestPanel.getByLabel("Your name")).toHaveCount(0);
    await guestPanel.getByTestId("comment-thread").first().getByRole("button", { name: "Resolve" }).click();
    await expect(guestPanel.getByTestId("comment-thread").first()).toContainText("Resolved by Grace Hopper");
    await expect.poll(() => marks(guest)).toMatchObject({ "fe-thread-resolved": ["plan, for"], "fe-thread": ["reading"] });

    // Choosing a mark in the text finds its thread.
    const box = await guest.evaluate(() => {
      const range = [...(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("fe-thread")!][0]!;
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await guest.mouse.click(box.x, box.y);
    await expect(guestPanel.getByTestId("comment-thread").nth(1)).toHaveAttribute("data-active", "true");

    // Someone with a view link reads the comments and can do nothing to them.
    const viewContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.2" } });
    const viewer = await viewContext.newPage();
    await viewer.goto(viewing.url);
    const viewPanel = viewer.getByTestId("comments-panel");
    await expect(viewPanel.getByTestId("comment-thread")).toHaveCount(2);
    await expect(viewPanel.getByRole("button", { name: /Reply|Resolve|Reopen|Edit|Delete/ })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "Comment on selection" })).toHaveCount(0);
    await expect.poll(() => marks(viewer)).toMatchObject({ "fe-thread": ["reading"] });

    // Her own comments she may edit and delete, and the owner's she may not.
    await guest.reload();
    const mine = guestPanel.getByTestId("comment-thread").nth(1);
    await expect(mine.getByRole("button", { name: "Edit" })).toBeVisible();
    const owners = guestPanel.getByTestId("comment-thread").first();
    await expect(owners.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(owners.getByRole("button", { name: /^Delete .*comment/ })).toHaveCount(0);
    await expect(owners.getByRole("button", { name: "Delete your reply" })).toHaveCount(1); // her own reply in it, though
    await mine.getByRole("button", { name: "Edit" }).click();
    await mine.getByLabel("Edit comment").fill("Reading what, exactly? The whole thing?");
    await mine.getByRole("button", { name: "Save" }).click();
    await expect(mine).toContainText("The whole thing?");
    await expect(mine).toContainText("edited");

    // The owner sees all of it, may delete anyone's, and closes the comments.
    await page.reload();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(2);
    await expect(panel.getByText("Resolved by Grace Hopper")).toBeVisible();
    const hers = panel.getByTestId("comment-thread").nth(1);
    await hers.getByRole("button", { name: /Delete Grace Hopper's comment/ }).click();
    await hers.getByRole("button", { name: "Yes, delete" }).click();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(1);
    await panel.getByRole("button", { name: "Close comments" }).click();
    await expect(panel.getByText("Comments are closed")).toBeVisible();
    await guest.reload();
    await expect(guestPanel.getByText("Comments are closed")).toBeVisible();
    await expect(guestPanel.getByRole("button", { name: /Reply|Resolve|Reopen/ })).toHaveCount(0);
    const threadId = ((await (await guestContext.request.get(`/doc/${ID_DOC}/comments`)).json()) as { threads: { id: number }[] }).threads[0]!.id;
    const refused = await guestContext.request.post(`/doc/${ID_DOC}/comments`, { headers: { origin: BASE }, data: { op: "reply", thread: threadId, body: "late", name: "Grace Hopper", clientId: "abcdefgh12345" } });
    expect(refused.status()).toBe(409);
    await panel.getByRole("button", { name: "Open comments" }).click();
    await expect(panel.getByText("Comments are closed")).toHaveCount(0);

    for (const context of [guestContext, viewContext]) await context.close();
  } finally {
    await restoreMore();
  }
});

test("a named account it is shared with comments as itself, and a revoked link stops commenting", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": withId(ID_NOTE, "a note") });
    const graceEmail = `grace-${Date.now()}@example.com`;
    const graceContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.3" } });
    const grace = await graceContext.newPage();
    await signUp(grace, graceEmail, "Grace Hopper");
    await page.request.post(`/api/connections/${id}/shares`, { headers: { origin: BASE }, data: { doc: ID_DOC, email: graceEmail, role: "comment" } });

    // She is signed in, so she is herself: no name is asked, and nothing says guest.
    await grace.goto(`/doc/${ID_DOC}`);
    const panel = grace.getByTestId("comments-panel");
    await expect(grace.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    await selectText(grace, "plan, for");
    await grace.getByRole("button", { name: "Comment on selection" }).click();
    await panel.getByLabel("New comment").fill("As myself.");
    await panel.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(panel.getByTestId("comment-thread")).toHaveCount(1);
    await expect(panel.getByLabel("Your name")).toHaveCount(0);
    await expect(panel.getByTestId("comment-thread")).toContainText("Grace Hopper");
    await expect(panel.getByTestId("comment-thread")).not.toContainText("Guest");

    // The owner sees it as hers, and a comment cannot be made without access or from elsewhere.
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect(page.getByTestId("comments-panel").getByText("As myself.")).toBeVisible();
    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "comment" } })).json()) as { id: number; url: string };
    const stranger = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.4" } });
    const threadId = ((await (await page.request.get(`/doc/${ID_DOC}/comments`)).json()) as { threads: { id: number }[] }).threads[0]!.id;
    const post = (request: import("@playwright/test").APIRequestContext, origin: string | null = BASE) =>
      request.post(`/doc/${ID_DOC}/comments`, { headers: origin === null ? {} : { origin }, data: { op: "reply", thread: threadId, body: "x", name: "Mallory", clientId: "abcdefgh12345" } });
    expect((await post(stranger.request)).status()).toBe(404);
    expect((await stranger.request.get(`/doc/${ID_DOC}/comments`)).status()).toBe(404);
    expect((await post(graceContext.request, "https://evil.example")).status()).toBe(403);

    const guestContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.5" } });
    const guest = await guestContext.newPage();
    await guest.goto(link.url);
    await expect(guest.getByTestId("comments-panel").getByTestId("comment-thread")).toHaveCount(1);
    expect((await post(guestContext.request)).status()).toBe(201);
    await page.request.delete(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, linkId: link.id } });
    expect((await post(guestContext.request)).status()).toBe(404);
    expect((await guestContext.request.get(`/doc/${ID_DOC}/comments`)).status()).toBe(404);

    // A note has no comments to be had.
    expect((await stranger.request.get(`/doc/${ID_NOTE}/comments`)).status()).toBe(404);
    expect((await page.request.get(`/doc/${ID_NOTE}/comments`)).status()).toBe(404);
    for (const context of [graceContext, stranger, guestContext]) await context.close();
  } finally {
    await restoreMore();
  }
});

// --- Anchors (ROADMAP 1d.2) --------------------------------------------------------------------------------------------------

const ANCHOR_DOC = (body: string) => `---\nid: ${ID_DOC}\ntitle: Q4 plan\n---\n\n# Q4 plan\n\n${body}\n`;

test("when a document is changed elsewhere, a thread follows the words around which, or in which, it was changed, and one whose words are gone is kept and said to be outdated", async ({ page }) => {
  try {
    const id = await repositoryWith(page, {
      "Notes/fjord.vault.json": VAULT_MANIFEST,
      "Notes/Plan.fj.md": ANCHOR_DOC("The plan covers the first quarter of the year in some detail.\n\nWe will hire two engineers before the summer starts, if the budget allows it.\n\nNothing in this paragraph is expected to change at all, ever."),
    });
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    const panel = page.getByTestId("comments-panel");
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("The plan covers");
    const comment = async (text: string, said: string) => {
      await selectText(page, text);
      await page.getByRole("button", { name: "Comment on selection" }).click();
      await panel.getByLabel("New comment").fill(said);
      await panel.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(panel.getByText(said)).toBeVisible();
    };
    await comment("the first quarter of the year", "Around: text is added before and after this");
    await comment("hire two engineers before the summer", "Inside: a word of this is changed");
    await comment("Nothing in this paragraph is expected to change", "Over: this is rewritten altogether");
    await expect(panel.getByTestId("comment-thread")).toHaveCount(3);
    await expect(panel.getByTestId("comment-outdated")).toHaveCount(0);

    // Somebody else changes the document in the repository: new text before and after the first, a word of the second, all of the third.
    await hubs.more.commitFiles({
      "Notes/Plan.fj.md": ANCHOR_DOC(
        "A new opening paragraph, added by somebody else.\n\nThe plan covers the first quarter of the year in some detail. It has a closing sentence now.\n\nWe will hire three engineers before the summer starts, if the budget allows it.\n\nThis paragraph was rewritten completely: hiring and offices are discussed in another document.",
      ),
    });
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("A new opening paragraph");

    // The first is where it was in its words; the second is on the words as they read now; the third is not marked, and is kept, said to be outdated.
    await expect.poll(() => marks(page)).toEqual({ "fe-thread": ["the first quarter of the year", "hire three engineers before the summer"] });
    await expect(panel.getByTestId("comment-thread")).toHaveCount(3);
    await expect(panel.getByTestId("comment-outdated")).toHaveCount(1);
    await expect(panel.getByTestId("comment-thread").nth(2)).toContainText("Over: this is rewritten altogether");
    await expect(panel.getByTestId("comment-thread").nth(2).getByTestId("comment-outdated")).toBeVisible();
    await expect(panel.getByTestId("comment-thread").nth(1).getByTestId("comment-outdated")).toHaveCount(0);

    // The server keeps the words the second thread is on now, so that the next change is compared with those.
    const stored = async () => {
      const listing = (await (await page.request.get(`/doc/${ID_DOC}/comments`)).json()) as { threads: { body: string; anchor: { quote: string } }[] };
      return Object.fromEntries(listing.threads.map((thread) => [thread.body.split(":")[0], thread.anchor.quote]));
    };
    await expect.poll(stored, { timeout: 10_000 }).toEqual({
      Around: "the first quarter of the year",
      Inside: "hire three engineers before the summer",
      Over: "Nothing in this paragraph is expected to change",
    });

    // And it holds: the page read again finds all that the same way, and the outdated thread is still there.
    await page.reload();
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("A new opening paragraph");
    await expect.poll(() => marks(page)).toEqual({ "fe-thread": ["the first quarter of the year", "hire three engineers before the summer"] });
    await expect(panel.getByTestId("comment-outdated")).toHaveCount(1);

    // The words come back (the change is undone elsewhere): the thread that was outdated is marked again, from the anchor it always had.
    await hubs.more.commitFiles({
      "Notes/Plan.fj.md": ANCHOR_DOC("The plan covers the first quarter of the year in some detail.\n\nWe will hire three engineers before the summer starts, if the budget allows it.\n\nNothing in this paragraph is expected to change at all, ever."),
    });
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect.poll(() => marks(page)).toEqual({ "fe-thread": ["the first quarter of the year", "hire three engineers before the summer", "Nothing in this paragraph is expected to change"] });
    await expect(panel.getByTestId("comment-outdated")).toHaveCount(0);
  } finally {
    await restoreMore();
  }
});

// --- Live updates (ROADMAP 1d.3) ---------------------------------------------------------------------------------------------

test("comments, replies, resolving and closing reach another browser without it reloading", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "comment" } })).json()) as { id: number; url: string };
    const ownerPanel = page.getByTestId("comments-panel");
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect(ownerPanel.getByText("No comments yet.")).toBeVisible();
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("The plan, for reading.");

    const guestContext = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.31" } });
    const guest = await guestContext.newPage();
    await guest.goto(link.url);
    const guestPanel = guest.getByTestId("comments-panel");
    await expect(guestPanel.getByText("No comments yet.")).toBeVisible();
    await expect(guest.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    // Neither page is loaded again from here on: whatever arrives, arrives through the stream.
    const loads = (target: typeof page) => target.evaluate(() => performance.getEntriesByType("navigation").length + (window as unknown as { __loaded?: number }).__loaded!);
    for (const target of [page, guest]) await target.evaluate(() => void ((window as unknown as { __loaded: number }).__loaded = 1));
    const before = [await loads(page), await loads(guest)];

    // The guest starts a thread (giving a name): it appears for the owner, in the panel and as a mark in the text.
    await selectText(guest, "plan, for");
    await guest.getByRole("button", { name: "Comment on selection" }).click();
    await guestPanel.getByLabel("Your name").fill("Grace Hopper");
    await guestPanel.getByRole("button", { name: "Continue" }).click();
    await guestPanel.getByLabel("New comment").fill("Is this the plan we agreed?");
    await guestPanel.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(guestPanel.getByTestId("comment-thread")).toHaveCount(1);
    await expect(ownerPanel.getByTestId("comment-thread")).toHaveCount(1);
    await expect(ownerPanel.getByText("Is this the plan we agreed?")).toBeVisible();
    await expect(ownerPanel.getByTestId("comment-count")).toHaveText("1 open");
    await expect.poll(() => marks(page)).toMatchObject({ "fe-thread": ["plan, for"] });

    // The owner replies, and the guest sees it; the owner resolves it, and the guest sees that, and the mark is drawn as a resolved one.
    await ownerPanel.getByRole("button", { name: "Reply" }).click();
    await ownerPanel.getByLabel("Reply").fill("Yes, it is.");
    await ownerPanel.getByRole("button", { name: "Reply", exact: true }).last().click();
    await expect(guestPanel.getByTestId("comment-reply")).toHaveCount(1);
    await expect(guestPanel.getByTestId("comment-reply")).toContainText("Yes, it is.");
    await ownerPanel.getByRole("button", { name: "Resolve" }).click();
    await expect(guestPanel.getByTestId("comment-thread")).toHaveAttribute("data-resolved", "true");
    await expect.poll(() => marks(guest)).toMatchObject({ "fe-thread-resolved": ["plan, for"] });

    // The owner closes the comments: the guest is told so. And deletes the thread: it goes from the guest's panel and text.
    await ownerPanel.getByRole("button", { name: "Close comments" }).click();
    await expect(guestPanel.getByText("Comments are closed")).toBeVisible();
    await ownerPanel.getByRole("button", { name: "Open comments" }).click();
    await expect(guestPanel.getByText("Comments are closed")).toHaveCount(0);
    await ownerPanel.getByRole("button", { name: /Delete Grace Hopper's comment/ }).click();
    await ownerPanel.getByRole("button", { name: "Yes, delete" }).click();
    await expect(guestPanel.getByTestId("comment-thread")).toHaveCount(0);
    await expect.poll(() => marks(guest)).toEqual({});

    expect([await loads(page), await loads(guest)]).toEqual(before);
    await guestContext.close();
  } finally {
    await restoreMore();
  }
});

// --- Limits and abuse (ROADMAP 1d.4) -----------------------------------------------------------------------------------------

test("comments are written only so fast by a browser and by a link, whatever names its guests give, and the owner is not held back by a link's guests", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "comment" } })).json()) as { id: number; url: string };
    const context = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.41" } });
    const guest = await context.newPage();
    await guest.goto(link.url);
    await expect(guest.getByTestId("comments-panel")).toBeVisible();
    const anchor = { type: "text-quote", quote: "plan", prefix: "The ", suffix: ", for reading.", position: 4 };
    const write = (browserId: string, n: number) =>
      context.request.post(`/doc/${ID_DOC}/comments`, { headers: { origin: BASE }, data: { op: "thread", anchor, body: `thread ${browserId} ${n}`, name: "Someone", clientId: browserId } });

    // One browser: twenty a minute, then it is told to wait, and how long.
    for (let n = 0; n < 20; n++) expect((await write("browser-aaaaaaaa", n)).status(), `write ${n}`).toBe(201);
    const slow = await write("browser-aaaaaaaa", 20);
    expect(slow.status()).toBe(429);
    expect(Number(slow.headers()["retry-after"])).toBeGreaterThan(0);
    expect((await slow.json()).error.code).toBe("rate_limited");

    // Another browser id on the same link has its own twenty, but the link has sixty for all of its guests together, so a new name is no way round.
    for (let n = 0; n < 20; n++) expect((await write("browser-bbbbbbbb", n)).status()).toBe(201);
    for (let n = 0; n < 20; n++) expect((await write("browser-cccccccc", n)).status()).toBe(201);
    expect((await write("browser-dddddddd", 0)).status()).toBe(429);

    // What was refused was not written; what was let through was.
    const listing = (await (await context.request.get(`/doc/${ID_DOC}/comments`)).json()) as { threads: { body: string }[] };
    expect(listing.threads).toHaveLength(60);
    expect(listing.threads.some((thread) => thread.body === "thread browser-aaaaaaaa 20")).toBe(false);

    // The owner has an account's own count, and comments as itself, whatever the link's guests have used.
    const mine = await page.request.post(`/doc/${ID_DOC}/comments`, { headers: { origin: BASE }, data: { op: "thread", anchor, body: "from the owner" } });
    expect(mine.status()).toBe(201);
    // Reading is not held back.
    expect((await context.request.get(`/doc/${ID_DOC}/comments`)).status()).toBe(200);
    await context.close();
  } finally {
    await restoreMore();
  }
});

// --- Security (ROADMAP 1d.5) -------------------------------------------------------------------------------------------------

/** Every Content-Security-Policy violation a page reports, across its navigations: the browser says each in its console. */
const watchViolations = (page: import("@playwright/test").Page): string[] => {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) seen.push(message.text());
  });
  return seen;
};

test("every page is sent with a Content-Security-Policy with a nonce of its own, and the app runs under it without a violation, while a script put in is not run", async ({ page, browser }) => {
  try {
    const owners = watchViolations(page);
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": "a note\n" });

    // The policy, and the other headers, on a page and on an API's answer; a new nonce for each page.
    const first = await page.request.get("/sign-in");
    const second = await page.request.get("/sign-in");
    const policy = first.headers()["content-security-policy"]!;
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("upgrade-insecure-requests"); // this instance is http
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    const nonceOf = (text: string) => /'nonce-([^']+)'/.exec(text)![1]!;
    expect(nonceOf(policy)).not.toBe(nonceOf(second.headers()["content-security-policy"]!));
    // Every script of the page carries that page's nonce, and the nonce is not in the page's address or a header the app sends on.
    const html = await first.text();
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, tag).toContain(`nonce="${nonceOf(policy)}"`);
    for (const response of [first, await page.request.get("/api/health")]) {
      const headers = response.headers();
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers["permissions-policy"]).toContain("camera=()");
      expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
      expect(headers["strict-transport-security"]).toBeUndefined(); // only over https
    }
    expect((await page.request.get("/api/health")).headers()["content-security-policy"]).toBeUndefined();

    // The pages a person uses, with their editors, menus and panels: nothing is blocked.
    await page.goto("/home");
    await page.goto(`/repo/${id}/Notes/idea.md`);
    await expect(noteEditor(page, "idea.md")).toBeVisible();
    await noteEditor(page, "idea.md").click();
    await page.keyboard.type(" and more");
    await page.goto(`/repo/${id}/Notes/Plan.fj.md`);
    await expect(noteEditor(page, "Plan.fj.md")).toContainText("The plan, for reading.");
    // The editor's own menus and dialogs: the block type list, a link's dialog, a table's.
    await page.getByRole("combobox", { name: "Block type" }).click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+z");
    await page.getByRole("button", { name: "Create link" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Insert Table" }).click();
    await page.keyboard.press("Escape");
    await selectText(page, "plan, for");
    await page.getByRole("button", { name: "Comment on selection" }).click();
    await page.getByTestId("comments-panel").getByLabel("New comment").fill("A comment under the policy");
    await page.getByTestId("comments-panel").getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByTestId("comment-thread")).toHaveCount(1);
    await expect.poll(() => marks(page)).toMatchObject({ "fe-thread": ["plan, for"] });
    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "comment" } })).json()) as { url: string };
    await page.reload();
    expect(owners, "the owner's pages").toEqual([]);

    const visitor = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.51" } });
    const guest = await visitor.newPage();
    const guests = watchViolations(guest);
    await guest.goto("/");
    await guest.goto(link.url);
    await expect(guest.getByTestId("comment-thread")).toHaveCount(1);
    await expect.poll(() => marks(guest)).toMatchObject({ "fe-thread": ["plan, for"] });
    expect(guests, "a guest's pages and the live stream").toEqual([]);

    // Markup that is put in, which is how a script reaches a page through a comment, a name or a document, does not run: an inline handler and a javascript:
    // address have no nonce. (A script element made by a script that has the nonce is trusted by `strict-dynamic`; that is the page's own code, not content.)
    const ran = await guest.evaluate(async () => {
      document.body.insertAdjacentHTML("beforeend", '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__injected = true" onerror="window.__injected = true">');
      document.body.insertAdjacentHTML("beforeend", '<a id="evil" href="javascript:window.__injected = true">x</a>');
      (document.getElementById("evil") as HTMLAnchorElement).click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });
    expect(ran).toBe(false);
    expect(guests.some((message) => /inline event handler/i.test(message))).toBe(true);
    expect(guests.some((message) => /javascript:/i.test(message))).toBe(true);
    await visitor.close();
  } finally {
    await restoreMore();
  }
});

const HOSTILE_DOC = `---\nid: ${ID_DOC}\ntitle: Hostile\n---\n\n# Hostile\n\n<script>window.__pwned = 1</script>\n\n<img src="https://evil.example/pixel.png" onerror="window.__pwned = 1">\n\n[click me](javascript:window.__pwned=1)\n\n![tracker](https://evil.example/tracker.png)\n\n<iframe src="https://evil.example/frame"></iframe>\n\nPlain text after.\n`;

test("what other people wrote, in a document, a comment or a name, is shown as text and does nothing: no script, no handler, no request to another site", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": HOSTILE_DOC });
    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "comment" } })).json()) as { url: string };
    const payload = `<img src="https://evil.example/c.png" onerror="window.__pwned = 1"><script>window.__pwned = 1</script> [x](javascript:window.__pwned=1)`;

    const visitor = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.61" } });
    const guest = await visitor.newPage();
    const requested: string[] = [];
    for (const target of [page, guest]) target.on("request", (request) => void (new URL(request.url()).origin !== BASE && requested.push(request.url())));

    // A guest writes the payload as a comment (a name with markup in it is refused), and the owner reads it, as text.
    await guest.goto(link.url);
    expect((await guest.context().request.post(`/doc/${ID_DOC}/comments`, { headers: { origin: BASE }, data: { op: "thread", anchor: { type: "text-quote", quote: "Plain text", prefix: "", suffix: "", position: 0 }, body: payload, name: "<img src=x onerror=alert(1)>", clientId: "browser-hostile1" } })).status()).toBe(400);
    expect((await guest.context().request.post(`/doc/${ID_DOC}/comments`, { headers: { origin: BASE }, data: { op: "thread", anchor: { type: "text-quote", quote: "Plain text", prefix: "", suffix: "", position: 0 }, body: payload, name: "Mallory", clientId: "browser-hostile1" } })).status()).toBe(201);

    for (const [who, target, address] of [["the owner", page, `/repo/${id}/Notes/Plan.fj.md`], ["a guest", guest, link.url]] as const) {
      await target.goto(address);
      await expect(target.getByTestId("comments-panel").getByTestId("comment-thread")).toHaveCount(1);
      // The comment is its own words, character for character, and made no element.
      await expect(target.getByTestId("comments-panel").getByTestId("comment-thread")).toContainText(payload);
      await expect(target.locator("main img[onerror], main script, main iframe, main a[href^='javascript']"), `${who}: nothing in the page that runs`).toHaveCount(0);
      // The document says what it says, as text in the editor, and none of it ran or loaded.
      await expect(target.locator("main")).toContainText("Plain text after.");
      await expect(target.locator("main img[src*='evil'], main iframe, main script:not([nonce])"), `${who}: the document's markup`).toHaveCount(0);
      await expect(target.locator("main a[href^='javascript']")).toHaveCount(0);
      expect(await target.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), `${who}: nothing ran`).toBeUndefined();
    }
    expect(requested, "nothing was asked of another site").toEqual([]);
    await visitor.close();
  } finally {
    await restoreMore();
  }
});

/**
 * The routes the matrix does not drive: sign-in has its own tests (1a), the entry of a link is a public GET by design, and the GitHub App's
 * (1a.6) are there only on an instance that has an App, which this one does not: they are a 404 to everyone (below), and the webhook is
 * GitHub's, let in by its signature and not by an `Origin`, so "refused from another site" is not its rule (`src/github-app/flow.test.ts`).
 */
const NOT_IN_THE_MATRIX = new Set(["/api/auth/[...all]", "/api/health", "/api/links/enter", "/api/github-app/install", "/api/github-app/callback", "/api/webhooks/github"]);

test("on an instance with no GitHub App, its routes are not there for anyone, and the page offers no way in", async ({ page, browser }) => {
  const nobody = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.73" } });
  try {
    for (const [method, path] of [["GET", "/api/github-app/install"], ["GET", "/api/github-app/callback?code=c&installation_id=1&state=s"], ["POST", "/api/webhooks/github"]] as const) {
      for (const request of [page.request, nobody.request]) {
        const response = await request.fetch(path, { method, maxRedirects: 0, failOnStatusCode: false, ...(method === "POST" ? { data: "{}", headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=00" } } : {}) });
        expect(response.status(), `${method} ${path}`).toBe(404);
      }
    }
    await page.goto("/repositories");
    await expect(page.getByRole("button", { name: "Install on GitHub" })).toHaveCount(0);
  } finally {
    await nobody.close();
  }
});

test("every route that changes something refuses another site's request, even from its owner, and every route refuses callers it has no business with, and nothing is changed by trying", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC });
    const before = await hubs.more.branchHead();
    const strangers = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.71" } });
    const mallory = await strangers.newPage();
    await signUp(mallory, `mallory-${Date.now()}@example.com`, "Mallory");
    const nobody = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.72" } });

    const address = (route: string) => route.replace("/api/connections/[id]", `/api/connections/${id}`).replace("/doc/[id]", `/doc/${ID_DOC}`).replace("/note/[id]", `/note/${ID_DOC}`);
    const sent = async (request: import("@playwright/test").APIRequestContext, method: string, route: string, origin: string | null) => {
      const response = await request.fetch(address(route), { method, ...(origin === null ? {} : { headers: { origin, "content-type": "application/json" } }), ...(method === "GET" ? {} : { data: {} }), maxRedirects: 0, failOnStatusCode: false });
      return response.status();
    };
    const tried: string[] = [];
    const wrong: string[] = [];
    for (const rule of ROUTES) {
      if (NOT_IN_THE_MATRIX.has(rule.route) || rule.methods === undefined) continue;
      for (const [method, access] of Object.entries(rule.methods)) {
        const name = `${method} ${rule.route}`;
        tried.push(name);
        // Someone with no account, and another account that owns nothing here: told no (not signed in, not allowed, not found, or that what was sent is not
        // a request; the body here is empty, and a route may look at it first, which tells a stranger nothing about what is there), never let in and never an
        // error. An account's own list is the one thing an account may ask for, and a stranger's is empty.
        for (const [who, request] of [["nobody", nobody.request], ["a stranger", mallory.request]] as const) {
          const status = await sent(request, method, rule.route, BASE);
          if (access.kind === "account" && method === "GET" && who === "a stranger") {
            if (status !== 200 || JSON.stringify(await (await request.get(address(rule.route))).json()).includes("acme")) wrong.push(`${name} by ${who}: ${status}`);
          } else if (![400, 401, 403, 404].includes(status)) wrong.push(`${name} by ${who}: ${status}`);
        }
        // The owner, from another site or with no origin at all: a request that changes something is refused.
        if (method !== "GET") {
          for (const origin of ["https://evil.example", "null", null]) {
            const status = await sent(page.request, method, rule.route, origin);
            if (status !== 403) wrong.push(`${name} by the owner from ${origin ?? "no origin"}: ${status}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(tried.length, "the registry was walked").toBeGreaterThan(20);
    // Nothing was changed by any of it.
    expect(await hubs.more.branchHead()).toBe(before);
    const listing = (await (await page.request.get(`/api/connections/${id}/links?doc=${ID_DOC}`)).json()) as { links?: unknown[] };
    expect(listing.links ?? []).toEqual([]);
    await strangers.close();
    await nobody.close();
  } finally {
    await restoreMore();
  }
});

test("the git host's token and the instance's secrets are in nothing that reaches a browser: no page, answer, script, cookie or storage, the owner's or a guest's", async ({ page, browser }) => {
  try {
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Plan.fj.md": SHARE_DOC, "Notes/idea.md": "a note\n" });
    const secrets = [GOOD, "ZTJlLW9ubHkta2V5LW5vdC1mb3ItYW55dGhpbmchISE=", "e2e-only-secret-not-for-anything-real-0123456789", Buffer.from("ZTJlLW9ubHkta2V5LW5vdC1mb3ItYW55dGhpbmchISE=", "base64").toString()];
    const leaks: string[] = [];
    let inspected = 0;
    const watch = (target: import("@playwright/test").Page, who: string) =>
      target.on("response", async (response) => {
        if (new URL(response.url()).origin !== BASE) return;
        const text = await response.text().catch(() => "");
        if (text !== "") inspected++;
        const headers = JSON.stringify(response.headers());
        for (const secret of secrets) if (text.includes(secret) || headers.includes(secret)) leaks.push(`${who}: ${response.url()}`);
      });
    watch(page, "owner");

    const link = (await (await page.request.post(`/api/connections/${id}/links`, { headers: { origin: BASE }, data: { doc: ID_DOC, role: "edit" } })).json()) as { url: string };
    for (const address of ["/", "/home", "/repositories", "/account/security", `/repo/${id}`, `/repo/${id}/Notes`, `/repo/${id}/Notes/idea.md`, `/repo/${id}/Notes/Plan.fj.md`, `/doc/${ID_DOC}`, `/deleted/${id}`]) {
      await page.goto(address);
      await page.waitForLoadState("networkidle");
    }
    for (const address of ["/api/connections", `/api/connections/${id}/links?doc=${ID_DOC}`, `/api/connections/${id}/shares?doc=${ID_DOC}`, `/doc/${ID_DOC}/comments`, "/api/health"]) {
      const response = await page.request.get(address);
      const body = await response.text();
      const headers = JSON.stringify(response.headers());
      for (const secret of secrets) if (body.includes(secret) || headers.includes(secret)) leaks.push(`owner: ${address}`);
    }
    // What the page keeps in the browser.
    const kept = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
    const cookies = JSON.stringify(await page.context().cookies());
    for (const secret of secrets) {
      expect(kept.includes(secret), "storage").toBe(false);
      expect(cookies.includes(secret), "cookies").toBe(false);
    }

    const visitor = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-forwarded-for": "10.99.8.81" } });
    const guest = await visitor.newPage();
    watch(guest, "guest");
    await guest.goto(link.url);
    await expect(guest.getByRole("textbox", { name: "Q4 plan" })).toContainText("The plan, for reading.");
    await guest.waitForLoadState("networkidle");
    expect(JSON.stringify(await visitor.cookies()).includes(GOOD)).toBe(false);
    await visitor.close();

    expect(inspected, "pages, scripts and answers were looked through").toBeGreaterThan(40);
    expect(leaks).toEqual([]);
  } finally {
    await restoreMore();
  }
});

// --- Encrypted files, opened in the browser (ROADMAP 2b.2) ---

/** The format module as Node loads it, to make the files the CLI would: encrypted to an identity, in both namings. */
const wasm = createRequire(join(process.cwd(), "package.json"))(join(wasmDirectory(), "fjord_wasm.js")) as {
  generateIdentity(): Uint8Array;
  identityRecipient(identity: Uint8Array): string;
  encrypt(plaintext: Uint8Array, recipients: string, armor: boolean): Uint8Array;
  decrypt(ciphertext: Uint8Array, identity: Uint8Array): Uint8Array;
  wrapContainer(name: string, contents: Uint8Array): Uint8Array;
  unwrapContainer(archive: Uint8Array): { name: string; contents: Uint8Array };
  sealWithPassphrase(plaintext: Uint8Array, passphrase: Uint8Array, logN: number): Uint8Array;
};
const bytes = (text: string) => new TextEncoder().encode(text);

test("an encrypted file is decrypted in the browser, in both namings, and nothing readable or secret passes the server", async ({ page }) => {
  // Each page load is locked, and unlocking is scrypt (about two seconds here): this opens four files across loads.
  test.setTimeout(240_000);
  const secret = wasm.generateIdentity();
  const recipient = wasm.identityRecipient(secret);
  const stranger = wasm.identityRecipient(wasm.generateIdentity());
  const sealedName = "01jagc4k7pr9tbm3ykwx6zq2hz";
  const PLAIN = "# Plain-named secret\n\nonly ever readable in the browser";
  const SEALED = "# Id-named secret\n\nits real name is inside the container";
  const vault = (id: string, naming: string, container: string) =>
    JSON.stringify({ fjord: 1, id, name: id, createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container, armor: false }, fileNaming: naming });
  const id = await repositoryWith(page, {
    "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3me", name: "Secrets", createdAt: "2026-10-16T09:34:00Z", vaults: [{ path: "Open", id: "01jagc4k7pr9tbm3ykwx6zq2hx" }, { path: "Sealed", id: "01jagc4k7pr9tbm3ykwx6zq2hy" }] }),
    "Open/fjord.vault.json": vault("01jagc4k7pr9tbm3ykwx6zq2hx", "plain", "none"),
    "Open/recipients.txt": `${recipient}\n`,
    "Open/note.md.age": wasm.encrypt(bytes(PLAIN), recipient, false),
    "Open/not-yours.md.age": wasm.encrypt(bytes("not for this identity"), stranger, false),
    "Sealed/fjord.vault.json": vault("01jagc4k7pr9tbm3ykwx6zq2hy", "id", "tar"),
    "Sealed/recipients.txt": `${recipient}\n`,
    [`Sealed/${sealedName}.age`]: wasm.encrypt(wasm.wrapContainer("Plan.md", bytes(SEALED)), recipient, false),
  });

  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const answers: string[] = [];
  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`));
  page.on("response", async (response) => {
    if (response.url().includes("/api/")) answers.push(`${response.url()} ${(await response.body().catch(() => Buffer.alloc(0))).toString("latin1")}`);
  });

  // Without an identity the page says what to do, and shows nothing.
  await page.goto(`/repo/${id}/Open/note.md.age`);
  await expect(page.getByText("No identity in this browser")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "note.md" })).toHaveCount(0);

  // Bring the identity (a file's text), sealed with a passphrase.
  const PASSPHRASE = "a passphrase of some length";
  await page.goto("/account/keys");
  await page.getByRole("button", { name: "I already have one" }).click();
  await page.getByLabel("Your secret key").fill(`# an identity file\n${new TextDecoder().decode(secret)}\n`);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Keep this identity" }).click();
  await expect(page.getByTestId("recipient")).toHaveText(recipient, { timeout: 60_000 });

  // A new page load is locked: the file asks for the passphrase, then opens.
  await page.goto(`/repo/${id}/Open/note.md.age`);
  await page.getByLabel("Passphrase").fill("not the passphrase");
  await page.getByRole("button", { name: "Unlock and open" }).click();
  await expect(page.getByText("That passphrase does not open the identity.")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock and open" }).click();
  const plain = page.getByRole("textbox", { name: "note.md", exact: true });
  await expect(plain).toContainText("# Plain-named secret", { timeout: 60_000 });
  await expect(plain).toHaveAttribute("contenteditable", "true");

  // Hidden on request, and opened again.
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(plain).toHaveCount(0);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("textbox", { name: "note.md", exact: true })).toContainText("only ever readable in the browser");

  // The id-named vault: the real name is inside the container and is what the page shows.
  await page.goto(`/repo/${id}/Sealed`);
  await expect(page.getByRole("list", { name: "Folder contents" })).toContainText(sealedName);
  await page.getByRole("link", { name: sealedName }).click();
  // The link is a navigation inside the same page load, which is locked (the load before it was the vault's list): unlocked here, it stays so for the next.
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock and open" }).click();
  await expect(page.getByRole("textbox", { name: "Plan.md", exact: true })).toContainText("its real name is inside the container", { timeout: 60_000 });

  // A file for someone else's key is refused in words, and shows nothing.
  await page.goto(`/repo/${id}/Open/not-yours.md.age`);
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock and open" }).click();
  await expect(page.getByText("This identity cannot open the file")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("not for this identity")).toHaveCount(0);

  // Nothing the server saw or said holds a plaintext, the passphrase or the key; the policy was kept.
  // (The check looks at what was said: the ciphertext itself was among it, so an empty record would not pass.)
  expect(answers.filter((answer) => answer.includes("/ciphertext?") && answer.includes("age-encryption.org/v1")).length).toBeGreaterThanOrEqual(3);
  const everything = [...sent, ...answers].join("\n");
  for (const forbidden of [PLAIN.slice(2, 20), SEALED.slice(2, 18), "Plan.md", "not for this identity", PASSPHRASE, new TextDecoder().decode(secret).slice(0, 24)]) {
    expect(everything, forbidden).not.toContain(forbidden);
  }
  expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);

  // Only the signed-in owner is handed the bytes.
  const anonymous = await page.context().browser()!.newContext({ baseURL: BASE });
  expect((await anonymous.request.get(`/api/connections/${id}/ciphertext?path=Open/note.md.age`, { failOnStatusCode: false })).status()).toBe(401);
  await anonymous.close();
  expect((await page.request.get(`/api/connections/${id}/ciphertext?path=Open/recipients.txt`, { failOnStatusCode: false })).status()).toBe(404);
  expect((await page.request.get(`/api/connections/${id}/ciphertext?path=Open/note.md.age`)).status()).toBe(200);
});
