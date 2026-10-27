// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The built package, as a client would take it: its entry point loads in plain Node with nothing but React next to it,
// exports what the interface says, ships its stylesheet and its type declarations, and mentions no client's design system.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const module = await import(new URL("../dist/index.js", import.meta.url));
assert.deepEqual(Object.keys(module).sort(), ["ANCHOR_CONTEXT", "DocumentEditor", "NoteEditor", "textQuoteAnchor", "themeTokens"]);
assert.equal(typeof module.DocumentEditor, "object", "a component made with forwardRef");
assert.equal(typeof module.textQuoteAnchor, "function");

for (const file of ["dist/index.d.ts", "dist/styles.css", "dist/styles.d.ts"]) assert.ok(statSync(file).size > 0, `${file} is missing`);

// The stylesheet holds MDXEditor's, and it is a guest in other people's pages: it sets nothing for the whole page, and the
// library's licence travels with it.
const stylesheet = readFileSync("dist/styles.css", "utf8");
assert.ok(!/(^|[\s,{}])(:root|html|body)\s*[,{]/.test(stylesheet.replace(/\/\*[\s\S]*?\*\//g, "")), "the stylesheet has a rule for the whole page");
assert.ok(stylesheet.includes("MDXEditor") && stylesheet.includes("Permission is hereby granted"), "MDXEditor's licence does not travel with its stylesheet");
assert.ok(stylesheet.includes(".fe-rich"), "the stylesheet does not dress the visual editor");

// The notices of what it is built on travel with it: the visual editor's library and its engine are in them, with their licence texts.
const notices = readFileSync("dist/THIRD_PARTY_NOTICES.txt", "utf8");
for (const name of ["@mdxeditor/editor", "lexical", "@codemirror/view", "mdast-util-from-markdown"]) assert.ok(notices.includes(`${name} `), `${name} is not in the notices`);
assert.ok(notices.includes("Permission is hereby granted"), "the notices carry no licence text");
assert.ok(/^\d+ packages\.$/m.test(notices) && Number(/^(\d+) packages\.$/m.exec(notices)[1]) > 100, "the notices do not cover the closure of the dependencies");

const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
for (const file of walk("dist")) assert.ok(!readFileSync(file, "utf8").includes("@sovereignfs"), `${file} mentions a client's design system`);
assert.ok(!walk("dist").some((file) => /\.test\./.test(file)), "the build carries its tests");

console.log(`fjord-editor builds: ${walk("dist").length} files in dist`);
