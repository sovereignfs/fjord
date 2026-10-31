# Fjord Web — roadmap

**Status:** phase 1 is done except a real-GitHub check of the PAT connection (1a.7) and the App (1a.6), and house style (1b.4); phase 2 is planned (tasks, not built) and phase 3 is an outline. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work, and the detail of each task is in [`docs/epics/`](../../docs/epics/). Section numbers (§) refer to `DESIGN.md` unless they say "spec".

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

These change the format and the CLI, so they land in `fjord` itself, and come
before the web slices that need them.

| # | Task | Status |
| --- | --- | --- |
| [P1](../../docs/epics/web-prerequisites.md#p1-spec-fjmd-names-a-document) | Spec: `*.fj.md` names a document | ✅ Done |
| [P2](../../docs/epics/web-prerequisites.md#p2-cli-create-and-list-documents) | CLI: create and list documents | ✅ Done |
| [P3](../../docs/epics/web-prerequisites.md#p3-fjord-core-vault-discovery-from-a-listing) | `fjord-core`: vault discovery from a listing | ✅ Done |
| [P4](../../docs/epics/web-prerequisites.md#p4-fjord-core-to-webassembly-pure-subset) | `fjord-core` to WebAssembly, pure subset | ✅ Done |
| [P5](../../docs/epics/web-prerequisites.md#p5-component-scaffolding) | Component scaffolding | ✅ Done |
| [P6](../../docs/epics/web-prerequisites.md#p6-fjord-core-scaffold-a-repository-as-data) | `fjord-core`: scaffold a repository as data | ✅ Done |

P4 is the longest pole; 1a needs P3–P5, 1b needs P1, P2 and P4; 1a.10 needs P6.

## Phase 1 — plaintext documents and notes, sharing, comments

### 1a — Sign in, connect, browse

| # | Task | Status |
| --- | --- | --- |
| [1a.0](../../docs/epics/web-1a.md#1a0-database-layer-both-dialects) | Database layer, both dialects | ✅ Done |
| [1a.1](../../docs/epics/web-1a.md#1a1-landing-page) | Landing page | ✅ Done |
| [1a.2](../../docs/epics/web-1a.md#1a2-local-auth) | Local auth | ✅ Done |
| [1a.3](../../docs/epics/web-1a.md#1a3-sovereign-oidc) | Sovereign OIDC | ✅ Done |
| [1a.4](../../docs/epics/web-1a.md#1a4-account-linking-when-both-are-on) | Account linking when both are on | ✅ Done |
| [1a.5](../../docs/epics/web-1a.md#1a5-provider-interface--github) | Provider interface + GitHub | ✅ Done |
| [1a.6](../../docs/epics/web-1a.md#1a6-github-app-connection) | GitHub App connection | ✅ Done |
| [1a.7](../../docs/epics/web-1a.md#1a7-pat-connection) | PAT connection | ⏳ In progress |
| [1a.8](../../docs/epics/web-1a.md#1a8-credentials-at-rest) | Credentials at rest | ✅ Done |
| [1a.9](../../docs/epics/web-1a.md#1a9-first-run-and-defaults) | First run and defaults | ✅ Done |
| [1a.10](../../docs/epics/web-1a.md#1a10-not-a-fjord-repository) | Not a Fjord repository | ✅ Done |
| [1a.11](../../docs/epics/web-1a.md#1a11-file-browser) | File browser | ✅ Done |
| [1a.12](../../docs/epics/web-1a.md#1a12-deployment) | Deployment | ✅ Done |

### 1b — Write and version

| # | Task | Status |
| --- | --- | --- |
| [1b.1](../../docs/epics/web-1b.md#1b1-editor-package-interface) | Editor package interface | ✅ Done |
| [1b.2](../../docs/epics/web-1b.md#1b2-note-editor) | Note editor | ✅ Done |
| [1b.3](../../docs/epics/web-1b.md#1b3-document-editor) | Document editor | ✅ Done |
| [1b.4](../../docs/epics/web-1b.md#1b4-house-style) | House style | 📋 Planned (§19 #7) |
| [1b.5](../../docs/epics/web-1b.md#1b5-frontmatter) | Frontmatter | ✅ Done |
| [1b.6](../../docs/epics/web-1b.md#1b6-routes-and-the-id-index) | Routes and the id index | ✅ Done |
| [1b.7](../../docs/epics/web-1b.md#1b7-create) | Create | ✅ Done |
| [1b.8](../../docs/epics/web-1b.md#1b8-working-copies) | Working copies | ✅ Done |
| [1b.9](../../docs/epics/web-1b.md#1b9-versions) | Versions | ✅ Done |
| [1b.10](../../docs/epics/web-1b.md#1b10-upstream-changes) | Upstream changes | ✅ Done |
| [1b.11](../../docs/epics/web-1b.md#1b11-rename-and-move) | Rename and move | ✅ Done |
| [1b.12](../../docs/epics/web-1b.md#1b12-delete-and-restore) | Delete and restore | ✅ Done |
| [1b.13](../../docs/epics/web-1b.md#1b13-idle-versions) | Idle versions | ✅ Done |

### 1c — Share

| # | Task | Status |
| --- | --- | --- |
| [1c.1](../../docs/epics/web-1c.md#1c1-roles-and-access-checks) | Roles and access checks | ✅ Done |
| [1c.2](../../docs/epics/web-1c.md#1c2-named-user-shares) | Named-user shares | ✅ Done |
| [1c.3](../../docs/epics/web-1c.md#1c3-link-shares) | Link shares | ✅ Done |
| [1c.4](../../docs/epics/web-1c.md#1c4-token-handling) | Token handling | ✅ Done |
| [1c.5](../../docs/epics/web-1c.md#1c5-password-links) | Password links | ✅ Done |
| [1c.6](../../docs/epics/web-1c.md#1c6-anonymous-names-and-edit-mode) | Anonymous names and edit mode | ✅ Done |
| [1c.7](../../docs/epics/web-1c.md#1c7-share-management-ui) | Share management UI | ✅ Done |

### 1d — Comment

| # | Task | Status |
| --- | --- | --- |
| [1d.1](../../docs/epics/web-1d.md#1d1-comment-plugin) | Comment plugin | ✅ Done |
| [1d.2](../../docs/epics/web-1d.md#1d2-anchors) | Anchors | ✅ Done |
| [1d.3](../../docs/epics/web-1d.md#1d3-live-updates) | Live updates | ✅ Done |
| [1d.4](../../docs/epics/web-1d.md#1d4-limits-and-abuse) | Limits and abuse | ✅ Done |
| [1d.5](../../docs/epics/web-1d.md#1d5-security-review-of-phase-1) | Security review of phase 1 | ✅ Done |

## Phase 2 — encrypted files

Planned on 2026-10-31; the prerequisites (P7, P8) and the keys in the browser (2a) are built, the reading and writing of encrypted files (2b) and sealed shares (2c) are not. What it promises and what it does not is in [`web-2.md`](../../docs/epics/web-2.md). The prerequisites need a Rust toolchain.

| # | Task | Status |
| --- | --- | --- |
| [P7](../../docs/epics/web-2.md#p7-fjord-core-age-and-the-tar-container-in-the-pure-subset) | `fjord-core`: age and the tar container in the pure subset | ✅ Done |
| [P8](../../docs/epics/web-2.md#p8-fjord-wasm-encrypt-decrypt-pack-and-unpack) | `fjord-wasm`: encrypt, decrypt, pack and unpack | ✅ Done |
| [2a.1](../../docs/epics/web-2.md#2a1-identities) | Identities | ✅ Done |
| [2a.2](../../docs/epics/web-2.md#2a2-content-security-policy-for-webassembly) | Content-Security-Policy for WebAssembly | ✅ Done |
| [2b.1](../../docs/epics/web-2.md#2b1-browse-encrypted-vaults) | Browse encrypted vaults | 📋 Planned |
| [2b.2](../../docs/epics/web-2.md#2b2-open) | Open | 📋 Planned |
| [2b.3](../../docs/epics/web-2.md#2b3-edit-and-drafts) | Edit and drafts | 📋 Planned |
| [2b.4](../../docs/epics/web-2.md#2b4-create-in-encrypted-vaults) | Create in encrypted vaults | 📋 Planned |
| [2b.5](../../docs/epics/web-2.md#2b5-rename-move-and-delete) | Rename, move and delete | 📋 Planned |
| [2b.6](../../docs/epics/web-2.md#2b6-moving-files-in-and-out-of-vaults) | Moving files in and out of vaults | 📋 Planned |
| [2c.1](../../docs/epics/web-2.md#2c1-sealed-link-shares) | Sealed link shares | 📋 Planned (§19 #13) |
| [2c.2](../../docs/epics/web-2.md#2c2-security-review-of-phase-2) | Security review of phase 2 | 📋 Planned |

## Phase 3 — collaborative editing

In outline.

- A shared Yjs document per open file, on the working copy (§11).
- `@lexical/yjs` in the document editor, or a replacement core behind the editor
  package's interface (§10).
- Comment anchors as Yjs relative positions beside the text-quote selectors.

## Later

GitLab, Forgejo/Gitea and other git servers (a provider each); search;
notifications; Sheets; the desktop client and the VS Code and Obsidian plugins
reusing `packages/fjord-editor`. The mobile client has its own plan:
[`../mobile/ROADMAP.md`](../mobile/ROADMAP.md).
