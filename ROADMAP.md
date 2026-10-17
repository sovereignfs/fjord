# Roadmap

Sequencing and status for `fjord-cli`. **This file tracks progress; it does
not define behaviour.** `spec/SPEC.md` is authoritative on the format and
`CLAUDE.md` on how to build it — where either disagrees with this file, this
file is stale and should be corrected.

State as of 2026-10-16: **M1 through M7 complete and green — every
milestone in the build brief.** `verify`, `init`, `key`, `vault`,
`encrypt`, `decrypt`, `open`, `new`, `ls`, `grep`, `status` and `sync` are
implemented end to end, with `fileNaming: "id"` and the tar container.
**All 40 diagnostics are implemented**; nothing is deferred. 277 tests
pass; `clippy -- -D warnings` and `cargo fmt --check` are clean.

**Every command the README documents is implemented.** CI runs on every
push — five jobs, with age cross-validation first and alone — plus a
separate Audit workflow for `cargo deny`. 313 tests pass.

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
| M0.1 | Verify the declared MSRV | `done` — see below |
| M0.2 | CI: `build`, `test`, `clippy -- -D warnings`, `fmt --check` on Linux and macOS | `done` |
| M0.3 | CI job installing the Go `age` binary for cross-validation | `done` — its own job, run first |
| M0.4 | Fixture harness | `done` — synthesised fixtures build in a tempdir, and `verify_mutates_nothing` hashes the committed tree before and after |
| M0.5 | Generate the README diagnostics table from `diagnostics::Code`, as CLAUDE.md claims happens | `todo` |

**M0.1 was done differently than planned, and the plan was wrong.** A
`rust-toolchain.toml` pinning the MSRV would make everyday development and
`clippy` run on the oldest supported compiler, whose lints differ from the
current ones — so the code would be checked against the wrong rules. The
declared `rust-version` in `Cargo.toml` is instead verified by a CI job
that reads the version *out of* `Cargo.toml`, so the declaration and the
check cannot drift apart.

**And the declared MSRV was not achievable.** 1.82 was declared from the
start and never worked: `time`, `ignore`, `globset` and `sha2` (via `age`)
all require 1.88. Pinning the lockfile would not have rescued the claim,
because `cargo install` resolves dependencies afresh — so anyone following
the README on 1.82 would have hit a parse error about `edition2024`, not a
Fjord problem they could diagnose. Now declared and tested at 1.88.

The CI workflow also checks the two build claims the README makes and
nothing had ever tested: the MSRV above, and that the Linux release binary
is **genuinely statically linked**, by inspecting it and then running
`init` and `verify` with it. `file` is the authority for that check and
`ldd` deliberately is not — on a static binary it reports "not a dynamic
executable" on some systems and "statically linked" on others, so matching
its output fails in one of the two cases for the wrong reason.

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
| M6 | `fjord sync` | `cmd/sync`, `git` | `done` |
| M7 | `fileNaming: "id"` and the tar container | `container`, `store`, `cmd/vaults` | `done` |

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

### M6 notes

Both acceptance criteria hold, and both are tested against a real bare
remote with two real clones — there is no honest way to fake a three-way
merge of ciphertext. Divergent edits to one encrypted Doc merge correctly,
and an unresolvable merge keeps both versions and exits 1.

The resolution is §9.1's, exactly: for each path Git refuses to merge, take
stages 1, 2 and 3 from the index, decrypt all three, run `git merge-file`
on the plaintext, re-encrypt the result. Using `git merge-file` rather than
a hand-rolled diff3 means the merge algorithm is the one Git itself uses,
and it is confined to `git.rs` like every other git call.

- **The merge base is decrypted too**, not just the two sides. §9.1 is
  explicit about it, and without it a three-way merge degrades to a two-way
  one that conflicts on every line either side touched.
- **Neither version is ever discarded.** Ours is written back byte for byte
  — the merge attempt leaves no trace on it — and theirs is written
  alongside as a new Doc with a fresh `id`. A test asserts the result still
  passes `verify`, which is what the fresh id is for: copying the id would
  resolve a conflict by creating an `E401`.
