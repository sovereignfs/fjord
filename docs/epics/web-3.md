# Fjord Web — 3 — Repository kinds

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [RFC 0001](../rfcs/0001-repository-kinds.md) until task 3a.1 moves it into [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); the `ssg` kind's detail is [Research 0001](../research/0001-ssg-kind.md). Where this file and either disagree, they are right. The order of work, across legs, is [workstream 0001](../workstreams/0001-repository-kinds.md).

**Status of the whole phase:** 📋 planned on 2026-11-02, nothing built. The RFC is proposed and not yet accepted: P9 does not start until it is.

## What the phase promises, and what it does not

- **A repository opens as what it is for.** `fjord.json`'s `kind` (`drive`, `journal` or `ssg`) chooses the landing page: a file explorer, a timeline, a site's content editor. Every repository can still be opened as a drive, and one of a kind a client does not know *is* opened as a drive.
- **One format.** A journal's entries and a site's posts are Fjord Docs like any other. Editing, versions, sharing, comments and encryption are phases 1 and 2's, unchanged.
- **An encrypted journal reveals no more than an encrypted vault does** (spec §11.2): entries are not put in dated folders, and the timeline and tags of an encrypted journal are derived where it is decrypted, never committed and never on the server in plaintext.
- **Not in this phase:** Fjord building a site itself (3d.2 is an outline), Fjord publishing one (never; spec §12), importing an existing site whose content is not in one root vault (RFC 0001, open question 1), the new kinds in Fjord Mobile and `fjord-mcp` (they open them as drives).

## Prerequisites in fjord

| # | Task |
| --- | --- |
| P9 | Spec: repository kinds, `date`, and comparing tags |
| P10 | `fjord-core`: kinds, their rules and their scaffolds |
| P11 | CLI: `init --kind`, `verify` and journal entries |
| P12 | `fjord-wasm`: kinds and journal paths |

### P9 Spec: repository kinds, `date`, and comparing tags

**Status:** 📋 Planned (*Next*, once RFC 0001 is accepted)

**Design:** RFC 0001, The `kind` field, The rules of each kind, `date`, Tags, Diagnostics

Write RFC 0001's format change into `docs/specs/Fjord.spec.md`:

- §3: `kind` and the settings object named after it, the fallback to `drive` and the duty to keep both.
- §2: files outside any vault are allowed. The format already relies on this (a root `README.md`); it is said in words for a site's engine files.
- The one-vault rule for `journal` and `ssg`, and plaintext for `ssg`.
- §8.1: `date`, with its local offset and the reason for the exception.
- §8.1: tag comparison as a SHOULD.
- §11.2: a sentence on choosing paths in an encrypted vault.

Fixtures: `tests/fixtures/broken/<code>/` for each new code, and a conforming repository of each new kind.

**Accepts when:** the spec says all of it; every new fixture emits exactly its code and nothing else; the conforming fixtures, old and new, emit nothing; the RFC's status says it was implemented by P9.

### P10 `fjord-core`: kinds, their rules and their scaffolds

**Status:** 📋 Planned

**Design:** RFC 0001, The CLI and `fjord-core`, Diagnostics

The manifest reads `kind` and its settings object and writes them back as they were, unknown values included. The new diagnostics go into `diagnostics.rs`, and the CLI README's tables follow them (`readme_diagnostics.rs` holds the two together). The scaffold-as-data of P6 gains a kind: one vault for a journal, plaintext or encrypted (`id` naming and a tar container when encrypted), and for `ssg` one plaintext vault plus the engine's files (Research 0001, *What both engines need*). A journal entry's path is computed from a `date` and an optional slug, in the writer's local time. All of it is in the pure subset.

**Accepts when:** round-tripping `fjord.json` with an unknown kind and an unknown settings object loses nothing (a property test, beside the frontmatter one); each kind's scaffold, written to disk, passes `verify`; the entry path is tested across a day boundary in UTC that is not one in local time; the pure subset builds for `wasm32-unknown-unknown`.

### P11 CLI: `init --kind`, `verify` and journal entries

**Status:** 📋 Planned

**Design:** RFC 0001, The CLI and `fjord-core`

- `fjord init --kind drive|journal|ssg`, with `--engine astro|jekyll` for `ssg` and `--encrypt` for a journal. Interactive on a TTY, and a usage error under `--no-input` when something is missing.
- `verify` checks the kinds' rules, and `--json` reports the repository's kind under a name that does not clash with `ls --json`'s `kind` (P2 already uses that name for a file).
- In a journal, `fjord new` with no path makes an entry for now, at the path P10 computes.

**Accepts when:** `fjord init --kind <k> x && cd x && fjord verify` exits 0 for each kind; an `ssg` repository with an encrypted vault, and a journal with two vaults, each fail with their codes; the schema of `verify --json` (`schema/`) gains the field; the README documents all of it.

### P12 `fjord-wasm`: kinds and journal paths

**Status:** 📋 Planned

**Design:** RFC 0001, The CLI and `fjord-core`

Expose P10 to JavaScript: a repository's kind and settings from its manifest (through discovery, which the web already calls), the scaffold of each kind, and an entry's path from a `date`.

**Accepts when:** the module's JavaScript tests read every new fixture with the answers the CLI gives (`fixtures.test.mjs`); its size change is recorded here.

## 3a — Kinds in the web client

### 3a.1 Kind modules

**Status:** 📋 Planned

**Design:** RFC 0001, The kind modules of Fjord Web

A module per kind, behind one interface: entry view, scaffold, content model, actions. A registry chooses the module from the repository's kind, and falls back to Drive for a kind it does not know. "Show files", which opens the drive view, is reachable from every kind. Move the RFC's design into `DESIGN.md` as a section of its own, and add the decision to its log.

