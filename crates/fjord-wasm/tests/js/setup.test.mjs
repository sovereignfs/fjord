// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Setting up a repository that is not a Fjord repository (ROADMAP 1a.10, P6): the built module must answer
// what `fjord-core` answers, which `tests/fixtures/setup.json` records, case by case.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixtures, wasm } from "./helpers.mjs";

const cases = JSON.parse(readFileSync(join(fixtures, "setup.json"), "utf8"));
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((pair) => parseInt(pair, 16)));
const plan = (c) => JSON.parse(wasm.planSetup(JSON.stringify(c.options), JSON.stringify(c.existing), c.nowMs, bytes(c.randomHex)));

test("the recorded cases are there to be held to", () => {
  assert.ok(cases.length >= 8, `${cases.length} cases`);
  assert.ok(cases.some((c) => c.expected.ok) && cases.some((c) => !c.expected.ok));
});

for (const c of cases) {
  test(`setup: ${c.name}`, () => {
    assert.deepEqual(plan(c), c.expected);
  });
}

test("a setup is pure: the same call gives the same answer, other randomness gives other identifiers", () => {
  const [first, second] = cases;
  assert.deepEqual(plan(first), plan(first));
  assert.notEqual(plan(first).repositoryId, plan(second).repositoryId);
});

test("a setup adds only files that are new, except a line at the end of .gitattributes", () => {
  for (const c of cases.filter((c) => c.expected.ok)) {
    for (const file of c.expected.files) {
      if (file.change === "create") {
        assert.ok(!c.existing.paths.includes(file.path), `${c.name}: ${file.path} is already there`);
      } else {
        assert.equal(file.path, ".gitattributes");
        assert.ok(file.contents.startsWith(c.existing.gitattributes), c.name);
      }
    }
  }
});

test("the identifiers and the time it writes are valid", () => {
  const made = plan(cases[0]);
  assert.ok(wasm.isUlid(made.repositoryId) && wasm.isUlid(made.vaultId));
  assert.ok(wasm.isRfc3339Utc(made.createdAt));
  const manifest = JSON.parse(wasm.describeRepositoryManifest(made.files.find((f) => f.path === "fjord.json").contents));
  assert.equal(manifest.ok, true);
  assert.deepEqual(manifest.vaults, [{ path: "Public", id: made.vaultId }]);
});

test("a malformed call is thrown, and a finding about the repository is data", () => {
  const options = JSON.stringify({ repositoryName: "r", vault: "V", generator: "g" });
  const existing = JSON.stringify({ paths: [], gitattributes: null });
  assert.equal(JSON.parse(wasm.planSetup(options, existing, 1e12, new Uint8Array(80))).ok, true);
  assert.throws(() => wasm.planSetup("nope", existing, 1e12, new Uint8Array(80)));
  assert.throws(() => wasm.planSetup(options, existing, 1e12, new Uint8Array(79)));
  assert.throws(() => wasm.planSetup(options, existing, -1, new Uint8Array(80)));
  assert.throws(() => wasm.planSetup(options, '{"paths":[1]}', 1e12, new Uint8Array(80)));
  assert.equal(JSON.parse(wasm.planSetup(options, JSON.stringify({ paths: ["fjord.json"] }), 1e12, new Uint8Array(80))).error.code, "already_fjord");
});

test("a free vault name is numbered after what is at the root", () => {
  assert.equal(wasm.freeVaultName("Public", JSON.stringify({ paths: ["README.md"] })), "Public");
  assert.equal(wasm.freeVaultName("Public", JSON.stringify({ paths: ["public/a.md"] })), "Public 2");
  assert.throws(() => wasm.freeVaultName("Public", "nope"));
});
