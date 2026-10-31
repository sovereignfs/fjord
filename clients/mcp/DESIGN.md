# Fjord for Claude (`fjord-mcp`) — design

**Status:** draft, written during the brainstorming and documentation phase
(2026-10-22). Nothing here is implemented. Where this file and
[`docs/specs/Fjord.spec.md`](../../docs/specs/Fjord.spec.md) disagree, the spec wins: this is the design
of one client, and the spec is the format every client follows.

[`ROADMAP.md`](ROADMAP.md) turns this into phases and tasks. It builds on the
[mobile design](../mobile/DESIGN.md)'s Rust engine and follows the
[web design](../web/DESIGN.md)'s rules for writing to a repository.

---

## 1. Purpose

People write documents with Claude: a plan, a report, meeting notes, a draft. Today
those stay in the conversation or get copied out by hand. **`fjord-mcp`** lets the
user say "save this to my Notes vault" and have it land as a Markdown file in their
own Fjord repository on GitHub; and lets Claude list, read, search, check, edit,
rename, move and delete the repository's documents and notes on request.

It is **an MCP server**, the protocol Claude uses to reach outside tools, so it
works with Claude on every surface, and later with ChatGPT, which speaks the same
protocol. It is **another client of the format**, a peer of the CLI, Fjord Web and
Fjord Mobile, and talks to GitHub directly: it needs no Fjord Web instance.

What it must not give up, whatever the convenience:

- **The files stay plain.** What Claude saves is an ordinary Fjord Doc that GitHub
  renders, Obsidian opens and the CLI verifies.
- **No secret passes through the conversation.** Everything said in a chat reaches
  the AI provider. No tool takes or returns an age identity, a token or a password.
- **Encrypted stays encrypted.** Claude may write into an encrypted vault, which
  needs only the vault's public recipients; it can never read one back (§9).
- **Nothing an assistant does is unrecoverable.** Every change is a commit; nothing
  is force-pushed; a deletion can be restored (§8).
- **One implementation of the format.** `fjord-core`, through the shared engine,
  for everything the spec defines (root `CLAUDE.md`, "Adding a component").

## 2. Phases

| Phase | What it delivers |
| --- | --- |
| **1** | Claude: Claude Desktop and Claude Code with a local server; claude.ai (and through it the Claude apps) with a self-hosted one. The curated tools of §7 on plaintext vaults; writing into encrypted vaults. |
| **2** | ChatGPT: the hosted server tested against ChatGPT's apps and its confirmation model; listings in the assistants' directories. |
| Later | Other git hosts (with the engine's providers), files as MCP resources, interactive views in the conversation, a Claude Code skill for the CLI. |

## 3. User journeys

1. **Setting up locally** (Claude Desktop): install the Fjord extension, or for
   Claude Code run `claude mcp add fjord -- fjord-mcp`. Sign in to GitHub once with a
   short code (§6). The repositories the Fjord GitHub App is installed on appear.
2. **Setting up on the web** (claude.ai): the user, or whoever runs their server,
   deploys `fjord-mcp serve` (§11) and adds its URL as a custom connector. Claude
   opens the server's sign-in page, which hands off to GitHub. The Claude apps on
   phones use connectors added on the web.
3. **Saving** a document written in the conversation: "save this as a document in
   my Work vault, in Plans". Claude calls `create_document`; Claude asks the user
   to allow the write; one commit lands, and Claude replies with its path.
4. **Asking about the repository**: "what's in my Inbox?", "find my notes about the
   boiler", "is the repository healthy?". Read tools, no confirmation needed.
5. **Editing**: "add these action items to yesterday's meeting note". Claude reads
   the note, then edits it with exact replacements against the version it read.
6. **Organising**: rename, move, delete; "bring back the note I deleted yesterday".
7. **Into an encrypted vault**: "save this to my Private vault". It is encrypted to
   the vault's recipients on the way in. Asking Claude to read it back is refused,
   with the reason.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| **MCP** | Model Context Protocol, the open protocol Claude and ChatGPT use to call outside tools. |
| **Tool** | One operation the server offers the assistant (§7). |
| **Local server** | `fjord-mcp` started by Claude Desktop or Claude Code on the user's machine, over stdio. |
| **Hosted server** | `fjord-mcp serve`, on the public internet, over Streamable HTTP, for claude.ai. |
| **Connector** | Claude's name for a remote MCP server the user has added. |
| **Engine** | The Rust library shared with Fjord Mobile: provider, commits, merge, names (mobile §5). |
| **Base** | The blob id a read returned, which a later edit must name (§8). |

## 5. Architecture

```
 Claude Desktop / Claude Code            claude.ai (and Claude's apps)
          │ stdio                                  │ HTTPS, from Anthropic's cloud
 ┌────────▼─────────────┐                ┌─────────▼──────────────────────────┐
 │ fjord-mcp (local)    │                │ fjord-mcp serve (self-hosted)      │
 │  token: OS keychain  │                │  OAuth 2.1 for Claude, GitHub login│
 │                      │                │  tokens encrypted in SQLite        │
 └────────┬─────────────┘                └─────────┬──────────────────────────┘
          │      one tool layer (§7), one engine (fjord-client + fjord-core)
          └──────────────────────────┬─────────────┘
                                     │ HTTPS
                              GitHub REST API
```

- **One binary, two transports.** `fjord-mcp` over stdio for the local case;
  `fjord-mcp serve` over Streamable HTTP for the hosted one. The tools, their
  results and their rules are the same code in both.
- **Built on the official Rust MCP SDK** (`rmcp`), so the binary is Rust end to end
  and shares one language with `fjord-core` and the engine.
- **The backend is the GitHub API, through the engine**, not a local clone: the
  mobile design's `fjord-client` (provider, multi-file commits without force,
  three-way merge, names). The same behaviour on every surface; no clone, no `git`.
  This makes `fjord-mcp` the engine's **first user**: the engine is built and proven
  here, before the mobile UI exists.
