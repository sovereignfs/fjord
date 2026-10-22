# Fjord Mobile — design

**Status:** draft, written during the brainstorming and documentation phase
(2026-10-22). Nothing here is implemented. Where this file and
[`spec/SPEC.md`](../../spec/SPEC.md) disagree, the spec wins: this is the design
of one client, and the spec is the format every client follows.

[`ROADMAP.md`](ROADMAP.md) turns this into phases and tasks. Much of it mirrors
[Fjord Web's design](../web/DESIGN.md); where the two differ, §14 says how and why.

---

## 1. Purpose

Fjord is a way to keep your own simple cloud: files in a Git repository you
control, with optional end-to-end encryption, readable without Fjord. **Fjord
Mobile** is the iOS and Android client: browse and edit your repositories from a
phone, and capture quick notes the moment you think of them. Its aim is a worthy
alternative to Google Keep and Apple Notes for people who want to own their notes.

It is **another client of the format**, a peer of the CLI and of Fjord Web, not a
window onto either. It talks to the git host itself, and needs no Fjord Web
instance and no server of its own.

What it must not give up, whatever the convenience:

- **The files stay plain.** A note captured on the phone is a Markdown file in the
  user's repository that GitHub renders, Obsidian opens and `git diff` reads.
- **Git is the storage.** The phone keeps a cache and drafts not yet pushed; the
  repository keeps the authoritative copy.
- **Writing never waits for the network.** Capturing and editing work offline;
  sync catches up. A note is never lost because the phone had no signal.
- **Nothing is collected.** No account with Fjord, no analytics, no telemetry. The
  app talks to the user's git host and nothing else.
- **One implementation of the format.** The app uses `fjord-core`, through a Rust
  engine and native bindings, for everything the spec defines. It never
  reimplements the format (root `CLAUDE.md`, "Adding a component").

## 2. Phases

| Phase | What it delivers |
| --- | --- |
| **1** | GitHub repositories, defaults, a file browser, a basic editor for **plaintext** documents and notes, quick capture, renaming, moving and deleting, offline use and sync. |
| **2** | Encrypted vaults on the phone: the age identity in the platform keystore, decrypt to read and edit, re-encrypt on save. |
| **3** | Richer editing: the document editor from `packages/fjord-editor`, and handing a document to a Fjord Web instance to share or comment on. |
| Later | Other git hosts, search, reminders, attachments (§18), Apple Watch and Wear OS capture. |

Phase 1 ships in slices (§15), each usable on its own.

## 3. User journeys

1. **Installing** the app and opening it for the first time asks the user to add a
   repository (§6): sign in to GitHub and choose repositories, or give a repository
   URL and a fine-grained token. More can be added later. The first one added is
   the default repository, and each repository has a default vault.
2. **Each launch after that** opens the default repository's view: its vaults, as in
   a file manager. The user switches repository from the header.
3. **Browsing** works as on the web (§7): names and folders, documents and notes
   openable, other files greyed out, encrypted vaults locked. What has been opened
   before is there offline.
4. **Opening** a document (`name.fj.md`) or a note (any other `.md`) shows it
   rendered; **Edit** switches to its Markdown source (§8).
5. **Quick capture** (§9): one tap from the app's main screen or from the app icon
   opens a blank note with the keyboard up. What is typed is saved on the phone at
   once, and lands in `Inbox/` of the default vault, named from its first line.
6. **Organising** (§10): rename, move or delete a document, note or folder; undo a
   deletion at once, or restore it later from **Recently deleted**.
7. **Sync** happens by itself (§12): when the app comes to the foreground, after an
   edit, and on pull-to-refresh. Several changes become one commit. If a file
   changed elsewhere meanwhile, the two versions are merged; if they cannot be, both
   are kept and the user is told.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| **Connection** | The app's link to one repository through a provider (§6). |
| **Default repository / vault** | Where the app opens, and which vault opens first per connection; also where quick notes go. |
| **Document** | A file named `*.fj.md`. |
| **Note** | Any other `.md` file in a vault. |
| **Quick note** | A note made by quick capture (§9); an ordinary note once saved. |
| **Inbox** | The folder `Inbox/` in the default vault, where quick notes land. |
| **Draft** | A change made on the phone and not yet pushed: an edit, a new file, a rename, a move or a delete. |
| **Base** | The blob a draft started from, used to merge (§12). |
| **Engine** | The Rust library that does the app's work below the UI (§5). |

## 5. Architecture

```
 ┌──────────────────────────── the phone ────────────────────────────┐
 │  Expo app (React Native, TypeScript)                              │
 │    screens: browser, viewer, editor, capture, settings            │
 │    expo-secure-store: tokens (Keychain / Keystore)                │
 │    native targets, slice 1e: widget, share extension, intents     │
 │                      │  uniffi bindings (fjord-ffi)               │
 │  ┌───────────────────▼─────────────────────────────────────────┐  │
 │  │ engine (Rust): fjord-client                                  │  │
 │  │   provider: GitHub REST       local store: SQLite + files    │  │
 │  │   sync queue, three-way merge, conflict copies               │  │
 │  │   fjord-core: manifests, discovery, paths, frontmatter, age  │  │
 │  └─────────────────────────────────────────────────────────────┘  │
 └──────────────────────────────────┬────────────────────────────────┘
                                    │ HTTPS
                             GitHub REST API
```

- **Expo (React Native) for the UI**, one codebase for iOS and Android, in the same
  TypeScript and React as Fjord Web. Expo's development builds and `prebuild`, not
  Expo Go, because the app carries native code.
- **A Rust engine below it.** Everything that is not drawing a screen lives in Rust,
  so it is written once, tested without a phone, and reused by the desktop client
  later:
  - `fjord-core` for the format, unchanged and still free of network, terminal and
    subprocess (root `CLAUDE.md`, Architecture).
  - **`fjord-client`**, new: the provider (§6), the local store (§11), the sync
    queue and merge (§12). It is where network and storage live, so `fjord-core`
    does not have to.
  - **`fjord-ffi`**, new: the uniffi interface over `fjord-client`, with bindings
    generated for React Native by
    [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native).
    If that proves unsuitable (ROADMAP MP4 is a spike), the fallback is a thin Expo
    native module per platform over uniffi's mature Swift and Kotlin bindings.
- **The engine never holds a credential at rest.** Tokens live in the platform
  keystore through `expo-secure-store`; the engine asks the app for one through a
  callback when it makes a request (§13).
- **The basic editor is React Native's own text input** (§8), not a WebView. A
  WebView editor arrives with `packages/fjord-editor` in phase 3.
- **Native targets** for what must be native (home-screen widget, share extension,
  App Intents and Shortcuts, Android's quick-settings tile) are added in slice 1e as
  small Swift and Kotlin targets alongside the Expo app.

### What runs where

| Concern | UI (TypeScript) | Engine (Rust) | Platform |
| --- | --- | --- | --- |
| Screens, editor, capture | ✓ | | |
| Tokens at rest | | | ✓ (Keychain / Keystore) |
| Talking to GitHub | | ✓ | |
| Tree cache, file cache, drafts | | ✓ | |
| Vault discovery, path rules, frontmatter, names | | ✓ (`fjord-core`) | |
| Commits, merge, conflict copies | | ✓ | |
| Background scheduling | | | ✓ (BGTaskScheduler / WorkManager) |
| Decryption and encryption (phase 2) | | ✓ (`fjord-core`) | identity in the keystore |

### Where the code lives

| Path | What |
| --- | --- |
| `clients/mobile/` | The Expo app: its own `package.json` and lockfile, `README.md`, `CHANGELOG.md`, `LICENSE` |
| `clients/engine/` | A Cargo workspace of its own with `fjord-client` and `fjord-ffi`, depending on `crates/fjord-core` by path; also home to `fjord-mcp` ([`../mcp/DESIGN.md`](../mcp/DESIGN.md)) |

The engine is a separate workspace, not a member of the root one, so the CLI's
lockfile, MSRV and `cargo deny` stay small (root `CLAUDE.md`, "Adding a component",
5). The desktop client will use the same workspace, and so will `fjord-mcp`, which may
be the engine's first user. (Open: §18.)

## 6. Repository connections

The engine has a **provider** interface, the same shape as Fjord Web's (web §7), so
GitHub is the first implementation and not an assumption:

- list the repositories the connection can reach;
- read a branch's head and its full tree listing (paths, sizes, blob ids);
- read one blob;
- commit several file changes atomically on top of a known head;
- tell whether the head has moved, cheaply.

**GitHub, two ways in:**

1. **The Fjord GitHub App, by device flow** (preferred). The project registers one
   public GitHub App for its native clients, with device flow enabled and the same
   minimal permissions as the web's: *Contents: read and write*, *Metadata: read*.
   The app shows a code, the user enters it at `github.com/login/device`, and the
   app receives a user token that reaches only the repositories where the user has
   installed the App; choosing repositories opens the App's installation page in the
   system browser. Device flow needs only the App's client id, which is not a
   secret, so no secret ships in the app and no server is needed to complete the
   sign-in. Whether refreshing an expiring user token needs the client secret
   decides how expiry is handled: if it does, the App opts out of token expiry or
   the app runs device flow again when a token lapses (ROADMAP 1a.2 checks this).
2. **A repository URL and a fine-grained personal access token**, limited to that
   repository with *Contents: read and write*. Its permissions are checked when it
   is added, and a read-only token is refused with a clear message.

**Defaults** as on the web: the first repository added is the default; with two or
more the user can change it. Each connection has a default vault: the first vault
listed in `fjord.json` until the user picks another. Defaults are kept on the phone;
with no server there is no account to carry them between devices.

**A repository that is not a Fjord repository** is shown as such and browsed
read-only; quick capture needs a default vault, so it is unavailable until there is
one. Whether to offer initialising it follows the web's answer (web §19 #3).

**Branch:** the repository's default branch, as on the web (web §19 #6).

## 7. Browsing

- **One listing per head**, from the provider's recursive tree listing, cached by
  commit id; very large repositories, where GitHub truncates the listing, fall back
  to listing directory by directory. With no webhooks (there is no server to
  receive them), the head is checked when the app comes to the foreground, on
  pull-to-refresh, every minute while a browser screen is open, and before every
  push. The check is a conditional request, so an unchanged head costs no rate
  limit.
- **Vaults are discovered from the listing** by `fjord-core`, as the spec says
  (§2.1), the same function Fjord Web uses (web ROADMAP P3).
- **What can be opened** is decided from the name alone, as on the web:

  | File | Shown as | Opens in |
  | --- | --- | --- |
  | `*.fj.md` | Document | Viewer and basic editor |
  | `*.md` (any other) | Note | Viewer and basic editor |
  | anything else | greyed out | — (phase 1) |
  | anything in an encrypted vault | greyed out, with a lock | — (phase 2) |

- **Offline**, the browser shows the last listing it had, marks files that are
  cached (openable offline), and shows drafts in place: a new file where it will be,
  a moved file at its new path.
- **Metadata** beyond the listing (a document's title, the last commit to touch a
  file) is loaded lazily for what is on screen and cached by blob id.

## 8. Opening and editing

- **Opening shows the file rendered**: Markdown to native views, sanitised, no raw
  HTML, no remote content loaded without a tap (an image by URL is a placeholder
  until asked for).
- **Edit shows the Markdown source** in a plain, full-screen text input, with a
  small row above the keyboard for the few things that are awkward to type:
  heading, list, checkbox, indent, outdent. Phase 1 has no syntax highlighting and
  no rich editing; the same editor serves documents and notes.
- **Byte-faithful.** What is saved is what was typed: line endings, trailing
  newline and everything the user did not touch are kept. The file is written only
  if its content changed (compared by hash), so opening and leaving a file never
  makes a commit.
- **Frontmatter is the engine's**, through `fjord-core`, never the editor's: the
  editor gets the body, and unknown keys and their order survive (spec §8.2, CLI
  invariant 3). An **Info** sheet shows the header: `id`, `created`, and keys Fjord
  does not know, read-only, so the user can see they are kept.
- **An existing note without frontmatter is left without it.** The app tracks files
  by path and follows the renames it makes itself, so it does not need an id, and a
  hand-written note edited on the phone stays as it was apart from the edit. This
  differs from Fjord Web, which adds a header on a note's first edit to give it an
  `/n/<id>` address (web §9); §18 asks whether the two should agree.
- **Creating** a document or a note (name, vault and folder chosen) writes a valid
  header through `fjord-core`, as `fjord new` does.
- **Saving** is continuous: every pause in typing writes the draft to the phone
  (§11). Leaving the editor queues the change for sync (§12).
- **Checklists** are GitHub task lists (`- [ ]`, `- [x]`). In the rendered view a
  tap toggles a box, which edits exactly that character.

## 9. Quick capture

Quick capture is how a thought gets into the repository fastest, and it must work
with no network, no repository reachable, and the app cold.

- **Entry points in phase 1:** a capture button on the main screen, and a **New
  note** quick action on the app icon (long press). Slice 1e adds a home-screen
  widget, the share sheet (shared text and links become a note), App Intents and
  Shortcuts on iOS, and a quick-settings tile on Android.
- **Where it lands:** `Inbox/` in the default vault, created if it is missing. Inbox
  is an ordinary folder; nothing marks it as special in the repository.
- **The name comes from the first line**, by a `fjord-core` function both clients
  use (ROADMAP MP2):
  - Markdown markers (`#`, `-`, `[ ]`) are stripped, whitespace trimmed, the text
    NFC-normalised and cut at 60 characters on a word boundary.
  - Characters the spec forbids in names, reserved names and trailing dots or
    spaces are dealt with by the spec's path rules (§5), so the name is valid on
    every operating system.
  - An empty first line gives the date and time: `2026-10-22 1430.md`.
  - A name that is taken in `Inbox/` (including one that differs only by case) gets
    ` 2`, ` 3`, … before the extension.
- **The name is chosen once**, when the note is first queued for sync. Editing the
  first line later does not rename the file, because a name that changes with every
  edit is a history of renames; the user can rename it (§10).
- **A quick note is a note** (`.md`), with a header written by `fjord-core` (`id`,
  `created`), so it is a Fjord Doc the CLI lists and verifies.
- **What is typed is on the phone at once**, before the app is backgrounded or
  killed. A capture abandoned empty leaves nothing behind.

## 10. Renaming, moving and deleting

The same rules as Fjord Web (web §8), so a repository behaves the same whichever
client changed it:

- Documents, notes and folders **inside plaintext vaults**; each action is one
  commit with the web's messages (`Rename <old> to <new>`, `Move <name> to
  <folder>`, `Delete <name>`), or part of a batched sync commit (§12).
- **Identity survives a rename or move**: a Doc's `id` is in its frontmatter; a note
  without one moves byte for byte.
- **The extension stays**, so a rename never turns a document into a note or back.
- **Names are checked by `fjord-core`** (spec §5), including names that differ only
  by case; a taken name is refused, never overwritten.
- **Into an encrypted vault is refused** (CLI invariant 1; moving in means
  encrypting, phase 2). Between repositories is not a move.
- **Folders** go with everything in them. Vault directories, `fjord.vault.json` and
  `fjord.json` are left to the CLI.
- **Offline**, renames, moves and deletes are drafts like edits, and are applied at
  sync on top of what has changed upstream (§12).

**Deleting** asks for confirmation, naming what will go. There is no trash folder in
the repository (the spec leaves trash out, §12). Instead:

- **Undo** is offered at once; before it is pushed, a deletion is only a draft.
- **Recently deleted** lists the deletions this phone made, for a restore window
  (default 30 days): the path, the id, the last blob and the deleting commit, kept
  in the local store. Restoring commits the last blob back at its path, or a chosen
  one if that path is taken.
- **Deletions made elsewhere** (the web, the CLI, another phone) are in git history
  but not in this list in phase 1. Finding them from history, so every client shows
  the same list, is open (§18).

## 11. Local storage and offline

- **A local store per connection**, in the app's private storage: an SQLite database
  (listings by commit, blob metadata, drafts, the sync queue, the deletion record)
  and a directory of cached file contents by blob id.
- **What is kept on the phone:** the latest listing, every file the user has opened,
  every draft and every quick note. Nothing else is downloaded ahead of time. A file
  opened once stays readable offline; the cache can be cleared from settings, which
  never clears a draft.
- **Drafts survive anything short of uninstalling**: a crash, a killed app, a reboot,
  a lapsed token. A draft is removed only when its change is in a pushed commit.
- **Storage is protected by the platform.** Files use iOS Data Protection ("complete
  until first user authentication", so background sync can still read them) and
  Android's app-private storage on an encrypted device. In phase 1 these are files
  from plaintext vaults, which are plaintext in the repository too; encrypted
  vaults (phase 2) are never stored decrypted (§13).
- **Removing a connection** deletes its store, after a warning if it holds drafts
  that are not pushed.

## 12. Sync and conflicts

**When:** when the app comes to the foreground; a few seconds after leaving an
editor or saving a capture; on pull-to-refresh; and opportunistically in the
background (BGTaskScheduler on iOS, WorkManager on Android), which neither platform
guarantees. A banner shows drafts waiting and the last successful sync.

**How a push works**, through the provider's commit operation:

1. Read the head. If it has moved since the drafts' bases, pull first (below).
2. Build one commit for everything queued: blobs, a tree on top of the head, a commit
   whose parent is the head.
3. Move the branch to it **without force**. If the head moved in between, the update
   is refused, and the sync starts again from 1. Nothing is ever force-pushed.

**The commit:** authored as the signed-in GitHub user (their name and no-reply
address). The message names what changed: `Add <name>` for one new note,
`Edit <name>` for one edit, the web's messages for a rename, move or delete, and for
several changes `Update <n> files` with one line per change in the body.

**Pulling**, for each file the drafts touch that has also changed upstream:

| Here | Upstream | Result |
| --- | --- | --- |
| edited | edited | Three-way merge of the plaintext from the base (spec §9.1), by `fjord-core` (ROADMAP MP1). Clean: one file. Not clean: both kept (below). |
| edited | deleted | The edit is kept: the file comes back with the edit. Deleting is never allowed to destroy an edit. |
| deleted | edited | The upstream version is kept and the deletion dropped; the user is told. |
| renamed or moved | edited | Upstream's content, merged with any edit here, at the new path. |
| renamed or moved | renamed or moved | Upstream's path wins; an edit here is merged into it; the user is told. |
| new file | a file at that path | The new file gets a free name, as in §9. |

**When a merge cannot complete**, neither side is discarded (spec §9.1, CLI
invariant 5). Upstream's version stays in place and this phone's is written beside
it as a new Doc with a fresh `id`, named as the CLI names it,
`name.conflict-<id suffix>.md`. Unlike `fjord sync`, which stops without pushing,
the app commits the copy: both sides are then safe in the repository, the state is
complete rather than half-merged, and the phone has no working tree to resolve in.
The file is badged as conflicted until the user deletes one of the two.

**Rate limits:** user tokens have GitHub's per-user limit; head checks are
conditional and blob reads are cached by id, so normal use stays far inside it. A
limit reached pauses sync with a message and loses nothing.

## 13. Security and privacy

- **No server, no Fjord account, no telemetry.** The app's only network peer is the
  git host. Crash reports, if ever added, are opt-in and say what they send.
- **Tokens** live in the platform keystore (Keychain, Android Keystore through
  `expo-secure-store`) and are passed to the engine for each request through a
  callback; the engine never writes one to its store or its logs. The fine-grained
  token is single-repository; the GitHub App's token reaches only the repositories
  the App is installed on.
- **App lock**, optional: Face ID, Touch ID or the device credential before the app
  shows anything, and its content hidden in the app switcher.
- **Rendering untrusted Markdown:** files may come from anyone with write access to
  the repository, so rendering is sanitised, raw HTML is shown as text, and nothing
  remote loads without a tap.
- **Encrypted vaults (phase 2):** the age identity is imported (from a file or a
  QR code, never typed), kept in the keystore behind biometrics, and used by the
  engine in memory and wiped after (`zeroize`). Decrypted content is never written
  to the phone's storage; drafts of encrypted files are kept encrypted to the
  vault's recipients, so the phone holds no plaintext of an encrypted vault at
  rest. This is CLI invariant 1 applied to a phone.

## 14. With the other clients

The repository is shared; the clients do not know about each other.

| | Fjord Web | Fjord Mobile |
| --- | --- | --- |
| Where it runs | A server the operator runs | The phone, no server |
| GitHub App | One per instance; webhooks | The project's App; device flow; no webhooks, head checks instead |
| Drafts | Working copies on the server | On the phone |
| When it commits | Save version, or after a quiet period | At sync, batched |
| An upstream change during an edit | Both versions shown; the user chooses | Merged automatically; both kept if that fails |
| A note's first edit | Adds a header and an id | Leaves the note as it was |
| Recently deleted | Deletions made through the instance | Deletions made on this phone |
| Sharing and comments | Yes | No; phase 3 hands a document to a web instance |

Two behaviours are the same everywhere because they are `fjord-core`'s: how a quick
note is named (MP2), and how a three-way merge and a conflict copy come out (MP1).

## 15. Phase 1 slices

| Slice | Delivers | Usable as |
| --- | --- | --- |
| **1a** | The engine on both platforms, connections (GitHub App and PAT), defaults, the browser, the local store | Connect a repository and browse it, offline too |
| **1b** | Viewer, basic editor, create, sync with merge and conflict copies | Read and write documents and notes |
| **1c** | Quick capture in the app and from the app icon, Inbox naming | Capture notes anywhere, offline |
| **1d** | Rename, move, delete, undo, Recently deleted | Organise a repository |
| **1e** | Widget, share sheet, App Intents and Shortcuts, quick-settings tile | Capture without opening the app |

Each slice ends usable, tested and in testers' hands (TestFlight and Play's internal
testing). The first store release follows 1d; 1e can follow it.

## 16. Build, distribution and releases

- **Stores:** the App Store and Google Play, under the project's developer accounts.
  Their credentials and signing keys are the owner's, set as CI or build-service
  secrets by the owner, never by an agent.
- **Builds:** EAS Build and EAS Submit at first, because they need the least setup
  for iOS signing; moving to GitHub Actions macOS runners with fastlane is a later
  option, not a rewrite (§18).
- **CI** runs only for changes that can affect the app (a `changes` job like
  `ci.yml`'s, root `CLAUDE.md`): TypeScript checks and tests, the engine's Rust
  tests on Linux, and the conformance fixtures through `fjord-ffi` (root
  `CLAUDE.md`, "Adding a component", 2). Device builds run on release branches and
  by hand, not on every PR, because macOS runners are slow and costly.
- **Releases** follow the monorepo's flow: a `mobile` component in
  `scripts/release/`, tagged `mobile-vX.Y.Z`, never marked *Latest* on GitHub (the
  CLI's install URLs depend on that slot). The store version is `X.Y.Z`; the build
  number only ever rises.
- **Store listings** say what the app collects: nothing.

## 17. Licence

`clients/mobile` and `clients/engine` are **MPL-2.0**, like `fjord-core` and the CLI.
The app does not bundle `@sovereignfs/ui` (a React DOM design system, and
AGPL-3.0-or-later), so nothing in it is AGPL, which matters because the App Store's
terms and the GPL family are a known poor fit. MPL-2.0's copyleft is per file, and
Firefox for iOS ships under it. The app's look follows Sovereign's design tokens,
copied as values, not the package. Whether there is ever a paid or closed build is
open (§18); if there is, it lives in a private repository (root `CLAUDE.md`).

## 18. Open questions

| # | Question | Default until decided |
| --- | --- | --- |
| 1 | Photos and attachments in notes: root `CLAUDE.md` puts photo handling out of scope permanently | Text only; images by URL render on tap |
| 2 | Should a note's first edit add a header (as the web does) or not (as here)? One answer for both clients | Mobile leaves it; revisit before web 1b.5 |
| 3 | Recently deleted from git history, so every client shows every deletion | Per client in phase 1 |
| 4 | The engine workspace's place: `clients/engine/` | As written |
| 5 | New Rust dependencies for the engine (HTTP client, SQLite) join the root `CLAUDE.md` table | Decide in MP5, with `rustls` and no C beyond SQLite |
| 6 | Search in phase 1 (the Keep and Notes habit) | Later, over cached files and the listing |
| 7 | Builds: EAS, or GitHub Actions with fastlane | EAS first |
| 8 | Open source only, or also a paid build | Open source, MPL-2.0, in this repository |
| 9 | A self-hoster's own GitHub App (their client id) instead of the project's | The project's App; a setting later |
| 10 | Should `fjord sync` switch from `git merge-file` to the `fjord-core` merge, so every client merges alike? | Decide with MP1 |
| 11 | Restore window | 30 days |

## 19. Decision log

| Date | Decision | Instead of |
| --- | --- | --- |
| 2026-10-22 | A standalone client that talks to the git host itself | A Capacitor shell around Fjord Web, as Sovereign Mobile is around Sovereign (no offline, no capture) |
| 2026-10-22 | Expo (React Native) UI over a Rust engine through uniffi | Native SwiftUI and Compose (two UIs); Tauri 2 mobile (WebView editing, young plugins) |
| 2026-10-22 | GitHub App by device flow, or a fine-grained PAT; tokens in the platform keystore | OAuth App (`repo` reaches every private repository); routing through a Fjord Web instance |
| 2026-10-22 | Phase 1: browse, a basic source editor for `.md` and `.fj.md`, plaintext vaults only, encrypted vaults locked | A rich editor and encryption in phase 1 |
| 2026-10-22 | Quick notes in `Inbox/` of the default vault, named from the first line, falling back to date and time | The vault root with date-time names; per-vault settings |
| 2026-10-22 | Offline: the listing, opened files, drafts and quick notes | A full mirror of the default vault or of every vault |
| 2026-10-22 | Rename, move and delete in phase 1, with the web's rules; Undo and Recently deleted kept on the phone | Leaving them for later; a trash folder in the repository |
| 2026-10-22 | One commit per sync, pushed without force; clean merges automatic; a failed merge commits a conflict copy beside the original | Asking on every upstream change; stopping without pushing, as `fjord sync` does |
| 2026-10-22 | MPL-2.0, no `@sovereignfs/ui` | AGPL with the design system |