- **A conflict is not pushed.** Exit 1, and the remote is left alone;
  everyone else would otherwise inherit a conflict only one person can
  resolve.
- **Binary documents are never text-merged.** A PDF has no lines, and
  `git merge-file` would corrupt it, so both versions are kept instead.
- **Without an identity, both ciphertexts are kept verbatim.** A
  collaborator who cannot read a vault must still not lose either side.
- `git.rs` gained `run_bytes`, because a stage of an encrypted payload is
  ciphertext and passing it through `from_utf8_lossy` would replace every
  invalid byte with U+FFFD and hand back something that is no longer an age
  file.

### Two more bugs from running the tool

Six for six. The suite proves what I thought to assert; the demo finds what
I did not.

1. **`fjord sync` ignored a remote with no upstream.** `git remote add` sets
   no `@{u}`, so the first sync after it reported "no remote tracked" —
   true, unhelpful, and indistinguishable from having no remote at all. It
   now treats a single remote plus the current branch as the obvious
   upstream and sets tracking on the first push, which removes
   `git push -u` from the quick start. Several remotes and no upstream is a
   usage error that names them.
2. **`ls --long` called a file undecryptable when it merely had no
   frontmatter.** §8.2 makes a Markdown file without frontmatter a vault
   file, not a broken Doc — so a hand-written file made `ls` tell the user
   their key was wrong. "Nothing to read" and "cannot be read" are now
   different answers, which is the same mistake as M5's "0 docs": reporting
   a limit of the inspection as a fact about the thing inspected.

### M7 notes

All three acceptance criteria hold: a vault in id mode round-trips a name
containing a space, `age -d | tar -x` recovers that name using the real
`age` and `tar` binaries, and every rejection §6.4 lists has its own test.

- **`container.rs` enforces §6.4 exhaustively**: exactly one entry, a
  regular file, a name with no path component. The escape tests build a
  hostile archive by hand, because the `tar` crate refuses to *write* a
  `..` path — the right default, and useless for testing untrusted input,
  since an attacker is not constrained by our writer's good manners.
- **`store.rs` derives container, encryption and naming in one place.** Each
  command working it out separately is how one ends up writing a file
  another cannot read. The order is fixed by §6.4 — container first, then
  encryption — which is exactly what makes `age -d | tar -x` the whole
  recovery procedure; a test asserts that order rather than trusting it.
- **A name too long for ustar is refused, not mangled.** A pax or GNU
  extension would store it by writing extra entries that §6.4's one-entry
  rule then rejects, so producing an archive a conforming reader must refuse
  would be worse than declining to write it.
- **`fjord vault add` landed here**, because an id vault had to be creatable
  before the mode could be used at all. It rewrites `fjord.json` through the
  parsed map, so a field a newer client added survives — invariant 3, with a
  test that plants an unknown object and checks both its presence and its
  key order.
- **`ls` and `grep` read through the container**, so they show and search
  documents by their real names rather than by the ULID on disk.

### What the container taught me

Two test expectations of mine were wrong and the format was right:

1. **A size field larger than the real content is not malformed.** Tar's
   size field *is* the authority on content length, so a header declaring
   400 bytes over a 5-byte body describes a valid 400-byte file whose tail
   is zeros. Rejecting it would reject every document that legitimately ends
   in a NUL byte.
2. **An archive missing only its trailing empty blocks is intact.** The
   entry is complete, and rejecting more than the format requires is its own
   bug.

But the probe that settled those found a real defect: for an archive cut off
*inside* the entry body, the reader returns the bytes it found and reports
no error at all. Without an explicit size check a truncated payload yielded
a short document and called it success. The three windows — mid-body,
mid-padding, past-the-entry — now each carry an assertion, since the correct
behaviour differs in all three and I had guessed two of them wrong.

### A documentation defect found while writing this

This file's **Fixtures section had drifted back to its pre-M1 text**,
claiming `tests/fixtures/broken/` did not exist and assigning placeholder
work to M3 that was finished three milestones earlier. Two separate patches
had reported success against it. Rewritten from what is actually on disk —
and a reminder that a status document is only worth its last verification.

