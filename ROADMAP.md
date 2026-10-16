# Roadmap

Sequencing and status for `fjord-cli`. **This file tracks progress; it does
not define behaviour.** `spec/SPEC.md` is authoritative on the format and
`CLAUDE.md` on how to build it — where either disagrees with this file, this
file is stale and should be corrected.

State as of 2026-10-16: **M1 through M5 complete and green.** `verify`,
`init`, `key new|add|list|remove`, `encrypt`, `decrypt`, `open`, `new`,
`ls`, `grep` and `status` are implemented end to end — every command the
README documents except `sync`, `rekey`, `export` and `import`. 230 tests
pass; `clippy -- -D warnings` and `cargo fmt --check` are clean.

All three milestones' acceptance criteria hold, including the one that
matters most: **a file encrypted by `fjord` decrypts with the real `age`
binary, and a file written by `age -R` decrypts with `fjord`** — in binary
and armored form, over all 256 byte values, with keys from either
implementation. `crates/fjord/tests/age_interop.rs` also runs the recovery
procedure the generated README documents, verbatim, so that document cannot
quietly become a lie.

Verified on rustc 1.99.1 only. The declared MSRV of 1.82 is **untested** —
M0.1 should pin it and CI should build against it. Version `0.1.0`, nothing
released.

## Status

| | |
| --- | --- |
| `done` | Implemented, tested, `cargo test` green. |
| `wip` | Started. |
| `todo` | Not started. |

## Groundwork — M0

Pure infrastructure, no format code. CLAUDE.md places age cross-validation
at M3; it is pulled forward here because it is the test that backs the
format's central promise — that `age -d` alone recovers a file — and
retrofitting it after three milestones of crypto code means discovering any
disagreement late.

| | Item | Status |
| --- | --- | --- |
| M0.1 | `rust-toolchain.toml` pinning the MSRV declared in `Cargo.toml` (1.82) | `todo` |
| M0.2 | CI: `build`, `test`, `clippy -- -D warnings`, `fmt --check` on Linux and macOS | `todo` |
| M0.3 | CI job installing the Go `age` binary, for the cross-validation tests M3 will fill in | `todo` |
| M0.4 | Fixture harness: a helper that copies `tests/fixtures/<name>/` to a tempdir and runs `verify` against it, so no test mutates a fixture in place | `todo` |
| M0.5 | `xtask` (or a test that writes and diffs) generating the README diagnostics table from `diagnostics::Code`, as CLAUDE.md already claims happens | `todo` |

*Accepts when:* CI is green on an empty test suite, and the generated README
table is byte-identical to the committed one.

## Format milestones

Acceptance criteria for each are in `CLAUDE.md § Milestones` and are not
restated here. Build in order; do not start the next until `cargo test` is
green.

| | Milestone | Modules | Status |
| --- | --- | --- | --- |
| M1 | `fjord verify`, read-only, no crypto | `scalar`, `path`, `manifest`, `doc`, `verify`, `cmd/verify` | `done` |
| M2 | `fjord init` | `scaffold`, `cmd/init`, `git` | `done` |
| M3 | Keys, encrypt, decrypt | `crypto`, `vault`, `cmd/keys`, `cmd/crypt` | `done` |
| M4 | `fjord open` | `cmd/open` | `done` |
| M5 | `new`, `ls`, `status`, `grep` | `cmd/new`, `cmd/list`, `cmd/grep`, `cmd/status` | `done` |
| M6 | `fjord sync` | `cmd/sync`, `git` | `todo` |
| M7 | `fileNaming: "id"` and the tar container | `container` | `todo` |

### M1 breakdown

| | Module | Status |
| --- | --- | --- |
| 1 | `scalar` — ULID and RFC 3339 UTC validators | `done` |
| 2 | `path` — §5 name and path rules, pure predicates | `done` |
| 3 | `manifest` — both manifests, unknown fields preserved | `done` |
| 4 | `doc` — frontmatter, Doc vs vault file | `done` |
| 5 | `verify` — discovery and the checks, rendering nothing | `done` |
| 6 | `cmd/verify` — human output, `--json`, exit codes | `done` |

