# Changelog

All notable changes to `fjord-cli` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — with the caveat that the Fjord
repository format is still a **draft**, and breaking changes to it are
expected until it is declared stable. They are marked **breaking** below.

Each release's section is also its GitHub release notes: `dist` reads this
file when a release is cut. Add the section for a version here *before*
tagging it.

## [Unreleased]

### Added

- **Documents and notes** (spec §8.4, ROADMAP P1): a Fjord Doc whose file name ends in `.fj.md` is a *document*,
  any other a *note*. It is the same format (same frontmatter, same rules, same identifiers; a `.fj.md` file with no
  valid `id` is a vault file like any `.md`), told apart by name so a client can edit a long-form document
  differently from a note without reading the file. **Nothing changes for an existing repository**: every `.md`
  Doc written before is a note, and `fjord verify` counts both kinds as Docs, as it always counted any `.md`
  with an `id`. In `fjord-core`, `doc::is_document_name` and `doc::DOCUMENT_SUFFIX`, and
  `listing::FileKind::Markdown` is now `Document` and `Note`. A new fixture, `tests/fixtures/documents/`, holds one
  of each (`fjord new --document` and `ls` showing which is which are ROADMAP P2).

### Changed

- **`fjord-core` has a pure subset that compiles to WebAssembly** (ROADMAP P4). A new default feature, `native`,
  gates everything that needs a machine (the filesystem walk, `age`, `tar`); with `default-features = false` the
  crate is manifests, documents, the path rules, discovery from a listing, and identifiers and timestamps made
  from a clock and random source the caller supplies (`scalar::new_ulid_from`, `scalar::rfc3339_utc_from_unix`).
  The CLI and every command **behave as before**. A new crate, `crates/fjord-wasm`, wraps the subset for
  JavaScript (see its README); it is built into the web client and is not released with the CLI. Two unused
  dependencies of `fjord-core` (`ignore`, and `blake3` outside its tests) are gone from its library.
