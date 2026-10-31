# Fjord Web — Prerequisites in fjord

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## P1 Spec: `*.fj.md` names a document

**Status:** ✅ Done

One-sentence amendment to spec §8 (and §1.3): a Doc whose name ends in `.fj.md` is a *document*, any other a *note*; both remain Fjord Docs. A fixture for each.

**Accepts when:** `docs/specs/Fjord.spec.md` says it; `fjord verify` treats both as Docs; fixtures pass.

- **Done as:** spec §1.3 and the new §8.4; `doc::is_document_name`; the `documents/` fixture (a document and a note); `listing` tells them apart and `fjord-wasm` reports `document` and `note`.

## P2 CLI: create and list documents

**Status:** ✅ Done

`fjord new --document` writes `name.fj.md`; `ls` shows which is which.

**Accepts when:** Created file verifies; `ls --json` reports `kind`.

- **Done as:** `--document`, and `ls --json` gains `docKind` (`document` or `note`) beside the unchanged `kind: "doc"`, so nothing that reads it breaks; in an `id` vault the kind is read from the name inside the container.

## P3 `fjord-core`: vault discovery from a listing

**Status:** ✅ Done

A pure function from a list of paths (and the manifests' bytes) to vaults and classified files, so a client with no filesystem can use it. The CLI's walk calls the same function.

**Accepts when:** Same results as the filesystem walk over every fixture.

- **Done as:** `fjord_core::listing`, and the walk now asks it; held to a recording of what the walk said before (`tests/fixtures/discovery.json`) for the pure function, the CLI's API and `verify`.

## P4 `fjord-core` to WebAssembly, pure subset

**Status:** ✅ Done

A `fjord-wasm` crate (`wasm-bindgen`) exposing manifests, vault discovery (P3), path rules, frontmatter parse/preserve/promote and new-document headers. Time and randomness injected (the system clock panics on `wasm32-unknown-unknown`); the filesystem walker and `tempfile` excluded from the build. Runs in Node and the browser.

**Accepts when:** A JS test suite runs the conformance fixtures through the WASM build and gets the CLI's answers; bundle size recorded.

- **Done as:** `crates/fjord-wasm` (its own workspace), 77 JavaScript tests over every fixture held to `tests/fixtures/discovery.json`, and the page-load smoke test in a browser; 499,598 bytes, 214,928 gzipped. The WASM package is consumed by the web client from 1a.11.

## P5 Component scaffolding

**Status:** ✅ Done

`clients/web`, a placeholder Next.js app with its own lockfile, `README.md`, `CHANGELOG.md`, `LICENSE` (AGPL-3.0-or-later) and `CLAUDE.md`; `web-ci.yml` (a `changes` job like `ci.yml`'s; type-check and build; the tests on three legs, an sqld container, a `file:` database and PostgreSQL, ready for 1a.0); `scripts/release/web.sh` and `web-release.yml`; root layout tables updated. `packages/fjord-editor` is **not** created here: it starts with 1b.1, when its licence is decided (§19 #4).

**Accepts when:** CI runs only for web changes; a placeholder build passes; the release component dry-runs.

## P6 `fjord-core`: scaffold a repository as data

**Status:** ✅ Done

`scaffold::plan` and `vault_files` already build the files `fjord init` writes as a list of paths and contents; they sit behind `native` only because `write` shares the module. Make that part pure (the ids and the time supplied by the caller), export it through `fjord-wasm`, and have `fjord init` write the same files through it. For a repository that is somebody's already, the setup is smaller than `fjord init`'s files: a `fjord.json`, one plaintext vault, and spec §9's merge guard in `.gitattributes` only where it is missing (no `README.md`, `.gitignore` or line-ending rule, which would clash with what is there).

**Accepts when:** A repository that has had the setup applied passes `fjord verify`, and one that has not does not; nothing that was there is changed but a line appended to `.gitattributes`; the vault is built by the same function as `fjord init`'s; the WebAssembly build gives the same answers, held by a recorded file (`tests/fixtures/setup.json`).

- **Done as:** `scaffold::{Origin, plan_with, plan_setup, free_vault_name, has_merge_guard}` in the pure subset, and `planSetup` and `freeVaultName` in `fjord-wasm`; tested natively, without the `native` feature, and from JavaScript.
