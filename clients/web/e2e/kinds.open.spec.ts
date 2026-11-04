import { createHash } from "node:crypto";
import { addressOf, expect, signUp, test, NOTE_PLACE, PLACE, POST_PLACE } from "./helpers";
import { type TwoGitHubs, startTwoGitHubs } from "./two-github";

/**
 * Repository kinds in a real browser (ROADMAP 3a, 3b, 3c; RFC 0001), on the instance whose GitHub is a fake with real git behind it: a journal
 * opens on its timeline and takes a new entry dated in the browser's own time; a repository that is not a Fjord repository is set up as an
 * Astro site, takes a post and shows the host's build; and every kind can be shown as files.
 */
test.describe.configure({ mode: "serial" });

const GOOD = "github_pat_e2egoodtoken0123456789abcdefghijklmnopqrstuvwx";
let hubs: TwoGitHubs;

test.beforeAll(async () => {
  hubs = await startTwoGitHubs(3192, { [GOOD]: { push: true } });
  const entry = (id: string, title: string, date: string, tags: string) => `---\nid: ${id}\ntitle: ${title}\ndate: "${date}"\ntags: [${tags}]\n---\n\n# ${title}\n\nSome words about ${title}.\n`;
  await hubs.notes.commitFiles(
    {
      "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3md", name: "Diary", createdAt: "2026-10-16T09:34:00Z", kind: "journal", vaults: [{ path: "journal", id: "01jagc4k7pr9tbm3ykwx6zq2hv" }] }),
      "journal/fjord.vault.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Journal", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" }),
      "journal/2026/11/02/0814-morning-run.md": entry("01jagc4k7pt8y3wqnmzv5xrb9c", "Morning run", "2026-11-02T08:14:00+05:30", "health, Running"),
      // Filed under the 1st, dated the 3rd: the date wins.
      "journal/2026/11/01/0900-moved.md": entry("01jagc4k7pt8y3wqnmzv5xrb9d", "Moved entry", "2026-11-03T09:00:00+05:30", "work"),
      "journal/2026/10/31/2200-old.md": entry("01jagc4k7pt8y3wqnmzv5xrb9e", "Old entry", "2026-10-31T22:00:00+05:30", "Work"),
    },
    { replace: true },
  );
  // Not a Fjord repository: somebody's, with a README of their own.
  await hubs.more.commitFiles({ "README.md": "# Mine\n" }, { replace: true });
});
test.afterAll(async () => hubs.stop());

async function connect(page: import("@playwright/test").Page, repository: string): Promise<number> {
  await page.goto("/repositories");
  await page.getByRole("textbox", { name: "Repository" }).fill(repository);
  await page.getByLabel("Access token").fill(GOOD);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(repository).first()).toBeVisible();
  const list = (await (await page.request.get("/api/connections")).json()) as { connections: { id: number; owner: string; name: string }[] };
  const found = list.connections.find((c) => `${c.owner}/${c.name}` === repository);
  if (!found) throw new Error(`${repository} was not connected`);
  return found.id;
}

