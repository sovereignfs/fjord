// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const pkg = join(here, "..", "..", "pkg");
export const fixtures = join(here, "..", "..", "..", "..", "tests", "fixtures");

/** The module built for Node (`./build.sh`). */
export const wasm = createRequire(import.meta.url)(join(pkg, "node", "fjord_wasm.js"));

/** What the filesystem walk said about every committed fixture, recorded before discovery was shared (P3). */
export const golden = JSON.parse(readFileSync(join(fixtures, "discovery.json"), "utf8"));

/** Every file under `root` as a tree listing would give it: no directories, links as files, nothing read. */
export function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push({ path: relative(root, path).split("\\").join("/"), size: statSize(path) });
    }
  };
  walk(root);
  return out;
}

import { lstatSync } from "node:fs";
const statSize = (path) => lstatSync(path).size;

/** The vault manifests a client would fetch, as `{ path: text }`. */
export function manifestsFor(root, files) {
  const paths = JSON.parse(wasm.manifestPaths(JSON.stringify(files)));
  const out = {};
  for (const path of paths) if (existsSync(join(root, path))) out[path] = readFileSync(join(root, path), "utf8");
  return out;
}
