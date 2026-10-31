# Fjord for Claude — 1a — Local, reading

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1a.1 stdio server

**Status:** 📋 Planned

On `rmcp` (§5): initialize, tool listing with annotations, structured errors.

**Accepts when:** Claude Code lists the tools; the MCP Inspector passes.

## 1a.2 Sign-in

**Status:** 📋 Planned

**Design:** §6

`fjord-mcp login` by device flow with the Fjord GitHub App; `--token-stdin` for a PAT; the OS keychain; a clear failure before sign-in.

**Accepts when:** Sign in on macOS, Linux and Windows; no token in a file, an argument, the environment or a log.

## 1a.3 Listing tools

**Status:** 📋 Planned

**Design:** §7

`list_repositories`, `list_vaults`, `list_files`.

**Accepts when:** Over a fixture repository on GitHub, the same vaults and kinds as `fjord ls`; pagination works.

## 1a.4 `read_file`, `history`

**Status:** 📋 Planned

**Design:** §7

Body, header fields, blob id; refused in encrypted vaults.

**Accepts when:** Read in Claude Desktop and Claude Code; an encrypted file is refused with the reason.

## 1a.5 `verify`

**Status:** 📋 Planned

**Design:** §7, MC1

.

**Accepts when:** Same diagnostics as `fjord verify --json` on every fixture; nothing written.

## 1a.6 `search`

**Status:** 📋 Planned

**Design:** §7, §10

Plaintext vaults, bounded, snippets, blob cache.

**Accepts when:** Finds the corpus's planted phrases; stops at the limits with a message saying so.
