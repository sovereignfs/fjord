# Workstream 0002 — Kinds, second pass

**Status:** 📋 Planned (waiting for RFC 0002 to be accepted)\
**Date:** November 2026\
**Author:** Claude Code, from a design conversation with the owner\
**Goal owner:** the repository's owner (kasunben)\
**Governs:** [RFC 0002](../rfcs/0002-kinds-second-pass.md); spec §1.3, §2.3, §3, §3.1, §6.6, §8.4, §12;
[`docs/epics/web-3.md`](../epics/web-3.md#kinds-second-pass-rfc-0002) (P13–P17, 3e–3h)\
**Research:** none; [RFC 0001](../rfcs/0001-repository-kinds.md) and [workstream 0001](0001-repository-kinds.md) are what it builds on

---

## Goal

A repository's kind decides everything about how its Docs are presented, and nothing else does: a drive's Docs open in the
document editor, a journal's in a quiet writing view, a site's in a content editor that never damages what it cannot hold. No
address Fjord Web shows has a real path in it, and a Doc has one address whether it is shared or not. A journal is encrypted unless
the person asks otherwise. A drive's Doc can be published as a page. And a person who already has files, a git repository or an
Astro or Jekyll site, can make it a Fjord repository without a file moved or rewritten.

## Definition of done

- [ ] The fixtures and `fjord-core` agree with the spec text already written: one kind of Doc, vaults at any depth, `E113`, a
      checkout begun by adoption (P13, P14).
- [ ] The CLI has no documents, makes journals encrypted by default, and adopts existing directories of each kind (P15, P16).
- [ ] `fjord-wasm` agrees with the CLI on every fixture, and plans an adoption for the web (P17).
- [ ] Fjord Web opens every Doc at `/d/<id>` in its kind's editor, everything else at `/f/<handle>`, and shows no path in an
      address (3e.1, 3e.2).
- [ ] Any drive Doc can be shared, and an `id` is added only when asked (3e.3).
- [ ] A journal opens on a writing view, and a new one is encrypted by default (3f).
- [ ] An adopted site opens on its posts, and its files edit safely in source or rich mode (3g).
- [ ] A drive's Doc can be published, publicly or privately, and from an encrypted vault only after the warning (3h).
- [ ] RFC 0002's status says it is implemented; `clients/web/DESIGN.md` says *as built* where it now says *planned (RFC 0002)*.

## Decisions locked

Settled with the owner on 2026-11-03. An agent running this workstream cannot see that conversation: do not reopen these
without asking.

| Decision | Choice | Rejected alternative and why |
| --- | --- | --- |
| Documents and notes | **Withdrawn** (spec §8.4). Every Doc is `.md`; the kind picks the editor: drive the document editor (MDXEditor), journal the note editor (CodeMirror) in a writing view, site the content editor, unknown as drive | `.fj.md` as the journal's marker: kind and extension would both decide presentation and could contradict each other |
| A Doc's address | Always `/d/<id>`, owned or shared; `/n/<id>` answers 308 | — |
| Every other address | `/f/<handle>`: a random handle in the web's database, `(connection, path) → handle`, derived, never committed, updated by Fjord's own move and rename; a stale one says "moved or gone" | An index committed to the repository (§2.1, §2.2; conflicts; stale; leaks names in `id` mode). An encoded path (longer, changes on rename, decodable) |
| When a file gets an `id` | Never on open or edit (1b.5's promotion is reversed). Files Fjord makes have one. Sharing, publishing or commenting on a file without one **asks**, then adds it; in a site the question warns about the engine's `id` | Promotion on first edit; sharing by handle (breaks on a rename outside Fjord) |
| Journal encryption | Encrypted by default in the CLI (`--no-encrypt` opts out, `--encrypt` goes) and the web. A SHOULD in the spec, not a MUST | Plaintext by default; a format MUST |
| Journal saving | Unchanged: working copies and idle versions already make one commit per writing session (DESIGN §11) | A new batching mechanism |
| What a journal entry is | Any `.md` in the journal's vault, dated by `date`, else the path, else its first commit | Only Docs (an adopted journal of plain notes would show nothing) |
| Site editing | The vault's files as a tree. Source mode by default; rich mode with a frontmatter form only when the round trip is byte for byte | Rich mode always (destroys MDX, Liquid, shortcodes) |
| Publishing | A drive's Doc as a sanitised, read-only page: public at `/p/<token>`, private through shares and links. From an encrypted vault: privately by sealed link; publicly only after a warning, as a plaintext copy the browser gives the server | Rendering `.html` files from the repository (untrusted script, needs a separate origin) |
| Vault location | Any depth below the root, never inside another vault, never under `.fjord/`, `.git/` or an ignored directory; one vault for journal and site stays | Site vaults only below the root; root-only (blocks adopting sites) |
| Adoption | `fjord init --adopt`, every kind now: writes over nothing, commits only its own files, merges `.gitattributes` and `.gitignore`, refuses an existing `fjord.json`, detects a site's engine and content folder | Drive and journal only, sites later |
| Encrypting adopted plaintext | Only with `--encrypt-existing`, as a checkout (§6.6) that `key add` and `encrypt <vault>` end, after a warning that Git's history keeps every committed version. A journal with existing files needs `--no-encrypt` or `--encrypt-existing` | Encrypting silently; refusing outright |
| The spec | Written now, with the RFC, at the owner's request; the tasks bring the code to it | The spec changing with each task, the usual rule (`docs/rfcs/README.md`) |

## Prerequisites

- **RFC 0002 accepted** by the owner (its **Status** line changed), with any change to the decisions above written back here first.
- **The spec text reviewed** as part of that: it is already in [`docs/specs/Fjord.spec.md`](../specs/Fjord.spec.md).
- A Rust toolchain for leg 1, and `pnpm build:wasm` and `pnpm build:editor` for the web legs.

## Legs

| Leg | Name | Epic tasks | Gate? | Done when |
| --- | --- | --- | --- | --- |
| 1 | The format and the CLI | P13, P14, P15, P16, P17 | **Yes**: the owner reviews the CLI's adoption on real directories before any web task depends on it | Every fixture passes in the CLI and the module alike; an adopted directory, git repository and Astro and Jekyll site verify and build, byte for byte untouched |
| 2 | Drive | 3e.1, 3e.2, 3e.3 | No | No address shows a path; every Doc opens at `/d/<id>` in its kind's editor; any drive Doc can be shared |
| 3 | Journal | 3f.1, 3f.2 | No | A journal opens on a writing view; a default journal is encrypted |
| 4 | Site | 3g.1, 3g.2 | **Yes**: rich mode's round-trip guard is reviewed against real posts of both engines | An adopted site opens on its posts; nothing rich mode cannot hold is opened in it |
| 5 | Publishing | 3h.1, 3h.2 | No | A Doc is published and unpublished; an encrypted one only after the warning |

Each task is its own branch and draft PR; a leg ends at its review gate ([README](README.md#legs)).

## Leg detail

### Leg 1 — The format and the CLI

**Epic tasks:** P13, P14, P15, P16, P17

**Why here:** every web task asks the format module what a file is and where the vaults are. The CLI is the reference
implementation, and the owner asked for its changes first.

**Technical notes:**

- P13 and P14 land together where the fixtures need the code (as P9's did with P10), so every commit keeps the fixture suite green.
- `FileKind::Document` and `Note` are used across `fjord-core`, the CLI and the web: grep `FileKind::Document`, `docKind`,
  `fj.md` and `DOCUMENT_EXTENSION`. The web's uses are left for 3e.1, and keep building on the module's new answer in between.
- Vaults at depth touch everything that joins a vault's name to the root: the checkout record (`.fjord/local/`), `rekey`, `export`
  and `import`, `vault add`, `status`, `sync`'s merge of encrypted files.
- Adoption reuses `scaffold::plan_setup` (the web's 1a.10 already adopts with it). Engine detection is data in `fjord-core`, not
  the CLI's.
- `--encrypt-existing` is a checkout begun differently (spec §6.6's new paragraph), so `encrypt <vault>` ends it with the code it
  already has; it must also remove the plaintext from Git's index.
- The README is held to the flags (`readme_commands.rs`) and the codes (`readme_diagnostics.rs`): change it with the code.

**Do not proceed if:** P16's spike finds that Astro or Jekyll publishes or chokes on `fjord.vault.json` in its content folder and
no ignore rule outside the vault fixes it. Then vaults below the root need another marker, and that goes back to the owner.

### Leg 2 — Drive

**Epic tasks:** 3e.1, 3e.2, 3e.3

**Why here:** the address scheme and the one-editor rule are what every later leg's pages use.

**Technical notes:** `src/browse/screens/IdPage.tsx` already finds a Doc by `id`; `/f/` is its sibling for everything else. The
handle table follows the database rules (two dialects, migrations generated, three test legs). Removing promotion on edit touches
`src/browse/document.ts` and its tests; adding an `id` on share reuses the header it made. Old addresses (`/n/`, `/repo/…/<path>`)
redirect, as `/doc/` and `/note/` do (`proxy.ts`).

**Do not proceed if:** dropping promotion on edit breaks comments on existing notes that already rely on an `id` from an edit. It
should not (those files have an `id` now), but check before removing it.

### Leg 3 — Journal

**Epic tasks:** 3f.1, 3f.2

**Technical notes:** the timeline's index (`src/journal/index-store.ts`, `encrypted-timeline.ts`) gains entries without an `id`,
keyed by handle; an encrypted journal's stays in the browser. The setup's encrypted default reuses 2d.1's identity check.

### Leg 4 — Site

**Epic tasks:** 3g.1, 3g.2

**Technical notes:** the content editor (3c.2) and the document editor's guard (1b.3) are the starting point; the guard's test
becomes the condition for rich mode. The frontmatter form writes through the module (`with_title` is the pattern).

**Do not proceed if:** the round-trip guard refuses most real posts of either engine. Then rich mode is not worth offering yet, and
the owner decides.

### Leg 5 — Publishing

**Epic tasks:** 3h.1, 3h.2

**Technical notes:** the share link machinery (`src/sharing/links.ts`, `tokens.ts`, `redact.ts`) and the sealed share (`src/sealed/`)
are the patterns: a hashed token, a redacted path, a 404 for every wrong answer, `noindex`. The rendering is the sanitised Markdown
of DESIGN §15.

## Risks

- **The spec runs ahead of the code** until leg 1 is done. Anyone reading the spec meanwhile sees rules `fjord verify` does not yet
  apply. The RFC says so; keep leg 1 short.
- **Removing promotion on edit** changes behaviour people may rely on (1b.5). Files keep their `id`s; only new promotion stops.
- **Vaults at depth** widen every path that assumed a root vault, including ones in the web (`src/browse/location.ts`,
  `default-vault.ts`). A missed one shows as a vault that cannot be opened, not as data loss, but test each.
- **`--encrypt-existing`** is the one path where Fjord puts an existing directory under encryption. Its warning and its checkout are
  what keep invariant 1; a review of it is part of leg 1's gate.
- **Publishing** is the first page Fjord serves to anyone with no account and no share. Its sanitising and CSP are tested like a
  security behaviour: seen to fail with each switched off.

## Kill criteria

- If leg 1's adoption cannot leave a real Astro or Jekyll site byte for byte intact, stop after P15: one kind of Doc and journals
  encrypted by default stand alone, and adoption returns to the RFC.
- If handles prove unworkable for a large repository (the table's size, or the cost of drawing a listing), keep `/d/<id>` and stop
  before 3e.2; the rest of the workstream does not depend on handles beyond its links.

## Changelog

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-03 | Initial draft, with RFC 0002 |
