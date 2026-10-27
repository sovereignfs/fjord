# Changelog

`fjord-wasm` is built into the web client and is not released on its own, so there are no versions here; what
changes is recorded under Unreleased and in the web client's notes when it ships.

## [Unreleased]

### Added

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
