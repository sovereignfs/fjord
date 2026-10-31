# Build brief: the Fjord monorepo

This file is instructions for whoever implements this repository, human or
model. Read it before writing code.

This is a monorepo: the format's specification, its reference implementation
(`fjord-core` and the CLI) and, as they are built, every first-party client and
editor integration live here, so that a change to the format and the code that
implements it is one commit. [Repository layout](#repository-layout) says what
lives where, and [Adding a component](#adding-a-component) what a new one owes
the rest. Everything from "Non-negotiable invariants" down is the brief for
`fjord-core` and the CLI; a component with conventions of its own gets its own
`CLAUDE.md` in its directory.

## Prime directive

**`docs/specs/Fjord.spec.md` is authoritative. This file is not.** Where they disagree, the
spec wins and this file is wrong and should be fixed. Where the spec is
silent, prefer the option that keeps a repository readable without Fjord.

The CLI is the *reference implementation* of a published format. Its job is
to be correct and boring, not clever. A behaviour that makes the tool nicer
at the format's expense is a bug.

The spec is `docs/specs/Fjord.spec.md`, in this repository, and it is edited here: there is
no other copy. A change to the format lands in the same commit as the code
that needs it, and every client reads the same file.

## Working conventions

How work gets into `main`. It is the flow `sovereignfs/sovereign` uses, trunk-based
with short-lived branches, and `CONTRIBUTING.md` is the same rules for people.

- **One task, one branch, one PR.** Branch from an up-to-date `main`
  (`git switch main && git pull`), named by the kind of change: `feat/<slug>`,
  `fix/<slug>`, `docs/<slug>`, `chore/<slug>`. Keep a PR to one logical change.
  Do not start a second task on a branch whose PR is not merged.
- **Nothing goes to `main` directly.** Not a typo, not a docs fix, not a
  release. The one standing exception is the owner's bypass, which is theirs to
  use and not something to reach for.
- **Commits explain why, not just what.** Subject under 72 characters, body
  wrapped at 100. Every commit an agent makes ends with
  `Co-Authored-By: Claude Code <noreply@anthropic.com>` — model-agnostic, never
  a specific model name. One logical change per commit; do not mix a rename
  with a behaviour change.
- **PRs are opened as drafts** (`gh pr create --draft --base main`) and marked
  ready only when told to. The body says what changed and why, cites the spec
  section when the format is involved, and ends with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Merge with rebase and merge**, never squash and never a merge commit, so each
  reviewed commit lands on `main` verbatim. Fix commit messages *before*
  merging; never rewrite `main`. **Never merge a PR automatically**: wait to be
  told, or ask.
- **Docs are part of the change.** A change to the format updates `docs/specs/Fjord.spec.md`,
  the fixtures under `tests/fixtures/` and the code in the same PR. A change to
  behaviour adds a line under `## [Unreleased]` in the component's CHANGELOG.
  A README or ROADMAP statement that the change makes false is fixed in it. A finished task is marked done in its roadmap row
  and its epic under `docs/epics/` says how it was done (what, where, what was left out).
- **Verify before claiming done.** Run `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo test --workspace`, and show the output. A regression test is trusted
  only after it has been seen to fail against the code it guards.
- **CI** runs on pull requests, and also on pushes to `main` (see below). It is
  skipped while a PR is a draft or carries the `skip-ci` label; marking the PR
  ready runs it. A first job works out what the change touches
  (`scripts/ci-changes.sh`, with tests), so a change to documentation alone runs
  nothing more. A new kind of file that the build or tests read must be added to
  that script, or CI will skip the change that breaks it.
- **Releases are their own PR.** Version bumps do not ride in feature PRs: changes
  accumulate under `[Unreleased]`, and `scripts/release.sh` makes a
  `chore/release-<component>-X.Y.Z` branch with one `Release <package> X.Y.Z`
  commit, opens it as a draft PR, and tags the merged commit. See `RELEASING.md`.

Where this differs from `sovereign`, on purpose:

1. **CI also runs on push to `main`.** The release step tags a commit and needs CI
   green on *that exact commit*; rebase-and-merge creates new SHAs, so a PR's run
   does not vouch for the commit that lands.
2. **Version bumps are a release PR's job**, not every PR's. `fjord-core` and the CLI
   share one workspace version and the changelog is the release notes.
3. **There is no CLA.** Contributions are licensed under the MPL-2.0 on the way in.

## Repository layout

| Path | What | Licence | Released as |
| --- | --- | --- | --- |
| `docs/` | `specs/Fjord.spec.md`, the format, canonical (CC0, the licence is in the file itself); `epics/`, the detail of every task of every roadmap; the security reviews | CC0 for the spec, MPL-2.0 for the rest | with whatever needs it |
| `schema/`, `tests/fixtures/` | The `verify --json` schema, and the conformance fixtures **every** client must pass | MPL-2.0 | — |
| `crates/fjord-core/` | The format as a library | MPL-2.0 | with the CLI |
| `crates/fjord-cli/` | The CLI: package `fjord-cli`, binary `fjord` | MPL-2.0 | `fjord-cli-vX.Y.Z` |
| `crates/fjord-wasm/` | `fjord-core`'s pure subset for WebAssembly (`wasm-bindgen`): vault discovery from a listing, manifests, path rules, frontmatter, identifiers from a supplied clock and randomness. Its own workspace and lockfile, built into the web client and not released on its own. See its [`README.md`](crates/fjord-wasm/README.md) | MPL-2.0 | — |
| `clients/web` | The hosted web client (Next.js, pnpm). **Phase 1 is built (sign in, browse, write, share, comment):** [`DESIGN.md`](clients/web/DESIGN.md), [`ROADMAP.md`](clients/web/ROADMAP.md), and its own [`CLAUDE.md`](clients/web/CLAUDE.md) | AGPL-3.0-or-later (it bundles `@sovereignfs/ui`) | `web-vX.Y.Z` |
| `packages/fjord-editor` | The document and note editors, shared by the clients: the interface, the note editor (CodeMirror) and a text area behind the document editor so far (`clients/web/DESIGN.md` §10; its own [`CLAUDE.md`](packages/fjord-editor/CLAUDE.md)). Its own pnpm project, built and tested alone | MPL-2.0, and independent of `@sovereignfs/ui` (`clients/web/DESIGN.md` §18) | with its users |
| `clients/mobile` | The iOS and Android client (Expo). **Design only so far:** [`DESIGN.md`](clients/mobile/DESIGN.md), [`ROADMAP.md`](clients/mobile/ROADMAP.md) | MPL-2.0 | `mobile-vX.Y.Z` |
| `clients/engine` | The Rust engine for the native clients (`fjord-client`, `fjord-ffi`) and the `fjord-mcp` binary, its own Cargo workspace. Not created yet | MPL-2.0 | with its users |
| `clients/mcp` | `fjord-mcp`, the MCP server for Claude and later ChatGPT. **Design only so far:** [`DESIGN.md`](clients/mcp/DESIGN.md), [`ROADMAP.md`](clients/mcp/ROADMAP.md) | MPL-2.0 | `mcp-vX.Y.Z` |
| `clients/desktop` | Not created yet | — | its own tag |
| `plugins/vscode`, `plugins/obsidian` | Not created yet | — | their own tags |

Directories are created when the component starts, not before.
A client that is not to be open source lives in its own private repository and
depends on `fjord-core`; it does not belong here.

## Adding a component

1. Its own directory, its own `README.md`, its own `CHANGELOG.md`.
2. It passes `tests/fixtures/`. The fixtures are the format's conformance suite,
   not the CLI's.
3. Its own CI workflow that runs only for changes that can affect it (`paths`
   filters, or a `changes` job like `ci.yml`'s), so it does not run the Rust
   matrix and the Rust matrix does not run for it.
4. A release entry in `scripts/release/<component>.sh` and a tag prefix
   `<component>-vX.Y.Z`. See `RELEASING.md`. A component's release is never
   marked *Latest*; the CLI's is, because the install URLs depend on it.
5. A GUI application gets its own lockfile and is not a member of the CLI's
   Cargo workspace, so `cargo deny`, the MSRV and the CLI's lockfile stay small.
6. It never reimplements the format. `fjord-core` stays portable for exactly
   this: Tauri, FFI and WASM (see Architecture below).

## Non-negotiable invariants

Breaking any of these is a release blocker, not a refactor.

1. **Never write plaintext into an encrypted vault, except through a
   checkout.** Not temporarily, not as a dotfile, not "just to stage it".
   Decrypted content lives in a tempdir outside the repository or in memory.
   The single exception is spec §6.6: `fjord decrypt <vault>` at the user's
   explicit request, recorded under `.fjord/local/`, with every command that
   commits refusing until `fjord encrypt <vault>` ends it. Nothing else may
   write a decrypted file into a vault, and `fjord decrypt <file> --out` into
   one stays refused.
2. **Never put a secret in `argv` or an environment variable the tool
   prints.** Identities arrive as a file path or on stdin. `ps` output and
   shell history are public.
3. **Preserve unknown fields.** Unknown frontmatter keys, unknown manifest
   fields. Round-tripping a file written by a newer client, or by Obsidian,
   must not lose data. Spec §8.2 and §10.1.
4. **Never write to a repository whose `fjord` version exceeds the one we
   implement.** Read-only, with a clear message. Spec §10.1.
5. **Never destroy a conflicting version.** If a merge cannot complete, both
   sides survive on disk. Spec §9.1.
6. **The filesystem is authoritative.** Never quarantine, rename or delete a
   file because it is absent from a manifest. Repair the manifest instead.
7. **`fjord verify` must not mutate anything.** `--fix` is a separate code
   path with an explicit allowlist of safe repairs.

## Architecture

```
fjord/
├── Cargo.toml                 workspace (fjord-core and the CLI)
├── crates/
│   ├── fjord-core/            the format. no IO beyond std::fs.
│   └── fjord-cli/             the binary. clap, terminal, git.
├── docs/specs/Fjord.spec.md   the format. canonical, edited here
├── schema/  tests/fixtures/   shared by every component
└── clients/  plugins/         when they exist; see Repository layout
```

**`fjord-core` must stay portable.** It is compiled into the Tauri
desktop app, iOS/Android via FFI, and the web client via WASM
(`crates/fjord-wasm`). It has two builds: the default `native` feature is
everything, and without it (`default-features = false`) it is the **pure
subset** (manifests, documents, path rules, discovery from a listing,
identifiers from a supplied clock and randomness) that compiles to
`wasm32-unknown-unknown`. Anything that reads a disk or needs `age` or `tar`
goes behind `native`; the pure subset must keep building for wasm32, and CI
checks it does. Therefore, in `fjord-core`:

- No `std::process::Command`. No shelling out to anything, ever.
- No terminal IO, no `println!`, no colour, no progress bars. Return data.
- No `git`. Git is the binary's concern.
- Keep filesystem access behind the few functions that genuinely need it, so
  a WASM virtual filesystem can be slotted in later without a rewrite.
- No system clock and no random source in the pure subset: a function that
  makes a time or an identifier takes them as arguments
  (`scalar::new_ulid_from`, `scalar::rfc3339_utc_from_unix`), and the native
  convenience that reads them (`new_ulid`, `now_rfc3339_utc`) is behind
  `native`.

**`fjord` (the binary)** owns everything `fjord-core` refuses to: argument
parsing, prompting, colour, the editor round trip, and git.

**Git is invoked by shelling out to `git`** in v1, confined to
`crates/fjord-cli/src/git.rs` behind a narrow interface. The user already has
git. This sidesteps the `git2`-vs-`gix` decision and saves substantial time.
When the clients need git without a binary, implement that trait with `gix`
in a separate crate — do not scatter `Command::new("git")` through the
codebase.

## Dependencies — already decided, do not relitigate

| Need | Crate | Why |
| --- | --- | --- |
| age encryption | `age` | Pure Rust, maintained, no C deps — keeps static musl builds clean. |
| CLI parsing | `clap` (derive) | Standard. |
| Identifiers | `ulid` | Spec §8.3 mandates ULID. |
| YAML | `serde_yaml_ng` | `serde_yaml` is unmaintained and archived. |
| Ordered maps | `indexmap` | Needed to preserve frontmatter key order. |
| JSON | `serde_json` with `preserve_order` | Same reason, for manifests. |
| Tar container | `tar` | Spec §6.4. |
| Tree walking | `ignore` | Respects `.gitignore`, which matters: a gitignored plaintext file is not vault content. |
| NFC normalisation | `unicode-normalization` | Spec §5.1. |
| Temp files | `tempfile` | Correct permissions by default. |
| Secret hygiene | `zeroize` | Wipe key material and decrypted buffers. |
| Change detection | `blake3` | Hash plaintext before/after an edit session. |
| Library errors | `thiserror` | Typed errors with codes. |
| Binary errors | `anyhow` | Context chains at the top level. |
| Colour | `owo-colors` | Must honour `NO_COLOR`. |

### The frontmatter trap

`serde` will silently drop unknown YAML keys, which violates invariant 3.
Capture them:

```rust
#[derive(Serialize, Deserialize)]
pub struct Frontmatter {
    pub id: Ulid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    // …
    #[serde(flatten)]
    pub extra: IndexMap<String, serde_yaml_ng::Value>,
}
```

This preserves unknown keys and their order. It does **not** preserve
comments — the spec permits that (§8.2: comments SHOULD, keys MUST). Do not
attempt comment preservation in v1; it needs an AST-level parser and is not
worth the complexity yet. Document the limitation in the README.

## Conventions

- **No `unwrap`, `expect` or panic in `fjord-core`.** Return `Result`. The
  binary may `expect` only on genuine programmer errors.
- **Every diagnostic has a stable code.** They are published API — once
  released, a code's meaning never changes. Add new ones; never renumber.
  The enum in `fjord-core/src/diagnostics.rs` is the single source of truth,
  and the README's tables are held to it by `crates/fjord-cli/tests/readme_diagnostics.rs`
  (a code without a row, a row without a code, a wrong heading or an unexplained gap fails).
- **Exit codes:** `0` success or conforming, `1` problems found, `2` usage
  error, `3` IO or git failure.
- **Interactive on a TTY, scriptable otherwise.** `std::io::IsTerminal`.
  Honour `--no-input`; with it, prompting is a usage error, never a hang.
- **`--json` on every command that reports.** CI consumes it.
- `rustfmt` default. `clippy -- -D warnings` must pass.

## Milestones

Each milestone ends with its acceptance criteria met and tests passing. Build
them in order; do not start the next until `cargo test` is green.

### M1 — `fjord verify`, read-only, no crypto

Parse both manifests, discover vaults from the filesystem, validate paths,
parse frontmatter, classify Docs vs vault files, emit coded diagnostics.

*Accepts when:* `fjord verify` on `tests/fixtures/conforming/` exits 0 with
no diagnostics; each fixture under `tests/fixtures/broken/` emits exactly its
expected code; `--json` output validates against a schema; nothing on disk
changes.

### M2 — `fjord init`

Scaffold a conforming repository, `git init`, first commit. Interactive and
`--no-input` paths both work.

*Accepts when:* `fjord init x && cd x && fjord verify` exits 0.

### M3 — crypto: keys, encrypt, decrypt

`fjord key new|add|list|remove`, `fjord encrypt`, `fjord decrypt`. Container
mode `none` only.

*Accepts when:* a file encrypted by `fjord` decrypts with the real `age`
binary and vice versa — see the cross-validation job below. `key remove`
prints the revocation warning from spec §11.4.

### M4 — `fjord open`

Decrypt to tempfile, launch `$EDITOR`, re-encrypt on change, shred.

*Accepts when:* all four edge cases are handled and tested — GUI editors that
fork (append `--wait` for known ones), no re-encryption when the plaintext
hash is unchanged, SIGINT/SIGTERM cleanup, and a lock preventing concurrent
opens of one file.

### M5 — `fjord new`, `ls`, `status`, `grep`

*Accepts when:* `fjord new` produces a Doc that `fjord verify` passes;
`grep` searches decrypted content in an encrypted vault.

### M6 — `fjord sync`

Pull, detect conflicts, resolve by decrypt → three-way merge on plaintext →
re-encrypt, push.

*Accepts when:* a test fabricates divergent commits touching one encrypted
Doc and sync produces a correctly merged result; an unresolvable merge leaves
both versions on disk and exits 1.

### M7 — `fileNaming: "id"` and the tar container

*Accepts when:* a vault in id mode round-trips a file whose name contains a
space; `age -d | tar -x` recovers the original name; the malformed-archive
rejections of spec §6.4 are all tested.

## Testing

**Fixtures.** `tests/fixtures/conforming/` is one valid repository.
`tests/fixtures/broken/<code>/` is a minimal repository that triggers exactly
diagnostic `<code>`. Adding a diagnostic means adding a fixture.

**Cross-validate against the reference age implementation.** We use the Rust
`age` crate, not the Go original, so CI must prove they agree: encrypt with
`fjord`, decrypt with the `age` binary; encrypt with `age -R`, decrypt with
`fjord`. This is the most important test in the repository — it is what
backs the claim that `age -d` is sufficient for recovery.

**Golden output.** `fjord verify` human-readable output is snapshot-tested so
formatting changes are deliberate.

**Property test** the path rules (§5) and frontmatter round-tripping: parse →
serialise → parse must be a fixed point, with unknown keys intact.

## Commands

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

Release builds use `cargo-dist`; Linux targets are musl for static linking.

## Out of scope — do not build

Not in v1, and not to be added speculatively because they seem easy:

- Sharing, publishing, trash, non-Git storage, nested vaults. Spec §12.
- Photo or video handling. Permanently out of scope.
- Any cryptography other than unmodified `age`. If a change would mean
  `age -d` no longer suffices to recover a file, it is wrong.
- A daemon, a server, or a sync service.
- `fjord-core` depending on git, a terminal, or a subprocess.
