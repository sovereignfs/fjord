// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Repository kinds, journal entries and tags, through the WebAssembly build (ROADMAP web P12). The same
// answers as `fjord init --kind`, `fjord new` in a journal and spec §8.1's tag comparison, from the same
// code in `fjord-core`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { wasm } from "./helpers.mjs";

const random = new Uint8Array(80).map((_, i) => (i * 7 + 3) & 0xff);
const now = 1_793_559_600_000; // 2026-11-01T19:00:00Z

function plan(options) {
  return JSON.parse(
    wasm.planKind(JSON.stringify({ repositoryName: "Notes", generator: "fjord-web test", ...options }), now, random),
  );
}

test("a manifest says how to present its repository, and keeps what it does not know", () => {
  const read = (manifest) => JSON.parse(wasm.describeRepositoryManifest(JSON.stringify(manifest)));
  assert.equal(read({ fjord: 1 }).kind, "drive");
  assert.equal(read({ fjord: 1 }).declaredKind, null);
  assert.equal(read({ kind: "journal" }).kind, "journal");
  assert.equal(read({ kind: "ssg", ssg: { engine: "astro" } }).kind, "ssg");
  assert.equal(read({ kind: "ssg", ssg: { engine: "astro" } }).ssgEngine, "astro");

  // Spec §3.1: what a client does not know, it shows as a drive, and keeps as written.
  const wiki = read({ kind: "wiki", wiki: { home: "Index" } });
  assert.equal(wiki.kind, "drive");
  assert.equal(wiki.declaredKind, "wiki");
  assert.deepEqual(wiki.raw.wiki, { home: "Index" });
  assert.equal(read({ kind: "ssg", ssg: { engine: "hugo" } }).kind, "drive");
  assert.equal(read({ kind: 3 }).kind, "drive");
});

test("each kind is planned as fjord init makes it", () => {
  const drive = plan({ kind: "drive", encrypted: true });
  assert.equal(drive.ok, true);
  assert.deepEqual(drive.vaults.map((v) => v.path), ["Public", "Private"]);
  assert.ok(!JSON.parse(drive.files.find((f) => f.path === "fjord.json").contents).kind, "a drive writes no kind");

  const journal = plan({ kind: "journal", encrypted: true });
  assert.deepEqual(journal.vaults.map((v) => v.path), ["journal"]);
  const vault = JSON.parse(journal.files.find((f) => f.path === "journal/fjord.vault.json").contents);
  assert.equal(vault.fileNaming, "id");
  assert.equal(vault.encryption.container, "tar");

  for (const [engine, file] of [
    ["astro", "src/content.config.ts"],
    ["jekyll", "_config.yml"],
  ]) {
    const site = plan({ kind: "ssg", engine });
    assert.equal(site.ok, true, engine);
    const manifest = JSON.parse(site.files.find((f) => f.path === "fjord.json").contents);
    assert.equal(manifest.kind, "ssg");
    assert.deepEqual(manifest.ssg, { engine });
    assert.ok(site.files.some((f) => f.path === file), `${engine}: ${file}`);
  }
});

test("what cannot be made is refused, with a code", () => {
  assert.equal(plan({ kind: "ssg", engine: "astro", encrypted: true }).error.code, "encrypted_site");
  assert.equal(plan({ kind: "ssg", engine: "hugo" }).error.code, "unknown_engine");
  assert.equal(plan({ kind: "ssg" }).error.code, "unknown_engine");
  assert.equal(plan({ kind: "wiki" }).error.code, "unknown_kind");
  assert.throws(() => wasm.planKind("{}", now, random), /kind/);
  assert.throws(() => wasm.planKind(JSON.stringify({ kind: "drive" }), now, random.slice(0, 10)), /random/);
});

test("an entry is dated at the writer's offset and filed by the writer's day", () => {
  // Half past midnight in Colombo is still the 1st in UTC.
  assert.equal(wasm.entryDateFromUnix(1_793_559_600, 330), "2026-11-02T00:30:00+05:30");
  assert.equal(wasm.entryDateFromUnix(1_793_559_600, 0.5), undefined);
  // A folder for the day and a file named by the minute, in an encrypted journal too; nothing of the title.
  assert.equal(wasm.journalEntryPath("2026-11-02T00:30:00+05:30"), "2026-11-02/00-30.md");
  assert.equal(wasm.journalEntryPath("2026-11-02"), undefined);
  assert.equal(wasm.journalSlug("?!"), undefined);
  assert.equal(wasm.isEntryDate("2026-11-02"), true);
  assert.equal(wasm.isEntryDate("2026-11-02 08:14:00 +0530"), false);
});