M1 emits **38 of the 40 codes**. Only `E301` (corrupt payload) and `E303`
(malformed container) are deferred, since they require opening an age payload
and a tar archive.

Three decisions worth knowing, all documented at their call sites:

- **Manifests and frontmatter parse into ordered maps, not typed structs.**
  A struct with `id: Ulid` turns a malformed identifier into
  `E102 fjord.json is not valid JSON`, which is both wrong and useless.
  Keeping fields untyped until they are checked is what makes a missing
  field `E104`, a bad ULID `E105`, and a genuinely broken file `E102`. It
  also preserves unknown fields and their order with no `#[serde(flatten)]`
  catch-all to get subtly wrong (invariant 3, §10.1).
- **`E201` fires on any plaintext in an encrypted vault**, whether or not
  `.gitignore` would stop it being committed. The tempting reading is that a
  gitignored file is harmless — but the canonical §6.5 guard ignores exactly
  that file, which would make the most serious diagnostic in the set
  unreachable in every conforming repository. Invariant 1 admits no
  "temporarily".
- **`.gitignore` is not consulted during the walk at all**, which keeps the
  `ignore` crate out of M1. It earns its place in M5, where `ls` and `grep`
  walk user content.

`--fix` is gated on `Code::is_auto_fixable`, which allows exactly four
repairs. It lands in M2 alongside `init`, which writes the same scaffolding;
until then `verify --fix` is refused as a usage error (exit 2) rather than
silently ignored.

### M2 notes

`fjord init` writes nine files, including the full `README.md` that explains
the format — the thing that makes a repository comprehensible to someone who
clones it without Fjord installed, which the prime directive asks for where
the spec is silent.

The static files live in `crates/fjord-core/templates/` and are the same
bytes the conforming fixture carries;
`the_static_files_are_byte_identical_to_the_fixture` holds the two together,
so neither can drift into describing a format the other does not produce.

Three decisions:

- **A fresh `Private` has no recipients.** §6.2 makes that valid and
  explicitly unwritable, and it is the honest state of a repository whose
  owner has not yet made a key. `verify` reports `W602`, which is a warning,
  so the acceptance criterion still holds — and `init` says so in its output
  before the user meets the warning.
- **`--identity` is refused, exit 2.** Registering a recipient is `key add`,
  which is M3. Accepting the flag and ignoring it would hand back a
  repository the user believes they can write to. The flag is global and has
  an env fallback, so the message names `FJORD_IDENTITY` too.
- **Scaffolding is checked before it is written.** A missing `git` is
  reported while the directory is still empty. When git itself fails — an
  unset `user.email`, most often — the files survive and the error says how
  to finish, because the alternative is a user who re-runs `init` and is
  told the directory is not empty.

`scaffold::plan` returns file contents and touches no filesystem;
`scaffold::write` is the only function there that performs IO and uses
`create_new`, so it cannot truncate. That split is what lets the web build
reuse it against a virtual filesystem.

### Two bugs the demo caught

Neither was visible in the tests, because both were about what the output
*means*:

1. **`verify` marked a warning-only vault `✗`** while reporting "0 errors"
   and exiting 0. The mark contradicted the verdict three lines below it.
   Now `✓`/`⚠`/`✗`, with warnings named as warnings, locked by a golden.
2. **`init`'s git failure did not say the repository had been created**, so
   the obvious next move — run it again — hit "directory is not empty".

### M3 notes

39 of the 40 diagnostics are now implemented; only `E303` (malformed tar
container) is left, and it belongs to M7.

- **`E301` arrived early.** Parsing an age *header* needs no identity, so
  `verify` can report a file named `.age` that is not an age file —
  truncated, corrupted in transfer, or replaced by a merge conflict — while
  still never asking anyone for a key. Authenticating the body does need a
  key, so that happens when a file is read. Both halves are documented on
  the code.
- **The fixtures now carry real key material.** A genuine `age1…` public key
  replaces the synthetic placeholder, and `broken/E302` and `broken/E304`
  hold genuine payloads. The matching identity is deliberately **not**
  committed: nothing in the committed fixtures needs decrypting, and tests
  that do need it generate their own keys in a temporary directory.