## Fixtures

`tests/fixtures/README.md` is the reference. The completeness guard is
`every_diagnostic_is_covered` in `crates/fjord-core/tests/fixtures.rs`,
which fails if a code has no coverage and is not recorded as unreachable by
a filesystem scan.

| Range | Codes | Committed | Synthesised | Predicate-only |
| --- | --- | --- | --- | --- |
| `E1xx` repository | 9 | 9 | — | — |
| `E2xx` vault | 8 | 8 | — | — |
| `E3xx` encryption | 6 | 5 | — | 1 |
| `E4xx` documents | 5 | 5 | — | — |
| `E5xx` paths | 8 | 1 | 6 | 1 |
| `W6xx` warnings | 4 | 2 | 2 | — |

Two codes cannot be reached by reading a repository, and are covered by
tests on the predicate instead:

- **`E504`** — no mainstream filesystem stores a path component over 255
  bytes, so it can only be caught by validating a name *before* writing it,
  which `fjord new` and `fjord vault add` do.
- **`E303`** — the tar archive is inside the ciphertext (§6.4), so checking
  it needs an identity and `fjord verify` never asks for one. Covered
  exhaustively by `fjord_core::container`, one test per rejection §6.4
  lists, plus an end-to-end test that reading a malformed container reports
  it.

Six of the `E5xx` fixtures are synthesised at test time rather than
committed, because a repository containing them could not be checked out on
some platform — which is the entire reason those rules exist. The committed
fixtures carry real key material: a genuine `age1…` public key and genuine
payloads. The matching identity is deliberately **not** committed, since
nothing committed needs decrypting and the tests that do generate their own
keys in a temporary directory.

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

## Beyond the milestones

`fjord rekey` is implemented, which closes the loop `fjord key add` opens:
age encrypts to the recipients present at write time (§6.2), so a key added
later reads nothing older, and `key add` tells people so. The central test
is the whole point of the command — a second identity cannot read a
document written before it was a recipient, and can after a rekey, while
the original key still can.

Two decisions worth recording:

- **It refuses to lock you out.** One document is re-encrypted to the new
  list and read back *before anything is written*; a result Fjord cannot
  read is a refusal, not a warning. Re-encrypting a vault to a list holding
  none of your identities would make every document in it permanently
  unreadable, and §11.4 leaves no way back — there is no undo to offer
  afterwards. `age -R` remains available for deliberately handing a vault
  to someone else.
- **It says it revokes nothing.** §11.4 makes that a MUST wherever a user
  might infer revocation, and "re-encrypted to the current recipient list"
  is exactly such a place. Tested, like `key remove`'s wording.

Files in the clear inside the vault are left alone: encrypting them would
change their names on disk, which is `fjord encrypt`'s job, not this one's.

| | Item | Status |
| --- | --- | --- |
| | `fjord rekey` | `done` |
| | `fjord export` / `fjord import` | `done` |
| | `cargo deny` in CI, with a dependency policy | `done` |
| | Replace `unsafe-libyaml` as the frontmatter parser | `todo` — see below |
| | M0.5: generate the README diagnostics table from `diagnostics::Code` | `todo` |
| | Release machinery: `dist`, installers, archives | `done` — see below |
| | Cut the first release (`git tag v0.1.0 && git push --tags`) | `todo` — the pipeline has never run |
| | Homebrew tap, crates.io publish | `todo` — neither is advertised until it exists |
| | Frontmatter comment preservation | out of scope for v1; needs an AST-level YAML parser |

### `cargo deny`, and the vulnerability it found

The dependency policy lives in `deny.toml` and is enforced by its own
workflow, which runs when the dependency tree changes and once a week
regardless — not on every push, because a new advisory lands in a
transitive crate on its own schedule and turning unrelated pushes red is
how a check gets switched off. Four policies: advisories, licences, sources
and bans. The sources check matters most here: a git dependency, or a crate
from a registry nobody chose, would be invisible in a diff that only
touched `Cargo.lock`.