test("tags are compared without case, and / nests them", () => {
  assert.equal(wasm.sameTag("Work", "work"), true);
  assert.equal(wasm.sameTag("café", "café"), true);
  assert.equal(wasm.foldTag("Project/Fjord"), "project/fjord");
  assert.equal(wasm.tagIsUnder("project/fjord", "Project"), true);
  assert.equal(wasm.tagIsUnder("projects", "project"), false);
  // The module and the page's own toLowerCase agree, which is why the spec says lowercase mapping.
  for (const tag of ["Work", "ΕΛΛΆΔΑ", "İstanbul", "STRASSE", "Ǆ"]) {
    assert.equal(wasm.foldTag(tag), tag.normalize("NFC").toLowerCase().normalize("NFC"), tag);
  }
});

test("a repository that is not a Fjord repository is set up as a journal or a site, and nothing of its own is written over", () => {
  const existing = JSON.stringify({ paths: ["README.md", "src/main.rs"], gitattributes: null });
  const setUp = (options) =>
    JSON.parse(wasm.planSetupKind(JSON.stringify({ repositoryName: "Mine", generator: "fjord-web test", ...options }), existing, now, random));
  const journal = setUp({ kind: "journal", vault: "journal", encrypted: false });
  assert.equal(journal.ok, true);
  assert.deepEqual(journal.files.map((f) => [f.path, f.change]).sort(), [
    [".gitattributes", "create"],
    ["fjord.json", "create"],
    ["journal/fjord.vault.json", "create"],
  ]);
  assert.equal(JSON.parse(journal.files.find((f) => f.path === "fjord.json").contents).kind, "journal");
  const site = setUp({ kind: "ssg", engine: "jekyll" });
  assert.ok(site.files.some((f) => f.path === "_config.yml"));
  assert.ok(!site.files.some((f) => f.path === "README.md"), "somebody's README is kept");
  const taken = JSON.parse(
    wasm.planSetupKind(JSON.stringify({ repositoryName: "M", generator: "g", kind: "ssg", engine: "astro" }), JSON.stringify({ paths: ["package.json"], gitattributes: null }), now, random),
  );
  assert.equal(taken.error.code, "file_taken");
  assert.equal(setUp({ kind: "drive" }).error.code, "unknown_kind");
});

test("a kind is changed with everything else kept, and its rules are the format's", () => {
  const changed = JSON.parse(wasm.withKind(JSON.stringify({ fjord: 1, name: "N", "x-mine": [1], vaults: [] }), "ssg", "astro"));
  assert.equal(changed.ok, true);
  const manifest = JSON.parse(changed.text);
  assert.equal(manifest.kind, "ssg");
  assert.deepEqual(manifest.ssg, { engine: "astro" });
  assert.deepEqual(manifest["x-mine"], [1]);
  assert.equal(JSON.parse(wasm.withKind("{}", "ssg", undefined)).error.code, "unknown_engine");
  assert.equal(JSON.parse(wasm.withKind("{}", "wiki", undefined)).error.code, "unknown_kind");
  assert.equal(wasm.kindRule("journal", "[false, false]"), "E111");
  assert.equal(wasm.kindRule("ssg", "[true]"), "E112");
  assert.equal(wasm.kindRule("drive", "[]"), undefined);
});

