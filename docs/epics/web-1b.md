# Fjord Web — 1b — Write and version

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1b.1 Editor package interface

**Status:** ✅ Done

**Design:** §10

Creates `packages/fjord-editor`, with its own CI and licence; `DocumentEditor`, `NoteEditor`, props, events; stories. **Licence decided (§19 #4): MPL-2.0, no dependency on `@sovereignfs/ui`**: its look comes from CSS custom properties the app maps its tokens onto, and the package has its own `LICENSE`.

**Accepts when:** The package builds and its tests run without `@sovereignfs/ui` installed; it exports one entry point and one stylesheet; an editor core is held to a contract that does not change when the core does. (That the app uses only the package's interface moves to 1b.2, where the app first renders it.)

- **Done as:** `packages/fjord-editor` (its own project, workflow, lockfile and `CLAUDE.md`); `DocumentEditor`, `NoteEditor`, `CommentsAdapter`, the text-quote `Anchor`; a plain text area behind both until 1b.2 and 1b.3; the contract, the package's self-checks and the stories (Ladle).

## 1b.2 Note editor

**Status:** ✅ Done

**Design:** §10

CodeMirror 6, byte-faithful.

**Accepts when:** Round-trip corpus: open, edit one word, save → the diff is that word. The app renders the editor through the package's interface only: the package is linked in, built before the app in CI and in the image, and the bundler's root settled.

- **Done as:** `NoteEditor` on CodeMirror 6 in the package, held to the contract and to a corpus of eleven real notes in eight variants (open: the same bytes; edit one word: the original with that word replaced); a note's file page opens it (editable since 1b.8; saving it as a version is 1b.9); the package is linked, built before the app in CI and in the image, and themed from the design system's tokens.

## 1b.3 Document editor

**Status:** ✅ Done

**Design:** §10

MDXEditor; Markdown-only toolbar; tables; images by URL; raw blocks preserved.

**Accepts when:** Every corpus file opens and saves; unknown syntax survives untouched.

- **Done as:** `DocumentEditor` on MDXEditor (pinned) with a Markdown-only toolbar, tables, task lists and code blocks, loaded when first needed, **for the documents it can hold without changing what they mean**; any other is shown as Markdown in the byte-faithful editor with a notice. The check is on opening: what the editor would write back must parse to the same tree, with each paragraph's text as written, and have no carriage returns. So raw HTML, footnotes, maths, reference links, loose lists and CRLF documents survive untouched (they never meet the visual editor) instead of as opaque raw blocks. A corpus of documents beside the notes', each with the editor it should open in; the contract for the visual editor and for the Markdown it falls back to; the web page opens a document like a note (the header is kept by the app and never given to the editor; an unreadable header shows the whole file as Markdown), with drafts, versions, upstream changes and delete as for notes. Styling scoped and dressed from the design system's tokens, and the notices of the 242 packages the editors are built on carried by the image.
- **Not here:** marks for comments (1d.1), the house style written down (1b.4), the properties panel (1b.5).

## 1b.4 House style

**Status:** 📋 Planned (§19 #7)

**Design:** §10

Documented, applied on save, first-save preview for documents written elsewhere.

**Accepts when:** The style is written down; the preview lists what changes.

## 1b.5 Frontmatter

**Status:** ✅ Done

**Design:** §9

Via `fjord-core`; Document properties panel; unknown keys shown and kept; promotion on first edit of a note.

**Accepts when:** A header with keys Fjord does not know round-trips byte for byte.

- **Done as:** the editors are given the body only for notes as well as documents, the header is kept in front of it and a body edit leaves it byte for byte (comments too); a **Document properties** panel shows `id`, `created`, every other key as written, and sets the `title` through the format module (`with_title`, new in `fjord-core`, via a header-only endpoint), which writes the header again, losing only comments; the first edit of a file with no header gives it one (`id`, `title`, `created`) and editing back to the original takes it off again; text with carriage returns or a byte order mark is not promoted; an unreadable header is shown whole. `implied_title` now strips `.fj.md`.
- **Not here:** `/note/<id>` and `/doc/<id>` (1b.6), renaming the file with the title (1b.11).

## 1b.6 Routes and the id index

**Status:** ✅ Done

**Design:** §9

`/doc/<id>`, `/note/<id>`, `/repo/<connection>/<path>`; index filled on read and by the worker; chooser for duplicates.

**Accepts when:** Each route opens the right file; a duplicate id shows the chooser.

- **Done as:** `/doc/<id>` and `/note/<id>` show the file in place (the same screen as the path route; the wrong one of the two is sent to the right one), 404 for an id that is malformed, absent or another account's, a chooser for several, and "still looking" or "some repositories could not be read" instead of a false 404. The `doc_index` table (both dialects, migration `0008`) is filled when a file is read and by a bounded search on a miss (300 files, repeatable); a row is believed only where its blob is still the repository's, so moves, edits and deletions made elsewhere are found; encrypted vaults are never read; disconnecting forgets it. A file's page says its address by id.
- **Not here:** the worker's background pass (1b.13), and the folder lists linking by id (a listing reads no file).

## 1b.7 Create

**Status:** ✅ Done

**Design:** §10

Documents and notes, in a chosen vault and folder.

**Accepts when:** Created files verify with the CLI.

- **Done as:** **New note** / **New document** on a plaintext vault's folder pages; `POST /api/connections/<id>/files` (§12's rules) makes one commit that adds one file, named by `fjord-core` (`quickNoteName`, `titleFromText`, `freeName`, new exports of the format module), with a document's header from `fjord-core`; the name is worked out at the head the commit goes on top of, so a name made meanwhile is not overwritten but the next free one taken. `src/files/cli.test.ts` runs the real `fjord verify --strict` over what was made (CI builds the CLI for the `file` leg).
- **Not here:** new folders, an encrypted vault, and opening a document (1b.3).

## 1b.8 Working copies

**Status:** ✅ Done

**Design:** §11

Debounced saves; base blob recorded.

**Accepts when:** Closing and reopening restores the draft; nothing is committed by typing.

- **Done as:** a `working_copy` table (both dialects, one draft per connection and path, base blob recorded); `PUT`/`DELETE /api/connections/<id>/working-copy` under §12's rules; a draft is started only for an editable note and a save for another base is refused; saves are compare-and-swap, so concurrent editors are all kept; a browser `DraftSaver` (debounced, one at a time, retried, flushed as the page goes); the note's page edits, restores and discards the draft and says when the note changed upstream; disconnecting deletes the drafts.

## 1b.9 Versions

**Status:** ✅ Done

**Design:** §11

Save version; author and `Co-authored-by`; default message. (Idle commits by the worker are 1b.13: there is no worker yet.)

**Accepts when:** Commits appear with the right author and trailers.

- **Done as:** `POST /api/connections/<id>/working-copy/version` (§12's rules) makes one commit through the owner's token, on top of the draft's base only, never forced; authored by the person who saved with the draft's other editors as `Co-authored-by:` trailers; the message is theirs or `Edit <name>`; a head that moved without touching the file is read again once; a changed or deleted file writes nothing and keeps the draft (1b.10 decides); the draft ends with the version, but not what was typed meanwhile. The note page has **Save version** with an optional message. Tested against the git-backed fake GitHub on all three databases (git itself says who the author and the trailers are) and in a browser. Also fixed: `NoteEditor` reverted the person's typing when switched between reading and editing.

## 1b.10 Upstream changes

**Status:** ✅ Done

**Design:** §11

Webhook flags; both versions shown; keep mine / take theirs / combine (`fjord_core::merge`, mobile MP1, which also settles two files added at one path).

**Accepts when:** A push during an edit never loses either side; tested with a real concurrent commit.

- **Done as:** a note whose draft is of an older blob than the branch's head shows both versions, read-only and side by side, with **Combine** (the server merges base, mine and theirs with `fjord-core`'s `merge3`, through the new `mergeTexts` of the format module, so it is the CLI's merge; overlapping edits are kept between markers, and a version with markers left asks first), **Keep mine** (the draft moves onto their version; the next version is a commit on top, theirs stays in history) and **Take theirs** (discard). A choice is made only about the version shown, and only if the draft was not typed into meanwhile; nothing is written to the repository by it. Saving a version of a changed note leads to the same page. A note deleted upstream keeps its draft visible, to copy and discard.
- **Not here:** the `push` webhook flag, which needs the GitHub App (1a.6): changes are found when the page is opened or a version is saved. Two files added at one path is for creating (1b.7).

## 1b.11 Rename and move

**Status:** ✅ Done

**Design:** §8

Files and folders within plaintext vaults; names checked by `fjord-core`; extension kept; pending working copy saved first; ids, shares, comments and the index follow; into an encrypted vault refused.

**Accepts when:** One commit per action; `/doc/<id>` and shares still work after a move; a case-only clash and an encrypted destination are refused; the CLI verifies the result.

- **Done as:** *Rename* and *Move* on a file's and a folder's page; one commit that puts the same blobs at the new paths (bytes, headers, ids and the executable bit untouched), named `Rename a to b` or `Move a to folder`; names checked by `fjord-core`; never over anything, a name alike by case refused (but a file's own case may change); a folder never onto one that is there or into itself; the extension kept; unsaved changes saved as a version first; the id index follows, so `/doc/<id>` works at once; into an encrypted vault refused. The CLI's `verify` accepts the result (a test).
- **Not here:** shares and comments (1c, 1d, which follow the `id` and need nothing of a move), converting a note to a document, undo.

## 1b.12 Delete and restore

**Status:** ✅ Done

**Design:** §8

Confirmation, one commit, the `deletion` record, Undo, Recently deleted, restore to the old or a chosen path.

**Accepts when:** A deleted document's links stop and its comments survive; restoring brings both back; restoring onto a taken path never overwrites.

- **Done as:** **Delete** on a note or document and on a folder (its confirmation names it, and for a folder how many files), `POST /api/connections/<id>/files/delete`: one commit that removes it, on the head read, never forced, only what was confirmed (the file's blob; the folder's file count); one `deletion` row per file (new table, both dialects, migration `0007`); **Undo** on the page after; **Recently deleted** (`/deleted/<id>`) within the restore window (`FJORD_RESTORE_WINDOW_DAYS`, default 30, §19 #11) where a file is put back where it was or at a chosen path and a folder's files all together, `POST …/files/restore`, never over anything (a taken path, or one in the way, is named and nothing is written). A file with unsaved changes has them saved as a version first; a folder with any is refused.
- **Not here:** links and comments stopping and returning, which need the id index (1b.6) and comments (1d); the record keeps the Doc's `id` for them.

## 1b.13 Idle versions

**Status:** 📋 Planned (§19 #5)

**Design:** §11, §19 #5

After a quiet period (default five minutes without edits, per instance) the worker makes the version, credited as a save is; a document is committed once. Needs the `worker` process (1a.12 names it; none runs yet) and the `event` table.

**Accepts when:** An idle draft is committed once, by the worker, with the right author and trailers; a draft being edited is not.
