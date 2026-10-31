# Fjord for Claude (`fjord-mcp`) — roadmap

**Status:** design only; no code yet. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work, and the detail of each task is in [`docs/epics/`](../../docs/epics/). Section numbers (§) refer to `DESIGN.md` unless they say "spec",
"web" or "mobile".

| | |
| --- | --- |
| ✅ Done | Implemented, tested, released. |
| ⏳ In progress | Started. |
| 📋 Planned | Not started (*Next*: its prerequisites are done). |
| 🚧 Open | Waits on a decision in `DESIGN.md` §N. |

Every task is one branch and one draft PR (root `CLAUDE.md`, Working conventions).
Each row links to its task in [`docs/epics/`](../../docs/epics/), where it says what the task is, what "accepts when" review checks, and how it was done.

---

## Prerequisites

**Shared with the other clients**, and built here first if `fjord-mcp` leads:

- From [Fjord Web](../web/ROADMAP.md): P1 (`*.fj.md` names a document), P3 (vault
  discovery from a listing), and the part of P4 that injects time and randomness
  into `fjord-core`.
- From [Fjord Mobile](../mobile/ROADMAP.md): MP1 (three-way merge and conflict
  copies), MP2 (a note's name from its text), MP3 (the engine workspace), MP5
  (`fjord-client` foundations) and 1a.1 (the GitHub provider). MP4, the Expo spike,
  is not needed here.

**New:**

| # | Task | Status |
| --- | --- | --- |
| [MC1](../../docs/epics/mcp-prerequisites.md#mc1-fjord-core-verify-from-a-listing-and-blobs) | `fjord-core`: verify from a listing and blobs | 📋 Planned |
| [MC2](../../docs/epics/mcp-prerequisites.md#mc2-the-engine-encrypt-a-new-file-for-a-vault) | The engine: encrypt a new file for a vault | 📋 Planned |
| [MC3](../../docs/epics/mcp-prerequisites.md#mc3-component-scaffolding) | Component scaffolding | 📋 Planned |

## Phase 1 — Claude

### 1a — Local, reading

| # | Task | Status |
| --- | --- | --- |
| [1a.1](../../docs/epics/mcp-1a.md#1a1-stdio-server) | stdio server | 📋 Planned |
| [1a.2](../../docs/epics/mcp-1a.md#1a2-sign-in) | Sign-in | 📋 Planned |
| [1a.3](../../docs/epics/mcp-1a.md#1a3-listing-tools) | Listing tools | 📋 Planned |
| [1a.4](../../docs/epics/mcp-1a.md#1a4-read_file-history) | `read_file`, `history` | 📋 Planned |
| [1a.5](../../docs/epics/mcp-1a.md#1a5-verify) | `verify` | 📋 Planned |
| [1a.6](../../docs/epics/mcp-1a.md#1a6-search) | `search` | 📋 Planned |

### 1b — Local, writing

| # | Task | Status |
| --- | --- | --- |
| [1b.1](../../docs/epics/mcp-1b.md#1b1-create_document-create_note) | `create_document`, `create_note` | 📋 Planned |
| [1b.2](../../docs/epics/mcp-1b.md#1b2-update_file-edit_file) | `update_file`, `edit_file` | 📋 Planned |
| [1b.3](../../docs/epics/mcp-1b.md#1b3-rename-move-delete-restore) | `rename`, `move`, `delete`, `restore` | 📋 Planned |
| [1b.4](../../docs/epics/mcp-1b.md#1b4-commits) | Commits | 📋 Planned |
| [1b.5](../../docs/epics/mcp-1b.md#1b5-refused-paths) | Refused paths | 📋 Planned |

### 1c — Encrypted vaults, write only

| # | Task | Status |
| --- | --- | --- |
| [1c.1](../../docs/epics/mcp-1c.md#1c1-create-in-an-encrypted-vault) | Create in an encrypted vault | 📋 Planned |
| [1c.2](../../docs/epics/mcp-1c.md#1c2-refusals) | Refusals | 📋 Planned (§14 #3) |

### 1d — Hosted, for claude.ai

| # | Task | Status |
| --- | --- | --- |
| [1d.1](../../docs/epics/mcp-1d.md#1d1-streamable-http-transport) | Streamable HTTP transport | 📋 Planned |
| [1d.2](../../docs/epics/mcp-1d.md#1d2-oauth-21-for-claude) | OAuth 2.1 for Claude | 📋 Planned |
| [1d.3](../../docs/epics/mcp-1d.md#1d3-github-login-and-allow-list) | GitHub login and allow-list | 📋 Planned |
| [1d.4](../../docs/epics/mcp-1d.md#1d4-state-and-secrets) | State and secrets | 📋 Planned |
| [1d.5](../../docs/epics/mcp-1d.md#1d5-container-and-deployment) | Container and deployment | 📋 Planned |
| [1d.6](../../docs/epics/mcp-1d.md#1d6-security-review-of-phase-1) | Security review of phase 1 | 📋 Planned |

### 1e — Distribution

| # | Task | Status |
| --- | --- | --- |
| [1e.1](../../docs/epics/mcp-1e.md#1e1-desktop-extension) | Desktop extension | 📋 Planned |
| [1e.2](../../docs/epics/mcp-1e.md#1e2-binaries-and-homebrew) | Binaries and Homebrew | 📋 Planned |
| [1e.3](../../docs/epics/mcp-1e.md#1e3-documentation) | Documentation | 📋 Planned |
| [1e.4](../../docs/epics/mcp-1e.md#1e4-first-release) | First release | 📋 Planned |

## Phase 2 — ChatGPT

In outline; tasks are written when phase 1 is done.

- Add the hosted server to ChatGPT as an app in developer mode; check that every
  read tool carries `readOnlyHint`, so ChatGPT asks only before writes.
- Test sign-in with ChatGPT's OAuth client, and the tools against its confirmation
  model.
- Listings in Claude's connector directory and ChatGPT's app directory, which both
  review.

## Later

Other git hosts, through the engine's providers; files as MCP resources (§14 #5);
interactive views in the conversation (§14 #6); a Claude Code skill that teaches the
`fjord` CLI to Claude for repositories already on the machine.