- **Stateless locally, small state when hosted.** The local server keeps a token in
  the keychain and caches blobs in memory. The hosted one keeps OAuth clients and
  grants and the GitHub tokens in one SQLite file (§6).
- **Claude Code with a clone** can already drive the `fjord` CLI through its shell;
  `fjord-mcp` is for when the repository is not on the machine, and for every other
  surface.

### Where the code lives

| Path | What |
| --- | --- |
| `clients/engine/fjord-mcp/` | The binary crate, in the engine's Cargo workspace (mobile §5) |
| `clients/mcp/` | This design, the roadmap, `README.md`, `CHANGELOG.md`, the Desktop extension manifest, the `Dockerfile` and deployment examples |

## 6. Signing in

**To GitHub**, as the mobile design does (mobile §6): the GitHub App with *Contents:
read and write* and *Metadata: read*, so a token reaches only the repositories the
App is installed on; or a fine-grained personal access token for one repository.

**Locally:**

- **Device flow with the project's Fjord GitHub App** (the same App as Fjord Mobile),
  which needs only its public client id. `fjord-mcp login` in a terminal shows a code
  to enter at `github.com/login/device`; the Desktop extension runs the same step
  from its settings. The token goes into the OS keychain (macOS Keychain, Windows
  Credential Manager, the Secret Service on Linux) and nowhere else.
- **A PAT**, read by `fjord-mcp login --token-stdin`, never from an argument or an
  environment variable (CLI invariant 2).
- If a tool is called before sign-in, it fails with instructions to sign in, and
  the server never asks for a token in the conversation.

**Hosted**, per the MCP authorization specification, which Claude supports:

- The server is its own **OAuth 2.1 authorization server** for Claude: protected
  resource and authorization server metadata, dynamic client registration (Claude
  registers itself), authorization code with PKCE, short-lived access tokens with
  refresh, bound to the server's URL.
- **Login is delegated to GitHub**: the authorize page sends the user through the
  operator's own GitHub App (its web flow needs a client secret, so each hosted
  server registers its own App, as each Fjord Web instance does). The signed-in
  GitHub user must be on the operator's **allow-list**; nobody else gets a grant.
- **Storage:** one SQLite file: registered clients, grants, hashed access and
  refresh tokens, and each user's GitHub token encrypted with an instance key.
- **Secrets are read from files** (`*_FILE`, as Docker secrets), not from the
  environment: the GitHub App's secret and key, and the instance key.
- Revoking: the operator can revoke a user's grants; the user can revoke the App on
  GitHub, which stops everything at once.

## 7. Tools

Every tool takes a `repository` (as `owner/name`) unless it lists them. Each carries
MCP annotations so the assistant knows which only read (`readOnlyHint`) and which
destroy (`destructiveHint`); Claude asks the user before a write, and ChatGPT treats
any tool without `readOnlyHint` as one.

**Read**

