# Fjord for Claude (`fjord-mcp`) — roadmap

**Status:** planning. Nothing is implemented yet. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work and how each piece is
known to be done. Section numbers (§) refer to `DESIGN.md` unless they say "spec",
"web" or "mobile".

| | |
| --- | --- |
| `done` | Implemented, tested, released. |
| `next` | Ready to start: its prerequisites are done. |
| `todo` | Not started. |
| `open` | Waits on a decision in `DESIGN.md` §14. |

Every task is one branch and one draft PR (root `CLAUDE.md`, Working conventions).
"Accepts when" is what review checks.

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

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| MC1 | **`fjord-core`: verify from a listing and blobs.** The checks of `fjord verify` over a file listing and the bytes it asks for, with no filesystem, so a client reading through an API gets the CLI's answers. The CLI's walk calls the same code. | Every fixture gives the same diagnostics and `--json` through both paths; the CLI's golden output is unchanged. | `todo` |
| MC2 | **The engine: encrypt a new file for a vault.** Given the vault's manifest and recipients, the bytes of a new encrypted file in `plain` or `id` naming (spec §6.4, §7.2), with no identity. | `age -d` recovers the plaintext, and `age -d \| tar -x` the name in id mode, as the CLI's cross-validation does. | `todo` |
| MC3 | **Component scaffolding**: `clients/mcp` (`README.md`, `CHANGELOG.md`, `LICENSE`), the `fjord-mcp` crate in `clients/engine/`, a CI workflow with a `changes` job, `scripts/release/mcp.sh`, root layout tables updated. | CI runs only for MCP and engine changes; a placeholder binary answers MCP's `initialize`; the release component dry-runs. | `todo` |

## Phase 1 — Claude

### 1a — Local, reading

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1a.1 | **stdio server** on `rmcp` (§5): initialize, tool listing with annotations, structured errors. | Claude Code lists the tools; the MCP Inspector passes. | `todo` |
| 1a.2 | **Sign-in** (§6): `fjord-mcp login` by device flow with the Fjord GitHub App; `--token-stdin` for a PAT; the OS keychain; a clear failure before sign-in. | Sign in on macOS, Linux and Windows; no token in a file, an argument, the environment or a log. | `todo` |
| 1a.3 | **Listing tools** (§7): `list_repositories`, `list_vaults`, `list_files`. | Over a fixture repository on GitHub, the same vaults and kinds as `fjord ls`; pagination works. | `todo` |
| 1a.4 | **`read_file`, `history`** (§7): body, header fields, blob id; refused in encrypted vaults. | Read in Claude Desktop and Claude Code; an encrypted file is refused with the reason. | `todo` |
| 1a.5 | **`verify`** (§7, MC1). | Same diagnostics as `fjord verify --json` on every fixture; nothing written. | `todo` |
| 1a.6 | **`search`** (§7, §10): plaintext vaults, bounded, snippets, blob cache. | Finds the corpus's planted phrases; stops at the limits with a message saying so. | `todo` |

### 1b — Local, writing

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1b.1 | **`create_document`, `create_note`** (§7, §8): headers by `fjord-core`; names checked; note names from the first line (MP2). | Created files verify with the CLI; a taken or case-clashing name is refused. | `todo` |
| 1b.2 | **`update_file`, `edit_file`** (§8): base blob required; header kept; one-occurrence rule. | A stale base fails and nothing is committed; unknown header keys round-trip byte for byte. | `todo` |
| 1b.3 | **`rename`, `move`, `delete`, `restore`** (§7, §8): web §8's rules; limits; restore from history. | A deletion made by the CLI is restored; more than 20 paths is refused; moving into an encrypted vault is refused. | `todo` |
| 1b.4 | **Commits** (§8): one per call, no force, retry on a moved head, messages, author, `Fjord-Client` trailer. | A concurrent push between read and write is retried, never forced; the trailer names the client. | `todo` |
| 1b.5 | **Refused paths** (§8). | Every refused path, written by every write tool, is refused. | `todo` |

### 1c — Encrypted vaults, write only

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1c.1 | **Create in an encrypted vault** (§9, MC2): `plain` and `id` naming. | The file decrypts with `age -d` using an identity the server never had; the CLI verifies the vault. | `todo` |
| 1c.2 | **Refusals** (§9): read, search, edit and replace in encrypted vaults. | Each refused with its reason; no decryption code is reachable from the server. | `todo` (§14 #3) |

### 1d — Hosted, for claude.ai

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1d.1 | **Streamable HTTP transport** (§5): `fjord-mcp serve`. | The same tool tests pass over HTTP as over stdio. | `todo` |
| 1d.2 | **OAuth 2.1 for Claude** (§6): metadata, dynamic client registration, PKCE, short-lived tokens and refresh. | claude.ai adds the server as a custom connector and completes sign-in; the MCP authorization conformance checks pass. | `todo` |
| 1d.3 | **GitHub login and allow-list** (§6): the operator's GitHub App web flow; only allow-listed users get a grant. | A user not on the list is refused; revoking the App on GitHub stops the server's access. | `todo` |
| 1d.4 | **State and secrets** (§6): the SQLite file; tokens hashed or encrypted; secrets from files. | No plaintext token in the database; rotating the instance key re-wraps all. | `todo` |
| 1d.5 | **Container and deployment** (§11): image, volume, configuration, backup. | A fresh server comes up from the documented configuration and serves claude.ai and the Claude apps. | `todo` |
| 1d.6 | **Security review of phase 1** (§10): tokens, OAuth, refused paths, limits, logs, prompt-injection scenarios. | Findings fixed or recorded before the first release. | `todo` |

### 1e — Distribution

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1e.1 | **Desktop extension** (§11): an `.mcpb` bundling the binaries, with sign-in from its settings. | One-click install in Claude Desktop on macOS and Windows; tools work after sign-in. | `todo` |
| 1e.2 | **Binaries and Homebrew** (§11): cargo-dist, the tap. | `brew install sovereignfs/tap/fjord-mcp` works; checksums published. | `todo` |
| 1e.3 | **Documentation**: setting up Claude Code, Claude Desktop and claude.ai; what each tool does; what is never a tool and why. | A new user follows it to a first saved document on each surface. | `todo` |
| 1e.4 | **First release**: `mcp-v0.1.0` through the release flow. | Binaries, the extension and the image are published; the tag is not *Latest*. | `todo` |

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
