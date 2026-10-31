# Fjord Mobile — 1d — Organise

The detail of the tasks in this part of [`clients/mobile/ROADMAP.md`](../../clients/mobile/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mobile/DESIGN.md`](../../clients/mobile/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1d.1 Rename and move

**Status:** 📋 Planned

**Design:** §10

Files and folders in plaintext vaults; names by `fjord-core`; extension kept; into an encrypted vault refused; offline as drafts.

**Accepts when:** One commit per action, or one line in a batched sync; a case-only clash and an encrypted destination are refused; the CLI verifies the result.

## 1d.2 Delete, Undo, Recently deleted

**Status:** 📋 Planned (§18 #11)

**Design:** §10

Confirmation; Undo before push; the local deletion record; restore to the old or a chosen path.

**Accepts when:** Restoring onto a taken path never overwrites; the record survives a restart; an entry past the window is gone.

## 1d.3 Organising against upstream changes

**Status:** 📋 Planned

**Design:** §12

The rename, move and delete rows of the merge table.

**Accepts when:** A test per row; no upstream edit is lost to a local delete or move.

## 1d.4 Security review of phase 1

**Status:** 📋 Planned

**Design:** §13

Tokens, storage protection, rendering, app lock, logs.

**Accepts when:** Findings fixed or recorded before the first store release.

## 1d.5 First store release

**Status:** 📋 Planned (§18 #7)

**Design:** §16

Listings, privacy declarations ("collects nothing"), `mobile-v1.0.0` (or a 0.x first) through the release flow.

**Accepts when:** Live on the App Store and Google Play; the tag is not *Latest*.