**The first run found a vulnerability introduced three milestones earlier.**
RUSTSEC-2023-0071, the Marvin Attack — a key-recovery timing side-channel
in `rsa` with no fixed version available. It reached the tree through
exactly one path: the `age` crate's `ssh` feature, enabled in M3 on the
argument that `fjord verify` accepts `ssh-ed25519` recipients, so a writer
unable to honour them would reject repositories its own verifier calls
conforming. That argument was sound in isolation, and it never weighed what
the feature dragged in. §6.2 makes SSH recipients optional while X25519 is
mandatory, so the feature was dropped rather than the finding ignored.
`crypto::parse_recipients` now refuses an SSH recipient by name, confirms
the vault is still conforming, cites the advisory and says what to do
instead.

Two unmaintained advisories are ignored with reasons on the record. One
deserves a decision rather than acceptance: **`unsafe-libyaml`**, reached
through `serde_yaml_ng`, with no safe upgrade. §8.1 requires a safe YAML
loader and §11.5 names frontmatter as untrusted input, and this is the
least safe part of the tree. CLAUDE.md chose `serde_yaml_ng` because
`serde_yaml` was unmaintained — and the replacement inherited the problem
one level down. Migrating to `saphyr`/`serde-saphyr` means re-proving
invariant 3, so it is a deliberate change and not a passing one.

### `export` and `import`

- **`export` writes outside the repository only.** Anything in a vault gets
  committed and anything in an encrypted vault must never be plaintext
  (§6.5), so a destination inside the repository is refused — tested for a
  plaintext vault, an encrypted vault and the repository root alike. In an
  `id` vault it is where the container earns its keep: files come out under
  their real names, not as ULIDs.
- **`import` promotes Markdown to Docs**, which §8.2 permits on an explicit
  instruction ("MAY assign an `id` ... when the user edits it") while
  forbidding it on a scan. A file that already has an `id` comes in
  untouched, keys and order intact. `doc::promote` fills in `title` and
  `created` only when absent: a file arriving from another tool brings its
  own, and they are better than anything Fjord could invent.
- **Both are all-or-nothing about names.** Every path is checked against §5
  and against what already exists before a byte is written, because a bulk
  operation that stops halfway leaves a state no error message can
  describe.

One test expectation of mine was wrong again, and the behaviour was right:
export-then-import is *not* byte-identical for a file that had no
frontmatter, because import promotes it. It is byte-identical for a file
that was already a Doc, which is the case where losslessness actually
means something — now two separate tests saying so.

## Format change: lowercase identifiers

Spec §8.3 now requires identifiers to be **lowercase**. It required
uppercase until 2026-10-17, and Fjord 0.1.0 wrote uppercase, so repositories
it created no longer conform. This was a deliberate breaking change to a
draft format, made while the cost was lowest: the spec's own header says
"breaking changes possible until declared stable", and the only released
version is hours old.

The ULID specification names uppercase canonical but defines decoding as
case-insensitive, so Fjord's identifier is a **profile** of ULID — the same
128 bits and sort order, one spelling. `scalar::new_ulid` is where the
`ulid` crate's uppercase becomes Fjord's lowercase, and it is the only place
an identifier is minted.

Decisions worth recording:

- **Exactly one form, still.** The tempting alternative was to accept both
  and write lowercase. That would have made every duplicate-id check,
  file-name comparison and merge normalise case first — the negotiation
  §8.3's "exactly one identifier form" exists to prevent. §8.3 now also says
  outright that a client MUST reject an uppercase id rather than fold it.
- **The refusal explains itself.** `scalar::is_ulid_ignoring_case` exists
  *only* to make a rejection helpful: the likeliest reason a valid-looking id
  is refused is that it is the old spelling, and "not a valid ULID" would
  send someone hunting for a typo that is not there. It never accepts
  anything, and a test asserts a genuine typo does **not** get the hint.
- **No migration tool.** Identifiers appear as file names in `id` vaults and
  inside encrypted documents, and §8.2 makes `id` immutable, so a
  trustworthy migration is a real feature rather than a sed script. It was
  not built because nothing real depends on 0.1.0. If something does, that
  is the next piece of work — and `verify --fix` is the wrong home for it,
  since `--fix` never touches document content.