- **Two features were added to the `age` dependency**, `armor` and `ssh`,
  for coherence rather than ambition: `verify` accepts `armor: true` (§4.1)
  and `ssh-ed25519` recipients (§6.2), so a writer unable to honour either
  would reject repositories its own verifier calls conforming.
- **`encrypt` reads the payload back before deleting the plaintext.** With
  an identity among the recipients that is a full round trip compared byte
  for byte; otherwise the header is parsed and the weaker check is reported
  rather than implied.
- **Secrets stay out of `argv` and out of the terminal.** `--identity -`
  reads from stdin, a generated identity is written `0600` and never
  printed — only its public key — and `Debug` for `Identities` prints a
  count, so a derived formatter cannot leak one into a log.

### The bug that mattered

`fjord decrypt --out Private/leaked.md` **wrote plaintext into the encrypted
vault**, straight through the guard meant to prevent it. The guard compared
`std::path::absolute(destination)` against a canonicalised root; since
`absolute` does not resolve symlinks, and macOS puts temporary directories
behind `/var` → `/private/var`, a destination inside the vault compared
unequal to the repository and was read as "outside it entirely".

Two things about this are worth keeping:

1. **It failed open.** For invariant 1 that is the worst available direction,
   and it is the second time the same mistake — comparing an unresolved path
   against a canonical one — has produced a security-relevant bug in this
   codebase. The first was M1's symlink check. There is now one shared
   `resolve_destination` that canonicalises the deepest existing ancestor,
   so a path that does not exist yet is still resolved honestly.
2. **Only an end-to-end test could find it.** Every unit in the chain was
   correct in isolation.

### M4 notes

All four of the edge cases CLAUDE.md names are handled, and each has a test
named after it in `crates/fjord/tests/open.rs`. The editors in those tests
are `#!/bin/sh` scripts, which is what makes the command testable at all: a
real editor wants a terminal, while a script can stand in for one that
saves, one that changes nothing, and one that hangs.

- **Forking GUI editors** get `--wait` appended, matched on the program's
  file stem so a full path still works.
- **An unchanged document is not re-encrypted.** The test asserts the
  payload's bytes are identical, which is the only honest check: `age`
  output is non-deterministic, so any re-encryption at all would change
  them.
- **SIGINT/SIGTERM shred the decrypted file and release the lock**, then
  exit 130. This needed `signal-hook`, since std has no API for installing
  a handler — a dependency CLAUDE.md's table has no row for, added
  deliberately. The test drives it with a hanging editor and a real
  `kill -TERM`.
- **The lock lives under `/.fjord/local/locks/`**, named by digest so any
  path becomes one safe file name. §2.2 reserves `/.fjord/` for client
  machinery and the generated `.gitignore` keeps it out of commits — and a
  lock inside an encrypted vault would be plaintext in the one place
  invariant 1 forbids. A test asserts the path, not just the behaviour.

Two further choices worth recording:

- **A session that could not be saved is never started.** The recipients are
  parsed before anything is decrypted, so a vault with no keys refuses up
  front rather than after the user has typed for an hour.
- **A non-zero editor exit does not discard the edit.** A GUI editor's exit
  code is not a reliable signal, and throwing away someone's work on the
  strength of one would be worse than persisting it. The exit is reported as
  a warning.

### Two bugs the demo caught, again

Both were invisible to the test suite, and both were about the seam between
components rather than any one of them:

1. **Repository-relative paths did not work.** `cli.rs` documents `open`'s
   path as "relative to the repository root", and `-C` is useless otherwise,
   but resolution only tried the working directory. Every M3 test passed
   absolute paths, which is exactly how it went unnoticed. Both spellings
   are now accepted, working directory first.
2. **A successful command printed an error.** `usage()` prints as a side
   effect, and `open` called it speculatively while probing for the payload
   name — so `fjord open Private/notes.md` emitted "does not exist" and then
   succeeded. The tests missed it because they assert stderr *contains* the
   expected text, and noise passes that. Path resolution now returns the
   message and lets the caller decide to print it; a test asserts stderr is
   empty on success.

### M5 notes

Both acceptance criteria hold: `fjord new` produces a Doc that `fjord
verify` passes — in a plaintext vault, an encrypted vault and a nested
directory — and `grep` finds text that exists only inside ciphertext. That
second test first asserts ordinary `grep -r` *cannot* find the string,
which is the part that makes it mean something.

