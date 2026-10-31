# Fjord for Claude — Prerequisites

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## MC1 `fjord-core`: verify from a listing and blobs

**Status:** 📋 Planned

The checks of `fjord verify` over a file listing and the bytes it asks for, with no filesystem, so a client reading through an API gets the CLI's answers. The CLI's walk calls the same code.

**Accepts when:** Every fixture gives the same diagnostics and `--json` through both paths; the CLI's golden output is unchanged.

## MC2 The engine: encrypt a new file for a vault

**Status:** 📋 Planned

Given the vault's manifest and recipients, the bytes of a new encrypted file in `plain` or `id` naming (spec §6.4, §7.2), with no identity.

**Accepts when:** `age -d` recovers the plaintext, and `age -d \| tar -x` the name in id mode, as the CLI's cross-validation does.

## MC3 Component scaffolding

**Status:** 📋 Planned

`clients/mcp` (`README.md`, `CHANGELOG.md`, `LICENSE`), the `fjord-mcp` crate in `clients/engine/`, a CI workflow with a `changes` job, `scripts/release/mcp.sh`, root layout tables updated.

**Accepts when:** CI runs only for MCP and engine changes; a placeholder binary answers MCP's `initialize`; the release component dry-runs.
