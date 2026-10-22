# Fjord Mobile — roadmap

**Status:** planning. Nothing is implemented yet. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work and how each piece is
known to be done. Section numbers (§) refer to `DESIGN.md` unless they say "spec"
or "web".

| | |
| --- | --- |
| `done` | Implemented, tested, released. |
| `next` | Ready to start: its prerequisites are done. |
| `todo` | Not started. |
| `open` | Waits on a decision in `DESIGN.md` §18. |

Every task is one branch and one draft PR (root `CLAUDE.md`, Working conventions).
"Accepts when" is what review checks.

---

## Prerequisites in fjord

These change `fjord-core` or the repository's layout, so they land in `fjord`
itself, before the slices that need them.

**Shared with Fjord Web** (tasks in [`../web/ROADMAP.md`](../web/ROADMAP.md)):
P1 (the spec says `*.fj.md` names a document) and P3 (vault discovery from a
listing). The part of P4 that injects time and randomness into `fjord-core` is
needed here too; its WASM build is not.

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| MP1 | **`fjord-core`: three-way text merge and conflict copies.** A pure-Rust merge of base, ours and theirs (spec §9.1), and the CLI's conflict-copy naming and fresh-id rewrite moved into `fjord-core`, so every client produces the same result without `git merge-file`. Web 1b.10's *combine* can offer it too. | Agrees with `git merge-file` over a corpus of clean and conflicting merges; a conflict copy verifies with the CLI and has a fresh id. Whether `fjord sync` switches to it is §18 #10. | `todo` |
| MP2 | **`fjord-core`: a note's name from its text** (§9): markers stripped, NFC, 60 characters on a word boundary, spec §5 rules, the date-time fallback, and a free name given the folder's existing names. | Property test: every output passes the path rules and never collides, case-insensitively, with the names it was given. | `todo` |
| MP3 | **The engine workspace** (§5): `clients/engine/` with `fjord-client` and `fjord-ffi`, its own lockfile and CI, depending on `crates/fjord-core` by path. | Builds and tests on Linux; the root workspace's lockfile is unchanged. | `open` (§18 #4) |
| MP4 | **Spike: Expo and uniffi on both platforms.** A throwaway Expo development build calling one `fjord-ffi` function (parse a manifest) through uniffi-bindgen-react-native, on an iOS simulator and an Android emulator. | It runs on both; the cost of each binding approach is written down, and the choice (§5) is confirmed or switched to the native-module fallback. | `todo` |
| MP5 | **`fjord-client` foundations**: the provider interface, the local store's schema and migrations, and the credential callback (§5, §11, §13). Dependency choices recorded in the root `CLAUDE.md` table. | A fake provider and an empty store pass the engine's contract tests; no token reaches the store or a log line. | `open` (§18 #5) |
| MP6 | **Component scaffolding**: `clients/mobile` (Expo app, development build, `README.md`, `CHANGELOG.md`, `LICENSE`), its CI workflow with a `changes` job, `scripts/release/mobile.sh`, root layout tables updated. | CI runs only for mobile and engine changes; a placeholder build installs on both platforms; the release component dry-runs. | `todo` |

MP4 comes first: it decides whether the stack in §5 holds before anything is built
on it. 1a needs MP3–MP6 and P3; 1b needs MP1 and P1; 1c needs MP2.

## Phase 1 — plaintext browse, edit, capture and organise

### 1a — Connect and browse

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1a.1 | **GitHub provider in the engine** (§6): repositories, head, tree, blob, multi-file commit without force, conditional head checks. | Contract tests pass against recorded GitHub responses and the fake provider; a moved head refuses the branch update. | `todo` |
| 1a.2 | **The Fjord GitHub App and device flow** (§6): App registered by the owner; sign-in by code; installation page in the system browser; token expiry and refresh settled. | Sign in on both platforms, choose two repositories, see them; how an expired token is handled is written into §6 and tested. | `todo` |
| 1a.3 | **PAT connection** (§6): URL and fine-grained token; permissions checked on add. | A read-only token is refused with a clear message; a correct one works. | `todo` |
| 1a.4 | **Tokens in the keystore** (§13). | Tokens survive a restart, are gone on removing the connection, and are not in the app's files or logs. | `todo` |
| 1a.5 | **First run and defaults** (§3, §6): prompt to add a repository; default repository; default vault per repository; switcher. | A fresh install is prompted; the next launch opens the default repository and vault. | `todo` |
| 1a.6 | **Not a Fjord repository** (§6): shown as such, read-only, capture unavailable. | Behaviour matches web §19 #3's answer. | `open` |
| 1a.7 | **Local store and tree cache** (§7, §11): listings by commit, blob cache, head checks on foreground, refresh and every minute. | Browsing a cached repository in airplane mode works; an unchanged head costs no rate limit (conditional request seen). | `todo` |
| 1a.8 | **File browser** (§7): vaults from the listing (P3), documents and notes openable, others greyed, encrypted vaults locked, cached files marked, large repositories listed per directory. | Matches `fjord ls` on the fixtures; nothing downloaded to draw it. | `todo` |
| 1a.9 | **App lock** (§13), optional. | With it on, nothing is shown before Face ID, Touch ID or the device credential; the app switcher shows a blank. | `todo` |

### 1b — Read, write, sync

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1b.1 | **Viewer** (§8): rendered Markdown, sanitised, raw HTML as text, remote images on tap, task boxes toggle one character. | Every file in a rendering corpus displays; a toggled box changes one byte in the saved file. | `todo` |
| 1b.2 | **Basic editor** (§8): source text input, keyboard row, continuous drafts. | Round-trip corpus: open, edit one word, save, the diff is that word; opening and leaving makes no draft. | `todo` |
| 1b.3 | **Frontmatter and Info** (§8): header through `fjord-core`; Info sheet; a note without a header left without one. | A header with keys Fjord does not know round-trips byte for byte; a header-less note gets none. | `open` (§18 #2) |
| 1b.4 | **Create** (§8): documents and notes, vault and folder chosen. | Created files verify with the CLI. | `todo` |
| 1b.5 | **Sync queue and push** (§12): when it runs, one commit per sync, messages, author, retry on a moved head, background tasks. | Five offline edits become one commit with the right author and message; a concurrent push in between is retried, never forced. | `todo` |
| 1b.6 | **Pull and merge** (§12): every row of the table in §12; conflict copies (MP1). | A test per row, against a real repository with fabricated upstream commits; an unmergeable edit leaves both versions in the pushed commit and a badge. | `todo` |
| 1b.7 | **Sync status** (§12): drafts waiting, last sync, rate-limit pause. | Shown on both platforms; a rate limit reached loses nothing and resumes. | `todo` |
| 1b.8 | **Drafts are durable** (§11). | Killing the app mid-edit, rebooting, and revoking the token each keep every draft; a draft goes only when its commit is pushed. | `todo` |

### 1c — Quick capture

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1c.1 | **Capture screen** (§9): from the main screen, keyboard up, saved as typed, empty capture leaves nothing. | From a cold start to typing is measured and recorded; a killed app keeps what was typed. | `todo` |
| 1c.2 | **App-icon quick action** (§9): **New note**, on both platforms. | Long-press, New note, typing. | `todo` |
| 1c.3 | **Inbox and naming** (§9, MP2): `Inbox/` created when missing; name fixed when queued; header written. | Notes captured offline sync with the expected names; a name clash in `Inbox/` gets a suffix; every quick note verifies with the CLI. | `todo` |

### 1d — Organise

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1d.1 | **Rename and move** (§10): files and folders in plaintext vaults; names by `fjord-core`; extension kept; into an encrypted vault refused; offline as drafts. | One commit per action, or one line in a batched sync; a case-only clash and an encrypted destination are refused; the CLI verifies the result. | `todo` |
| 1d.2 | **Delete, Undo, Recently deleted** (§10): confirmation; Undo before push; the local deletion record; restore to the old or a chosen path. | Restoring onto a taken path never overwrites; the record survives a restart; an entry past the window is gone. | `todo` (§18 #11) |
| 1d.3 | **Organising against upstream changes** (§12): the rename, move and delete rows of the merge table. | A test per row; no upstream edit is lost to a local delete or move. | `todo` |
| 1d.4 | **Security review of phase 1** (§13): tokens, storage protection, rendering, app lock, logs. | Findings fixed or recorded before the first store release. | `todo` |
| 1d.5 | **First store release** (§16): listings, privacy declarations ("collects nothing"), `mobile-v1.0.0` (or a 0.x first) through the release flow. | Live on the App Store and Google Play; the tag is not *Latest*. | `todo` (§18 #7) |

### 1e — Capture without opening the app

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1e.1 | **Share sheet** (§9): text and links shared from other apps become a quick note. | Sharing from a browser and a messaging app lands a note in `Inbox/`, offline too. | `todo` |
| 1e.2 | **Home-screen widget** (§9): one tap to capture; on iOS WidgetKit, on Android a Glance or AppWidget. | Tapping it opens the capture screen ready to type. | `todo` |
| 1e.3 | **App Intents and Shortcuts** (iOS) (§9): "New Fjord note" with text, usable from Siri and Shortcuts. | A Shortcut creates a note without opening the app. | `todo` |
| 1e.4 | **Quick-settings tile** (Android) (§9). | Tapping it opens the capture screen. | `todo` |

## Phase 2 — encrypted vaults

In outline; tasks are written when phase 1 is done.

- Import an age identity from a file or a QR code; keep it in the keystore behind
  biometrics; use it in memory only (§13).
- Browse encrypted vaults (names in `plain` naming; ids in `id` naming), open, edit,
  and commit ciphertext only; drafts kept encrypted to the vault's recipients.
- Merge in encrypted vaults the way spec §9.1 requires: decrypt both sides and the
  base in memory, merge, re-encrypt.
- Rename, move and delete in encrypted vaults, and moving files in and out of them;
  quick capture into an encrypted default vault.

## Phase 3 — richer editing

In outline.

- The document editor from `packages/fjord-editor` in a WebView, for `*.fj.md`.
- Open in Fjord Web: hand a document to a configured web instance to share it or
  comment on it.

## Later

GitLab, Forgejo/Gitea and other git servers (a provider each); search over cached
files (§18 #6); reminders; attachments (§18 #1); Apple Watch and Wear OS capture;
the desktop client on the same engine.
