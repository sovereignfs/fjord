# Build brief: fjord-cli

This file is instructions for whoever implements this repository, human or
model. Read it before writing code.

## Prime directive

**`SPEC.md` is authoritative. This file is not.** Where they disagree, the
spec wins and this file is wrong and should be fixed. Where the spec is
silent, prefer the option that keeps a repository readable without Fjord.

The CLI is the *reference implementation* of a published format. Its job is
to be correct and boring, not clever. A behaviour that makes the tool nicer
at the format's expense is a bug.

A copy of the spec lives at `spec/SPEC.md` (vendored from `fjord-spec`). Keep
it in sync; never edit it here.

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
fjord-cli/
├── Cargo.toml                 workspace
├── crates/
│   ├── fjord-core/            the format. no IO beyond std::fs.
│   └── fjord/                 the binary. clap, terminal, git.
└── spec/SPEC.md               vendored, read-only
```

**`fjord-core` must stay portable.** It will later be compiled into the Tauri
desktop app, iOS/Android via FFI, and the web client via WASM. Therefore, in
`fjord-core`:

- No `std::process::Command`. No shelling out to anything, ever.
- No terminal IO, no `println!`, no colour, no progress bars. Return data.
- No `git`. Git is the binary's concern.
- Keep filesystem access behind the few functions that genuinely need it, so
  a WASM virtual filesystem can be slotted in later without a rewrite.

**`fjord` (the binary)** owns everything `fjord-core` refuses to: argument
parsing, prompting, colour, the editor round trip, and git.

**Git is invoked by shelling out to `git`** in v1, confined to
`crates/fjord/src/git.rs` behind a narrow interface. The user already has
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
  and the README table is generated from it.
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
