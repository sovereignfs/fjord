# fjord-wasm

[`fjord-core`](../fjord-core)'s **pure subset** for WebAssembly: what a client with no filesystem needs to
read a repository's shape and work on its documents. It is what the web client (`clients/web`) runs in the
browser and on the server, so it never reimplements the format.

It is a library built into the web client, not something released on its own: it has no tag and no release
workflow, and `publish = false`. It is its own Cargo workspace, with its own lockfile, so `wasm-bindgen`'s
dependency tree stays out of the CLI's lockfile, its audit and its minimum Rust version (CI audits both).

## What it offers

Everything takes and returns strings, bytes and numbers; structured results are **JSON text** (`JSON.parse`
it). A finding about the input (a manifest that is not JSON, broken frontmatter) is data in the JSON; a
malformed *call* throws. [`src/api.rs`](src/api.rs) documents every shape.

| Function | What it does |
| --- | --- |
| `manifestPaths(files)`, `discover(files, manifests)` | Which directories are vaults, which vault manifests are where none may be, and what each file in a vault is by its name, from a tree listing and the text of a few manifests (spec §2, §4, §6.3). |
| `describeRepositoryManifest(text)`, `describeVaultManifest(text)` | A manifest, read: its fields, and the whole thing as written (`raw`), which a rewrite must preserve (§10.1). |
| `checkName`, `caseCollisions`, `toNfc`, `checkManifestPath` | The path rules (§5), by the codes they break (`E501`…). |
| `parseDocument`, `newDocument`, `withFreshId`, `promoteDocument`, `impliedTitle` | Frontmatter: read with every key in order, a new document's header, a fresh `id`, promoting a file to a Doc without losing unknown keys (§8). |
| `newUlid(ms, random)`, `isUlid`, `isRfc3339Utc`, `rfc3339FromUnix`, `formatVersion` | Identifiers and timestamps from a **clock and random source the caller supplies** (`Date.now()`, `crypto.getRandomValues`): the module has none of its own (the system clock panics on `wasm32-unknown-unknown`). |

Not here, on purpose: reading a directory (`verify`, `ls`), `age` encryption, `tar` containers. They need a
real machine, and are `fjord-core`'s `native` feature. This crate depends on it with
`default-features = false`.

## Build and test

Needs the `wasm32-unknown-unknown` target and the `wasm-bindgen` command line tool at the version this
crate's `Cargo.lock` names (the script says which, and refuses a different one):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version '=<the version in Cargo.lock>' --locked

./build.sh                          # pkg/node (CommonJS) and pkg/web (an ES module)
cargo test                          # the API, natively
node --test "tests/js/*.test.mjs"   # the module itself, from JavaScript (Node 20 or later)
```

The JavaScript suite runs the module over every conformance fixture (`tests/fixtures/`) given only a list of
paths and the text of a few manifests, and holds it to `tests/fixtures/discovery.json`, what the CLI's
filesystem walk said about each. It also checks the web build answers as the Node build does.

**In a browser:** serve this directory with any static server after `./build.sh`
(`python3 -m http.server --directory crates/fjord-wasm`), open `/tests/browser/index.html`, and read the
result. It loads the web build as a page does, with the page's own clock and `crypto.getRandomValues`.

## Size

`fjord_wasm_bg.wasm` is **499,598 bytes, 214,928 gzipped** (release, `opt-level = "z"`, LTO; `wasm-opt` is
not required and would take a little more off). The YAML parser, `time`, Unicode normalisation and
`serde_json` are most of it. CI records it on every run.
