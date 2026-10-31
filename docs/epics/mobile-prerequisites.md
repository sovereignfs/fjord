# Fjord Mobile — Prerequisites in fjord

The detail of the tasks in this part of [`clients/mobile/ROADMAP.md`](../../clients/mobile/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mobile/DESIGN.md`](../../clients/mobile/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## MP1 `fjord-core`: three-way text merge and conflict copies

**Status:** ✅ Done

A pure-Rust merge of base, ours and theirs (spec §9.1), and the CLI's conflict-copy naming and fresh-id rewrite moved into `fjord-core`, so every client produces the same result without `git merge-file`. Web 1b.10's *combine* can offer it too.

**Accepts when:** Agrees with `git merge-file` over a corpus of clean and conflicting merges; a conflict copy verifies with the CLI and has a fresh id. Whether `fjord sync` switches to it is §18 #10. **Also the add/add rule** (§12): two different files added at one path are both kept, upstream's in place and ours moved to the next free number, with no conflict; one `id` twice is merged from an empty base.

- **Done as:** `fjord_core::merge` (`merge3`, `conflict_copy_path`, `conflict_copy_text`, `add_add`), pure and in the WebAssembly subset; held to the real `git merge-file` by `crates/fjord-cli/tests/merge_agreement.rs` (every one of 2,000 generated merges and 26 written out agree on clean or conflicted and on the text; 3.6% of merges of very repetitive text differ, none losing a change, because git and `fjord-core` may pick different shortest comparisons); `fjord sync` now names its conflict copies through it, and a conflicted `.fj.md` document's copy stays a document. `fjord sync` still merges with `git merge-file` (§18 #10). Not yet exported through `fjord-wasm`.

## MP2 `fjord-core`: a note's name from its text

**Status:** ✅ Done

**Design:** §9

Markers stripped, NFC, 60 characters on a word boundary, spec §5 rules, the date-time fallback, and a free name given the folder's existing names.

**Accepts when:** Property test: every output passes the path rules and never collides, case-insensitively, with the names it was given.

- **Done as:** `fjord_core::naming` (`quick_note_name`, `title_from_text`, `free_name`, `date_time_stem`), pure and in the WebAssembly subset; the caller supplies the local time and the names in the folder. Held by a 20,000-case property test, and each rule seen to fail with it switched off. Not yet exported through `fjord-wasm`: the web client's 1b.7 will need that.

## MP3 The engine workspace

**Status:** 🚧 Open (§18 #4)

**Design:** §5

`clients/engine/` with `fjord-client` and `fjord-ffi`, its own lockfile and CI, depending on `crates/fjord-core` by path.

**Accepts when:** Builds and tests on Linux; the root workspace's lockfile is unchanged.

## MP4 Spike: Expo and uniffi on both platforms

**Status:** 📋 Planned

A throwaway Expo development build calling one `fjord-ffi` function (parse a manifest) through uniffi-bindgen-react-native, on an iOS simulator and an Android emulator.

**Accepts when:** It runs on both; the cost of each binding approach is written down, and the choice (§5) is confirmed or switched to the native-module fallback.

## MP5 `fjord-client` foundations

**Status:** 🚧 Open (§18 #5)

The provider interface, the local store's schema and migrations, and the credential callback (§5, §11, §13). Dependency choices recorded in the root `CLAUDE.md` table.

**Accepts when:** A fake provider and an empty store pass the engine's contract tests; no token reaches the store or a log line.

## MP6 Component scaffolding

**Status:** 📋 Planned

`clients/mobile` (Expo app, development build, `README.md`, `CHANGELOG.md`, `LICENSE`), its CI workflow with a `changes` job, `scripts/release/mobile.sh`, root layout tables updated.

**Accepts when:** CI runs only for mobile and engine changes; a placeholder build installs on both platforms; the release component dry-runs.
