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
  assert.equal(
    wasm.journalEntryPath("2026-11-02T00:30:00+05:30", wasm.journalSlug("Morning run"), false),
    "2026/11/02/0030-morning-run.md",
  );
  assert.equal(wasm.journalEntryPath("2026-11-02T00:30:00+05:30", undefined, true), "2026-11-02-0030.md");
  assert.equal(wasm.journalEntryPath("2026-11-02", undefined, false), undefined);
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
