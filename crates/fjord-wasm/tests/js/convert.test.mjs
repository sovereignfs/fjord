// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Making a vault encrypted or plaintext (RFC 0003): the module plans what `fjord encrypt <vault> --permanent` and
// `fjord decrypt <vault> --permanent` write, so the web client and the CLI write the same files.

import assert from "node:assert/strict";
import { test } from "node:test";
import { wasm } from "./helpers.mjs";

const PLAIN = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", "x-future": { a: 1 }, encryption: null, fileNaming: "plain" });
const key = () => wasm.identityRecipient(wasm.generateIdentity());
const encrypt = (manifest, recipients, gitattributes = null) => JSON.parse(wasm.planVaultEncryption(manifest, JSON.stringify({ recipients, gitattributes })));

test("a plaintext vault is planned encrypted: its own fields kept, the recipients file and the guard written, the merge guard asked for", () => {
  const recipient = key();
  const plan = encrypt(PLAIN, [recipient]);
  assert.equal(plan.ok, true);
  const manifest = JSON.parse(plan.manifest);
  assert.equal(manifest.id, "01jagc4k7pr9tbm3ykwx6zq2hv");
  assert.deepEqual(manifest["x-future"], { a: 1 });
  assert.equal(manifest.encryption.tool, "age");
  assert.deepEqual(plan.files.map((f) => f.path), ["recipients.txt", ".gitignore"]);
  assert.ok(plan.files[0].contents.includes(recipient));
  assert.equal(plan.gitattributes, "*.age binary -diff -merge\n");
  assert.equal(encrypt(PLAIN, [recipient], "*.age binary -diff -merge\n").gitattributes, null);
  assert.equal(encrypt(PLAIN, [recipient], "*.png binary").gitattributes, "*.png binary\n*.age binary -diff -merge\n");
});

test("it is refused, with a code, for no one to encrypt to, a key that is not one, and a vault that is already what was asked", () => {
  assert.equal(encrypt(PLAIN, []).error.code, "no_recipients");
  assert.equal(encrypt(PLAIN, ["age1nope"]).error.code, "bad_recipient");
  assert.equal(JSON.parse(wasm.planVaultDecryption(PLAIN)).error.code, "not_encrypted");
  assert.equal(encrypt(encrypt(PLAIN, [key()]).manifest, [key()]).error.code, "already_encrypted");
});

test("an encrypted vault is planned plaintext, with the guard that goes with it", () => {
  const encrypted = encrypt(PLAIN, [key()]);
  const plan = JSON.parse(wasm.planVaultDecryption(encrypted.manifest));
  assert.equal(plan.ok, true);
  assert.equal(JSON.parse(plan.manifest).encryption, null);
  assert.deepEqual(JSON.parse(plan.manifest)["x-future"], { a: 1 });
  assert.equal(plan.guard, encrypted.files.find((f) => f.path === ".gitignore").contents);
});
