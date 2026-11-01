# Changelog

`fjord-wasm` is built into the web client and is not released on its own, so there are no versions here; what
changes is recorded under Unreleased and in the web client's notes when it ships.

## [Unreleased]

### Added

- **`planVault`** (ROADMAP 2d.1): `fjord_core::scaffold::plan_vault`, the files to add for a new vault, plaintext or encrypted, from
  `fjord.json`, the repository's paths and its `.gitattributes`, with the time and randomness the caller supplies. The CLI's `fjord vault add`
  writes from the same planner. Held, by Rust and by the JavaScript suite, to `tests/fixtures/vault.json`. 1,321,125 bytes, 499,067 gzipped.
- **`withTitle`** (ROADMAP 1b.5): `fjord_core::doc::with_title`, a document's text with its `title` set or taken away, every other
  key kept in its place, for the web client's Document properties panel. `impliedTitle` now strips the whole `.fj.md` from a
  document's name.
- **`quickNoteName`, `titleFromText`, `freeName`** (ROADMAP 1b.7): `fjord_core::naming`, so a note or a document the web client creates is
  named exactly as one made on a phone or by the CLI. 549,291 bytes, 231,680 gzipped.
- **`mergeTexts`** (ROADMAP 1b.10): `fjord_core::merge::merge3` for the web client's upstream-change handling, so the web
  merges a note exactly as the CLI does: `{clean, conflicts, text}`, with both sides kept between conflict markers when
  the edits overlap. 539,432 bytes, 228,126 gzipped.
- **`planSetup` and `freeVaultName`** (ROADMAP P6): what to add to a repository that is not a Fjord repository so
  that it is one, from the repository's paths and the text of its `.gitattributes`, with the time and the
  randomness the caller supplies. Held, by Rust and by the JavaScript suite, to a recorded file of cases
  (`tests/fixtures/setup.json`). 526,402 bytes, 223,959 gzipped.
- **`fjord-core`'s pure subset for WebAssembly** (ROADMAP P4): vault discovery from a tree listing, manifests,
  the path rules, documents and their frontmatter, and identifiers and timestamps from a clock and random
  source the caller supplies. Runs in Node and in a browser. Held, by a JavaScript suite over every
  conformance fixture, to what the CLI's filesystem walk says. 499,598 bytes, 214,928 gzipped.