- **`fjord-core` can discover vaults from a list of paths** (`fjord_core::listing`), for clients that
  have no filesystem: which directories are vaults, which vault manifests are where the format does
  not allow one, and what each file in a vault is by its name (an encrypted payload, plaintext where
  there must be none, a Markdown file that may carry frontmatter, machinery). It is pure, so it
  compiles to WebAssembly (ROADMAP P3, the web client's file browser). The filesystem walk that
  `fjord verify`, `ls`, `grep` and the rest perform now asks the same function instead of restating
  the rules, and **behaves as before** on every fixture (held to a recording of what it said before:
  `tests/fixtures/discovery.json`). One difference at the edges: vaults whose directory names are
  prefixes of one another (`A` and `A-b`) are now always in directory order, where `verify` listed
  them in the order of their manifests' paths.

## [0.3.1] - 2026-10-21

**The tool behaves as before,** apart from the Unicode update below. What is new
is a way to install it: Homebrew.

### Added

- **Homebrew:** `brew install sovereignfs/tap/fjord`. Each release now publishes a
  formula to the tap `sovereignfs/homebrew-tap`, which installs the prebuilt
  binary for macOS (Apple silicon and Intel) and Linux (x86-64 and arm64); nothing
  is built from source. The shell and PowerShell installers and the archives work
  as they did.

### Changed

- **Name normalisation follows Unicode 18.** The NFC check on file and directory
  names (spec §5.1) uses `unicode-normalization` 0.1.26, which moves from Unicode
  17 to Unicode 18. Unicode keeps already-assigned characters normalising the same
  way, so no existing name changes. Only a name using a character first assigned
  in Unicode 18 can be judged differently from one checked by a client still on 17.

## [0.3.0] - 2026-10-21

**There is no change to what `fjord` does or to the repository format.** This
is the first release from the new monorepo: what changes is where the tool
lives and how it is published, and the installers, archives and commands you
already use keep working.

### Changed

- **The repository is now `sovereignfs/fjord`,** a monorepo for the
  specification, `fjord-core`, the CLI and the clients and plugins to come.
  The old `sovereignfs/fjord-cli` URLs redirect, so existing install commands
  and installers keep working. The package is still `fjord-cli` and the
  binary still `fjord`.
- **Releases of the CLI are tagged `fjord-cli-vX.Y.Z`** from now on, so that
  other components can have tags of their own. Releases up to 0.2.0 keep
  their `vX.Y.Z` tags. Only a CLI release is ever marked *Latest*, which is
  what keeps `releases/latest/download/fjord-cli-installer.sh` pointing at
  the CLI.
- **Releases are titled `fjord-cli 0.3.0`,** the component and the version,
  without the date (the date is in this file). Earlier releases keep the
  titles they have.
- **The specification is no longer described as vendored.** `spec/SPEC.md` is
  the canonical copy.

## [0.2.0] - 2026-10-21

You can now decrypt a whole encrypted vault in place, work on it with any
editor, and check it back in; and `fjord sync` no longer publishes, or
silently drops, plaintext left in an encrypted vault. There is no format
change from 0.1.3: repositories made by it are unaffected. **The
specification is amended** (§6.5, and a new §6.6): a checkout is the one
sanctioned exception to "no plaintext in an encrypted vault", and other
clients will see a checked-out vault as files in the clear.

Two commands are stricter, deliberately. `fjord sync`, `rekey` and
`vault add --commit` now **refuse** while an encrypted vault holds a file in
the clear, is checked out, or has lost its guard `.gitignore`; `sync` used
to answer "already up to date". A script that relied on `rekey` carrying on
past a stray file will now see exit `1`.

### Added

- **`fjord decrypt <vault>` and `fjord encrypt <vault>`: work on a whole
  vault.** Decrypting a vault writes every document beside its payload
  (`notes.md.age` → `notes.md`), so any editor or note application can work
  on it in place; `fjord encrypt <vault>` checks it back in, re-encrypting
  only what changed, adding what is new, and removing the encrypted copies of
  what you deleted after asking (`--yes`, `--dry-run`, `--discard`). Until
  then `fjord sync`, `rekey` and `vault add --commit` refuse. See "Working on
  a whole vault" in the README. **This is spec §6.6, a new section.** It is
  the one exception to "never write plaintext into an encrypted vault", and
  the vendored spec and CLAUDE.md's first invariant are amended to say so;
  `fjord-spec` upstream needs the same change.
- `fjord status` and `fjord verify` say when a vault is checked out, and
  `status --json` gains `checkedOut`.
- **`fjord verify --fix` now exists.** The README has documented it since the
  start, and until now it was refused as a usage error. It repairs
  `fjord.json` where it disagrees with the disk, as spec §2.1 asks: a vault
  on disk that the manifest does not list (`W601`) is added with its own `id`,
  and an entry for a vault that is gone (`E106`) is removed. Unknown keys and
  other entries are preserved; nothing is committed; a repository from a
  newer format version is refused. `--json` gains a `repairs` array when
  `--fix` is given. It repairs nothing else, and the README says what it
  leaves alone.
- **`fjord verify --json` declares the conformance levels** (spec §10) in a new
  `conformance` field: `["L0", "L1", "L2", "L3"]`. The declaration is
  `fjord_core::conformance::DECLARED`. L1 requires repairing `fjord.json`,
  which is what `--fix` is for; L3 carries one limit, documented in the
  README: a vault that lists an SSH recipient is refused for writing, since
  this build links no RSA implementation.

### Fixed

- **`fjord import` into an `id`-named vault now names each payload after the
  document's own id.** Spec §7.2 requires the on-disk name to equal the
  document's `id`. Import gave every payload a fresh id and kept the
  Markdown's own inside it, so the two disagreed whenever a file already had
  frontmatter, which is exactly what `export` followed by `import` produces.
  `fjord verify` could not see it, because it never decrypts. A file that is
  given frontmatter on import is named by the id it was given, and two files
  in one import carrying the same id now refuse the whole import instead of
  sharing a name. **A vault imported into by an earlier version may hold
  payloads whose names differ from their documents' ids**; nothing detects
  that today, and the way to correct one is to export the vault and import it
  into a new one.
- **`fjord sync` no longer commits, or silently skips, plaintext in an
  encrypted vault.** Spec §6.5 says a client MUST NOT commit an unencrypted
  document into an encrypted vault, and relies on the vault's `.gitignore`.
  That guard is a safety net, not a lock: with it intact, a stray decrypted
  file was skipped by `sync` without a word (your edit was in no commit, and
  the output said "already up to date"), and with it deleted `sync` committed
  and pushed the file. `sync` now checks first, and refuses with exit `1`,
  naming the files, when an encrypted vault holds a file in the clear
  (`E201`) or has lost its guard `.gitignore` (`E208`). `fjord rekey` and
  `fjord vault add --commit`, which stage a whole vault, make the same check.
  This has been the behaviour since `sync` was added.

### Changed

- **`fjord rekey` now refuses, rather than skips, a file in the clear.** It
  used to carry on and note how many files it left alone; it now stops, for
  the reason above, and leaves the file untouched.

## [0.1.3] - 2026-10-20

### Changed

- **Release archives now include `CHANGELOG.md`**, beside the README and the
  licence, so the history travels with the binary. The README links to it.

### Notes

- **There are no code changes in this release.** The `fjord` binary, the
  repository format and every command behave exactly as they did in 0.1.2,
  and repositories are unaffected; the only difference in the binary is the
  version it reports, and so the `generator` that `fjord init` records. This
  release exists to ship the changelog in the archives, and it is the first
  cut with `scripts/release.sh`, which now handles the version bump, the
  checks and the tag.

## [0.1.2] - 2026-10-20

An encrypted vault can now be created ready to use, in one command. There is
no format change from 0.1.1: repositories created by 0.1.1 are unaffected.

### Added

- **`fjord vault add --recipient <key>`** registers an age public key as the
  new vault's recipient, so the vault is writable immediately. Repeat it for
  several. Before this, an encrypted vault was created unwritable (spec §6.2),
  `fjord verify` warned `W602`, and you had to run `fjord key add` as a
  separate step. Every key is checked before anything is written, so a bad
  one refuses the whole command and creates nothing.
- **`fjord vault add --commit`** commits the new vault in one commit, `Add
  vault <name>`, containing the vault and its entry in `fjord.json` and
  nothing else. It needs a git repository and refuses up front, creating
  nothing, if there is none.
- **`fjord vault add --json`** prints the new vault's id, settings, the
  recipients registered, whether it was committed, and the files written.
  Standard output is the JSON and nothing else.

### Changed

- **A recipient's checksum is now checked** by `key add`, `vault add
  --recipient` and `verify`. A key with one mistyped character keeps the
  right length and alphabet but fails its checksum, and was previously
  accepted: `key add` took it, `verify` counted it as a usable recipient and
  reported a clean repository, and the next write failed with `invalid Bech32
  encoding`. It is now refused up front, and `verify` reports such a line as
  `E209`.
  **A repository that `verify` passed under 0.1.1 can therefore fail under
  0.1.2** if its recipients file contains one. Nothing could have been
  written to that vault either way; the line needs correcting.
- **`key add` refuses SSH recipients.** It previously accepted them and left
  a vault this build could not encrypt to, since SSH support was dropped
  over RUSTSEC-2023-0071. The error says why.

### Fixed

- **`open --commit` and `rekey` no longer commit work you had staged.** Both
  staged their own files and then ran a bare `git commit`, which commits the
  whole index, so anything already staged landed in a commit whose message
  said something else. They now commit only their own files and leave the
  rest of the index as they found it. This has been the behaviour since
  `open` was added.
- **A secret key given by mistake is no longer echoed back.** `key add`'s
  error message repeated its argument, which would print an identity pasted
  there by mistake into terminal scrollback. It is now redacted, and the
  message says to treat the key as exposed, since it is already in your shell
  history.

## [0.1.1] - 2026-10-17

### Changed

- **Breaking: identifiers are now lowercase** (spec §8.3). 0.1.0 wrote them
  uppercase, so a repository it created does not conform to this revision.
  `fjord verify` reports the old spelling with a message that names it, so it
  is not mistaken for a typo. Nothing is accepted in both forms: §8.3 permits
  exactly one, so that every client can compare and sort identifiers without
  negotiating. If a 0.1.0 repository holds nothing you need, run `fjord init`
  again; if it does, do not hand-edit it, because identifiers are also file
  names in `id`-named vaults and live inside encrypted documents.
- **`fjord.json`'s `generator` is now `fjord <version>`**, the binary's own
  name and version, where 0.1.0 wrote `fjord-init <version>`.
  `fjord init` still records it by default. It is visible to anyone who can
  read the repository, and the specification now lists it among what remains
  visible (§11.2).

## [0.1.0] - 2026-10-17

First release.

### Added

- **The whole documented command surface:** `init`, `verify`, `key`,
  `vault`, `encrypt`, `decrypt`, `open`, `new`, `ls`, `grep`, `status`,
  `sync`, `rekey`, `export` and `import`.
- **`fjord verify`**, which checks a repository against the specification and
  reports coded diagnostics without changing anything. All 40 diagnostics are
  implemented, and `--json` output follows a published schema.
- **Encryption with age**, unmodified, so `age -d` alone recovers a file. It
  is checked in both directions against the reference `age` binary on every
  push, including the documented recovery procedure.
- **`fileNaming: "id"`** with the tar container, so file names as well as
  contents can be concealed, and `age -d | tar -x` recovers the original name.
- **`fjord sync`**, which resolves conflicts in encrypted vaults by
  decrypting both sides and their merge base, merging the plaintext, and
  re-encrypting. Where a merge cannot complete, both versions are kept.
- **Five platforms**, installed from GitHub Releases: macOS on Apple silicon
  and Intel, Linux on x86-64 and arm64 as static musl binaries, and Windows
  on x86-64.

### Notes

- Licensed under the Mozilla Public License 2.0. The specification itself is
  CC0.
- SSH recipients are not supported. Writing to one means linking an RSA
  implementation, which carries an unfixed key-recovery weakness
  (RUSTSEC-2023-0071); `fjord verify` still accepts such a repository as
  conforming.
- Building from source needs Rust 1.88 or newer.

[Unreleased]: https://github.com/sovereignfs/fjord/compare/fjord-cli-v0.3.1...HEAD
[0.3.1]: https://github.com/sovereignfs/fjord/compare/fjord-cli-v0.3.0...fjord-cli-v0.3.1
[0.3.0]: https://github.com/sovereignfs/fjord/compare/v0.2.0...fjord-cli-v0.3.0
[0.2.0]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sovereignfs/fjord-cli/releases/tag/v0.1.0
