// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The conformance fixtures, through the WebAssembly build (ROADMAP P4). `tests/fixtures/discovery.json`
// is what the CLI's filesystem walk said about each of them; the module, given only a list of paths and
// a few manifests' text, must say the same.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtures, golden, listing, manifestsFor, wasm } from "./helpers.mjs";

for (const [name, expected] of Object.entries(golden)) {
  test(`${name}: the vaults, their files and what each is`, () => {
    const root = join(fixtures, name);
    const files = listing(root);
    const found = JSON.parse(wasm.discover(JSON.stringify(files), JSON.stringify(manifestsFor(root, files))));

    assert.deepEqual(found.nested, expected.verify.nested, "nested vault manifests");

    // The CLI refuses a repository whose vault manifest cannot be read as a whole; from a listing
    // that vault is there, with its problem.
    if (expected.discover === "error") {
      assert.ok(found.vaults.some((v) => v.manifestError), "the unreadable manifest is reported");
      return;
    }

    assert.deepEqual(
      found.vaults.map((v) => v.directory),
      expected.discover.map((v) => v.directory),
      "which directories are vaults",
    );
    for (const [vault, want] of found.vaults.map((v, i) => [v, expected.discover[i]])) {
      const at = `${name}/${vault.directory}`;
      assert.equal(vault.name, want.label, `${at}: label`);
      assert.equal(vault.encrypted, want.encrypted, `${at}: encrypted`);
      assert.equal(vault.suffix, want.suffix, `${at}: suffix`);
      assert.deepEqual(
        vault.files.map((f) => [f.relative, f.logical, f.kind === "payload", f.size]),
        want.contents.map((c) => [c.relative, c.logical, c.is_payload, c.size]),
        `${at}: files`,
      );
    }
  });

  test(`${name}: documents and other files are counted as verify counted them`, () => {
    const root = join(fixtures, name);
    const files = listing(root);
    const found = JSON.parse(wasm.discover(JSON.stringify(files), JSON.stringify(manifestsFor(root, files))));

    for (const want of expected.verify.vaults) {
      const vault = found.vaults.find((v) => v.directory === want.path);
      assert.ok(vault, `${name}: ${want.path} is a vault`);
      let docs = 0;
      let others = 0;
      for (const file of vault.files) {
        // A Doc is a Markdown file in a plaintext vault whose frontmatter has a valid `id`: that needs the
        // file's text, which a listing does not have, so it is read and asked of the module.
        if (file.kind === "document" || file.kind === "note") {
          const read = JSON.parse(wasm.parseDocument(readFileSync(join(root, file.path), "utf8")));
          if (read.status === "present" && read.docId) docs += 1;
          else others += 1;
        } else if (file.kind !== "stray") {
          others += 1;
        }
      }
      assert.equal(docs, want.docs, `${name}/${want.path}: documents`);
      assert.equal(others, want.files, `${name}/${want.path}: other files`);
    }
  });
}

test("the golden file covers every fixture the module is run on", () => {
  assert.ok(Object.keys(golden).length >= 31);
  assert.ok("conforming" in golden);
});
