# Fjord for Claude — 1d — Hosted, for claude.ai

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1d.1 Streamable HTTP transport

**Status:** 📋 Planned

**Design:** §5

`fjord-mcp serve`.

**Accepts when:** The same tool tests pass over HTTP as over stdio.

## 1d.2 OAuth 2.1 for Claude

**Status:** 📋 Planned

**Design:** §6

Metadata, dynamic client registration, PKCE, short-lived tokens and refresh.

**Accepts when:** claude.ai adds the server as a custom connector and completes sign-in; the MCP authorization conformance checks pass.

## 1d.3 GitHub login and allow-list

**Status:** 📋 Planned

**Design:** §6

The operator's GitHub App web flow; only allow-listed users get a grant.

**Accepts when:** A user not on the list is refused; revoking the App on GitHub stops the server's access.

## 1d.4 State and secrets

**Status:** 📋 Planned

**Design:** §6

The SQLite file; tokens hashed or encrypted; secrets from files.

**Accepts when:** No plaintext token in the database; rotating the instance key re-wraps all.

## 1d.5 Container and deployment

**Status:** 📋 Planned

**Design:** §11

Image, volume, configuration, backup.

**Accepts when:** A fresh server comes up from the documented configuration and serves claude.ai and the Claude apps.

## 1d.6 Security review of phase 1

**Status:** 📋 Planned

**Design:** §10

Tokens, OAuth, refused paths, limits, logs, prompt-injection scenarios.

**Accepts when:** Findings fixed or recorded before the first release.
