# Fjord for Claude — 1b — Local, writing

The detail of the tasks in this part of [`clients/mcp/ROADMAP.md`](../../clients/mcp/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mcp/DESIGN.md`](../../clients/mcp/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1b.1 `create_document`, `create_note`

**Status:** 📋 Planned

**Design:** §7, §8

Headers by `fjord-core`; names checked; note names from the first line (MP2).

**Accepts when:** Created files verify with the CLI; a taken or case-clashing name is refused.

## 1b.2 `update_file`, `edit_file`

**Status:** 📋 Planned

**Design:** §8

Base blob required; header kept; one-occurrence rule.

**Accepts when:** A stale base fails and nothing is committed; unknown header keys round-trip byte for byte.

## 1b.3 `rename`, `move`, `delete`, `restore`

**Status:** 📋 Planned

**Design:** §7, §8

Web §8's rules; limits; restore from history.

**Accepts when:** A deletion made by the CLI is restored; more than 20 paths is refused; moving into an encrypted vault is refused.

## 1b.4 Commits

**Status:** 📋 Planned

**Design:** §8

One per call, no force, retry on a moved head, messages, author, `Fjord-Client` trailer.

**Accepts when:** A concurrent push between read and write is retried, never forced; the trailer names the client.

## 1b.5 Refused paths

**Status:** 📋 Planned

**Design:** §8

.

**Accepts when:** Every refused path, written by every write tool, is refused.