test("an entry is written, re-dated, tagged and summarised by the format module", () => {
  const text = wasm.newEntry("01jagc4k7pt8y3wqnmzv5xrb9c", "Morning run", "2026-11-01T19:00:00Z", "2026-11-02T00:30:00+05:30");
  assert.match(text, /^---\nid: 01jagc4k7pt8y3wqnmzv5xrb9c\ntitle: Morning run\ncreated: "2026-11-01T19:00:00Z"\ndate: "2026-11-02T00:30:00\+05:30"\n---\n\n# Morning run\n$/);
  assert.equal(wasm.newEntry("01jagc4k7pt8y3wqnmzv5xrb9c", undefined, "2026-11-01T19:00:00Z", "2026-11-02").endsWith("---\n\n"), true);
  const tagged = wasm.withTags(wasm.withDate(text, "2026-11-01T23:00:00+05:30"), JSON.stringify(["Health", "running"]));
  const summary = JSON.parse(wasm.journalEntry(`${tagged}Five kilometres.\n`, "2026/11/02/0030-morning-run.md"));
  assert.equal(summary.title, "Morning run");
  assert.deepEqual(summary.tags, ["Health", "running"]);
  assert.deepEqual(summary.when, { day: "2026-11-01", time: "23:00", source: "date", sortKey: "2026-11-01T23:00" });
  assert.equal(summary.excerpt, "Five kilometres.");
  assert.equal(summary.dateInvalid, false);
  assert.equal(wasm.withDate("no header\n", "2026-11-02"), undefined);
});

test("a site's post goes where its engine reads it, with what it reads", () => {
  assert.equal(wasm.sitePostPath("astro", "2026-11-02T00:30:00+05:30", "Hello, World!", false), "posts/hello-world.md");
  // Jekyll's name is a rule: the writer's day, then the slug; a draft is a folder.
  assert.equal(wasm.sitePostPath("jekyll", "2026-11-02T00:30:00+05:30", "First light", false), "_posts/2026-11-02-first-light.md");
  assert.equal(wasm.sitePostPath("jekyll", "2026-11-02", "Later", true), "_drafts/later.md");
  assert.equal(wasm.sitePostPath("hugo", "2026-11-02", "x", false), undefined);
  assert.equal(wasm.sitePostPath("jekyll", "yesterday", "x", false), undefined);
  const astro = wasm.siteNewPost("astro", "01jagc4k7pt8y3wqnmzv5xrb9c", "Hi", "2026-11-01T19:00:00Z", "2026-11-02", true);
  assert.match(astro, /draft: true\n---\n\n$/);
  assert.equal(wasm.siteNewPost("jekyll", "01jagc4k7pt8y3wqnmzv5xrb9c", "Hi", "2026-11-01T19:00:00Z", "2026-11-02", true).includes("draft"), false);
  assert.match(wasm.siteTagProblem("jekyll", "two words"), /two tags/);
  assert.equal(wasm.siteTagProblem("jekyll", "project/fjord"), undefined);
  assert.equal(wasm.siteTagProblem("astro", "two words"), undefined);
  assert.equal(JSON.parse(wasm.journalEntry("---\ndraft: true\n---\nx\n", "posts/a.md")).draft, true);
});

test("a site's images: type by bytes, folder, name and reference (RFC 0004)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(wasm.siteImageType(png), "png");
  assert.equal(wasm.siteImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(wasm.siteImageMime("jpg"), "image/jpeg");
  assert.equal(wasm.siteImageMime("svg"), undefined);
  assert.equal(wasm.siteImageDir("astro", "src/content"), "src/content/images");
  assert.equal(wasm.siteImageDir("jekyll", "content"), "content/images");
  assert.equal(wasm.siteImageDir("jekyll", "_posts"), "assets/images");
  assert.equal(wasm.siteImageDir("hugo", "content"), undefined);
  assert.equal(wasm.siteImageName("My Photo.JPG", "jpg", "[]"), "my-photo.jpg");
  assert.equal(wasm.siteImageName("photo.png", "png", '["Photo.png"]'), "photo-2.png");
  assert.equal(wasm.siteImageName("x.png", "svg", "[]"), undefined);
  assert.equal(wasm.siteImageName("x.png", "png", "not json"), undefined);
  assert.equal(wasm.siteImageRef("astro", "content/posts/p.md", "content/images/x.png"), "../images/x.png");
  assert.equal(wasm.siteImageRef("jekyll", "content/_posts/2026-11-08-p.md", "content/images/x.png"), "/content/images/x.png");
  assert.equal(wasm.siteImageRef("hugo", "p.md", "x.png"), undefined);
  assert.equal(wasm.siteImageTarget("content/posts/p.md", "../images/x.png"), "content/images/x.png");
  assert.equal(wasm.siteImageTarget("content/posts/p.md", "https://example.com/x.png"), undefined);
  assert.equal(wasm.siteRefersTo("content/posts/p.md", "![a](../images/x.png)", "content/images/x.png"), true);
  assert.equal(wasm.siteRefersTo("content/posts/p.md", "![a](../images/y.png)", "content/images/x.png"), false);
});

test("an entry's title is its header's before its heading or its file name (spec §8.2), as a site's posts, which have no heading, need", () => {
  const summary = (text, path) => JSON.parse(wasm.journalEntry(text, path));
  assert.equal(summary("---\ntitle: Hello, World!\ndate: 2026-11-02\n---\n\nNo heading.\n", "posts/hello-world.md").title, "Hello, World!");
  assert.equal(summary("---\ntitle: Header\n---\n\n# Body\n", "a.md").title, "Header");
  assert.equal(summary("---\ndate: 2026-11-02\n---\n\nx\n", "posts/hello-world.md").title, "hello-world");
});


test("a header field is set where it was, a flag or text, and taken away, without touching another key or the body", () => {
  const text = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\nlayout: post\ntitle: Hello\ndraft: true\n---\n\nBody\n";
  const keys = (t) => t.split("\n").slice(1, t.split("\n").indexOf("---", 1)).map((line) => line.split(":")[0]);
  const flagged = wasm.withField(text, "draft", "false");
  assert.ok(flagged.includes("draft: false\n"));
  assert.deepEqual(keys(flagged), ["id", "layout", "title", "draft"]);
  assert.ok(flagged.endsWith("---\n\nBody\n"));
  const described = wasm.withField(text, "description", JSON.stringify('A: "post"'));
  assert.deepEqual(keys(described), ["id", "layout", "title", "draft", "description"]);
  assert.deepEqual(keys(wasm.withField(text, "draft", "null")), ["id", "layout", "title"]);
  // Keys a form may not set, and texts it cannot rewrite, are refused as nothing; a value of another shape is an exception.
  for (const key of ["id", "created", "fjord", "", "a b"]) assert.equal(wasm.withField(text, key, "true"), undefined, key);
  assert.equal(wasm.withField("no header\n", "draft", "true"), undefined);
  assert.throws(() => wasm.withField(text, "draft", "[1]"));
  assert.throws(() => wasm.withField(text, "draft", "7"));
});
