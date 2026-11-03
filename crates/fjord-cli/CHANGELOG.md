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

### Changed

- **Breaking: a journal is encrypted unless `--no-encrypt` is given** (spec §3.1, RFC 0002). `fjord init --kind journal` makes an encrypted vault (`id` naming, a tar container, no recipients yet, so `W602` until `fjord key add`); `--no-encrypt` makes it plaintext, as `--kind drive --no-encrypt` does for `Private`. `--encrypt` is removed (exit 2). On a terminal the question "Encrypt the journal?" now defaults to yes. `--no-encrypt` with `--kind ssg` is refused: a site is never encrypted.
- **Breaking: there is one kind of Fjord Doc** (spec §8.4, RFC 0002). A `.fj.md` name no longer makes a *document*; every Doc is a `.md` file and a repository's kind decides how a client edits it. `fjord new --document` is gone (exit 2), `fjord ls --json` no longer has `docKind` (`kind` is still `doc` for a Fjord Doc), `ls --long` no longer says `document` or `note`, and a title or a conflict copy treats `.fj.md` like any other name (`plan.fj.md` conflicts into `plan.fj.conflict-…md`). `fjord_core::listing::FileKind::Document` and `Note` are now `Doc`, and `doc::is_document_name` and `DOCUMENT_SUFFIX` are removed. No file in a repository has to change.
- **A vault may be at any depth below the repository root** (spec §2.3): `src/content` can be a vault, so a site's engine can keep reading its content where it always did. A vault inside another vault, and a manifest at the root, are still `E207`. `fjord_core::vault::discover` and `containing` walk the tree (not into a vault, `.git` or the root `.fjord/`), `listing::locate_vaults` and `Discovery::vault_containing` say the same of a listing, and a new fixture, `tests/fixtures/depth/`, holds an Astro site that is one.

- **`fjord vault add --encrypted` adds the merge guard** (`*.age binary -diff -merge`, spec §9) to `.gitattributes` when the repository lacks it, and `--commit` commits that file with the vault. The command now asks the same planner (`fjord_core::scaffold::plan_vault`) as the web client's *Add a vault*, so the two make the same files; its flags and messages are unchanged. `--json` lists the files outside the vault it changed under `changed`.

### Added

