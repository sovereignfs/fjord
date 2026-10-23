// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The build for a browser (an ES module that fetches and instantiates the module) answers as the build
// for Node does. It is loaded here the way a page loads it, from bytes handed to `initSync`; a browser
// is checked by loading the same files (see README.md).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtures, golden, listing, manifestsFor, pkg, wasm as node } from "./helpers.mjs";

const web = await import(join(pkg, "web", "fjord_wasm.js"));
web.initSync({ module: readFileSync(join(pkg, "web", "fjord_wasm_bg.wasm")) });

test("both builds are the same module", () => {
  assert.deepEqual(readFileSync(join(pkg, "web", "fjord_wasm_bg.wasm")), readFileSync(join(pkg, "node", "fjord_wasm_bg.wasm")));
});

test("the web build discovers every fixture's vaults exactly as the Node build does", () => {
  for (const name of Object.keys(golden)) {
    const root = join(fixtures, name);
    const files = JSON.stringify(listing(root));
    const manifests = JSON.stringify(manifestsFor(root, JSON.parse(files)));
    assert.equal(web.discover(files, manifests), node.discover(files, manifests), name);
  }
});

test("the web build reads and writes documents as the Node build does", () => {
  const text = "---\nid: 01j8z3k9t2v4w5x6y7z8a9b0c1\nzzz: 1\n---\nbody\n";
  assert.equal(web.parseDocument(text), node.parseDocument(text));
  assert.equal(web.promoteDocument("plain\n", "01j8z3k9t2v4w5x6y7z8a9b0c1", "2026-01-01T00:00:00Z", "T"), node.promoteDocument("plain\n", "01j8z3k9t2v4w5x6y7z8a9b0c1", "2026-01-01T00:00:00Z", "T"));
  assert.equal(web.newUlid(42, new Uint8Array(10)), node.newUlid(42, new Uint8Array(10)));
});
