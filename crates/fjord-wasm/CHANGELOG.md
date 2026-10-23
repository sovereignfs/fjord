# Changelog

`fjord-wasm` is built into the web client and is not released on its own, so there are no versions here; what
changes is recorded under Unreleased and in the web client's notes when it ships.

## [Unreleased]

### Added

- **`fjord-core`'s pure subset for WebAssembly** (ROADMAP P4): vault discovery from a tree listing, manifests,
  the path rules, documents and their frontmatter, and identifiers and timestamps from a clock and random
  source the caller supplies. Runs in Node and in a browser. Held, by a JavaScript suite over every
  conformance fixture, to what the CLI's filesystem walk says. 499,598 bytes, 214,928 gzipped.
