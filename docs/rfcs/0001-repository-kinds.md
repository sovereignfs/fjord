# RFC 0001 — Repository kinds: Drive, Journal and SSG

| | |
| --- | --- |
| **Status** | Accepted, 2026-11-02, by the owner. Implemented in part: the format (P9–P12) is in the spec, `fjord-core`, the CLI and `fjord-wasm`; the web client's kinds are being built on `feat/repository-kinds` ([workstream 0001](../workstreams/0001-repository-kinds.md)) |
| **Date** | November 2026 |
| **Author** | Claude Code, for review |
| **Scope** | [`docs/specs/Fjord.spec.md`](../specs/Fjord.spec.md) §3, §8.1, §11.2 (a format change, additive); `fjord-core`, `fjord-cli`, `fjord-wasm`; Fjord Web ([`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) §8, a new section); the other clients' fallback |
| **Tasks** | [`docs/epics/web-3.md`](../epics/web-3.md): P9–P12, then 3a–3d |
| **Research** | [Research 0001 — The `ssg` kind](../research/0001-ssg-kind.md) |
| **Workstream** | [0001 — Repository kinds](../workstreams/0001-repository-kinds.md) |
| **Supersedes** | Nothing. Fjord Web's phase 3 (collaborative editing, an outline) becomes phase 4 |

## Summary

Let a repository say what it is for. `fjord.json` gains an optional `kind`: **`drive`** (the default, and every repository
today), **`journal`** or **`ssg`**. A client opens a repository on the landing page of its kind: a file explorer for a drive, a
timeline for a journal, a content editor for a static site built with Astro or Jekyll. More kinds can be added later, each a
module of the client.

A kind is **a hint about presentation, never a different format.** The files are Fjord Docs as they are today, any
repository can always be opened as plain files, an unknown kind is opened as a drive, and changing a kind loses nothing. The
format gains one field, two rules for the new kinds (a journal or a site has exactly one vault, and a site's is plaintext), a
`date` key for Docs, and a recommendation for comparing tags.

## Motivation

A Fjord repository is a general store of documents and notes, and Fjord Web shows every one the same way: its vaults, then a
folder tree. That suits a drive. It does not suit:

- **A journal.** Entries are written in order and read by date: today's, last week's, everything tagged `health`. A folder
  tree of `2026/11/02/` is a poor way to read one, and there is nowhere to start a new entry for now.
- **A website.** An Astro or Jekyll site in a git repository is already a common way to publish. Its content is Markdown with
  frontmatter, which is what Fjord edits, but the person editing wants posts, drafts and fields, not a file tree, and the
  site's code (`astro.config.mjs`, layouts) is not theirs to edit there.

Each of these could be a separate product. Making them kinds of one repository keeps one format, one sync, one encryption
model, one sharing and comment system and one editor, and puts the difference where it belongs: in what the person sees first.

## Current state

Checked in the repository, November 2026:

- **The format has two levels.** A repository (`fjord.json`, §3) holds zero or more vaults, each a directory at the root with
  its own `fjord.vault.json` (§2.3, §4), plaintext or encrypted on its own. A directory is a vault if and only if it contains
  `fjord.vault.json` (§2.1); `fjord.json`'s `vaults` list is a convenience. Nested vaults are not permitted (§2.3).
- **`fjord.json` has no field about purpose.** Its fields are `fjord`, `id`, `name`, `createdAt`, `generator` and `vaults`.
  Unknown fields MUST be preserved (§10.1, invariant 3 of [`CLAUDE.md`](../../CLAUDE.md)), so a new optional field is safe
  for every existing client.
- **There is a precedent for presentation by name.** §8.4: a `*.fj.md` file is a document and any other `.md` a note, and a
  client "MUST NOT infer anything about a file's content from the distinction." A kind works the same way, one level up.
- **Frontmatter already has `tags`** (§8.1, an array of strings) and **`created`** (RFC 3339, UTC, set once). It has no date
  for what a Doc is *about*, and no rule for comparing tags.
- **What an encrypted vault reveals** (§11.2): directory names in every mode, file names in `plain` mode. In `id` mode leaf
  names are ULIDs (§7.2), and a ULID begins with its creation time (§8.3).
- **Publishing a vault to the web is reserved** (§12), and out of scope for the CLI (`CLAUDE.md`, Out of scope).
- **Fjord Web** discovers vaults from the listing with `fjord-core` (DESIGN §8, ROADMAP 1a.11), shows them with their counts,
  and opens a repository on its default vault. Setting up a repository that is not a Fjord one offers one plaintext vault
  (1a.10), and a vault can be added, plaintext or encrypted, from one planner shared with the CLI (2d.1).

## Goals

1. A repository can declare a kind, and every client opens it on that kind's landing page, or as a drive if it does not know
   the kind.
2. Three kinds: `drive` (today's behaviour, unchanged), `journal` and `ssg`.
3. A journal is a timeline of dated entries, several a day, findable by tag, and can be encrypted.
4. An `ssg` repository is an Astro or Jekyll site whose content Fjord edits. Previewing it is designed for, not built first.
5. A new kind is a new client module plus, at most, a few lines of spec: not a new format version, and not a rework of the
   kinds before it.
6. Every repository stays readable without Fjord: a journal is dated Markdown, a site builds with its own engine.

## Non-goals

- **Fjord does not publish.** Building and deploying a site stays the git host's job (GitHub Actions or Pages, or a host's
  own builds). §12 stays as it is.
- **Importing an existing site as it is**, with its content wherever its engine keeps it. See [Open questions](#open-questions).
- **The repository root as a vault.** Rejected below.
- **Kinds in the CLI's interface.** The CLI scaffolds and verifies them. It does not grow a timeline.
- **Mobile and `fjord-mcp` views of the new kinds.** Those clients honour the fallback; their own views are later.

## Design

### The `kind` field

`fjord.json` gains an optional field:

```json
{
  "fjord": 1,
  "id": "01jagc4k7pqw2xn8rvty5zb3md",
  "name": "Notebook",
  "createdAt": "2026-11-02T09:34:00Z",
  "kind": "ssg",
  "ssg": { "engine": "astro" },
  "vaults": [{ "path": "content", "id": "01jagc4k7pr9tbm3ykwx6zq2hv" }]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | string | no | `"drive"`, `"journal"` or `"ssg"` in this revision. Absent means `"drive"`. |
| `<kind>` | object | no | Settings for the kind, under a key named after it. Only `ssg` has any in this revision: `engine`, `"astro"` or `"jekyll"`. |

Rules, as proposed for §3:

- A client that does not know a repository's kind **MUST** treat it as `"drive"`, and **MUST** preserve `kind` and every
  settings object when it writes `fjord.json`. This is what lets a kind be added without a new format version.
- A kind changes how a client **presents** a repository, never what its files mean. A client **MUST** be able to show any
  repository as a drive, and **MUST NOT** refuse to read a repository because of its kind.
- A kind **MAY** be changed by editing the field. Nothing else changes, and the repository must then meet the new kind's rules.
- An unknown `engine` is treated like an unknown kind: the repository is shown as a drive by a client that cannot edit for it.

No new format version: `fjord` stays `1`.

### The rules of each kind

| Kind | Vaults | Encryption | Landing page (Fjord Web) |
| --- | --- | --- | --- |
| `drive` | Any number, as now | Per vault, as now | File explorer, as now |
| `journal` | **Exactly one** | Optional, chosen when it is created | Timeline |
| `ssg` | **Exactly one**: the site's content | **Never**: the vault is plaintext | Content editor |

- **Exactly one vault**, found as every vault is: by its `fjord.vault.json` (§2.1). The spec names no folder: Fjord's scaffold
  creates `journal/` or `content/`, but the vault may be renamed and still counts, because it is the only one. A new kind
  therefore needs no reserved name.
- **The vault is not shown.** For a journal or a site, the client presents the repository as the thing itself ("My Journal"),
  never a list of one vault.
- **Encryption stays where it is**, in the vault's `fjord.vault.json`. With one vault, choosing its encryption *is* choosing it
  for the repository, and §6, the checkout (§6.6), the recipients and `age -d` recovery all work unchanged.
- **An `ssg` vault is plaintext**, because a site is published. A site built from ciphertext would need its key in the host's
  build, which defeats the encryption.
- **The engine's own files live outside the vault**: `astro.config.mjs`, `package.json`, `_config.yml`, layouts. They are
  ordinary files of the repository outside any vault, as a root `README.md` is today (the conforming fixture has one). §2 does
  not say in words that such files are allowed, so P9 adds a sentence saying so. Fjord shows them in the drive view and does
  not edit them from the content editor. Research 0001 has the layout for each engine.

### `date`: what a Doc is about

§8.1 gains a key:

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `date` | RFC 3339 date-time or full-date | no | The moment the Doc is about. **Keeps the writer's local offset**: `2026-11-02T08:14:00+05:30`. A date alone (`2026-11-02`) is allowed. |

- **It is not `created`.** `created` is when the file was made, in UTC, set once. `date` is when the entry is about, and may be
  set or changed by the writer: an entry written the next morning about last night is dated last night.
- **It keeps the local offset, unlike every other timestamp in the format.** A journal is read by *the writer's* day. An entry
  written at 01:00 in Colombo is the previous day in UTC and would land on the wrong day of the timeline. The spec says so
  explicitly, so that the exception is not taken for an oversight.
- **It is defined for every Doc, not only journals.** It is the key Jekyll and Astro sites already use for a post's date, so the
  same key serves `ssg` posts, and an Obsidian vault that already has `date` keeps working.
- **A `date` that is not RFC 3339 is a warning, not an error.** Files written by other tools must be tolerated (§2.1). Jekyll,
  for instance, writes `2026-11-02 08:14:00 +0530`. A client falls back to the path, then to `created`.

### Journals

- **An entry is a Fjord Doc** (a note, `.md`, by default), with a `date`. Nothing else makes it an entry.
- **Several entries a day.** In a **plaintext** journal, Fjord creates an entry at `YYYY/MM/DD/HHMM[-slug].md`, from `date` in
  the writer's local time: `2026/11/02/0814-morning-run.md`. The path is a convention for making entries, not a rule: when the
  path and `date` disagree, `date` wins, and the mismatch is never a diagnostic. A file moved anywhere in the vault keeps its
  place on the timeline.
- **In an encrypted journal, entries are not put in dated folders.** Directory names are plaintext in every mode (§11.2, §7.2),
  so `2026/11/02/` would show anyone who can read the repository which days have entries, and how many. Fjord creates an
  encrypted journal with `fileNaming: "id"` and `container: "tar"` and puts its entries at the vault's root, so only ULIDs
  show. The timeline is built from the `date` inside each entry.
- **The timeline is derived, never stored in the repository.** It is an index of `date`, title and tags per entry. For a
  plaintext journal it can be built from the paths and frontmatter on the server. For an encrypted one it is built where the
  entries are decrypted (the browser, in Fjord Web), and kept there or not at all: never committed, never on the server in
  plaintext. §2.2 already forbids committing derived data.
- **Opening a journal** shows the timeline, newest first, with a "new entry" action for now.

### Tags

- **Tags are §8.1's `tags`**, an array of strings. No new key.
- **Proposed for §8.1, as a SHOULD:** clients compare tags **case-insensitively**, after NFC normalisation and Unicode case
  folding, and treat **`/` as nesting**, so `project/fjord` is a tag under `project`. A tag is stored exactly as it was written:
  comparison never rewrites a file.
- **Only the frontmatter counts.** A `#tag` in the text is not a tag to Fjord. That keeps the rule exact, and keeps Fjord from
  parsing prose to find tags in code blocks, headings and URLs.
- **The tag index is shared by every kind**: a journal filters its timeline by tags and a date range, a drive can list a tag's
  Docs, a site's posts carry them. The index is derived in the same way as the timeline, under the same rule for encrypted
  vaults.
- **Discoverability is the client's**: a list of every tag with its count, filters that combine, and suggestions of existing
  tags while one is typed, so that `run` and `running` do not both appear by accident.

### Sites (`ssg`)

Research 0001 has the detail; the decisions are:

- **Fjord scaffolds the site** for its engine, with the engine configured to read its content from the one vault (`content/`).
  This works within the format's rules (vaults at the root, no nesting) without changing them. An existing site whose content
  lives elsewhere is not supported in this revision.
- **First, content editing.** Posts and pages as Fjord Docs, their fields from a content model the kind module declares
  (title, `date`, `tags`, draft, description), and the build's status read from the git host.
- **Then preview, in two steps.** First through the host's own preview deploys: Fjord commits to a branch, the host builds it,
  and Fjord shows the preview's address. Later, possibly, a build that Fjord runs itself in a sandbox, behind the same action
  slot. That is designed for, not committed to.
- **Publishing stays the host's.** Fjord never deploys a site.

### The kind modules of Fjord Web

Each kind is a module of the web client with one interface, so a new kind is a new module and not a change to the others.
A module supplies:

| Part | What it is | Drive | Journal | SSG |
| --- | --- | --- | --- | --- |
| **Entry view** | The landing page of a repository of this kind | Today's vault list and folder browser | Timeline | Posts and pages |
| **Scaffold** | What a new repository of this kind contains, as data from `fjord-core` (as P6 and 2d.1 do today) | One vault | One vault, plaintext or encrypted | One plaintext vault and the engine's files |
| **Content model** | Where a new item goes and which frontmatter fields it has | Anywhere | `date`, `tags`; the path from `date` | Per engine: title, `date`, `tags`, draft |
| **Actions** | What the kind adds beyond editing | None | New entry | Build status; preview later |

Everything else is shared and unchanged: the document and note editors, working copies and versions, sharing, comments,
encryption in the browser, rename, move and delete. The drive view stays reachable from every kind ("Show files").

The design proper goes into `clients/web/DESIGN.md` when task 3a.1 is built; until then this RFC is the design.

### The CLI and `fjord-core`

- **`fjord-core`** reads and preserves `kind` and its settings object, reports the new diagnostics, scaffolds each kind as data
  (as it does for `init` today, P6), and computes a journal entry's path from a `date`. All of it is in the pure subset, so
  `fjord-wasm` can expose it.
- **`fjord init --kind <kind>`** scaffolds a repository of that kind (`--engine` for `ssg`; `--encrypt` for `journal`, as
  vaults are encrypted today), interactive or `--no-input`.
- **`fjord verify`** checks the kind's rules, and reports the kind in `--json`.
- **`fjord new`** in a journal makes a new entry for now, dated in local time, at the path the convention gives.

### Diagnostics

In outline. The numbers are assigned by task P9, and once released never change:

| Code | Meaning |
| --- | --- |
| `E111` | Kind `journal` or `ssg`, but not exactly one vault |
| `E112` | Kind `ssg`, but its vault is encrypted |
| `W606` | `date` is not an RFC 3339 date-time or full-date |

A kind that is not known is **not** a diagnostic: it is how a repository made by a newer client looks, and `verify` must not
fail it. A wrong type for `kind` (a number, say) is `E110`, as for any field today.

### Other clients

Fjord Mobile and `fjord-mcp` are designs. Each design gains one rule: a repository of a kind the client does not present is
shown, or served, as a drive, with every field preserved. `fjord-mcp` may later expose a journal's timeline as a tool. A
journal is an obvious thing to ask Claude about, and that is for its own roadmap.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| **The kind on each vault**, so one repository mixes a drive, a journal and a site | It was the first proposal. Rejected by the owner: one repository is one thing to the person, and a site is deployed per repository by every common host. Mixing is two repositories, which Fjord Web already handles as two connections. |
| **The root as the vault** of a journal or site, with encryption in `fjord.json` | It collides with most of §2 and §6: the root must keep `fjord.json`, `.gitattributes` and `.gitignore` in plaintext, the recipients file moves, a checkout would cover the whole repository, and every client and fixture changes. One hidden vault gives the same experience with almost no change to the format. |
| **Fixed folder names** per kind (`journal/`, `content/` required) | They add a reserved name per kind to the spec and break on a rename. "Exactly one vault" needs none, and discovery is already by manifest. |
| **`site` as the ID** of the static-site kind | Proposed, because it names what the person has and would fit a site built another way later. The owner chose `ssg`. The engine setting carries the detail either way. Recorded so it is not reopened by accident. |
| **`date` in UTC**, like `created` | Consistent, but it puts a late-night entry on the wrong day, which is the one thing a journal must get right. |
| **Reusing `created`** for an entry's date | `created` is set once and is about the file. An entry's date can be chosen and changed. |
| **Dated folders in an encrypted journal** | Directory names are never encrypted (§11.2). They would publish which days have entries. |
| **`#tags` in the text** as well as the frontmatter | Obsidian does this, but the rules are fuzzy (code, headings, URLs, `#1` in prose), and it would make Fjord parse prose. The frontmatter is exact. |
| **Exact-match tags** | Simple, and it makes `Work` and `work` two tags, which no one means. |
| **Fjord builds and publishes sites** from the start | A build is arbitrary code from the repository (`npm install`, plugins). Running it is a sandboxing problem of its own, and publishing is reserved by §12. Previews through the host come first. |

## Security and privacy

- **An encrypted journal reveals what any encrypted vault does** (§11.2): the number and size of entries, when each was
  committed, and its ULID, which encodes when it was created, as its first commit already does. It does **not** reveal entry
  dates, titles or tags: those are inside the ciphertext, and the layout above keeps dates out of directory names. The spec's
  §11.2 gains a sentence on choosing paths in an encrypted vault, since the journal is the first layout Fjord itself proposes.
- **The timeline and tag index of an encrypted journal** never leave the place where the entries were decrypted, and are never
  committed (§2.2).
- **An `ssg` repository is public by intent.** Fjord says so when one is created, and refuses to make its vault encrypted
  rather than pretend.
- **A build run by Fjord** (later) would execute code from the repository. It is out of this RFC, and would need its own
  review before it is built.

## Open questions

1. **Importing an existing site**, whose content is where its engine keeps it (`src/content/blog`, `_posts/` at the root). It
   needs the kind to declare content folders, a `collection` concept, and the root-only rule for vaults bent for it. Later, as
   its own RFC.
2. **Notes or documents in a journal.** The default is notes (`.md`). Whether a journal offers documents (`*.fj.md`) for long
   entries is the client's choice, and the format does not care.
3. **The labels people see** are the client's: "Drive", "Journal" and "Site" are proposed.
4. **More kinds** (a reading log, a wiki) are expected, and each needs this RFC's module interface and nothing more. They are
   not proposed here.

## Changelog

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-02 | Initial draft, from a design conversation with the owner |
| 1.0 | 2026-11-02 | Accepted by the owner as drafted; workstream 0001 started |
| 1.1 | 2026-11-02 | P9: tags are compared by Unicode's default lowercase mapping after NFC, not by case folding, so that every client's standard library gives the same answer (JavaScript has `toLowerCase` and no case folding); `date` written in the spec as an RFC 3339 date-time with any offset, or a full-date |
