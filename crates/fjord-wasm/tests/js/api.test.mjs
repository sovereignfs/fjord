// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The module's functions, from JavaScript: what each takes, what it returns, and what it refuses.

import assert from "node:assert/strict";
import { test } from "node:test";
import { wasm } from "./helpers.mjs";

const ID = "01j8z3k9t2v4w5x6y7z8a9b0c1";
const OTHER = "01j8z3k9t2v4w5x6y7z8a9b0c2";

test("it implements format version 1", () => {
  assert.equal(wasm.formatVersion(), 1);
});

test("path rules name the codes a name breaks", () => {
  const codes = (name) => JSON.parse(wasm.checkName(name));
  assert.deepEqual(codes("notes.md"), []);
  assert.deepEqual(codes("a:b.md"), ["E501"]);
  assert.deepEqual(codes("trailing "), ["E502"]);
  assert.deepEqual(codes("CON.md"), ["E503"]);
  assert.deepEqual(JSON.parse(wasm.caseCollisions(JSON.stringify(["Notes.md", "notes.md", "x.md"]))), [["Notes.md", "notes.md"]]);
  assert.equal(wasm.toNfc("e\u0301"), "\u00e9");
  assert.equal(wasm.checkManifestPath("../etc"), "E507");
  assert.equal(wasm.checkManifestPath("/abs"), "E507");
  assert.equal(wasm.checkManifestPath("keys/recipients.txt"), undefined);
});

test("a manifest is read, what is wrong with it is data, and unknown fields survive", () => {
  const repo = JSON.parse(
    wasm.describeRepositoryManifest(`{"fjord":1,"id":"${ID}","name":"R","createdAt":"2026-01-01T00:00:00Z","vaults":[{"path":"Notes","id":"x"}],"x-future":{"k":[1,2]}}`),
  );
  assert.equal(repo.ok, true);
  assert.deepEqual(repo.vaults, [{ path: "Notes", id: "x" }]);
  assert.deepEqual(repo.raw["x-future"], { k: [1, 2] });
  for (const bad of ["", "[1]", "not json", "\ufeff{}"]) {
    const result = JSON.parse(wasm.describeRepositoryManifest(bad));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(typeof result.error, "string");
  }
  const vault = JSON.parse(wasm.describeVaultManifest('{"encryption":{"tool":"age","recipients":"r.txt","suffix":".age","container":"none","armor":false}}'));
  assert.equal(vault.encrypted, true);
  assert.equal(vault.recipients, "r.txt");
});

test("a document is read with every key in order, and what is not one is said so", () => {
  const read = JSON.parse(wasm.parseDocument(`---\nid: ${ID}\ntitle: Plan\nfuture: {a: 1}\n---\n\n# Plan\n`));
  assert.equal(read.status, "present");
  assert.equal(read.docId, ID);
  assert.deepEqual(Object.keys(read.frontmatter), ["id", "title", "future"]);
  assert.deepEqual(read.frontmatter.future, { a: 1 });
  for (const [text, status] of [
    ["# just text\n", "absent"],
    ["\n---\nid: x\n---\n", "notAtStart"],
    ["---\nid: x\n", "unterminated"],
    ["---\n- a\n---\n", "notAMapping"],
    ["---\nid: [\n---\n", "unparseable"],
  ]) {
    assert.equal(JSON.parse(wasm.parseDocument(text)).status, status, JSON.stringify(text));
  }
  assert.equal(JSON.parse(wasm.parseDocument("---\nid: nope\n---\n")).docId, null);
});

test("a new document reads back, whatever the title", () => {
  const title = 'Q4: plan "final" - v2';
  const made = wasm.newDocument(ID, title, "2026-01-01T00:00:00Z");
  const read = JSON.parse(wasm.parseDocument(made));
  assert.equal(read.docId, ID);
  assert.equal(read.title, title);
});

test("promoting keeps every key and its order, and a fresh id changes only the id", () => {
  const promoted = wasm.promoteDocument("---\ntitle: Mine\nzzz: kept\naaa: also\n---\nbody\n", ID, "2026-01-01T00:00:00Z", "Ignored");
  const read = JSON.parse(wasm.parseDocument(promoted));
  assert.deepEqual(Object.keys(read.frontmatter), ["title", "zzz", "aaa", "id", "created"]);
  assert.equal(read.title, "Mine");
  assert.ok(promoted.endsWith("body\n"));
  assert.equal(JSON.parse(wasm.parseDocument(wasm.withFreshId(promoted, OTHER))).docId, OTHER);
  assert.equal(wasm.withFreshId("no frontmatter", OTHER), undefined);
  assert.equal(wasm.promoteDocument("---\nid: [\n---\n", ID, "c", "t"), undefined);
  assert.equal(wasm.impliedTitle("intro\n# The Heading\n", "x.md"), "The Heading");
});