| Tool | Does | Notes |
| --- | --- | --- |
| `list_repositories` | Repositories the token reaches, with their vaults | |
| `list_vaults` | Vaults (from the listing, spec §2.1), encrypted or not, naming mode | |
| `list_files` | Files and folders under a path, kind (document, note, other) | Paginated; encrypted vaults show what the repository shows: names in `plain` naming, ids in `id` naming |
| `read_file` | A document or note: body, header fields, blob id, path | Plaintext vaults only; paginated beyond 256 KB |
| `search` | Text search over a vault's documents and notes, with line snippets | Plaintext vaults only; bounded (§10) |
| `verify` | `fjord verify`'s diagnostics, in the `verify --json` schema (`schema/`) | Read-only, as the CLI's is (CLI invariant 7) |
| `history` | Recent commits touching a path | |

**Write**

| Tool | Does | Notes |
| --- | --- | --- |
| `create_document` | A new `*.fj.md` with a header written by `fjord-core` | Title, vault, folder, body |
| `create_note` | A new `.md` note with a header | Name optional: from the first line, as quick capture names it (mobile §9) |
| `update_file` | Replace a file's body | Requires the base blob id; the header is kept |
| `edit_file` | Exact replacements in a file's body | Requires the base blob id; each old string must occur once. Saves re-sending a long document |
| `rename` | A file or folder, in place | Extension kept (web §8) |
| `move` | Files or folders to another folder | Never into an encrypted vault as plaintext |
| `delete` | Files or folders | `destructiveHint`; bounded (§10) |
| `restore` | A deleted file, from history | To its old path, or a given one if that is taken |

**Not tools, by design:** creating, listing, adding or removing keys; `decrypt`;
`rekey`; `init`; `open`; `sync`; checking a vault out. An identity in a tool call
would sit in the conversation's transcript at the AI provider; a recipient added by
a manipulated assistant would let a stranger read everything written after it. These
stay with a person at the CLI.

## 8. Writing

The web design's rules (web §8, §11), so a repository behaves the same whichever
client changed it:

- **One commit per write call**, on the default branch, on top of the head just
  read, moved there **without force**; if the head moved in between, the engine
  re-reads and retries. Messages are the web's (`Add <name>`, `Edit <name>`,
  `Rename <old> to <new>`, `Move <name> to <folder>`, `Delete <name>`,
  `Restore <name>`).
- **Authored as the GitHub user**, with a trailer naming the client from MCP's
  `clientInfo`, e.g. `Fjord-Client: Claude via fjord-mcp`, so history shows what an
  assistant did. The name is self-reported by the client: a label, not proof.
- **Never overwrite.** `update_file` and `edit_file` name the blob they read; if the
  file changed since, the call fails and says so, and the assistant reads it again.
  Nothing is merged silently on an assistant's behalf.
- **Headers are `fjord-core`'s.** The body is what the assistant writes; the header
  is created or kept by `fjord-core`, unknown keys and their order intact (spec §8.2,
  CLI invariant 3). A note without a header is left without one, as on the phone
  (mobile §8).
- **Names are checked by `fjord-core`** (spec §5), case-only clashes included; a
  taken name is refused, never replaced.
- **Refused paths:** nothing writes `fjord.json`, `fjord.vault.json`, a vault's
  recipients, its guard `.gitignore` (spec §6.5), `.gitattributes`, or anything under
  `.fjord/`. These belong to the CLI and to people.
- **Restore** finds the commit that deleted the path and commits the blob from
  before it. This works for deletions made by any client, because it reads history
  rather than a record of its own.

## 9. Encrypted vaults: write only

- **Creating in an encrypted vault** encrypts the new file to the vault's public
  recipients with `fjord-core`: an `.age` payload in `plain` naming, the tar
  container in `id` naming (spec §6.4, §7.2). No identity is involved, so none needs
  to be on the server. The plaintext came from the conversation, so it was already
  with the AI provider; nothing new is exposed.
- **Never read back:** `read_file`, `search` and `edit_file` refuse files in an
  encrypted vault and say why. Decrypting would mean an identity on the server and
  the plaintext sent to the AI provider, which is the promise encryption makes.
- **Replacing an existing encrypted file** without reading it is refused in phase 1
  (§14). Renaming, moving and deleting in encrypted vaults wait for the clients'
  phase 2.
- **Never plaintext into an encrypted vault** (CLI invariant 1): every write into
  one is encrypted, and moving a plaintext file into one is refused.

## 10. Safety

