# Fjord Mobile — 1a — Connect and browse

The detail of the tasks in this part of [`clients/mobile/ROADMAP.md`](../../clients/mobile/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/mobile/DESIGN.md`](../../clients/mobile/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1a.1 GitHub provider in the engine

**Status:** 📋 Planned

**Design:** §6

Repositories, head, tree, blob, multi-file commit without force, conditional head checks.

**Accepts when:** Contract tests pass against recorded GitHub responses and the fake provider; a moved head refuses the branch update.

## 1a.2 The Fjord GitHub App and device flow

**Status:** 📋 Planned

**Design:** §6

App registered by the owner; sign-in by code; installation page in the system browser; token expiry and refresh settled.

**Accepts when:** Sign in on both platforms, choose two repositories, see them; how an expired token is handled is written into §6 and tested.

## 1a.3 PAT connection

**Status:** 📋 Planned

**Design:** §6

URL and fine-grained token; permissions checked on add.

**Accepts when:** A read-only token is refused with a clear message; a correct one works.

## 1a.4 Tokens in the keystore

**Status:** 📋 Planned

**Design:** §13

.

**Accepts when:** Tokens survive a restart, are gone on removing the connection, and are not in the app's files or logs.

## 1a.5 First run and defaults

**Status:** 📋 Planned

**Design:** §3, §6

Prompt to add a repository; default repository; default vault per repository; switcher.

**Accepts when:** A fresh install is prompted; the next launch opens the default repository and vault.

## 1a.6 Not a Fjord repository

**Status:** 📋 Planned

**Design:** §6

Shown as such, read-only, capture unavailable.

**Accepts when:** A repository without `fjord.json` is shown as such, read-only, with capture unavailable; no offer to set it up in phase 1 (the web offers it, web §19 #3).

## 1a.7 Local store and tree cache

**Status:** 📋 Planned

**Design:** §7, §11

Listings by commit, blob cache, head checks on foreground, refresh and every minute.

**Accepts when:** Browsing a cached repository in airplane mode works; an unchanged head costs no rate limit (conditional request seen).

## 1a.8 File browser

**Status:** 📋 Planned

**Design:** §7

Vaults from the listing (P3), documents and notes openable, others greyed, encrypted vaults locked, cached files marked, large repositories listed per directory.

**Accepts when:** Matches `fjord ls` on the fixtures; nothing downloaded to draw it.

## 1a.9 App lock

**Status:** 📋 Planned

**Design:** §13

, optional.

**Accepts when:** With it on, nothing is shown before Face ID, Touch ID or the device credential; the app switcher shows a blank.
