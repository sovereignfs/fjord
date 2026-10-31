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
| `quickNoteName(text, existing, year, month, day, hour, minute)`, `titleFromText(text)`, `freeName(stem, extension, existing)` | The name of a new file (`fjord_core::naming`, the one every client uses): from the first line of its text with the Markdown that makes a line something else than a title stripped, cut at 60 characters, else from the writer's local date and time (`2026-10-22 1430`), and numbered (`Plan 2.md`) past what the folder already has, case aside. A document is named from its title with `titleFromText` and `freeName(stem, ".fj.md", …)`. The names are a valid component (spec §5). |
| `withTitle(text, title)` | A document's text with its `title` set (trimmed), or taken away if it is empty, every other key staying in its place (spec §8.2; `fjord_core::doc::with_title`). Only the header is rewritten; what follows it is as it was. A client that keeps the header apart passes the header alone and gets it back. `undefined` for a text with no header, or a broken one. `impliedTitle` now strips the whole `.fj.md` from a document's name. |
| `mergeTexts(base, ours, theirs, oursLabel, theirsLabel)` | Three-way merge of two edits of one text, by lines (`fjord_core::merge::merge3`, the merge the CLI's `sync` uses). Answers `{clean, conflicts, text}`: the merged text when clean, else the text with each conflict between `<<<<<<<`, `=======` and `>>>>>>>` lines, so neither side is dropped. A label is made safe for a marker line. Nothing is an error. |
| `planSetup(options, existing, nowMs, random)`, `freeVaultName(preferred, existing)` | What to add to a repository that is **not** a Fjord repository so that it is one: a `fjord.json` and one plaintext vault, and nothing else but the one line spec §9 requires of `.gitattributes`. Nothing is changed or removed; the time and 80 random bytes are the caller's, so the same call gives the same answer. A finding (already a Fjord repository, a vault name that is taken or cannot be one) is data. Held to `tests/fixtures/setup.json`. |
| `newUlid(ms, random)`, `isUlid`, `isRfc3339Utc`, `rfc3339FromUnix`, `formatVersion` | Identifiers and timestamps from a **clock and random source the caller supplies** (`Date.now()`, `crypto.getRandomValues`): the module has none of its own (the system clock panics on `wasm32-unknown-unknown`). |
| `generateIdentity()`, `identityRecipient(identity)`, `checkRecipient(text)` | An X25519 identity as its `AGE-SECRET-KEY-1…` line **as bytes** (so the page can `fill(0)` it), the `age1…` key that goes with an identity or an identity file's text, and why a recipient line cannot be used (a secret key given as one, a typo, an SSH or passphrase recipient), or `undefined`. |
| `encrypt(plaintext, recipients, armor)`, `decrypt(ciphertext, identity)`, `isWellFormed(bytes)` | `age` over bytes (`fjord_core::crypto`): to every recipient of a recipients file's text, never to nobody; a payload binary or armored, with an identity. `isWellFormed` reads the header only and needs no key. Checked against the real `age` binary both ways (`tests/js/crypto.test.mjs`). |
| `wrapContainer(name, contents)`, `unwrapContainer(archive)` | The single-entry `tar` container of an `id`-named vault (spec §6.4): `unwrapContainer` gives `{name, contents}` and refuses what the spec says to (more than one entry, a path in the name, anything but a regular file). |

Not here, on purpose: reading a directory (`verify`, `ls`) and the system clock. They need a real machine, and are
`fjord-core`'s `native` feature. This crate depends on `fjord-core` with `default-features = false` and the `crypto` feature
(`age`, `tar`): the module is about 960 KB, 390 KB gzipped (it was 550 and 230 before `age`), which the web client loads
only where it decrypts. Encryption draws its randomness through `getrandom`'s `js` source, the host's `crypto.getRandomValues`.

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
