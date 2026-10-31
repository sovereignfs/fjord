# Build brief: fjord-editor

Instructions for whoever builds `packages/fjord-editor`, human or model. The repository-wide rules in the root
[`CLAUDE.md`](../../CLAUDE.md) apply here too (one task, one branch, one draft PR; commits explain why; docs are part of
the change). The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) §10 and §13, the plan
[`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md) 1b.1 to 1b.3, and where this file and the design disagree the
design is right.

## Rules

- **MPL-2.0, and it depends on no client's design system.** React is a peer; the only dependencies are an editor core's
  own packages (CodeMirror's, MDXEditor's, and the Markdown parser the visual editor's safety check uses), which are MIT, and
  `src/package.test.ts` fails for any other, or for one whose licence is not MIT. The licences of the whole closure are
  checked when the package is built, and its notices are written into `dist/THIRD_PARTY_NOTICES.txt` (`scripts/notices.mjs`),
  which a client's image carries; a licence the build does not know to be permissive stops it. Never import `@sovereignfs/ui` or anything of Fjord Web's: the desktop app, the
  editor plugins and the MPL-2.0 mobile client must be able to embed this package.
- **The look comes from `--fe-*` custom properties**, each with a default (`src/theme.ts` lists them), and from nothing
  else. No colour or font is written outside a `var()` default; a client maps its own tokens onto these.
- **The visual document editor is never allowed to change what a document means, or its line endings.** MDXEditor
  re-writes a document in its own style and refuses or normalises what it does not model, so `DocumentEditor` opens a text in
  it only if what it would write back **parses to the same tree, with the text of each paragraph as it was written**
  (`src/rich/meaning.ts`), and has no carriage return in it; any other text is shown in the byte-faithful Markdown editor, with
  a notice. Restyling (`-` for `*`, blank lines) is not a loss; escapes before characters only an extension knows (`[[x]]`, `[^1]`,
  `==x==`, `#tag`) are, because a renderer that knows the extension reads them differently. Opening tells the app nothing
  (the check is made on the editor's own first report, `onChange` with `initialMarkdownNormalize`: asking it for its text at
  the moment it is made returns the text it was made with), an edit undone gives back the text the app gave byte for byte,
  and the blank lines a body begins and ends with are kept. `src/document-corpus.test.tsx` says which editor each corpus file
  opens in (`corpus/` and `corpus/documents/`), so that a change in MDXEditor, which is pinned to an exact version and
  upgraded on purpose, is seen.
- **The header is not the editor's.** The editor is given the body; the app keeps the header (`clients/web/DESIGN.md` §9).
- **MDXEditor's stylesheet is taken in at build time and scoped** (`scripts/copy-styles.mjs`): it sets its colour scales on
  `:root`, for the whole page, and the build makes them local to the editor and fails if a rule for the page is left. Its
  theme variables are set from the `--fe-*` custom properties in `src/styles.css`; its classes are hashed, so nothing here
  styles one.
- **One entry point.** A client can import `fjord-editor` and `fjord-editor/styles.css` and nothing deeper (`exports`).
  What a client needs is exported from `src/index.ts`; what is not exported is not the interface.
- **The interface is the contract, not the core.** `src/contract.test.tsx` says what an editor does whatever is behind
  it (through a `Surface`, `src/testing/surfaces.ts`: a new core is a new surface), and CodeMirror (1b.2, done) and
  MDXEditor (1b.3, done) pass it unchanged; the document editor is run as the visual editor and as the Markdown it falls back to. Change a core and these tests stay the same;
  change the interface and every client changes with it, so that is a design change (`clients/web/DESIGN.md` §10).
- **`onChange` is for the person's edits only.** Never for a change the app made by setting `value`, and never when the
  text may only be read. The whole new text, not a delta.
- **Comment marks are highlights, not nodes.** `src/marks.ts` draws each thread of the app's `CommentsAdapter` over the rendered text with the CSS
  Custom Highlight API and finds it again from its text-quote anchor whenever the threads or the text change, so a mark is never part of what is
  edited, saved or compared with the Markdown, and a document that is only read is marked as well as one that is edited. The Markdown fallback is
  not marked. Colours come from `--fe-mark-*` custom properties (`src/theme.ts`). Finding a thread's text again after the document changed is
  `src/reanchor.ts` (word for word, else within 30% of the quote different, else outdated: ROADMAP 1d.2); it is pure, given a text and an anchor, and
  the app is told what it found through `CommentsAdapter.anchored`.
- **Frontmatter is not the editor's.** It is given the body and gives the body back; the app keeps the header
  (`DESIGN.md` §9).
- **A note's editor is byte-faithful**: an edit changes only what the person changed, and a note the editor did not touch comes
  out as it went in. Keep it that way: read the text with `state.sliceDoc()` (never `doc.toString()`), tell CodeMirror the
  note's line separator, and add a note to `corpus/` for anything new it must not rewrite. The visual document editor is not
  byte-faithful and is not to be mistaken for it: that is why a document it could change goes to this editor instead.
- **TypeScript is strict**, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; relative imports carry a
  `.js` extension so the build is valid Node ESM. No `any` without a comment saying why it cannot be avoided.
- **Dependencies are chosen, not accumulated**, and the lockfile is committed with any change to one. Every file
  carries the MPL header.
- **A change to behaviour adds a line under `## [Unreleased]`** in `CHANGELOG.md`.

## Commands

```bash
pnpm install --frozen-lockfile   # never `pnpm install` in CI or a PR check
pnpm typecheck
pnpm test
pnpm build && pnpm check:build
pnpm stories                     # Ladle
```
