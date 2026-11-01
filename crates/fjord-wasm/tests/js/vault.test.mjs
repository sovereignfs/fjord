// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Adding a vault to a Fjord repository (ROADMAP 2d.1): the built module must answer what `fjord-core` answers, which
// `tests/fixtures/vault.json` records, case by case. The CLI's `fjord vault add` is the same planner.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtures, wasm } from "./helpers.mjs";

const cases = JSON.parse(readFileSync(join(fixtures, "vault.json"), "utf8"));
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((pair) => parseInt(pair, 16)));
const plan = (c) => JSON.parse(wasm.planVault(JSON.stringify(c.options), c.manifest, JSON.stringify(c.existing), c.nowMs, bytes(c.randomHex)));

test("the recorded cases are there to be held to", () => {
  assert.ok(cases.length >= 12, `${cases.length} cases`);
  assert.ok(cases.some((c) => c.expected.ok) && cases.some((c) => !c.expected.ok));
});

for (const c of cases) {
  test(`vault: ${c.name}`, () => {
    assert.deepEqual(plan(c), c.expected);
  });
}

test("a plan is pure: the same call gives the same answer, other randomness another identifier", () => {
  const [first] = cases;
  assert.deepEqual(plan(first), plan(first));
  const other = { ...first, randomHex: "ff".repeat(16) };
  assert.notEqual(plan(first).vaultId, plan(other).vaultId);
});

test("a vault adds only files that are new, and rewrites fjord.json and at most .gitattributes", () => {
  for (const c of cases.filter((c) => c.expected.ok)) {
    for (const file of c.expected.files) {
      if (file.change === "create") {
        assert.ok(!c.existing.paths.includes(file.path), `${c.name}: ${file.path} is already there`);
      } else {
        assert.ok([".gitattributes", "fjord.json"].includes(file.path), `${c.name}: ${file.path}`);
      }
    }
    const manifest = JSON.parse(c.expected.files.find((f) => f.path === "fjord.json").contents);
    assert.deepEqual(manifest.vaults.at(-1).id, c.expected.vaultId, c.name);
    for (const [key, value] of Object.entries(JSON.parse(c.manifest))) {
      if (key !== "vaults") assert.deepEqual(manifest[key], value, `${c.name}: ${key} was lost`);
    }
  }
});

test("the identifier and the time it writes are valid", () => {
  const made = plan(cases[0]);
  assert.ok(wasm.isUlid(made.vaultId) && wasm.isRfc3339Utc(made.createdAt));
});

test("a secret key given as a recipient is refused and never echoed", () => {
  const secret = Buffer.from(wasm.generateIdentity()).toString("utf8").trim();
  const options = JSON.stringify({ name: "Secret", encrypted: true, recipients: [secret] });
  const answer = JSON.parse(wasm.planVault(options, '{"fjord":1}', '{"paths":["fjord.json"],"gitattributes":null}', 1e12, new Uint8Array(16)));
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, "bad_recipient");
  assert.ok(!JSON.stringify(answer).includes(secret));
});

test("a malformed call is thrown, and a finding about the repository is data", () => {
  const existing = '{"paths":["fjord.json"],"gitattributes":null}';
  assert.equal(JSON.parse(wasm.planVault('{"name":"V"}', '{"fjord":1}', existing, 1e12, new Uint8Array(16))).ok, true);
  assert.throws(() => wasm.planVault("nope", '{"fjord":1}', existing, 1e12, new Uint8Array(16)));
  assert.throws(() => wasm.planVault('{"name":"V"}', '{"fjord":1}', existing, 1e12, new Uint8Array(15)));
  assert.throws(() => wasm.planVault('{"name":"V","recipients":"age1"}', '{"fjord":1}', existing, 1e12, new Uint8Array(16)));
  assert.equal(JSON.parse(wasm.planVault('{"name":"V"}', "nope", existing, 1e12, new Uint8Array(16))).error.code, "manifest_unusable");
});