test("identifiers and timestamps come from what the caller supplies", () => {
  const random = Uint8Array.from({ length: 10 }, (_, i) => i * 7);
  const id = wasm.newUlid(1_700_000_000_000, random);
  assert.ok(wasm.isUlid(id), id);
  assert.equal(id, wasm.newUlid(1_700_000_000_000, random), "the same time and randomness make the same identifier");
  assert.notEqual(id, wasm.newUlid(1_700_000_000_001, random));
  assert.ok(wasm.newUlid(1, new Uint8Array(10)) < wasm.newUlid(2, new Uint8Array(10)), "identifiers sort by time");
  assert.throws(() => wasm.newUlid(-1, random), /not negative/);
  assert.throws(() => wasm.newUlid(NaN, random), /not negative/);
  assert.throws(() => wasm.newUlid(1, new Uint8Array(9)), /ten random bytes/);
  assert.equal(wasm.isUlid(id.toUpperCase()), false);

  assert.equal(wasm.rfc3339FromUnix(1_700_000_000), "2023-11-14T22:13:20Z");
  assert.equal(wasm.rfc3339FromUnix(NaN), undefined);
  assert.equal(wasm.isRfc3339Utc("2026-01-01T00:00:00Z"), true);
  assert.equal(wasm.isRfc3339Utc("2026-01-01T00:00:00+02:00"), false);
});

test("a malformed call throws, and says what was wrong", () => {
  assert.throws(() => wasm.discover("nope", "{}"), /not JSON/);
  assert.throws(() => wasm.discover("{}", "{}"), /array/);
  assert.throws(() => wasm.discover("[]", '{"a":1}'), /text/);
  assert.throws(() => wasm.manifestPaths("nope"), /not JSON/);
});

test("it has no filesystem, no clock and no random source of its own to fall back on", () => {
  // What the module offers is what the pure subset has; nothing here reads a disk or makes a time up.
  const offered = Object.keys(wasm).filter((name) => typeof wasm[name] === "function").sort();
  for (const forbidden of ["now", "readDirectory", "verify", "encrypt", "decrypt", "newUlidNow"]) {
    assert.ok(!offered.includes(forbidden), forbidden);
  }
  assert.ok(offered.includes("discover") && offered.includes("newUlid"));
});

test("a document's title is set, and taken away, and nothing else of its header or its body changes", () => {
  const text = "---\nzeta: 1\nid: 01jagc4k7pt8y3wqnmzv5xrb7h\ntitle: Old\nx-future:\n  - kept\n---\r\n\r\n# Body\r\n";
  const set = wasm.withTitle(text, "  Plan: the sequel  ");
  const parsed = JSON.parse(wasm.parseDocument(set));
  assert.equal(parsed.title, "Plan: the sequel");
  assert.equal(parsed.docId, "01jagc4k7pt8y3wqnmzv5xrb7h");
  assert.deepEqual(Object.keys(parsed.frontmatter), ["zeta", "id", "title", "x-future"]);
  assert.deepEqual(parsed.frontmatter["x-future"], ["kept"]);
  assert.ok(set.endsWith("---\n\r\n# Body\r\n"), "the body is as it was");
  assert.equal(JSON.parse(wasm.parseDocument(wasm.withTitle(text, ""))).title, null);
  assert.equal(wasm.withTitle("no header\n", "T"), undefined);
  assert.equal(wasm.withTitle("---\nnever closed\n", "T"), undefined);
  assert.equal(wasm.impliedTitle("body\n", "Q4 plan.fj.md"), "Q4 plan");
});

test("two edits of one text merge by lines: apart cleanly, together with both sides kept between markers", () => {
  const merge = (...args) => JSON.parse(wasm.mergeTexts(...args));
  assert.deepEqual(merge("one\ntwo\nthree\nfour\nfive\n", "ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n", "mine", "theirs"), {
    clean: true,
    conflicts: 0,
    text: "ONE\ntwo\nthree\nfour\nFIVE\n",
  });
  const conflicted = merge("a\nsame\nz\n", "a\nmine\nz\n", "a\ntheirs\nz\n", "Your changes", "In the repository");
  assert.equal(conflicted.clean, false);
  assert.equal(conflicted.conflicts, 1);
  assert.equal(conflicted.text, "a\n<<<<<<< Your changes\nmine\n=======\ntheirs\n>>>>>>> In the repository\nz\n");
  // A label cannot break out of its marker line, and non-ASCII text goes through whole.
  assert.match(merge("x\n", "m\n", "t\n", "a\nb", "é\u0007").text, /^<<<<<<< a b\nm\n=======\nt\n>>>>>>> é\n$/);
  assert.equal(merge("日本\n", "日本語\n", "日本\n", "m", "t").text, "日本語\n");
});

test("a new file is named from its first line, then by the time, and numbered past what the folder has", () => {
  const note = (text, existing = []) => wasm.quickNoteName(text, JSON.stringify(existing), 2026, 10, 22, 14, 30);
  assert.equal(note("# Meeting notes\n\nbody"), "Meeting notes.md");
  assert.equal(note("- [ ] Buy milk"), "Buy milk.md");
  assert.equal(note(""), "2026-10-22 1430.md");
  assert.equal(note("a/b: c?"), "a b c.md");
  assert.equal(note("CON"), "Note CON.md");
  assert.equal(note("日本語のノート"), "日本語のノート.md");
  assert.equal(note("Plan", ["Plan.md", "PLAN 2.md", "Archive"]), "Plan 3.md");
  assert.throws(() => wasm.quickNoteName("x", "{}", 2026, 1, 1, 0, 0));

  assert.equal(wasm.titleFromText("# Q4 plan\nmore"), "Q4 plan");
  assert.equal(wasm.titleFromText("***"), undefined);
  assert.equal(wasm.freeName("Q4 plan", ".fj.md", JSON.stringify(["q4 plan.fj.md"])), "Q4 plan 2.fj.md");
  assert.equal(wasm.freeName("Q4 plan", ".fj.md", JSON.stringify(["Q4 plan.md"])), "Q4 plan.fj.md");
  assert.throws(() => wasm.freeName("x", ".md", "nope"));
});
