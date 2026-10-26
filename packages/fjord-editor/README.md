# fjord-editor

The document and note editors for [Fjord](../../README.md) clients, behind one interface. Fjord Web uses them first;
the desktop app, the editor plugins and the mobile client's WebView are meant to follow, which is why this package is
[MPL-2.0](LICENSE) and depends on **no client's design system**: React is its only dependency, and a client sets its
look from outside.

**Status: the note editor is real; the document editor is a text area behind the same interface.** `NoteEditor` is
CodeMirror 6 with light Markdown styling, and byte-faithful (below). `DocumentEditor` implements the whole interface with
a plain text area standing in for MDXEditor (ROADMAP 1b.3). The contract tests are what a core must pass, so the swap
changes nothing for a client. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) §10 and §13.

## Using it

```tsx
import { DocumentEditor, NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";

<DocumentEditor
  value={body}                       // the Markdown body, frontmatter removed
  onChange={(body) => save(body)}    // the whole new body, after the person edited it
  role="edit"                        // "view" | "comment" | "edit"
  comments={adapter}                 // threads to mark, live changes, "the person asked to comment"
  onNeedName={askForDisplayName}     // () => Promise<boolean>, for a person with no account
/>

<NoteEditor value={text} onChange={setText} readOnly={false} />
```

### The note editor is byte-faithful

A note is often edited by hand or in Obsidian too, so opening one changes nothing and an edit changes only what the person
changed: line endings (CRLF where every break in the note is one; a note that mixes them keeps each carriage return, shown
as a control character), a byte order mark, trailing spaces, tabs and a missing final newline are all kept, and `onChange` is
given the whole text exactly. The editor holds the text while the person types; `value` is what it starts with and what it
is set to when it changes from outside, which is not reported as an edit.

- `onChange` is called with the whole new text, and **never** for a change the app made by setting `value`, nor
  when the text may only be read.
- `role` decides what the person may do: `view` reads, `comment` reads and starts comment threads, `edit` changes the
  text. Who gets which role is the app's.
- `onNeedName` is asked before an anonymous person's first edit or comment. Resolve `true` once a name is set; on
  `false` nothing happens, and it is asked again at the next attempt.
- `comments` is a small `CommentsAdapter`: the threads to mark (`threads()`), a way to hear of changes
  (`subscribe()`), and what the person asked for (`create(anchor)`, `open(threadId)`). The thread panel, replies,
  live updates and storage are the app's. An `Anchor` is a tagged text-quote selector, and `textQuoteAnchor(body,
  start, end)` makes one.
- A `ref` gives an `EditorHandle` (`focus()`).

Only `fjord-editor` and `fjord-editor/styles.css` can be imported; nothing deeper resolves.

## Theming

The stylesheet is made of custom properties, each with a default, and nothing else is a colour or a font:

`--fe-color-text`, `--fe-color-muted`, `--fe-color-surface`, `--fe-color-border`, `--fe-color-accent`,
`--fe-color-accent-text`, `--fe-color-focus`, `--fe-font-body`, `--fe-font-mono`, `--fe-radius`, `--fe-space`
(`themeTokens` lists them). A client sets them to its own palette; Fjord Web maps its design system's tokens onto them.
See the *Themed* story.

## Developing

Node 24 and pnpm 11 (the `packageManager` field names the version). The package is its own project, with its own
lockfile; it is not part of the Rust workspace or of Fjord Web's.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test             # the contract, the package's promises about itself, every story rendering
pnpm build            # tsc to dist/, with the stylesheet
pnpm check:build      # the built package, as a client takes it
pnpm stories          # the stories, in a browser (Ladle)
pnpm stories:build
```

CI runs those for a change to this directory, and nothing else runs for it (`.github/workflows/editor-ci.yml`).

## Not here yet

The document editor's real core (MDXEditor, 1b.3), the house style (1b.4), and the comment marks and anchors (1d).

## The corpus

`corpus/` is real Markdown, and `src/note-editor.test.tsx` opens every file in eight variants (as written, CRLF, mixed
endings, old-Mac CR, a byte order mark, no final newline, blank lines first and last, a NUL and line and paragraph
separators in it): the text must come out the same, and editing one word must change that word and nothing else. The
files carry `-text` in `corpus/.gitattributes` so that Git never normalises them.