- **`new` writes encrypted vaults encrypted.** The document is built in
  memory and written as a payload; the plaintext never touches the vault,
  not even for the instant between creating a file and encrypting it.
- **§5 is enforced before the write.** `new` is the only path by which
  Fjord creates a name, so it is the only place the path rules can be
  applied in advance rather than diagnosed afterwards — and the only way
  `E504` is reachable at all.
- **Editing reuses `fjord open`** rather than reimplementing the lock, the
  temporary file and the signal handling, which would be a second place for
  any of it to be wrong.
- **A plain `ls` reads no document contents**, so it needs no identity: in a
  `plain` vault the names are already visible to anyone who can read the
  repository (§11.2). `--long` and `--json` decrypt, and say what they could
  not open.
- **`grep` matches a literal substring, not a regex.** A regex engine is not
  among the chosen dependencies, and documenting substring matching
  honestly beats implying syntax that does not work.
- **No matches is exit 0**, deliberately unlike `grep(1)`: exit 1 means
  "problems found in the repository" everywhere else in this tool.

Shared work landed in core rather than in each command:
`vault::Vault::contents` walks a vault once and strips payload suffixes, so
`ls` and `grep` agree about what a document is called; `doc::new_document`
serialises frontmatter through the YAML writer, so a title containing a
colon cannot produce a file this crate would then refuse to parse; and
`scalar::new_ulid` means there is exactly one way to make an identifier,
which is how "exactly one identifier form is permitted" gets enforced.

### Two more bugs from running the tool

The pattern is now unmistakable: **five milestones, and every single time
the thing that found the bug was using the tool, not the test suite.**

1. **`git status --porcelain` lost a character.** `Git::run` trimmed its
   output, which strips the leading space from the *first* line only — so
   ` M Private/recipients.txt` became `M Private/...` and an index-based
   slice ate the `P`. A general helper's convenience silently corrupting a
   caller that needed exact bytes. `run` now returns what git said, a
   separate `run_line` trims for single-value queries, and the parse works
   from structure rather than a fixed offset.
2. **An encrypted vault claimed "0 docs".** True but misleading: `verify`
   never decrypts, so it cannot tell a Doc from any other file in there.
   The count is now simply not claimed — a fact about what was inspected
   should not be printed as a fact about the vault.

## Fixtures

`tests/fixtures/conforming/` exists and appears spec-correct.
`tests/fixtures/broken/` **does not exist yet — 0 of 39 fixtures.** M1 cannot
be accepted without them.

| Range | Codes | Fixtures |
| --- | --- | --- |
| `E1xx` repository | 8 | 0 |
| `E2xx` vault | 8 | 0 |
| `E3xx` encryption | 6 | 0 |
| `E4xx` documents | 5 | 0 |
| `E5xx` paths | 8 | 0 |
| `W6xx` warnings | 4 | 0 |

Four of them need more care than a text file, and should be written last:

- `E301` corrupt payload — needs a real age header with a damaged body.
- `E303` malformed container — needs hand-built tar archives (zero entries,
  two entries, a directory entry, an entry name containing `/`), all of which
  M7 must reject.

And M3 must replace two placeholders that are shaped right but are not real
cryptography: the `age1…` recipient in every encrypted fixture, and the
placeholder `.age` payloads in `broken/E302/` and `broken/E304/`. Once a
payload is actually parsed, those two fixtures will emit `E301` as well as
the code they are named for.

## Test suites

| Suite | Covers | Status |
| --- | --- | --- |
| Diagnostic self-consistency | Unique codes, complete `all()`, severity matches range | `done` |
| CLI definition | `debug_assert`, no secret-bearing flag | `done` |
| Fixture conformance | `conforming/` exits 0; each `broken/<code>/` emits exactly that code | `done` |
| Golden output | `verify` human output, snapshotted (`FJORD_UPDATE_GOLDEN=1` to refresh) | `done` |
| JSON schema | `--json` output checked against `schema/verify.schema.json`, every fixture | `done`‡ |
| Property: paths | §5 rules | `done`§ |
| Property: frontmatter | parse → serialise → parse is a fixed point, unknown keys intact | `done`§ |
| age cross-validation | `fjord` encrypts → `age -d` decrypts, and `age -R` encrypts → `fjord` decrypts | `done` |
| Read-only guarantee | `verify` mutates nothing — blake3 over the tree before and after | `done` |
| Version refusal | A repository declaring `fjord: 2` reports read-only (invariant 4) | `done` |

