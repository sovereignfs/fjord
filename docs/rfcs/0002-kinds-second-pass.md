# RFC 0002 — Kinds, second pass: one kind of Doc, addresses, adoption

| | |
| --- | --- |
| **Status** | Draft, for the owner's review |
| **Date** | November 2026 |
| **Author** | Claude Code, from a design conversation with the owner (2026-11-03) |
| **Scope** | [`docs/specs/Fjord.spec.md`](../specs/Fjord.spec.md) §1.3, §2.3, §3, §3.1, §6.6, §8.4, §12 (a format change, not additive: §8.4 is withdrawn); `fjord-core`, `fjord-cli`, `fjord-wasm`; Fjord Web ([`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) §8, §9, §10, §12) |
| **Tasks** | [`docs/epics/web-3.md`](../epics/web-3.md#kinds-second-pass-rfc-0002): P13–P17, then 3e–3h |
| **Workstream** | [0002 — Kinds, second pass](../workstreams/0002-kinds-second-pass.md) |
| **Amends** | [RFC 0001](0001-repository-kinds.md): `.fj.md` in a journal (its open question 2), importing an existing site (its open question 1), and the site layout rule ("an existing site whose content lives elsewhere is not supported") |

## Summary

RFC 0001 gave a repository a kind. This RFC makes the kind do more of the work, and removes the parts that overlapped it:

- **One kind of Doc.** Spec §8.4's split between a *document* (`*.fj.md`) and a *note* (any other `.md`) is withdrawn. Every Doc is
  a `.md` file. The repository's kind decides how it is edited: a drive's Docs in the document editor, a journal's in a minimal
  Markdown editor, a site's in a content editor.
- **Addresses that are not paths.** A Doc is always `/d/<id>`. Everything else (a folder, a PDF, a `.md` with no `id`, a site's
  page) is `/f/<handle>`, an opaque handle the web client keeps in its own database. Nothing about addresses is committed.
- **A journal is encrypted unless asked otherwise**, by the CLI and the web.
- **A drive's Doc can be published** as a rendered, read-only page, publicly or privately.
- **A vault can be at any depth**, never inside another, so an existing Astro or Jekyll site can become a Fjord repository with its
  content where its engine already reads it.
- **`fjord init --adopt`** makes a Fjord repository of a directory that already has files, of any kind, writing over nothing.

The spec text of this RFC was written into [`docs/specs/Fjord.spec.md`](../specs/Fjord.spec.md) at the owner's request with the RFC
itself, ahead of the code. Until P13–P17 land, the spec says more than `fjord-core` and the CLI do: the code still knows
`.fj.md` documents and root-only vaults. The tasks close that gap; nothing in a repository has to change.

## Motivation

- **Two things decided the same question.** After RFC 0001, how a Doc is presented could be decided by the repository's kind and by
  its file name. They can contradict each other (a `.fj.md` in a journal, a plain `.md` that a drive wants as a long document), and
  the extension had to be carried through every rename, move, merge and restore (`extension_changed`, the `.fj.md` cases in
  `naming.rs` and `merge.rs`). The kind is the coarser and more useful signal, and it is already there.
- **The address bar shows real paths.** Browsing is `/repo/<connection>/<path>`, so a long name, a space or a special character is
  in the address, and so is any name a person did not mean to show in a screenshot or a link they paste.
- **A journal is the most private thing a person writes.** Plaintext should be the choice, not the default.
- **A drive's Doc is often meant to be read by someone without an account.** Today a document can be shared with accounts or by
  link, inside Fjord's page; there is no clean, read-only rendering of it.
- **Most people who would use Fjord already have files.** `fjord init` refuses a directory that is not empty, and a site's content
  cannot be a vault where its engine keeps it.

## Current state

Checked in the repository, 2026-11-03:

- **§8.4** defines document (`*.fj.md`) and note. `fjord-core` classifies them (`listing.rs`, `FileKind::Document` and
  `FileKind::Note`), the CLI has `fjord new --document` and `ls --json`'s `docKind`, and Fjord Web opens a document at `/d/<id>`
  in MDXEditor and a note at `/n/<id>` in CodeMirror. **Only documents can be shared** (`clients/web/src/sharing/http.ts`,
  `not_a_document`).
- **Addresses** (DESIGN §9): `/d/<id>` and `/n/<id>` resolve through the derived `doc_index` (`src/browse/doc-index.ts`, `ids.ts`).
  Folder listings link by path, `/repo/<connection>/<path>`. A file with no header is **promoted on its first edit** (ROADMAP
  1b.5): the edit gives it `id`, `title` and `created`.
- **Saving already batches.** Every edit goes to a working copy, and a version (one commit) is made on Save version or after a quiet
  period, five minutes by default (DESIGN §11, ROADMAP 1b.9, 1b.13). An encrypted file's working copy is ciphertext (2b.3).
- **A journal** is one vault; encrypted, it is `fileNaming: "id"` with the tar container, entries flat at its root (RFC 0001).
  `fjord init --kind journal` is plaintext unless `--encrypt`; the web's setup offers either. A new entry opens in the note editor
  (3b.1).
- **A site** is scaffolded by Fjord with its engine reading `content/` (3c.1). Its posts open in the content editor (3c.2), built on
  the document and note editors.
- **Vaults are root-level directories** (§2.3, before this RFC). `fjord.json`'s `vaults[].path` already allowed a relative path.
- **`fjord init`** refuses any directory that is neither empty nor only `.git`. The web's setup of a repository that is not a Fjord
  one (`src/browse/setup.ts`, ROADMAP 1a.10) already adds Fjord to existing files, through `fjord-core`'s `scaffold::plan_setup`:
  a `fjord.json`, a new vault, and a line appended to `.gitattributes`, writing over nothing.
- **Sharing and publishing** are not in the format (§12 reserves them). Shares and links live in the web client's database.

## Goals

1. One kind of Doc in the format; the editor is the kind's choice.
2. No real path in any address Fjord Web shows, and one address per Doc whether or not it is shared.
3. A journal encrypted by default, in every client that creates one.
4. A drive's Doc publishable as a page, public or private.
5. An existing directory, git repository or site adopted as a Fjord repository without a file moved or rewritten.

## Non-goals

- **Rendering `.html` files stored in a repository.** It needs a sandboxed separate origin, since a repository's HTML is
  untrusted script. Not now.
- **A CMS for sites** beyond listing and editing the vault's files: collections, schemas read from the engine, media. Later.
- **Slugs** as addresses. A handle is opaque; a readable slug can be added later beside it.
- **Nested vaults**, a vault inside a vault. Still reserved (§12).
- **Changing how saving works.** Working copies and idle versions already do what a journal needs (below).

## Design

### One kind of Doc

- **§8.4 is withdrawn** (spec text: "One kind of Doc"). Every Doc is a `.md` file with a valid `id`; a client MUST NOT infer
  anything from a Doc's name beyond §8. A `.fj.md` file is a `.md` file like any other, and nothing in a repository has to change.
- **The kind chooses the editor** (§3.1's new sentence):

  | Kind | Editor | What it is |
  | --- | --- | --- |
  | `drive` | The document editor (MDXEditor, `packages/fjord-editor`) | Long-form, rich editing, with its existing guard: a Doc whose meaning it cannot keep opens in the source editor instead (DESIGN §10, 1b.3) |
  | `journal` | The minimal editor: today's note editor (CodeMirror 6, byte-faithful Markdown) in a writing view without file chrome | Fast entry-taking |
  | `ssg` | The content editor: source by default, rich only when the round trip is exact (below) | Posts and pages |
  | unknown | As `drive` | §3.1's fallback |

  "Show files" keeps working for every kind, and a file opened from it uses its kind's editor.
- **In `fjord-core`**, `FileKind::Document` and `FileKind::Note` become one `FileKind::Doc`; the `.fj.md` cases in `naming.rs`
  (`free_name`), `merge.rs` (how a name ends) and the web's `files/restore.ts` and rename rules (`extension_changed`) go. The CLI
  drops `fjord new --document` and `ls --json`'s `docKind`.

### Addresses

Two kinds of address, both opaque, both stable across a rename made in Fjord:

| What | Address | Where the mapping lives |
| --- | --- | --- |
| A Doc (a `.md` with a valid `id`, §8.1) | `/d/<id>` | The `id` is in the file (§8.3). The existing `doc_index` finds it |
| Anything else: a folder, a vault file, a `.md` with no `id`, a site's file | `/f/<handle>` | A new table in the web client's database, `(connection, path) → handle` |

- **`/d/<id>` is the one address of a Doc**, owned or shared, so a link means the same to its owner and to the person it was sent to.
  It survives renames and moves made anywhere, because the `id` travels with the file. `/n/<id>` answers a 308 to `/d/<id>`, as
  `/doc/` and `/note/` already do.
- **A handle** is a short random identifier (128 bits, base32, like a ULID without its time), made the first time Fjord shows a link
  to that path. It is **derived data**: never committed (§2.2), rebuildable, and dropped with the connection. Fjord's own rename and
  move update it in the same request that updates `doc_index`. A file moved outside Fjord has a new path and gets a new handle; the
  old one answers **"moved or gone"**, never a different file. A handle is per connection, so it says nothing to someone who cannot
  open the connection.
- **`/repo/<connection>/<path>` goes.** Folder lists link by handle (`/f/…`) or by id (`/d/…`) when the listing's `doc_index` row
  knows one. A path typed into `/repo/…` redirects once to its handle, so old bookmarks work.
- **When a file gets an `id`** changes: **never silently**. Opening a file never adds one (§8.2 already forbids it), and, reversing
  ROADMAP 1b.5's promotion, **neither does editing it**: a `.md` written by Obsidian or by hand is edited at its `/f/` address and
  stays byte for byte what its author made it, apart from the edit. Files Fjord creates have an `id` from the start. An `id` is
  added only by an action that needs a lasting identity — **sharing, publishing or commenting** — and that action asks first ("This
  adds an identifier to the file's header so the link keeps working if it is renamed"). Then `/f/<handle>` redirects to `/d/<id>`.
  In an `ssg` repository the question also warns that the engine may read an `id` key (Jekyll's `page.id`).

### Sharing any drive Doc

With one kind of Doc, the `not_a_document` refusals go: **any Doc in a drive can be shared** with accounts or by link (DESIGN §12),
and a `.md` without an `id` can be, after the question above. Comments follow sharing. A journal's entries and a site's files are
not offered sharing by their kind's views; they can still be shared from "Show files", which is the drive's view.

### Journals

- **Encrypted by default.** `fjord init --kind journal` encrypts its vault; `--no-encrypt` makes it plaintext, and `--encrypt` is
  dropped. The web's setup selects *encrypted* when the browser has an identity, and asks for one to be made otherwise (as 2d.1
  does). The spec says it as a SHOULD (§3.1): a plaintext journal still conforms.
- **The minimal editor** is a writing view: today's entry, or a new one, open at once in the note editor, with the date, tags and
  nothing else on screen. No new editor core is needed.
- **Saving needs nothing new.** A working copy is saved as the person types and a version made after the quiet period (DESIGN §11),
  so a journal makes one commit per writing session already, and an encrypted one keeps only ciphertext on the server. A journal
  MAY have a shorter quiet period than other kinds; that is a setting, not a mechanism.
- **An entry is any `.md` in the journal's vault**, not only a Doc, so an adopted journal of daily notes with no frontmatter
  (`2026-11-02.md`) has a timeline at once. Its date is `date`, else the path (RFC 0001), else the file's first commit. An entry
  with no `id` is addressed by handle until something gives it one.

### Sites

- **The site's view lists the vault's files**, as a tree, with *New post* as today.
- **Each file opens in source mode** (the note editor, byte-faithful) **or rich mode** with a **frontmatter form**. Rich mode is
  offered only when parse→serialise gives back the file byte for byte, the same test MDXEditor's guard already makes (1b.3);
  otherwise it is disabled and the reason is shown. This keeps MDX components, Liquid `{% %}` tags and shortcodes intact.
- **The frontmatter form** has fields for title, `date`, `tags`, draft and description, and a generic key and value editor for the
  rest. Every key is kept, in order (invariant 3); the form writes through `fjord-core`, never a parser of the web's.
- **A site's files are never given an `id` by editing** (above). They use handles.

### Publishing a drive's Doc

- **A Doc can be published as a page**: Markdown rendered to sanitised HTML (no raw HTML from the file is passed through, DESIGN
  §15), read-only, with its title and nothing of Fjord's interface. Two modes:
  - **Public**: anyone with the address, `/p/<token>`, no account. It can be unpublished, which ends the address at once.
  - **Private**: today's shares with accounts and password links (DESIGN §12), which gain the same read-only rendering.
- **The page is rendered from the Doc's current version** on the repository's default branch, not from a draft, so what is
  published is what was saved.
- **From an encrypted vault**, the server cannot render the Doc: it has no key (DESIGN §12). Privately, the sealed link (2c.1)
  already is the answer, its key in the address's fragment and never sent to the server, and it gains the same rendering. Publicly,
  only after a warning that names what happens: the owner's browser decrypts the Doc and gives the server a **plaintext copy** of
  that version to serve, readable by anyone with the address and kept until it is unpublished; a later version is published again.
  It is never on by default.
- **Not the format.** A publication is a row in the web client's database, like a share; nothing is written to the repository,
  and §12's reservation of "publishing a plaintext vault" is untouched.

### Vaults at any depth

- **§2.3** now allows a vault at any depth below the root, never inside another vault, never under `/.fjord/` or `.git/`, and not in a
  directory Git ignores. `fjord.json`'s `vaults[].path` is the path from the root (`src/content`).
- **Discovery** looks for `fjord.vault.json` throughout the tracked tree. For the CLI this is the walk it already makes (with
  `ignore`, which respects `.gitignore`); for the web it is the listing it already has. `fjord-core`'s discovery from a listing
  already takes every path.
- **A vault inside a vault** gets a diagnostic of its own, proposed as `E113`. The number is assigned by P14 and, once released,
  never changes.
- **What else depends on a vault being at the root**: the `.gitattributes` rule (`*.age`) is path-free and unchanged; an
  encrypted vault's guard `.gitignore` is the vault's own; a checkout's record names the vault by path. Each is checked by P14.
- **RFC 0001's rule of exactly one vault** for a journal or a site stays.

### Adopting existing files: `fjord init --adopt`

`fjord init --adopt [--kind <kind>] [--vault <dir>]…` turns a directory that already has files into a Fjord repository.

- **Writes over nothing.** It never moves, renames or rewrites an existing file (invariant 6, §8.2). It writes `fjord.json`, each
  vault's `fjord.vault.json`, and appends spec §9's lines to an existing `.gitattributes` and `.gitignore` (or creates them). It
  refuses a directory that already has `fjord.json`.
- **Git.** In a directory that is not a git repository it runs `git init`, as `init` does. In one that is, it does not, and its
  commit contains **only the files it wrote**: a person's uncommitted work stays uncommitted. `--no-git` skips the commit.
- **Which directories are vaults.** `--vault <dir>` (repeatable for a drive), or on a terminal a choice among the top-level
  directories. A drive with none chosen gets a new, empty `Public` vault, as the web's setup does. Files outside every vault stay
  ordinary files (§2).
- **A site.** The engine is detected: `astro.config.*` means Astro, with `src/content` proposed as the vault; `_config.yml` means
  Jekyll, with `_posts`. `--engine` and `--vault` override. Nothing of the engine's is changed.
- **A journal.** One vault, chosen or detected (a directory of dated `.md` files). Its entries need nothing written to them (above).
- **The planner is `fjord-core`'s**: `scaffold::plan_setup` and its kind variants, extended to take existing directories as vaults,
  so the CLI and the web make the same bytes (as 2d.1 does for `vault add`).

**Encrypting what was plaintext.** A journal is encrypted by default, but adopting existing plaintext as an encrypted vault cannot
undo the past: the files are already on disk, and may already be in Git's history. So:

- `--adopt` of a journal with existing files requires a choice: `--no-encrypt`, or `--encrypt-existing`. With `--no-input` and
  neither, it is a usage error (exit `2`), never a silent default.
- **`--encrypt-existing`** creates the vault encrypted and records its plaintext as a **checkout** (§6.6). Nothing can be committed
  until it ends. The person adds a key (`fjord key add`), and `fjord encrypt <vault>` ends the checkout as any checkout ends:
  every file encrypted to the recipients, each payload checked, the plaintext removed from disk and from Git's index, in one
  commit. The spec's §6.6 gains a paragraph allowing a checkout to begin this way.
- **It warns**, before anything, that **every version already committed stays readable in Git's history** (§11.4), and that only a
  new repository, or rewriting history, removes it. If the directory has no history of these files, it says so instead.

## The CLI and `fjord-core`

- **`fjord-core`** (P14): `FileKind::Doc`; discovery and the path checks with vaults at depth; `E113`; the adoption plan beside
  `plan_setup`. All of it except reading a disk is in the pure subset, so `fjord-wasm` (P17) exposes it.
- **The CLI** (P15, P16): `new` and `ls` without documents; the journal encrypted by default; `init --adopt`. The README's command
  sections change with the flags (`tests/readme_commands.rs`), and its diagnostics table with `E113` (`readme_diagnostics.rs`).
- **`fjord verify`** accepts vaults at depth and reports `E113`. A `.fj.md` file is no longer classified apart.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `E113` (proposed) | A vault inside another vault: a directory with `fjord.vault.json` below another one |

Nothing is removed: no code was about `.fj.md`.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| **`.fj.md` as the journal's marker** (entries `.fj.md`, drive files `.md`) | The owner's first proposal. Kind and extension would then both say how a Doc is presented, and could contradict each other; a journal's files would look odd to Obsidian, Jekyll and `ls`; and every rename, merge and restore would still carry the extension. "In a journal's vault" already says it is an entry |
| **Keeping §8.4 as it was** | It answered a question RFC 0001's kinds now answer better, per repository |
| **An index committed to each vault**, id or slug to path | It contradicts §2.1 (the filesystem is authoritative) and §2.2 (derived data is never committed); two devices adding files conflict on it; an edit made outside Fjord makes it stale at once; and in an encrypted `id`-mode vault it would publish the real names that mode exists to hide |
| **The path encoded** (base64url) in the address | It is longer than the path, still changes on a rename, and can be decoded by anyone, so the path still leaks through shared links, referrers and logs |
| **Promoting a file on first edit** (ROADMAP 1b.5, today) | Decided against by the owner: a file another tool wrote should change only by what the person typed. An `id` is added when a lasting identity is needed, and asked for |
| **Sharing by handle**, so no `id` is ever added | A handle does not survive a rename made outside Fjord; a share that breaks on a rename is worse than a question |
| **A journal's encryption as a format MUST** | A plaintext journal is a legitimate choice (one meant to be read, or kept on a private host); the default carries the intent |
| **Rendering `.html` files** for a drive's static pages | Untrusted script; needs a sandboxed separate origin and its own review. Publishing a Doc as a page covers the need |
| **Vaults below the root for `ssg` only** | Two rules where one does, and the same need (content that already lives in a subfolder) exists for drives and journals |
| **Adopting drive and journal only**, sites later | Proposed, to keep the root-only rule. The owner chose all three now, which is what made vaults at depth necessary |
| **`--adopt` encrypting existing plaintext silently** | It would promise privacy that Git's history does not give |

## Security and privacy

- **Handles say nothing.** They are random, per connection, and never committed. A stale one never shows a different file.
- **An address no longer shows a file's name**, which removes a leak through screenshots, referrers and links. Folder names inside
  the repository are still visible to anyone who can read it (§11.2).
- **No more `id`s are added than are needed**, and every one is asked for.
- **A published page** is sanitised, sent with the strict Content-Security-Policy (DESIGN §15), and loads nothing third-party. A
  public page from an encrypted vault is a plaintext copy on the server, readable by anyone with the address; Fjord says so before
  publishing it, and the server still never holds a key.
- **`--encrypt-existing`** goes through a checkout, so invariant 1 holds: plaintext is in an encrypted vault only while a recorded
  checkout lasts, and nothing is committed until it ends. The warning about history is required, as §11.4's is for removing a key.
- **A site is public by intent**, as before; adopting one never offers encryption.

## Open questions

1. **Engines and `fjord.vault.json`.** Does Astro (content collections, legacy or the content layer) or Jekyll (`_posts`) complain
   about, or publish, a `fjord.vault.json` in its content folder? P16's spike checks both; if either does, the scaffold adds the
   engine's ignore rule (outside the vault, never in a file the person wrote).
2. **How long a handle lives** after its file is gone: forever (cheap, and "moved or gone" stays honest), or pruned after a while.
   Proposed: kept while the connection exists.
3. **Slugs** beside handles, for a readable public address. Later, if asked for.
4. **A journal's quiet period.** Whether a journal should version sooner than five minutes. Decided when 3f is built.

## Changelog

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-03 | Initial draft, from a design conversation with the owner. The spec text (§1.3, §2.3, §3, §3.1, §6.6, §8.4, §12) written with it, at the owner's request |
