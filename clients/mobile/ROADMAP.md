# Fjord Mobile — roadmap

**Status:** design only; no app code yet. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work, and the detail of each task is in [`docs/epics/`](../../docs/epics/). Section numbers (§) refer to `DESIGN.md` unless they say "spec"
or "web".

| | |
| --- | --- |
| ✅ Done | Implemented, tested, released. |
| ⏳ In progress | Started. |
| 📋 Planned | Not started (*Next*: its prerequisites are done). |
| 🚧 Open | Waits on a decision in `DESIGN.md` §N. |

Every task is one branch and one draft PR (root `CLAUDE.md`, Working conventions).
Each row links to its task in [`docs/epics/`](../../docs/epics/), where it says what the task is, what "accepts when" review checks, and how it was done.

---

## Prerequisites in fjord

These change `fjord-core` or the repository's layout, so they land in `fjord`
itself, before the slices that need them.

**Shared with Fjord Web** (tasks in [`../web/ROADMAP.md`](../web/ROADMAP.md)):
P1 (the spec says `*.fj.md` names a document) and P3 (vault discovery from a
listing). The part of P4 that injects time and randomness into `fjord-core` is
needed here too; its WASM build is not.

| # | Task | Status |
| --- | --- | --- |
| [MP1](../../docs/epics/mobile-prerequisites.md#mp1-fjord-core-three-way-text-merge-and-conflict-copies) | `fjord-core`: three-way text merge and conflict copies | ✅ Done |
| [MP2](../../docs/epics/mobile-prerequisites.md#mp2-fjord-core-a-notes-name-from-its-text) | `fjord-core`: a note's name from its text | ✅ Done |
| [MP3](../../docs/epics/mobile-prerequisites.md#mp3-the-engine-workspace) | The engine workspace | 🚧 Open (§18 #4) |
| [MP4](../../docs/epics/mobile-prerequisites.md#mp4-spike-expo-and-uniffi-on-both-platforms) | Spike: Expo and uniffi on both platforms | 📋 Planned |
| [MP5](../../docs/epics/mobile-prerequisites.md#mp5-fjord-client-foundations) | `fjord-client` foundations | 🚧 Open (§18 #5) |
| [MP6](../../docs/epics/mobile-prerequisites.md#mp6-component-scaffolding) | Component scaffolding | 📋 Planned |

MP4 comes first: it decides whether the stack in §5 holds before anything is built
on it. MP1, MP2, MP3, MP5 and 1a.1 are shared with `fjord-mcp`
([`../mcp/ROADMAP.md`](../mcp/ROADMAP.md)), which may build them first. 1a needs
MP3–MP6 and P3; 1b needs MP1 and P1; 1c needs MP2.

## Phase 1 — plaintext browse, edit, capture and organise

### 1a — Connect and browse

| # | Task | Status |
| --- | --- | --- |
| [1a.1](../../docs/epics/mobile-1a.md#1a1-github-provider-in-the-engine) | GitHub provider in the engine | 📋 Planned |
| [1a.2](../../docs/epics/mobile-1a.md#1a2-the-fjord-github-app-and-device-flow) | The Fjord GitHub App and device flow | 📋 Planned |
| [1a.3](../../docs/epics/mobile-1a.md#1a3-pat-connection) | PAT connection | 📋 Planned |
| [1a.4](../../docs/epics/mobile-1a.md#1a4-tokens-in-the-keystore) | Tokens in the keystore | 📋 Planned |
| [1a.5](../../docs/epics/mobile-1a.md#1a5-first-run-and-defaults) | First run and defaults | 📋 Planned |
| [1a.6](../../docs/epics/mobile-1a.md#1a6-not-a-fjord-repository) | Not a Fjord repository | 📋 Planned |
| [1a.7](../../docs/epics/mobile-1a.md#1a7-local-store-and-tree-cache) | Local store and tree cache | 📋 Planned |
| [1a.8](../../docs/epics/mobile-1a.md#1a8-file-browser) | File browser | 📋 Planned |
| [1a.9](../../docs/epics/mobile-1a.md#1a9-app-lock) | App lock | 📋 Planned |

### 1b — Read, write, sync

| # | Task | Status |
| --- | --- | --- |
| [1b.1](../../docs/epics/mobile-1b.md#1b1-viewer) | Viewer | 📋 Planned |
| [1b.2](../../docs/epics/mobile-1b.md#1b2-basic-editor) | Basic editor | 📋 Planned |
| [1b.3](../../docs/epics/mobile-1b.md#1b3-frontmatter-and-info) | Frontmatter and Info | 🚧 Open (§18 #2) |
| [1b.4](../../docs/epics/mobile-1b.md#1b4-create) | Create | 📋 Planned |
| [1b.5](../../docs/epics/mobile-1b.md#1b5-sync-queue-and-push) | Sync queue and push | 📋 Planned |
| [1b.6](../../docs/epics/mobile-1b.md#1b6-pull-and-merge) | Pull and merge | 📋 Planned |
| [1b.7](../../docs/epics/mobile-1b.md#1b7-sync-status) | Sync status | 📋 Planned |
| [1b.8](../../docs/epics/mobile-1b.md#1b8-drafts-are-durable) | Drafts are durable | 📋 Planned |

### 1c — Quick capture

| # | Task | Status |
| --- | --- | --- |
| [1c.1](../../docs/epics/mobile-1c.md#1c1-capture-screen) | Capture screen | 📋 Planned |
| [1c.2](../../docs/epics/mobile-1c.md#1c2-app-icon-quick-action) | App-icon quick action | 📋 Planned |
| [1c.3](../../docs/epics/mobile-1c.md#1c3-inbox-and-naming) | Inbox and naming | 📋 Planned |

### 1d — Organise

| # | Task | Status |
| --- | --- | --- |
| [1d.1](../../docs/epics/mobile-1d.md#1d1-rename-and-move) | Rename and move | 📋 Planned |
| [1d.2](../../docs/epics/mobile-1d.md#1d2-delete-undo-recently-deleted) | Delete, Undo, Recently deleted | 📋 Planned (§18 #11) |
| [1d.3](../../docs/epics/mobile-1d.md#1d3-organising-against-upstream-changes) | Organising against upstream changes | 📋 Planned |
| [1d.4](../../docs/epics/mobile-1d.md#1d4-security-review-of-phase-1) | Security review of phase 1 | 📋 Planned |
| [1d.5](../../docs/epics/mobile-1d.md#1d5-first-store-release) | First store release | 📋 Planned (§18 #7) |

### 1e — Capture without opening the app

| # | Task | Status |
| --- | --- | --- |
| [1e.1](../../docs/epics/mobile-1e.md#1e1-share-sheet) | Share sheet | 📋 Planned |
| [1e.2](../../docs/epics/mobile-1e.md#1e2-home-screen-widget) | Home-screen widget | 📋 Planned |
| [1e.3](../../docs/epics/mobile-1e.md#1e3-app-intents-and-shortcuts) | App Intents and Shortcuts | 📋 Planned |
| [1e.4](../../docs/epics/mobile-1e.md#1e4-quick-settings-tile) | Quick-settings tile | 📋 Planned |

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
