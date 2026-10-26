# Changelog

`fjord-editor` is built into the clients that use it and is not released on its own, so there are no versions here;
what changes is recorded under Unreleased and in the clients' notes when they ship.

## [Unreleased]

### Fixed

- **`NoteEditor` no longer reverts the person's typing when it is switched between reading and editing, or renamed**, if
  the app still gives it the text it started with. It took the unchanged `value` for a text the app had just set, and
  put it back. Only a different `value` is the app setting a text now.

### Added

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