- **Format version stays 1.** The spec is a draft and says so.

Two test mistakes worth noting, both caught before commit: lowercasing the
overflow cases (`8zzz…`) was necessary because left uppercase they would
have been rejected for their case rather than for overflowing, and the five
excluded-letter cases (`i`, `l`, `o`, `u`, `-`) were skipped by the first
search-and-replace because those letters are outside the alphabet it
matched. Both would have kept passing while testing nothing.

**The vendored spec is changed here, and upstream must be too.** CLAUDE.md
says `spec/SPEC.md` is vendored from `fjord-spec` and "never edit it here";
the upstream is not in this tree, so the same §8.3 edit has to be made
there or the next sync will silently revert it.

## Licence

**MPL-2.0**, chosen deliberately over the alternatives and over the
`Apache-2.0 OR MIT` originally declared. The goal was: keep it free, make
changes come back, let anyone profit who contributes back, and allow paid
client applications. File-level copyleft is the only one of the obvious
options that does all four.

- **AGPL-3.0 was considered and rejected.** Its network clause exists to
  cover a server, and CLAUDE.md lists "a daemon, a server, or a sync
  service" under *Out of scope — do not build*, so the clause that
  distinguishes it would do nothing here. It would also block the iOS
  client `fjord-core` is explicitly built for — GPL-family terms and the
  App Store have a long-standing practical conflict — and it would make a
  copyleft reference implementation of a CC0 format, which pushes
  independent implementers to rewrite rather than reuse.
- **LGPL** has the same App Store friction, and its relinking requirements
  were written for dynamic linking and map badly onto Rust's static
  linking.
- **MPL** draws its line around its own files rather than around whatever
  links to them, which is what lets a paid proprietary client embed
  `fjord-core` while modifications to `fjord-core` itself stay open. The
  same terms apply to everyone: no contributor licence agreement, no
  commercial exception, no rights the authors hold and contributors do not.

The specification stays **CC0**. It is meant to outlive this
implementation, and anyone should be able to write another one without
asking.

Two mechanical details worth knowing. The Exhibit A notice is at the top of
every Rust source file, because MPL identifies covered software per file
and a `LICENSE` alone would leave that ambiguous. And
`crates/fjord-core/templates/` is deliberately **excluded**: those files are
copied verbatim into a user's repository by `fjord init`, so a header there
would stamp this licence onto documents that belong to the user.

## Release

Configured in `dist-workspace.toml` and `.github/workflows/release.yml`,
both generated by `dist` (formerly cargo-dist), which CLAUDE.md names as the
tool. A release is cut by pushing a tag; nothing else publishes.

**There is no `fjord.sh`.** The README advertised a `curl | sh` from that
domain, a Homebrew tap and `cargo install fjord-cli` — three routes, none of
which existed. Everything is now fetched from GitHub Releases, and the
installers are themselves release assets, so there is no host to trust
beyond GitHub and this repository.

Two defaults needed changing:

- **Linux targets musl, not gnu.** `dist init` chose `-gnu`, which would
  have broken the README's promise that one Linux binary works on any
  distribution: a glibc build inherits the build machine's glibc version as
  a floor. CI already proves the musl binary is statically linked and then
  runs it.
- **Installers were empty.** `installers = ["shell", "powershell"]` is what
  produces the two commands the README now gives.

Five platforms: macOS on Apple silicon and Intel, Linux on x86-64 and arm64,
Windows on x86-64. Each archive carries the binary, both licences and the
README, with a `.sha256` beside it and a `sha256.sum` over the release.

**The crate had no licence file**, though it had always declared one.
Shipping binaries and a source tarball with no licence text is a real gap
rather than a formality, so `LICENSE` is now present and included in every
archive.

No Homebrew formula yet. `dist` can publish one, but only into a tap
repository that exists — and advertising a tap that does not is the same
mistake as advertising `fjord.sh`.

**The release pipeline has never run.** Pushing a tag is the only thing
that fires it, so it is untested in exactly the way CI was before it was
first run.

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
