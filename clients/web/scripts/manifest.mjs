// What an image is built with from sovereign.manifest.json: its label and its port (DESIGN.md §17).
//
//   node scripts/manifest.mjs check                         is the file a manifest this script can build from?
//   node scripts/manifest.mjs label                         the value of the image label
//   node scripts/manifest.mjs docker-args [--format F]      the arguments to build with: the label and PORT.
//                                                           F is shell (default; for eval) or github (for $GITHUB_OUTPUT)
//
// It does what `sovereign-manifest` of @sovereignfs/manifest does, with the same commands and output, and nothing else: that package is
// not published yet, and this app takes no dependency that is not on npm. When it is, this file is replaced by it
// (`npx sovereign-manifest docker-args`) and nothing else changes. The file is checked against the manifest's JSON Schema by
// src/sovereign-manifest.test.ts, so what this script does not check is checked in CI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "io.github.sovereignfs.app-manifest";
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "sovereign.manifest.json");

const [command, ...rest] = process.argv.slice(2);
const usage = "Usage: node scripts/manifest.mjs check | label | docker-args [--format shell|github]";
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

if (!["check", "label", "docker-args"].includes(command ?? "")) fail(usage, 2);
let format = "shell";
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === "--format" && command === "docker-args") {
    format = rest[(index += 1)] ?? "";
    if (format !== "shell" && format !== "github") fail(`--format is shell or github.\n${usage}`, 2);
  } else {
    fail(`Unknown argument: ${rest[index]}\n${usage}`, 2);
  }
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`${file} cannot be read as JSON: ${error instanceof Error ? error.message : "unknown error"}`);
}
const problems = [];
if (manifest?.manifest !== 2) problems.push("manifest must be 2");
if (typeof manifest?.prefix !== "string" || !/^[a-z][a-z0-9]*$/.test(manifest.prefix)) problems.push("prefix must be lower case letters and digits");
if (!Number.isInteger(manifest?.port) || manifest.port < 1 || manifest.port > 65535) problems.push("port must be a port number");
if (problems.length > 0) fail(`${file} is not a manifest:\n${problems.map((p) => `  ${p}`).join("\n")}`);

// The value of the label is the manifest with its white space removed.
const label = `${LABEL}=${JSON.stringify(manifest)}`;
const port = `PORT=${manifest.port}`;
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

if (command === "check") console.log(`${file} is a manifest ${manifest.manifest}.`);
else if (command === "label") console.log(JSON.stringify(manifest));
else if (format === "github") console.log(`labels=${label}\nbuild-args=${port}`);
else console.log(`--label ${quote(label)} --build-arg ${quote(port)}`);
