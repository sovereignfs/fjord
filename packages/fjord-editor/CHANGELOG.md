# Changelog

`fjord-editor` is built into the clients that use it and is not released on its own, so there are no versions here;
what changes is recorded under Unreleased and in the clients' notes when they ship.

## [Unreleased]

### Added

- **The package and its interface** (ROADMAP 1b.1): `DocumentEditor` and `NoteEditor` with their props (`value`,
  `onChange`, `role`, `comments`, `onNeedName`, `readOnly`), the `CommentsAdapter` and the tagged text-quote `Anchor`
  with `textQuoteAnchor`, the theme as `--fe-*` custom properties, and a plain text area behind both editors until
  the real cores arrive. MPL-2.0, with React as its only dependency and no client's design system. A contract that every
  core must pass, checks of the package's promises about itself, stories (Ladle), and a CI workflow of its own.
