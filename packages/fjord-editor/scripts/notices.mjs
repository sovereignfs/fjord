// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The notices of what the package is built on, in one file that travels with it (`dist/THIRD_PARTY_NOTICES.txt`).
//
// The package's own code is MPL-2.0; what it depends on at run time is, all of it, permissive (MIT, and a few BSD, ISC,
// 0BSD and Python-2.0), and those licences ask that their notice accompany copies. A client bundles these packages into its
// own, where nothing would carry the notice, so the package says what it is made of: every package in the closure of its
// `dependencies` (never its development tools), with its licence and the text it shipped.
//
// It is read from what is installed, not from a list kept by hand, so a new dependency is in it without anyone remembering.
// A licence the build does not recognise as permissive stops the build: that is a decision for a person (and the licence
// test in `src/package.test.ts` is the same decision, for the direct dependencies).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "Python-2.0", "BlueOak-1.0.0", "CC0-1.0", "Unlicense"]);

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const seen = new Map();

/** The licence id of a package.json, which is a string, or in older packages an object or a list. */
function licenceOf(pkg) {
  const raw = pkg.license ?? pkg.licenses;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((entry) => entry.type ?? "").join(" OR ");
  return raw?.type ?? "";
}

/** `node_modules` directories from the package's own outward, as node would look for a dependency. */
function lookupDirectories(directory) {
  const parts = realpathSync(directory).split("/");
  const found = [];
  for (let i = parts.length - 1; i > 0; i--) if (parts[i] === "node_modules") found.push(parts.slice(0, i + 1).join("/"));
  return found;
}

function visit(directory) {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const text = readdirSync(directory)
    .filter((name) => /^(licen[sc]e|copying)(\.|$)/i.test(name))
    .sort()
    .map((name) => readFileSync(join(directory, name), "utf8").trim())[0];
  seen.set(key, { name: pkg.name, version: pkg.version, licence: licenceOf(pkg), text, homepage: pkg.homepage ?? pkg.repository?.url ?? "" });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    for (const modules of lookupDirectories(directory)) {
      const candidate = join(modules, dependency);
      if (existsSync(join(candidate, "package.json"))) {
        visit(realpathSync(candidate));
        break;
      }
    }
  }
}

for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(realpathSync(join("node_modules", dependency)));

const entries = [...seen.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
for (const entry of entries) {
  const ids = entry.licence.split(/\s+(?:OR|AND)\s+|[()]/).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => PERMISSIVE.has(id))) {
    throw new Error(`${entry.name}@${entry.version} is licensed "${entry.licence}", which the notices build does not know to be permissive: decide, then add it to PERMISSIVE`);
  }
}

const rule = "=".repeat(78);
const body = entries
  .map((entry) => `${rule}\n${entry.name} ${entry.version}\nLicence: ${entry.licence}${entry.homepage ? `\n${entry.homepage}` : ""}\n${rule}\n\n${entry.text ?? "(this package's licence text is not in the package; its licence is as named above)"}\n`)
  .join("\n");

mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/THIRD_PARTY_NOTICES.txt",
  `fjord-editor is MPL-2.0 (see LICENSE). It is built on the following packages, each under the licence shown, which asks that its notice accompany copies.\n${entries.length} packages.\n\n${body}`,
);
console.log(`notices: ${entries.length} packages`);
