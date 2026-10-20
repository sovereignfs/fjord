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

[Unreleased]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sovereignfs/fjord-cli/releases/tag/v0.1.0