- **Prompt injection is the threat that matters.** A file, a web page or a pasted
  text can carry instructions an assistant might follow. The design limits what a
  manipulated assistant can do rather than hoping it will not be:
  - no tool can reveal or add a key, widen access, or touch the manifests (§7, §8);
  - every write needs the user's approval in Claude, and is a commit that can be
    reverted or restored;
  - limits per call: at most 20 paths deleted or moved, files up to 1 MB, search
    over at most 500 files or 20 MB, results paginated.
- **File content is data.** Read results return content in a structured field, never
  mixed into the tool's own instructions.
- **No secret in a tool argument or result**, ever; tokens never appear in logs.
- **Scope:** the GitHub App reaches only the repositories it is installed on; a PAT,
  one repository. The hosted server serves only allow-listed GitHub users.
- **What the hosted server sees:** the plaintext of plaintext vaults, in transit, as
  any server editing them does. That is why it is self-hosted by default (§11).

## 11. Deployment and distribution

- **Local:** one binary per platform, built and released like the CLI (cargo-dist),
  and installable from the Homebrew tap. For Claude Desktop, a Desktop extension
  (`.mcpb`) bundling the binaries, installed with one click. For Claude Code,
  `claude mcp add fjord -- fjord-mcp`.
- **Hosted:** a container image (`ghcr.io/sovereignfs/fjord-mcp`), one container
  with a volume for the SQLite file, behind TLS. Configuration: the public URL, the
  GitHub App's id, client id and (from files) its secret and key, the instance key
  file, the allow-list. Backups: the SQLite file (`sqlite3 .backup`, or Litestream).
- **Releases** follow the monorepo's flow: an `mcp` component in `scripts/release/`,
  tagged `mcp-vX.Y.Z`, never marked *Latest* (the CLI's install URLs depend on it).
- **A project-run public server**, so people need not host one, is open (§14): it
  would see users' plaintext files in transit and hold their GitHub tokens.

## 12. With the other clients

| | Fjord Web | Fjord Mobile | `fjord-mcp` |
| --- | --- | --- | --- |
| Who writes | A person in an editor | A person in an editor | An assistant, approved by a person |
| When it commits | Save version or idle | At sync, batched | Each write call |
| An upstream change | Both shown, the person chooses | Merged; both kept if not | The call fails; the assistant re-reads |
| Encrypted vaults | Phase 2, in the browser | Phase 2, on the phone | Write only, never read |
| Recently deleted | The instance's own deletions | This phone's deletions | Any deletion, from history |

## 13. Licence

**MPL-2.0**, like `fjord-core`, the CLI and the engine.

## 14. Open questions

| # | Question | Default until decided |
| --- | --- | --- |
| 1 | A project-run public hosted server | None; self-hosted only |
| 2 | Signing in from inside the conversation (an MCP elicitation showing the device code) instead of `fjord-mcp login` | `login` and the extension's settings |
| 3 | Replacing an existing encrypted file without reading it | Refused |
| 4 | Several writes as one commit (a "batch" tool) | One commit per call |
| 5 | Files as MCP resources as well as tools | Later |
| 6 | Interactive views in the conversation (a file browser) | Later |
| 7 | The limits in §10 | As written |
| 8 | A PAT for the hosted server, for people without a GitHub App | GitHub App only |

## 15. Decision log

| Date | Decision | Instead of |
| --- | --- | --- |
| 2026-10-22 | An MCP server, so one implementation serves Claude and, later, ChatGPT | A separate integration per assistant |
| 2026-10-22 | Claude first; ChatGPT in phase 2 | Both at once |
| 2026-10-22 | No Fjord Web: one `fjord-mcp` binary, stdio locally and a self-hosted HTTP server for claude.ai | A `/mcp` endpoint inside Fjord Web |
| 2026-10-22 | The GitHub API through the shared engine | A local clone driven by `git` |
| 2026-10-22 | A curated tool set; keys, decrypt, rekey, init, open, sync and checkout never tools | Every CLI command as a tool |
| 2026-10-22 | Encrypted vaults write only | Reading by per-vault opt-in; plaintext vaults only |
| 2026-10-22 | Edits name the blob they read and fail on a change | Merging on the assistant's behalf |

## Sources

What Claude and ChatGPT support, as read on 2026-10-22:

- Anthropic: [Building custom connectors via remote MCP servers](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers)
  (remote servers reached from Anthropic's cloud; OAuth with dynamic client
  registration; Streamable HTTP; mobile uses connectors added on the web).
- OpenAI: [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
  (remote MCP servers; write actions need confirmation; `readOnlyHint` decides what
  is a write).