test("the home page has a tile for each repository, in the icon and the words of its kind from the moment it is connected, at an address of its own that is not a count", async ({ page }) => {
  await signUp(page);
  const journal = await connect(page, "acme/notes");
  const other = await connect(page, "acme/more");
  const listed = (await (await page.request.get("/api/connections")).json()) as { connections: { id: number; publicId: string; address: string }[] };
  const publicId = listed.connections.find((c) => c.id === journal)?.publicId ?? "";
  // A journal's addresses begin with its kind, which connecting it read.
  const address = listed.connections.find((c) => c.id === journal)?.address ?? "";
  expect(address).toBe(`journal/${publicId}`);
  // A short generated name, lower case, and not the number it is kept under.
  expect(publicId).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
  expect(publicId).not.toBe(String(journal));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fjord", level: 1 })).toBeVisible();
  await expect(page.getByText("REPOSITORIES (2)", { exact: true })).toBeVisible();
  // The way to connect and disconnect is an icon at the end of that line, not a link under the tiles.
  await expect(page.getByRole("link", { name: "Connect or disconnect repositories" })).toHaveAttribute("href", "/repositories");
  const tiles = page.getByRole("list", { name: "Repositories", exact: true });
  await expect(tiles.getByRole("link")).toHaveCount(2);
  await expect(tiles.getByRole("link", { name: /acme\/notes/ })).toHaveAttribute("href", `/${address}`);
  // Never opened, and already a journal's tile: connecting a repository reads it, so its kind is known.
  await expect(tiles.getByRole("link", { name: /acme\/notes/ })).toContainText("Journal");
  await expect(tiles.getByRole("link", { name: /acme\/more/ })).toContainText("Drive");
  void other;
  // What a repository used to be called, by its number, still arrives and is sent to its name.
  await page.goto(`/repo/${journal}`);
  await expect(page).toHaveURL(new RegExp(`/${address}$`));
  await expect(page.getByRole("heading", { name: "acme/notes", level: 1 })).toBeVisible();
  // An address of another kind (a drive's, for what is a journal) is sent to the one that is its kind, and so is `/repo/<repo>`.
  await page.goto(`/drive/${publicId}`);
  await expect(page).toHaveURL(new RegExp(`/${address}$`));
  await page.goto(`/repo/${publicId}`);
  await expect(page).toHaveURL(new RegExp(`/${address}$`));
  // A drive's address stays a drive's.
  const other2 = (await (await page.request.get("/api/connections")).json()).connections.find((c: { id: number }) => c.id === other) as { publicId: string; address: string };
  expect(other2.address).toBe(`drive/${other2.publicId}`);
  // Signing in lands on the default repository, not on the grid.
  await page.goto("/open");
  await expect(page).toHaveURL(new RegExp(`/${address}$`));
});