‡ The checker covers the keywords the schema uses — `type`, `required`,
`properties`, `additionalProperties`, `items`, `enum`, `minimum` — but not
`pattern`, which would mean a regex dependency. Swapping in a real validator
is a CI task. § Example-based, not generative: they assert the specific
properties (byte-length counting, NFC, round-trip fixed point) rather than
quantifying over generated input. A `proptest` dependency would strengthen
them.

### Three bugs the suite caught

Worth recording, because each was invisible to inspection:

1. **`Report::version` was never assigned**, so every report claimed no
   format version was declared. Caught by the golden snapshot — the exact
   class of silent wrongness a snapshot exists for.
2. **`CON ` was not recognised as a device name.** Windows trims trailing
   whitespace before resolving a name, so `CON ` *is* the console device.
   The implementation compared the untrimmed stem.
3. **Every symlink inside a repository under a symlinked ancestor was
   reported as an escape** (`/var` → `/private/var` on macOS, a symlinked
   home directory). The target was resolved textually and compared against a
   canonicalised root.

The last two guard invariants that are easy to break accidentally in a later
refactor and silent when broken.

## Release

| | Item | Status |
| --- | --- | --- |
| R1 | `cargo-dist` configuration; Linux targets musl for static linking | `todo` |
| R2 | Installer scripts behind the `fjord.sh` URLs the README advertises | `todo` |
| R3 | Homebrew tap `fjord-sh/tap` | `todo` |

Nothing here should start before M3: the README's install section promises
binaries for a tool that cannot yet open a file.

## Documentation defects

Found while auditing the scaffolding. Each is a small, isolated fix, and each
would otherwise be implemented as written.

- [x] ~~**README's `--fix` promises a repair the spec forbids.**~~ Fixed:
      the claim is gone, and the README now says why a file without
      frontmatter is not a Doc to be repaired. It says
      `--fix` "will: assign a missing `id`", but no diagnostic code covers a
- [x] ~~**`E107`, `E205` and `W603` are skipped with no record.**~~ Fixed:
      recorded as reserved in the `diagnostics` module doc and the README,
      and guarded by `reserved_numbers_are_not_assigned`.
- [x] ~~**README links `../fjord-spec/SPEC.md`, which does not exist.**~~
      Fixed: it points at the vendored `spec/SPEC.md`. Where the upstream
      lives is still unrecorded, and `CLAUDE.md` requires keeping the copy in
      sync with it. The
- [ ] **Spec §10 conformance levels have no home in the code.** A client
      MUST declare its levels and MUST NOT act above them. The CLI
      declares nothing today and reaches L3 at M3; decide where that
      declaration lives — `fjord verify --json` is the obvious place — before
      M1 ships a client that reads repositories without naming its level.
- [x] ~~**README's `fjord init` flag table omits `--name`.**~~ Fixed.
- [x] ~~**`ExitCode` carries `#[allow(dead_code)]`.**~~ Removed, as its own
      comment instructed: all four variants are now constructed.

Two codes were added or widened while implementing M1, both deliberate and
both free to make now because nothing has been released:

- **`E110` added** — a field that is present and *wrong*. Without it, a
  `vaults` that is not an array, a `fileNaming` of `"banana"` and a
  non-boolean `encryption.armor` all had to be reported as `E104 required
  field missing`, which sends a user looking for the wrong thing.
- **`E405` widened** from "`created` is not an RFC 3339 UTC timestamp" to
  any timestamp that is not RFC 3339 UTC. §3 and §4 impose the same rule on
  `createdAt` in both manifests, and no code enforced it — so a malformed
  `createdAt` was silently accepted.

## Out of scope

See `CLAUDE.md § Out of scope` and spec §12. Nothing on either list is to be
added speculatively, including the parts that look like an afternoon's work.
