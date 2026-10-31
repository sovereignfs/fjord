# Fjord for Claude — 1c — Encrypted vaults, write only

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1c.1 Create in an encrypted vault

**Status:** 📋 Planned

**Design:** §9, MC2

`plain` and `id` naming.

**Accepts when:** The file decrypts with `age -d` using an identity the server never had; the CLI verifies the vault.

## 1c.2 Refusals

**Status:** 📋 Planned (§14 #3)

**Design:** §9

Read, search, edit and replace in encrypted vaults.

**Accepts when:** Each refused with its reason; no decryption code is reachable from the server.
