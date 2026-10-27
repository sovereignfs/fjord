import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { alertOn, expect, signUp, test } from "./helpers";
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
  return expect.stringMatching(new RegExp(`^---\\nid: [0-9a-hjkmnp-tv-z]{26}\\ntitle: ${escape(title)}\\ncreated: \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\n---\\n(?:\\n)?${escape(text)}$`));
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

test("an encrypted vault's files are shown by name and locked", async ({ page }) => {
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/notes");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/notes");

  await page.goto("/");
  await page.getByRole("list", { name: "Vaults" }).getByRole("link", { name: "Private" }).click();
  const contents = page.getByRole("list", { name: "Folder contents" });
  // The name without the `.age` it is stored under, and no way in.
  await expect(contents.getByText("secret.md")).toBeVisible();
  await expect(contents.getByRole("link", { name: "secret.md" })).toHaveCount(0);
  await expect(contents.getByLabel("Locked")).toBeVisible();
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
    expect(text).toMatch(/^---\nid: [0-9a-hjkmnp-tv-z]{26}\ntitle: Q4 plan\ncreated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n---\n\n# Q4 plan\n$/);
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

test("nothing is offered in an encrypted vault, and it is refused if asked for", async ({ page }) => {
  try {
    const id = await repositoryWith(page, { "Secret/fjord.vault.json": ENCRYPTED_MANIFEST, "Secret/recipients.txt": RECIPIENTS, "Secret/x.md.age": "age-encryption.org/v1", "Notes/fjord.vault.json": VAULT_MANIFEST });
    await page.goto(`/repo/${id}/Secret`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "New note" })).toHaveCount(0);
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
    expect(((await (await post(del, { vault: "Secret", type: "file", path: "Secret/x.md.age", blob })).json()).error.code)).toBe("encrypted_vault");
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

test("an encrypted file stays locked, and a document opens in its editor", async ({ page }) => {
  const id = await connected(page);
  await page.goto(`/repo/${id}/Private/secret.md.age`);
  await expect(page.getByText("Files in an encrypted vault cannot be opened in this version.")).toBeVisible();
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
    await expect(page.getByRole("toolbar")).toBeVisible();
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

test("a document the visual editor cannot keep as written is shown as Markdown, and edited byte for byte", async ({ page }) => {
  try {
    const body = "\nSome text first.\n\n<details>\n<summary>Raw HTML</summary>\n\nInside.\n\n</details>\n\nA footnote[^1] too.\n\n[^1]: The note.\n";
    const id = await repositoryWith(page, { "Notes/fjord.vault.json": VAULT_MANIFEST, "Notes/Raw.fj.md": DOC_HEADER + body });
    await page.goto(`/repo/${id}/Notes/Raw.fj.md`);

    await expect(page.getByRole("note")).toContainText("shown as Markdown");
    const editor = noteEditor(page, "Raw.fj.md");
    await expect(editor).toContainText("<details>");
    await expect(page.getByRole("toolbar")).toHaveCount(0);

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
    await expect(page.getByRole("toolbar")).toHaveCount(0);
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
    expect(saved).toBe("---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nzeta: 1\ntitle: 'Plan: the sequel'\nx-future:\n- kept\ncreated: 2026-10-16T09:34:00Z\n---\n" + body);
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