**Accepts when:** a repository with no `kind`, with `drive`, and with a kind the client does not know, each opens on the drive view; a test registers a stand-in kind and its entry view is shown with nothing else changed; every new route is in `src/access/routes.ts`.

### 3a.2 Drive as a kind

**Status:** 📋 Planned

**Design:** RFC 0001, The kind modules of Fjord Web; DESIGN §8

Today's vault list and folder browser become the `drive` module's entry view, with no change of behaviour.

**Accepts when:** the existing browse unit and e2e tests pass unchanged; nothing a person sees differs for an existing repository.

### 3a.3 Choosing a kind

**Status:** 📋 Planned

**Design:** RFC 0001; DESIGN §7 (setting up a repository, 1a.10)

When a repository that is not a Fjord repository is set up, offer a kind: drive (today's offer), journal (plaintext, or encrypted when the person has an identity, as 2d.1 does for vaults), or site (with an engine). The plan is `fjord-core`'s scaffold, through the module (P12), previewed before the one commit, as today. A repository's kind can later be changed from its settings, with the new kind's rules checked first.

**Accepts when:** each kind set up in the web client passes the real `fjord verify` (`FJORD_CLI`, as `cli.test.ts` does); changing a kind refuses a repository that breaks the new kind's rules and says why; an `ssg` repository is never offered an encrypted vault.

## 3b — Journal

### 3b.1 Journal entries

**Status:** 📋 Planned

**Design:** RFC 0001, Journals

"New entry" makes a note dated now in the writer's local time. In a plaintext journal it goes at the conventional path, and in an encrypted one at the vault's root. It opens in the note editor. The `date` can be changed from the properties panel (1b.5), and changing it never moves the file.

**Accepts when:** an entry made just after midnight local time is on that local day, whatever the UTC date; an entry in an encrypted journal is created with no dated directory; a moved entry keeps its place on the timeline.

### 3b.2 Timeline

**Status:** 📋 Planned

**Design:** RFC 0001, Journals

The journal's entry view: entries newest first, grouped by day, with their title and the start of their text, paged. The index is derived from `date`, falling back to the path and then `created` (and `W606` shown for a `date` that cannot be read). For a plaintext journal it is built on the server. For an encrypted journal it is built in the browser from entries decrypted there, kept in memory or in the browser only, never sent to the server.

**Accepts when:** a timeline of a few thousand entries pages without reading every blob at each view; a test of the encrypted journal reads every request the page sends and finds no date, title or tag of an entry; entries with a `date` and a path that disagree are placed by the `date`.

### 3b.3 Tags

**Status:** 📋 Planned

**Design:** RFC 0001, Tags

A tag index shared by every kind, built where the timeline index is and under the same rule for encrypted vaults. Comparison is case-insensitive after NFC and case folding, with `/` as nesting. In the journal: filter the timeline by one or more tags and a date range, a list of every tag with its count, and suggestions of existing tags while one is typed into an entry's `tags`.

**Accepts when:** `Work` and `work` are one tag and both spellings stay as they were written in the files; a filter on `project` includes `project/fjord`; the suggestions offer existing spellings first; the encrypted case is tested as in 3b.2.

## 3c — SSG

### 3c.1 Site scaffold

**Status:** 📋 Planned

**Design:** RFC 0001, Sites; Research 0001, *What both engines need* and *Recommendation*

Opens with a spike that settles every **to confirm** of Research 0001 against the engines' current releases, recorded here. Then each engine's scaffold, from P10: Astro with `glob()` over `content/`, Jekyll with `collections_dir: content`, the manifests kept out of the built site, and, if the person chooses, the host's usual publishing workflow.

**Accepts when:** each scaffold builds with its engine's own tools on a clean machine (in CI or recorded here) and the built site contains neither manifest; each passes `fjord verify`.

### 3c.2 Content editor

**Status:** 📋 Planned

**Design:** RFC 0001, Sites; Research 0001

The `ssg` module's entry view: the site's posts, and for Astro its pages, with the fields of a fixed content model per engine (title, `date`, `tags`, draft, description). Paths follow the engine's rules (Jekyll's dated names). Drafts take the engine's own form. Editing is the document and note editors, unchanged.

**Accepts when:** a post written in Fjord builds with its engine and shows its fields (checked against a scaffold of 3c.1); a Jekyll post's file name follows its `date`; a tag with a space is refused for Jekyll.

### 3c.3 Build status

**Status:** 📋 Planned

**Design:** Research 0001, *Build status and preview*

The head commit's statuses, checks and deployments, read through the `Provider`, shown on the site's page: building, built (with the site's address when the host gives one), or failed (with the host's link). Nothing is configured in Fjord. A host that reports nothing shows nothing.

**Accepts when:** the provider contract covers reading statuses (`MemoryProvider` and the GitHub fixtures, re-recorded); the page shows each state from a recorded answer.

## 3d — Preview

### 3d.1 Previews through the host

**Status:** 📋 Planned

**Design:** Research 0001, *Build status and preview*, open question 4

"Preview" commits the working copy to a preview branch, not the default branch, waits for the host's status on that commit, and shows its link. The branch's lifetime (one per working copy or one per person, and when it is deleted) is decided at the start of this task and recorded here.

**Accepts when:** against a recorded host answer, the link appears for the preview commit and not the default branch's; the default branch is never written; a host that previews no branches is told plainly, not left waiting.

### 3d.2 A build in Fjord

**Status:** 🚧 Open (needs its own RFC and a security review)

**Design:** Research 0001, *Build status and preview*, point 4

An outline only. A sandboxed build of the site, served from another origin, behind the `ssg` module's actions. Not started before its RFC is accepted.