test("a journal opens on its timeline, placed by date, and takes an entry dated in the browser's own time", async ({ page }) => {
  await signUp(page);
  const id = await connect(page, "acme/notes");
  await page.goto(`/repo/${id}`);

  // Newest first by the day each is about; the entry dated the 3rd is there although it is filed under the 1st.
  const days = page.getByTestId("timeline").locator("h3");
  await expect(days).toHaveText(["3 November 2026", "2 November 2026", "31 October 2026"]);
  await expect(page.getByTestId("timeline-entry")).toHaveCount(3);
  await expect(page.getByRole("link", { name: /Moved entry/ })).toBeVisible();

  // Tags are counted once, case aside, and narrow the timeline.
  await page.getByText("Tags and dates").click();
  await expect(page.getByRole("button", { name: /#work/i })).toHaveCount(1);
  await page.getByRole("button", { name: /#work/i }).click();
  await expect(page.getByTestId("timeline-entry")).toHaveCount(2);
  await page.getByRole("button", { name: "Show everything" }).click();
  await expect(page.getByTestId("timeline-entry")).toHaveCount(3);

  // A new entry, in one action: dated now, with this browser's offset, in the dated folder of the writer's own day. It opens at its note address
  // (`/journal/<repo>/n/<id>`, workstream 0003), as a writing view: the editor and the properties, the rest under "More".
  await page.getByRole("button", { name: "New entry" }).click();
  await expect(page).toHaveURL(NOTE_PLACE, { timeout: 30_000 });
  await expect(page.getByTestId("more")).toBeVisible();

  const head = (await hubs.notes.branchHead())!;
  const files = await hubs.notes.filesAt(head);
  const day0 = new Date();
  const dated = `journal/${day0.getFullYear()}-${String(day0.getMonth() + 1).padStart(2, "0")}-${String(day0.getDate()).padStart(2, "0")}/`;
  const made = Object.keys(files).find((path) => path.startsWith(dated) && /\/\d\d-\d\d\.md$/.test(path))!;
  const day = new Date();
  const folder = `journal/${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}/`;
  expect(made.startsWith(folder)).toBe(true);
  expect(files[made]).toMatch(/date: "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)"/);

  // Every kind can be shown as files (its one vault, at its own address), and back by the path above it.
  await page.goto(`/repo/${id}`);
  await page.getByRole("link", { name: "Show files" }).click();
  await expect(page).toHaveURL(new RegExp(`/${await addressOf(page, id)}/v/[0-9a-hjkmnp-tv-z]{26}$`));
  await expect(page.getByRole("list", { name: "Folder contents" })).toBeVisible();
  // The old address, `?view=files`, is sent there.
  await page.goto(`/repo/${id}?view=files`);
  await expect(page).toHaveURL(new RegExp(`/${await addressOf(page, id)}/v/[0-9a-hjkmnp-tv-z]{26}$`));
  await page.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "acme/notes" }).click();
  await expect(page.getByTestId("timeline")).toBeVisible();
});

test("a journal's note is at /journal/<repo>/n/<id>, is shared at /n/<id>, and an old address by path or by id is sent to it", async ({ page, browser }) => {
  await signUp(page);
  const id = await connect(page, "acme/notes");
  const NOTE = "01jagc4k7pt8y3wqnmzv5xrb9c";
  const here = new RegExp(`/${await addressOf(page, id)}/n/${NOTE}$`);
  await page.goto(`/repo/${id}`);
  await page.getByRole("link", { name: /Morning run/ }).click();
  await expect(page).toHaveURL(here);
  await expect(page.getByRole("heading", { name: "2026-11-02/08-14.md" })).toHaveCount(0);

  // An old address by its path (the entry is filed the old way), and the address by id, end there.
  await page.goto(`/repo/${id}/journal/2026/11/02/0814-morning-run.md`);
  await expect(page).toHaveURL(here);
  await page.goto(`/n/${NOTE}`);
  await expect(page).toHaveURL(here);
  await page.goto(`/d/${NOTE}`);
  await expect(page).toHaveURL(here);

  // A link to a note is given at /n/<id>, and opens it there for someone with no account, with the token gone from the address.
  const made = await page.request.post(`/api/connections/${id}/links`, { headers: { origin: "http://localhost:3201" }, data: { doc: NOTE, role: "view", address: "n" } });
  expect(made.status()).toBe(201);
  const link = (await made.json()) as { url: string };
  expect(link.url).toMatch(new RegExp(`^http://localhost:3201/n/${NOTE}\\?token=`));
  const visitor = await browser.newContext({ baseURL: "http://localhost:3201" });
  const guest = await visitor.newPage();
  await guest.goto(link.url);
  await expect(guest).toHaveURL(`http://localhost:3201/n/${NOTE}`);
  await expect(guest.getByRole("heading", { name: "Morning run", level: 1 })).toBeVisible();
  // Without the link, the same address is nothing to a stranger.
  const stranger = await browser.newContext({ baseURL: "http://localhost:3201" });
  const nobody = await stranger.newPage();
  await nobody.goto(`/n/${NOTE}`);
  await expect(nobody).toHaveURL(/\/sign-in/);
  await visitor.close();
  await stranger.close();
});

test("a repository that is not a Fjord repository is set up as a site, takes a post and shows the host's build", async ({ page }) => {
  await signUp(page);
  const id = await connect(page, "acme/more");
  await page.goto(`/repo/${id}`);

  await expect(page.getByRole("heading", { name: "This is not a Fjord repository yet" })).toBeVisible();
  await page.getByLabel(/A site: the posts of a static site/).check();
  await page.getByRole("radio", { name: "Astro", exact: true }).check();
  // What would be written is shown first: the engine's files, not the person's README.
  await expect(page.getByText("src/content.config.ts")).toBeVisible();
  await expect(page.getByLabel("What would be added").getByText("README.md")).toHaveCount(0);
  const before = (await hubs.more.branchHead())!;
  await page.getByRole("button", { name: "Set up Fjord here" }).click();
  await expect(page.getByRole("button", { name: "New post" })).toBeVisible({ timeout: 30_000 });
  const after = (await hubs.more.branchHead())!;
  expect(after).not.toBe(before);
  const files = await hubs.more.filesAt(after);
  expect(files["README.md"]).toBe("# Mine\n");
  expect(JSON.parse(files["fjord.json"]!)).toMatchObject({ kind: "ssg", ssg: { engine: "astro" } });

  // A post, as a draft: the engine's own way of saying so.
  await page.getByRole("button", { name: "New post" }).click();
  await page.getByLabel("Title").fill("Hello, World!");
  await page.getByRole("button", { name: "Write it" }).click();
  await expect(page).toHaveURL(POST_PLACE, { timeout: 30_000 }); // a post has an id from the start: `/ssg/<repo>/post/<id>`
  const post = (await hubs.more.filesAt((await hubs.more.branchHead())!))["content/posts/hello-world.md"]!;
  expect(post).toContain("draft: true");
  expect(post).toMatch(/date: "\d{4}-\d\d-\d\d/);

  // The host reports a build of the head commit: the page says it is built, and where.
  await page.goto(`/repo/${id}`);
  const hello = page.getByTestId("timeline-entry").filter({ hasText: "Hello, World!" });
  await expect(hello).toHaveCount(1);
  await expect(hello.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByTestId("build-status")).toHaveCount(0);
  const head = (await hubs.more.branchHead())!;
  hubs.more.reportBuild(head, {
    checkRuns: [{ name: "Build site", status: "completed", conclusion: "success", html_url: "https://ci.example/runs/1" }],
    deployments: [{ id: 11, environment: "preview", statuses: [{ state: "success", environment_url: "https://preview-abc.pages.example" }] }],
  });
  await page.reload();
  const build = page.getByTestId("build-status");
  await expect(build.getByText("The site is built")).toBeVisible();
  await expect(build.getByRole("link", { name: "https://preview-abc.pages.example" })).toHaveAttribute("href", "https://preview-abc.pages.example");
});

test("a tag with a space is refused on a Jekyll site, with the engine's reason, and a draft takes Jekyll's folder", async ({ page }) => {
  const jekyllHub = hubs.more;
  // The same repository, made plain again: the whole tree is replaced.
  await jekyllHub.commitFiles({ "README.md": "# Mine, again\n" }, { replace: true });
  await signUp(page);
  const id = await connect(page, "acme/more");
  await page.goto(`/repo/${id}`);
  await page.getByLabel(/A site: the posts of a static site/).check();
  await page.getByRole("radio", { name: "Jekyll", exact: true }).check();
  await page.getByRole("button", { name: "Set up Fjord here" }).click();
  await expect(page.getByRole("button", { name: "New post" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New post" }).click();
  await page.getByLabel("Title").fill("First light");
  await page.getByLabel(/A draft/).uncheck();
  await page.getByRole("button", { name: "Write it" }).click();
  await expect(page).toHaveURL(POST_PLACE, { timeout: 30_000 });

  await page.getByText("Properties").click();
  await page.getByLabel("Tags").fill("two words");
  await page.getByRole("button", { name: "Set tags" }).click();
  await expect(page.getByText(/Jekyll reads a tag with a space in it as two tags/)).toBeVisible();
  await page.getByLabel("Tags").fill("one-word, project/fjord");
  await page.getByRole("button", { name: "Set tags" }).click();
  await expect(page.getByText(/Jekyll reads a tag/)).toHaveCount(0);
});

test("unsaved changes to a site are previewed through the host on a branch of their own, and the default branch is never written", async ({ page }) => {
  // The site again, from a plain repository, with a build already reported for its default branch: the preview must not borrow that one's address.
  await hubs.more.commitFiles({ "README.md": "# Mine, once more\n" }, { replace: true });
  await signUp(page);
  const id = await connect(page, "acme/more");
  await page.goto(`/repo/${id}`);
  await page.getByLabel(/A site: the posts of a static site/).check();
  await page.getByRole("radio", { name: "Astro", exact: true }).check();
  await page.getByRole("button", { name: "Set up Fjord here" }).click();
  await expect(page.getByRole("button", { name: "New post" })).toBeVisible({ timeout: 30_000 });

  const main = (await hubs.more.branchHead())!;
  hubs.more.reportBuild(main, {
    checkRuns: [{ name: "Build site", status: "completed", conclusion: "success" }],
    deployments: [{ id: 21, environment: "production", statuses: [{ state: "success", environment_url: "https://main-site.example" }] }],
  });

  // Nothing edited yet: nothing to preview.
  await page.goto(`/repo/${id}`);
  const panel = page.getByTestId("preview-panel");
  await expect(panel.getByRole("button", { name: "Preview" })).toBeDisabled();

  // An unsaved change to the welcome post, kept as a draft the way the editor keeps it.
  const original = (await hubs.more.filesAt(main))["content/posts/welcome.md"]!;
  const blob = createHash("sha1").update(`blob ${Buffer.byteLength(original)}\0`).update(original).digest("hex");
  const edited = `${original}\nAn edit that is not saved as a version.\n`;
  const saved = await page.request.put(`/api/connections/${id}/working-copy`, { headers: { origin: "http://localhost:3201" }, data: { path: "content/posts/welcome.md", baseBlob: blob, content: edited } });
  expect(saved.status()).toBe(200);

  await page.reload();
  await expect(panel.getByText(/You have an unsaved change to this site's posts/)).toBeVisible();
  await panel.getByRole("button", { name: "Preview" }).click();
  await expect(panel.getByTestId("preview")).toHaveCount(1);
  await expect(panel.getByTestId("preview").getByText("Waiting")).toBeVisible();

  // A branch of its own holds the change; the default branch is where it was and holds the file as it was.
  expect(await hubs.more.branchHead()).toBe(main);
  const listing = (await (await page.request.get(`/api/connections/${id}/previews`)).json()) as { previews: { branch: string; commit: string }[] };
  const [preview] = listing.previews;
  expect(preview!.branch).toMatch(/^fjord\/preview\/[0-9a-f]{8}-\d{8}t\d{6}z$/);
  expect((await hubs.more.filesAt(preview!.commit))["content/posts/welcome.md"]).toBe(edited);
  expect((await hubs.more.filesAt(main))["content/posts/welcome.md"]).toBe(original);

  // The host builds that branch and says where: the page shows that address, not the default branch's.
  hubs.more.reportBuild(preview!.commit, {
    checkRuns: [{ name: "Build site", status: "completed", conclusion: "success" }],
    deployments: [{ id: 22, environment: "preview", statuses: [{ state: "success", environment_url: "https://preview-abc.example" }] }],
  });
  await page.reload();
  const link = panel.getByTestId("preview").getByRole("link", { name: "Open the preview" });
  await expect(link).toHaveAttribute("href", "https://preview-abc.example");
  await expect(panel.getByText("main-site.example")).toHaveCount(0);

  // Stopping deletes the branch and nothing else.
  await panel.getByRole("button", { name: "Stop previewing" }).click();
  await expect(panel.getByTestId("preview")).toHaveCount(0);
  expect(await hubs.more.branchHead(preview!.branch)).toBeUndefined();
  expect(await hubs.more.branchHead()).toBe(main);
});

test("nobody can preview, list or stop a preview of a repository that is not theirs, or without signing in", async ({ page, request }) => {
  expect((await request.get("/api/connections/1/previews")).status()).toBe(401);
  expect((await request.post("/api/connections/1/previews", { headers: { origin: "http://localhost:3201" } })).status()).toBe(401);
  await signUp(page);
  // Someone else's connection (or none) is not found, and from another site a write is refused.
  expect((await page.request.get("/api/connections/9999/previews")).status()).toBe(404);
  expect((await page.request.post("/api/connections/9999/previews", { headers: { origin: "http://localhost:3201" } })).status()).toBe(404);
  expect((await page.request.post("/api/connections/9999/previews", { headers: { origin: "https://evil.example" } })).status()).toBe(403);
  expect((await page.request.delete("/api/connections/9999/previews?branch=main", { headers: { origin: "http://localhost:3201" } })).status()).toBe(404);
});

