# Changelog

`fjord-wasm` is built into the web client and is not released on its own, so there are no versions here; what
changes is recorded under Unreleased and in the web client's notes when it ships.

## [Unreleased]

### Added

- **Repository kinds** (ROADMAP web P12, spec §3.1): `describeRepositoryManifest` reports the `kind` to present a repository as, its
  `declaredKind` and `ssgEngine`; `planKind` plans a new repository of a kind from `fjord_core::scaffold::plan_kind_with`, as
  `fjord init --kind` does; `journalEntryPath`, `journalSlug`, `entryDateFromUnix` and `isEntryDate` date and file a journal entry at the
  writer's offset; `foldTag`, `sameTag` and `tagIsUnder` compare tags (spec §8.1). The fixture suite checks every fixture's kind against
  what `fjord verify` recorded. 1,385,572 bytes, 522,115 gzipped (from 1,321,125 and 499,067).
- **`sitePostPath`, `siteNewPost`, `siteTagProblem`** (ROADMAP web 3c.2): where a site's post goes by its engine's rules, its text, and Jekyll's refusal of a tag with a space; `journalEntry` also says whether an entry is a `draft`. 1,422,180 bytes, 535,025 gzipped.
- **`newEntry`, `withDate`, `withTags`, `journalEntry`** (ROADMAP web 3b): a journal entry's text, a header's `date` and `tags` set with
  nothing else changed, and what a timeline shows of an entry, placed by its `date`, path or `created`. 1,418,361 bytes, 533,420 gzipped.
- **`planSetupKind`, `withKind`, `kindRule`** (ROADMAP web 3a.3): set a repository that is not a Fjord repository up as a journal or a site, change a
  repository's kind with every other field of `fjord.json` kept, and say which rule of spec §3.1 a kind would break. 1,406,509 bytes, 529,961 gzipped.
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
