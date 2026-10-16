# Roadmap

Sequencing and status for `fjord-cli`. **This file tracks progress; it does
not define behaviour.** `spec/SPEC.md` is authoritative on the format and
`CLAUDE.md` on how to build it — where either disagrees with this file, this
file is stale and should be corrected.

State as of 2026-10-16: **M1 complete and green.** `fjord verify` is
implemented end to end — `scalar`, `path`, `manifest`, `doc` and `verify` in
the core, `cmd/verify` in the binary. 81 tests pass; `clippy -- -D warnings`
and `cargo fmt --check` are clean. All four of M1's acceptance criteria hold:
the conforming fixture exits 0 with no diagnostics, each `broken/` fixture
emits exactly its code, `--json` is checked against
`schema/verify.schema.json`, and a blake3 digest of the tree proves nothing
on disk changes.

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
| M2 | `fjord init` | `cmd/init`, `git` | `todo` |
| M3 | Keys, encrypt, decrypt | `crypto` | `todo` |
| M4 | `fjord open` | `cmd/open` | `todo` |
| M5 | `new`, `ls`, `status`, `grep` | `cmd/*` | `todo` |
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
| age cross-validation | `fjord` encrypts → `age -d` decrypts, and `age -R` encrypts → `fjord` decrypts | `todo` — M3 |
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