- **`fjord vault encrypt <vault>` and `fjord vault decrypt <vault>`** (spec §6.7, RFC 0003). The first makes a plaintext vault an encrypted one in one command: it encrypts every file to `--recipient` (or your identity's own key), proves each payload opens to what it was made from, and only then removes the plain files; the vault keeps its id and every field. The second makes an encrypted vault plaintext for good. Both ask first (`--yes` without a terminal) because history keeps what was committed, and `--commit` commits the vault and nothing else. `fjord encrypt <vault>` and `fjord decrypt <vault>` are still the checkout for working on a vault that stays encrypted; their help now says so. `fjord_core::scaffold` gains `plan_encrypt_vault`, `plan_decrypt_vault` and `vault_guard`.
- **`fjord-core` can set one header field** (`doc::with_field`, `FieldValue`, `is_settable_key`): text or a yes or no, or taken away, with every other key and the body untouched; `id`, `created` and `fjord` are not settable. The web client's front-matter form uses it.
- **`fjord init --adopt`** makes a Fjord repository of a directory that already has files (RFC 0002), of any kind: `--vault <dir>` names the directories to make vaults of, at any depth (repeat it in a drive); a site's engine and content folder are found from `astro.config.*` (`src/content`) or `_config.yml` (`_posts`). It **writes over nothing** — it adds `fjord.json`, each vault's manifest, and lines at the end of `.gitattributes` (and `.gitignore`, where something is encrypted) — and commits **only** those files, leaving a person's uncommitted work alone. A journal over notes that are already there must choose `--no-encrypt` or `--encrypt-existing`; the latter begins a checkout (spec §6.6) before it writes anything, makes no commit, warns that git's history keeps what was committed, and is ended by `fjord key add` and `fjord encrypt <vault>`. `fjord-core` gains `adopt::plan_adopt` (pure, in the wasm subset) and `adopt::detect_site`.
- **Repository kinds** (spec §3.1, RFC 0001): `fjord verify` reads `fjord.json`'s optional `kind` (`drive`, `journal` or `ssg`) and its settings object, and checks the rules of each. Three new diagnostics: **`E111`**, a journal or `ssg` repository without exactly one vault; **`E112`**, an `ssg` repository whose vault is encrypted; and the warning **`W606`**, a Doc whose `date` is not an RFC 3339 date-time or full-date (spec §8.1). A kind this build does not know is not a finding: it is presented as a drive, and kept. `fjord-core` gains `manifest::Kind`, `manifest::Engine`, `Manifest::kind`, `Manifest::presented_kind`, and `scalar::is_entry_date`.
- **`fjord-core` scaffolds each kind and files journal entries**: `scaffold::plan_kind_with` makes a drive (exactly today's repository), a journal (one `journal/` vault, plaintext, or encrypted with `id` naming and a tar container), or an Astro or Jekyll site (one plaintext `content/` vault and the engine's own files around it). `journal::entry_path` files an entry by its `date` in the writer's own time (`YYYY/MM/DD/HHMM-slug.md`, or flat at the vault's root in an encrypted journal, spec §11.2), `scalar::rfc3339_from_unix_at_offset` writes such a `date`, and `tags::same` and `tags::is_under` compare tags as spec §8.1 says. All of it is in the pure subset.
- **`fjord-core` sets up an existing repository as a kind, and changes a kind**: `scaffold::plan_setup_kind` adds a journal or a site to a repository that is not a Fjord repository, additively, through `plan_vault` for the one vault, and refuses an engine's file that is already there; `scaffold::with_kind` rewrites `fjord.json`'s kind keeping every other field; `manifest::kind_rule` says which rule of spec §3.1 a kind would break.
- **`fjord-core` reads a journal entry for a timeline, and rewrites a header's `date` and `tags`**: `journal::when` places an entry by its `date`, else the date its path is filed under, else its `created` (spec §8.1); `journal::summary` is what a timeline shows of one (title, tags, `date` and whether it is one, the start of its text); `doc::with_date` and `doc::with_tags` change one key of a header and nothing else.
- **`fjord new` with no path, in a site, makes a post** as its engine reads it (spec §3.1; `fjord_core::site`): Astro's `content/posts/<title>.md`, Jekyll's `content/_posts/YYYY-MM-DD-<title>.md` (a name that is a rule, dated in the writer's day), with `--draft` for Astro's `draft: true` or Jekyll's `_drafts/`. A tag with a space is refused for Jekyll (`site::tag_problem`).
- **A Jekyll site's posts have a layout**: the scaffold's `_config.yml` gives every post the `post` layout, found by building it (Astro 5.18.2 and Jekyll 4.4.1 both build the scaffolds; `scripts/check-site-scaffolds.sh`).
- **`fjord init --kind journal|ssg`** (`--engine astro|jekyll` for a site, `--encrypt` for a journal) makes a repository of that kind; with no `--kind` it is a drive, as before. A flag for another kind is refused (exit 2), and so is `--kind ssg` with no engine under `--no-input`. `init --json` reports `kind`.
- **`fjord verify --json` reports `repositoryKind`** (`"drive"` when none is declared; `schema/verify.schema.json` gains it), and the human output names a kind other than `drive` on its first line.
- **`fjord new` with no path, in a journal, writes an entry** dated now at this machine's offset (or `--date`), filed by that date (`journal/YYYY/MM/DD/HHMM-slug.md`, flat in an encrypted journal).
- **`fjord-core` and `fjord-cli` are on crates.io** (from 0.4.0): `cargo install fjord-cli` builds the `fjord` command, and `fjord-core` can be used as a library (`fjord-core = "0.4"`).

## [0.4.0] - 2026-11-01

### Security

- **The frontmatter parser is safe Rust** (ROADMAP: replace `unsafe-libyaml`): `fjord-core` reads and writes YAML through `serde-saphyr` (`fjord_core::yaml`), which forbids
  unsafe code and limits what an alias can expand to, in place of `serde_yaml_ng`, which sat on `unsafe-libyaml`, a C-to-Rust transliteration, and had no
  such limits. Frontmatter is untrusted input (spec §8.1, §11.5). The advisory ignore for `unsafe-libyaml` is gone from `deny.toml`.
  What a file says survives as before (invariant 3), and **a block that could not be written back exactly is now reported as unparseable (`E402`) and not
  rewritten**: a key given twice (the old library kept the last and dropped the first), a YAML tag (it would have been dropped), and a whole number too large
  to be one (it would have been rounded). `yes`/`no`/`on`/`off` remain text; a `<<` key remains a key. Slightly wider than YAML 1.2: `1_000` and `0b11` are read
  as numbers (as YAML 1.1 and Obsidian do), and written back as `1000` and `3`. The text Fjord writes is read identically by `libyaml` (checked on 20,000 random
  mappings), and a multi-line text with a tab, a carriage return or a Unicode line separator is written in double quotes so that no reader differs.
- **A header Fjord writes quotes more**: text is in double quotes where it was in single quotes (`title: "Q4: plan"`), and a timestamp is quoted (`created: "2026-10-16T09:34:00Z"`, which every reader
  reads as the same text, where an unquoted one some tools read as a date). The first time Fjord rewrites a file's header (a new id, a title, a promotion) these lines change; the keys, their values and
  their order do not.
- **Building from source needs Rust 1.89** (it was 1.88): the YAML library requires it.

### Added

- **`fjord-core` can set or take away a document's `title`** (ROADMAP 1b.5): `doc::with_title` rewrites a header's `title`
  and keeps every other key, in its place; a title that YAML would misread (a colon, a leading `-`, quotes) reads back as
  it was written. `implied_title` now strips the whole `.fj.md` from a document's name, so `fjord new` and the bulk
  commands no longer imply `Q4 plan.fj` from `Q4 plan.fj.md`.
- **`fjord-core` can plan a repository's files without a disk or a clock, and set one up in a repository that
  is not one** (ROADMAP P6): `scaffold` is now in the pure subset (WebAssembly). `plan_with` is `plan` with the
  time and the identifiers given (`Origin`), so the same inputs give the same files; `plan`, which reads the clock,
  and `write` stay behind `native`, and `fjord init` writes what it did, through `plan_with`. `plan_setup` decides
  what to add to a repository that is not a Fjord repository: a `fjord.json`, one plaintext vault with a starter
  note, and, only when it is missing, spec §9's `*.age` merge guard in `.gitattributes`. It changes nothing that is
  there (the guard is a line appended to an existing `.gitattributes`), leaves out the `README.md`, `.gitignore`
  and line-ending rule that `fjord init` writes, refuses a repository that has a `fjord.json`, and refuses a vault
  name that is taken (case aside) or cannot be a directory. A repository it has set up passes `fjord verify`.
  `has_merge_guard` is the one check of that guard, used by `verify` too.
- **A three-way text merge in `fjord-core`, and conflict copies named by it** (ROADMAP MP1, `clients/mobile`):
  `fjord_core::merge::merge3` merges two edits of a text by lines and says what it could not: it agrees with
  `git merge-file` on which merges are clean and on their text (a test runs the real `git` over generated and
  hand-written merges), so a client with no `git`, the web client or a phone, produces the result `fjord sync` does.
  `conflict_copy_path` and `conflict_copy_text` are how the side that could not be merged is kept (§9.1), and
  `add_add` settles two different files added at one path: both are kept, the pulled one in place and the local one
  moved to the next free number. Pure, so in the WebAssembly subset. `fjord sync` still merges with
  `git merge-file`; it now names its conflict copies through `fjord-core`.
- **A note's name from its text** (ROADMAP MP2, `clients/mobile`): `fjord_core::naming::quick_note_name` gives a new
  note the file name its first line asks for, so a note captured on a phone and one typed in a browser get the same
  name. Markdown markers (`#`, `>`, `-`, `1.`, `[ ]`) are stripped; what spec §5 forbids becomes a space; the name is
  NFC and cut at 60 characters on a word boundary; a first line with nothing to name it by gives the date and time
  (`2026-10-22 1430.md`); a Windows device name is prefixed with `Note `; and a name already in the folder, by case
  or normalisation, gets ` 2`, ` 3`, … before the extension. Pure (the caller supplies the local time and the folder's
  names), so it is in the WebAssembly subset. Nothing in the CLI uses it yet.
- **`fjord new --document`, and `ls` says which is which** (ROADMAP P2): `--document` names a new Doc
  `*.fj.md` (`plan` and `plan.md` become `plan.fj.md`; a name already ending in `.fj.md` is a document without
  the flag), and a document's default title no longer keeps its suffix. `ls --json` keeps `"kind": "doc"` for every
  Fjord Doc, so nothing that reads it breaks, and adds `"docKind": "document"` or `"note"` (null for anything that
  is not a Fjord Doc); `ls --long` shows the kind before the id and title. In an `id`-named encrypted vault, where
  the name on disk is the identifier, the kind comes from the name inside the container.
- **Documents and notes** (spec §8.4, ROADMAP P1): a Fjord Doc whose file name ends in `.fj.md` is a *document*,
  any other a *note*. It is the same format (same frontmatter, same rules, same identifiers; a `.fj.md` file with no
  valid `id` is a vault file like any `.md`), told apart by name so a client can edit a long-form document
  differently from a note without reading the file. **Nothing changes for an existing repository**: every `.md`
  Doc written before is a note, and `fjord verify` counts both kinds as Docs, as it always counted any `.md`
  with an `id`. In `fjord-core`, `doc::is_document_name` and `doc::DOCUMENT_SUFFIX`, and
  `listing::FileKind::Markdown` is now `Document` and `Note`. A new fixture, `tests/fixtures/documents/`, holds one
  of each (`fjord new --document` and `ls` showing which is which are ROADMAP P2).

### Changed

- **`fjord sync` keeps a conflicted document a document**: the copy of the side it could not merge is now
  `plan.conflict-<id>.fj.md` for `plan.fj.md`, not `plan.fj.conflict-<id>.md`, which is a note (it was split at the
  last dot, before `.fj.md` was one extension). The copy's name is also kept under 255 bytes and never overwrites a
  file already beside it.
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
- **The specification is no longer described as vendored.** `docs/specs/Fjord.spec.md` is
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

[Unreleased]: https://github.com/sovereignfs/fjord/compare/fjord-cli-v0.4.0...HEAD
[0.4.0]: https://github.com/sovereignfs/fjord/compare/fjord-cli-v0.3.1...fjord-cli-v0.4.0
[0.3.1]: https://github.com/sovereignfs/fjord/compare/fjord-cli-v0.3.0...fjord-cli-v0.3.1
[0.3.0]: https://github.com/sovereignfs/fjord/compare/v0.2.0...fjord-cli-v0.3.0
[0.2.0]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sovereignfs/fjord-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/sovereignfs/fjord-cli/releases/tag/v0.1.0
