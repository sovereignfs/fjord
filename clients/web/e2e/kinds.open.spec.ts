import { expect, signUp, test } from "./helpers";
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

  // A new entry: dated now, with this browser's offset, in the dated folder of the writer's own day.
  await page.getByRole("button", { name: "New entry" }).click();
  await page.getByLabel("Title").fill("Written in the test");
  await page.getByRole("button", { name: "Write it" }).click();
  await expect(page).toHaveURL(/\/repo\/\d+\/journal\/\d{4}\/\d\d\/\d\d\/\d{4}-written-in-the-test\.md$/);

  const head = (await hubs.notes.branchHead())!;
  const files = await hubs.notes.filesAt(head);
  const made = Object.keys(files).find((path) => path.endsWith("-written-in-the-test.md"))!;
  const day = new Date();
  const folder = `journal/${day.getFullYear()}/${String(day.getMonth() + 1).padStart(2, "0")}/${String(day.getDate()).padStart(2, "0")}/`;
  expect(made.startsWith(folder)).toBe(true);
  expect(files[made]).toMatch(/date: "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)"/);

  // Every kind can be shown as files, and back.
  await page.goto(`/repo/${id}`);
  await page.getByRole("link", { name: "Show files" }).click();
  await expect(page).toHaveURL(/\?view=files$/);
  await expect(page.getByRole("link", { name: /Journal/ }).first()).toBeVisible();
  await page.getByRole("link", { name: /Show as journal/ }).click();
  await expect(page.getByTestId("timeline")).toBeVisible();
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
  await expect(page).toHaveURL(/\/repo\/\d+\/content\/posts\/hello-world\.md$/);
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
  await expect(page).toHaveURL(/\/repo\/\d+\/content\/_posts\/\d{4}-\d\d-\d\d-first-light\.md$/);

  await page.getByText("Properties").click();
  await page.getByLabel("Tags").fill("two words");
  await page.getByRole("button", { name: "Set tags" }).click();
  await expect(page.getByText(/Jekyll reads a tag with a space in it as two tags/)).toBeVisible();
  await page.getByLabel("Tags").fill("one-word, project/fjord");
  await page.getByRole("button", { name: "Set tags" }).click();
  await expect(page.getByText(/Jekyll reads a tag/)).toHaveCount(0);
});
