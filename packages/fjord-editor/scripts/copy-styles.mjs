// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The package's one stylesheet goes next to the code it styles, because `tsc` emits code and not CSS.
//
// It is made of two: MDXEditor's, which the visual document editor needs to be usable (its toolbar, its dialogs, its table
// editor), and the package's own (`src/styles.css`), which dresses everything in the client's palette. MDXEditor's is a
// library's, in its own words, and does two things a package embedded in other people's pages must not: it defines its colour
// scales (`--blue-1` … `--slate-12`, and more) on `:root`, for the whole page, and it dresses itself in its own palette.
// So here it is taken in, with the first made local to the editor (the page's own variables are not touched) and the
// second left to `src/styles.css`, which sets the variables it reads from the package's custom properties.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

mkdirSync("dist", { recursive: true });

const require = createRequire(import.meta.url);
const vendorDirectory = dirname(require.resolve("@mdxeditor/editor/package.json"));
const vendor = readFileSync(join(vendorDirectory, "dist", "style.css"), "utf8");
const licence = readFileSync(join(vendorDirectory, "LICENSE"), "utf8");

/** `:root, .light, .light-theme` and its hashed twin: every place the library sets a variable for the whole page. */
const GLOBAL = /:root,\s*(?:\.light,\s*\.light-theme|\._light_\w+,\s*\._light-theme_\w+)/g;
const scoped = vendor.replace(GLOBAL, ".fe-rich");
if (/(^|[\s,{}])(:root|html|body)\s*[,{]/.test(scoped.replace(/\/\*[\s\S]*?\*\//g, ""))) {
  throw new Error("MDXEditor's stylesheet has a rule for the whole page that the build does not know how to scope: look at the new version's style.css");
}

const banner = `/*
 * fjord-editor's stylesheet: MDXEditor's, scoped to the editor (below, first), and the package's own (after it).
 *
 * MDXEditor (https://github.com/mdx-editor/editor) is MIT licensed:
 *
${licence
  .trim()
  .split("\n")
  .map((line) => ` * ${line}`.trimEnd())
  .join("\n")}
 */
`;

writeFileSync("dist/styles.css", `${banner}\n${scoped}\n\n${readFileSync("src/styles.css", "utf8")}`);

// So that `import "fjord-editor/styles.css"` type-checks in a project that does not already allow stylesheet imports.
writeFileSync("dist/styles.d.ts", "// A stylesheet, imported for its effect.\nexport {};\n");
