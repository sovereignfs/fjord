# Changelog

`fjord-editor` is built into the clients that use it and is not released on its own, so there are no versions here;
what changes is recorded under Unreleased and in the clients' notes when they ship.

## [Unreleased]

### Fixed

- **A document typed in the visual editor is not told, when opened again, that it is not written the way Fjord writes.** Enter at the end of a block leaves an empty paragraph, which Markdown does not have: it was written as a run of blank lines that the next reading dropped, and that was offered as a reformat. What the editor writes has one blank line between blocks, except in a fenced code block (`withOneBlankLine`).

### Changed

- **`Comment on selection` works on any selection in the visual editor.** The anchor is taken from the rendered text (`anchorOfRange`), where a mark is found, and not looked for in the Markdown: a selection across bold, a link or several blocks is as good as one within a word. It is also a quiet button. The count of threads has the class `fe-thread-count`, so an app with its own panel can leave it to a screen reader.
- **A table in the visual editor lays its columns out equally between two narrow tool columns, left-aligned, and keeps each column's alignment** (`:---`, `:-:`, `---:`): the cells' own alignment was overridden, and the tool columns took as much width as a column of text, which made a table look centred.
- **A document that is only read, or only commented on, has no formatting toolbar** (`data-role` other than `edit`): there is nothing for it to change.
- **A choice about a document is remembered** (`DocumentEditor`'s `choiceKey`, `rich/choice.ts`). *Reformat and edit here* and *Edit as Markdown, unchanged* were kept in the page only, so the question came back whenever the document was opened again; with a key from the app they are kept in the browser, for that document, and the Markdown notice has *Use the visual editor* to take the choice back. Without a key (a document someone else shared) nothing is kept.
- **A numbered heading and a bracket as a character reference are no longer a reason to show Markdown.** `## 1\. Introduction` and `## 1. Introduction` are the same heading (a heading is never a list), and `&#91;x\]`, `\[x]` are the same literal text, so a document from a word processor's export that has them opens in the visual editor; `1\. x` in a paragraph, which the other way would be a list, and an escaped `[[wiki link]]`, still do not (`rich/meaning.ts`).
- **Tables in the visual editor are a document's tables**: cells close together with a hairline between them, the first row as the head in a quiet fill, the tools of the table narrow and faint until it is pointed at. New token `--fe-color-surface-muted`. *Check again* is a text button, as is the new *Use the visual editor*.
- **A document shown as Markdown says why** (the document editor's notice). When the visual editor cannot keep a text exactly as written, the notice lists each spot by line: what is written there and what the editor would write instead (for a text whose meaning would change), the raw HTML it does not hold, or that the line endings are carriage returns; and a *Check again* button tries the visual editor again once it is fixed. `rich/meaning.ts` gains `differences`, `htmlSpots` and `unreadable`, and `RichDocument`'s `onUnsafe` now says why. Nothing about which documents the visual editor holds has changed.

### Added

- **The house style, and a preview of what an edit would restyle** (ROADMAP 1b.4): the visual document editor writes `-` bullets, `*` emphasis and strong, `---` rules, `1.` on every numbered item,
  fences and compact tables with three-dash delimiter rows (`src/rich/style.ts`); a document already written so comes back byte for byte. For one written another way,
  `DocumentEditor` says which lines would change (`src/rich/restyle.ts`) and waits, read-only, until the person chooses to reformat or to edit it as Markdown. `RestylePreview` is exported.
  New theme tokens: `--fe-restyle-removed-bg` and `--fe-restyle-added-bg`.

### Fixed

- **The block type menu says which heading level each is.** MDXEditor gives its text with the blanks in it (`Heading {{level}}`) and leaves the filling to the page; the editor now fills them (`rich/translation.ts`). A document that begins with a heading no longer has the heading's margin above it, which made the editor's top a lot of space.

- **`NoteEditor` no longer reverts the person's typing when it is switched between reading and editing, or renamed**, if
  the app still gives it the text it started with. It took the unchanged `value` for a text the app had just set, and
  put it back. Only a different `value` is the app setting a text now.

### Fixed

- **The note editor works under a Content-Security-Policy that allows style elements only with the page's nonce** (ROADMAP 1d.5): CodeMirror's stylesheet is made at run
  time, and without the nonce it was blocked, leaving the editor unstyled (its lines no longer wrapped and its spaces were typed as non-breaking ones). The editor
  now takes the nonce from the page's own scripts (`src/csp.ts`); a page with no policy has none and gets none.

### Added

- **Finding a thread's text again after the document changed** (ROADMAP 1d.2): a thread is still on its quote if the quote is there word for
  word (`intact`, wherever the text around it went); else on the nearest place whose text is within 30% of the quote's characters different
  (`edited`: a quote of 12 characters or more is searched for like this, a large document near where the quote was); else it is `outdated`, and
  not marked. `CommentsAdapter.anchored` (optional) tells the app each thread's fate and, for an edited one, the anchor that is true now
  (`AnchorReport`). `src/reanchor.ts`.
- **Marks for comment threads** (ROADMAP 1d.1): `DocumentEditor` draws each thread of the app's `CommentsAdapter` over the text it is about, in a
  document that is only read as well as one that is edited, and tells the app which thread a click on a mark was on (`open`). The marks are
  drawn with the browser's CSS Custom Highlight API over ranges of the rendered text (`src/marks.ts`), so they are never part of what is
  edited, saved or compared with the Markdown, and are found again from each thread's text-quote anchor when the threads or the text change.
  Open threads, resolved threads and the one the app is showing (`CommentsAdapter.active`, optional) are coloured apart
  (`--fe-mark-bg`, `--fe-mark-resolved-bg`, `--fe-mark-active-bg`); a thread whose quote is not in the text is left unmarked, and the Markdown
  fallback is not marked. Where the browser has no such API nothing is drawn.
- **The document editor on MDXEditor** (ROADMAP 1b.3): `DocumentEditor` is MDXEditor with a Markdown-only toolbar (undo and
  redo, bold, italic, code, block type, lists, link, image by address, table, rule), tables, task lists and code blocks, loaded
  when a document first needs it. It opens a text visually **only if it can hold it without changing what it means**:
  what it would write back must parse to the same tree, with each paragraph's text as written, and have no carriage returns
  (`src/rich/meaning.ts`). Any other text (raw HTML, footnotes, maths, reference links, loose lists, CRLF documents) is shown
  as Markdown in the byte-faithful editor, with a notice. Opening tells the app nothing; an edit undone gives back the text the
  app gave byte for byte; a body's leading and trailing blank lines are kept; the header is never in the editor. A round-trip
  corpus of documents (`corpus/documents/`) and the notes' corpus, each with the editor it should open in, and the contract run
  for the visual editor and for the Markdown it falls back to. The text area that stood in is gone. MDXEditor's stylesheet is
  scoped to the editor at build time (it sets colour scales on `:root`), dressed from the `--fe-*` properties, and
  `dist/THIRD_PARTY_NOTICES.txt` carries the notices of the 242 packages the editors are built on. MDXEditor 4.3.3 is pinned.

- **The note editor on CodeMirror 6** (ROADMAP 1b.2): `NoteEditor` is CodeMirror with light Markdown styling and
  no toolbar, and it is byte-faithful: what goes in comes out unchanged but for what the person changed, whatever the
  note's line endings (CRLF is kept where every break is one; a note that mixes them keeps each carriage return, shown as a
  control character), a byte order mark, trailing spaces, tabs, or a missing final newline. A change the app makes to
  `value` is applied as the smallest change and is not reported as an edit. A round-trip corpus of eleven real notes
  tried in eight variants, a contract that runs against CodeMirror and the text area alike (`src/testing/surfaces.ts`),
  and dependencies that are CodeMirror's MIT packages, nothing else.
- **The package and its interface** (ROADMAP 1b.1): `DocumentEditor` and `NoteEditor` with their props (`value`,
  `onChange`, `role`, `comments`, `onNeedName`, `readOnly`), the `CommentsAdapter` and the tagged text-quote `Anchor`
  with `textQuoteAnchor`, the theme as `--fe-*` custom properties, and a plain text area behind both editors until
  the real cores arrive. MPL-2.0, with React as its only dependency and no client's design system. A contract that every
  core must pass, checks of the package's promises about itself, stories (Ladle), and a CI workflow of its own.
