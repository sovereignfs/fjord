# Fjord Mobile — 1b — Read, write, sync

The detail of the tasks in this part of [`clients/mobile/ROADMAP.md`](../../clients/mobile/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mobile/DESIGN.md`](../../clients/mobile/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1b.1 Viewer

**Status:** 📋 Planned

**Design:** §8

Rendered Markdown, sanitised, raw HTML as text, remote images on tap, task boxes toggle one character.

**Accepts when:** Every file in a rendering corpus displays; a toggled box changes one byte in the saved file.

## 1b.2 Basic editor

**Status:** 📋 Planned

**Design:** §8

Source text input, keyboard row, continuous drafts.

**Accepts when:** Round-trip corpus: open, edit one word, save, the diff is that word; opening and leaving makes no draft.

## 1b.3 Frontmatter and Info

**Status:** 🚧 Open (§18 #2)

**Design:** §8

Header through `fjord-core`; Info sheet; a note without a header left without one.

**Accepts when:** A header with keys Fjord does not know round-trips byte for byte; a header-less note gets none.

## 1b.4 Create

**Status:** 📋 Planned

**Design:** §8

Documents and notes, vault and folder chosen.

**Accepts when:** Created files verify with the CLI.

## 1b.5 Sync queue and push

**Status:** 📋 Planned

**Design:** §12

When it runs, one commit per sync, messages, author, retry on a moved head, background tasks.

**Accepts when:** Five offline edits become one commit with the right author and message; a concurrent push in between is retried, never forced.

## 1b.6 Pull and merge

**Status:** 📋 Planned

**Design:** §12

Every row of the table in §12; conflict copies (MP1).

**Accepts when:** A test per row, against a real repository with fabricated upstream commits; an unmergeable edit leaves both versions in the pushed commit and a badge.

## 1b.7 Sync status

**Status:** 📋 Planned

**Design:** §12

Drafts waiting, last sync, rate-limit pause.

**Accepts when:** Shown on both platforms; a rate limit reached loses nothing and resumes.

## 1b.8 Drafts are durable

**Status:** 📋 Planned

**Design:** §11

.

**Accepts when:** Killing the app mid-edit, rebooting, and revoking the token each keep every draft; a draft goes only when its commit is pushed.
