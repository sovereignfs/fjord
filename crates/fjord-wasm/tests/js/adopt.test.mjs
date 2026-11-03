// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Adopting a directory that already has files (RFC 0002, P17): the module makes the plan `fjord init --adopt` makes,
// so the web client and the CLI write the same bytes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { wasm } from "./helpers.mjs";

const random = (count) => Uint8Array.from({ length: 16 * (1 + count) }, (_, i) => (i * 7 + 3) % 256);
const NOW = 1_793_000_000_000;
const plan = (options, existing) => JSON.parse(wasm.planAdopt(JSON.stringify(options), JSON.stringify(existing), NOW, random(options.vaults?.length ?? 0)));
const base = { repositoryName: "Mine", generator: "fjord-web test" };

test("a drive adopts the directories it is given, below the root too, and writes over nothing", () => {
  const existing = { paths: ["README.md", "notes/a.md", "src/content/post.md"], gitattributes: null, gitignore: null };
  const made = plan({ ...base, kind: "drive", vaults: [{ path: "notes", encrypted: false }, { path: "src/content", encrypted: false }] }, existing);
  assert.equal(made.ok, true);
  assert.deepEqual(made.files.map((f) => f.path), ["fjord.json", "notes/fjord.vault.json", "src/content/fjord.vault.json", ".gitattributes"]);
  assert.ok(made.files.every((f) => f.change === "create"));
  assert.ok(made.files.every((f) => !existing.paths.includes(f.path)));
  assert.deepEqual(made.vaults.map((v) => [v.path, v.holdsFiles]), [["notes", true], ["src/content", true]]);
  assert.ok(wasm.isUlid(made.repositoryId) && made.vaults.every((v) => wasm.isUlid(v.id)));
  assert.equal(new Set([made.repositoryId, ...made.vaults.map((v) => v.id)]).size, 3, "no two identifiers are alike");
});

test("a site is one plaintext vault with the engine recorded; an encrypted one is refused", () => {
  const existing = { paths: ["astro.config.mjs", "src/content/a.md"], gitattributes: null, gitignore: null };
  const made = plan({ ...base, kind: "ssg", engine: "astro", vaults: [{ path: "src/content", encrypted: false }] }, existing);
  assert.equal(made.ok, true);
  const manifest = JSON.parse(made.files[0].contents);
  assert.equal(manifest.kind, "ssg");
  assert.equal(manifest.ssg.engine, "astro");
  assert.equal(manifest.vaults[0].path, "src/content");

  const encrypted = plan({ ...base, kind: "ssg", engine: "astro", vaults: [{ path: "src/content", encrypted: true }] }, existing);
  assert.deepEqual([encrypted.ok, encrypted.error.code], [false, "encrypted_site"]);
  assert.equal(plan({ ...base, kind: "ssg", engine: "hugo", vaults: [] }, existing).error.code, "unknown_engine");
});

test("gitattributes and gitignore only gain lines, and an encrypted vault with files says so", () => {
  const existing = { paths: [".gitattributes", ".gitignore", "journal/a.md"], gitattributes: "*.png binary", gitignore: "target/" };
  const made = plan({ ...base, kind: "journal", vaults: [{ path: "journal", encrypted: true }] }, existing);
  assert.equal(made.ok, true);
  assert.equal(made.vaults[0].holdsFiles, true);
  for (const [path, original] of [[".gitattributes", "*.png binary"], [".gitignore", "target/"]]) {
    const file = made.files.find((f) => f.path === path);
    assert.equal(file.change, "append", path);
    assert.ok(file.contents.startsWith(original), `${path}: nothing is reworded`);
  }
  assert.ok(made.files.find((f) => f.path === ".gitignore").contents.includes(".fjord/local/"));
});

test("a finding about the directory is data, not an exception", () => {
  const ask = (vaults, paths = []) => plan({ ...base, kind: "drive", vaults }, { paths, gitattributes: null, gitignore: null });
  assert.equal(ask([{ path: "notes", encrypted: false }], ["fjord.json"]).error.code, "already_fjord");
  assert.equal(ask([{ path: "a", encrypted: false }, { path: "a/b", encrypted: false }]).error.code, "nested_vaults");
  assert.equal(ask([{ path: "../x", encrypted: false }]).error.code, "invalid_vault_path");
  assert.equal(ask([{ path: "notes", encrypted: false }], ["notes/fjord.vault.json"]).error.code, "vault_exists");
  assert.equal(ask([]).error.code, "vault_count");
});

test("a malformed call is an exception, and too little randomness is too", () => {
  assert.throws(() => wasm.planAdopt("nope", "{}", NOW, random(1)));
  assert.throws(() => wasm.planAdopt(JSON.stringify({ ...base, kind: "drive", vaults: [{ path: "a" }] }), JSON.stringify({ paths: [] }), NOW, new Uint8Array(8)));
});

test("a site is known by its engine's files, only at the root", () => {
  const detect = (paths) => JSON.parse(wasm.detectSite(JSON.stringify({ paths })));
  assert.deepEqual(detect(["astro.config.mjs", "package.json"]), { engine: "astro", content: "src/content" });
  assert.deepEqual(detect(["_config.yml"]), { engine: "jekyll", content: "_posts" });
  assert.equal(detect(["docs/astro.config.mjs", "README.md"]), null);
});

test("the same call gives the same plan", () => {
  const options = { ...base, kind: "drive", vaults: [{ path: "notes", encrypted: false }] };
  const existing = { paths: ["notes/a.md"], gitattributes: null, gitignore: null };
  assert.deepEqual(plan(options, existing), plan(options, existing));
});
