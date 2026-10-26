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
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("no longer accepts this repository's token");
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
  await expect(page.getByText("Opening it comes next")).toBeVisible();
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
  await page.goto(`/repo/${id}/Public/Q4/report.fj.md`);
  await expect(page.getByText("Opening it comes next")).toBeVisible();
  const asked = hubs.notes.requests.map((request) => `${request.method} ${request.path.replace("/repos/acme/notes", "")}`);
  expect(asked.filter((path) => path.startsWith("GET /git/trees/") || path.startsWith("GET /git/blobs/"))).toEqual([]);

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
    await expect(page.getByRole("alert").filter({ hasText: "already used" })).toBeVisible();
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
    await expect(page.getByRole("alert").filter({ hasText: "changed while you were looking" })).toBeVisible();
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
async function repositoryWith(page: import("@playwright/test").Page, files: Record<string, string | Uint8Array>): Promise<number> {
  await hubs.more.commitFiles(files, { replace: true });
  await signUp(page);
  await page.goto("/repositories");
  await connect(page, "acme/more");
  await expect(page.getByRole("list", { name: "Connected repositories" })).toContainText("acme/more");
  return (await (await page.request.get("/api/connections")).json()).connections[0].id as number;
}

const VAULT_MANIFEST = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const noteEditor = (page: import("@playwright/test").Page, name: string) => page.getByRole("textbox", { name });

test("a note opens in the note editor, which can only be read for now, and reads the file once", async ({ page }) => {
  const id = await connected(page);
  await page.goto(`/repo/${id}/Public`);
  hubs.notes.requests.length = 0;
  await page.goto(`/repo/${id}/Public/idea.md`);

  const editor = noteEditor(page, "idea.md");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("# Idea");
  await expect(editor).toHaveAttribute("aria-readonly", "true");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.getByText("You are reading this note")).toBeVisible();

  // Typing does nothing to a note that is only being read.
  await editor.click();
  await page.keyboard.type("nope");
  await expect(editor).not.toContainText("nope");

  // The file was read, once, by its blob; nothing else was.
  const blobReads = hubs.notes.requests.filter((request) => request.path.includes("/git/blobs/"));
  expect(blobReads).toHaveLength(1);
  expect(hubs.notes.requests.filter((request) => request.path.includes("/git/trees/"))).toEqual([]);
});

test("a document is not opened in the note editor, and an encrypted file stays locked", async ({ page }) => {
  const id = await connected(page);
  await page.goto(`/repo/${id}/Public/plan.fj.md`);
  await expect(page.getByText("The document editor is the next thing to be built")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.goto(`/repo/${id}/Private/secret.md.age`);
  await expect(page.getByText("Files in an encrypted vault cannot be opened in this version.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
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
