# Fjord Mobile — 1c — Quick capture

The detail of the tasks in this part of [`clients/mobile/ROADMAP.md`](../../clients/mobile/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mobile/DESIGN.md`](../../clients/mobile/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1c.1 Capture screen

**Status:** 📋 Planned

**Design:** §9

From the main screen, keyboard up, saved as typed, empty capture leaves nothing.

**Accepts when:** From a cold start to typing is measured and recorded; a killed app keeps what was typed.

## 1c.2 App-icon quick action

**Status:** 📋 Planned

**Design:** §9

**New note**, on both platforms.

**Accepts when:** Long-press, New note, typing.

## 1c.3 Inbox and naming

**Status:** 📋 Planned

**Design:** §9, MP2

`Inbox/` created when missing; name fixed when queued; header written.

**Accepts when:** Notes captured offline sync with the expected names; a name clash in `Inbox/` gets a suffix; every quick note verifies with the CLI.
