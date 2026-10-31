# Fjord Web — 1d — Comment

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1d.1 Comment plugin

**Status:** ✅ Done

**Design:** §13

Lexical marks; threads, replies, resolve, edit and delete own; owner moderation.

**Accepts when:** All of it, by role, in the editor and in view mode.

- **Done as:** threads on a selection, replies, resolve and reopen (anyone who may comment), edit and delete one's own, and the owner's deleting of anyone's and closing of a document's comments, in a panel beside the document for its owner, for a signed-in account it is shared with, and for anyone with a link (view reads, comment and edit also write); `/doc/<id>/comments` (cookie-scoped like the guest draft route; a session works too); tables `comment_thread`, `comment_reply`, `comment_activity`, `comment_closed` (migration `0012`); a guest is a name and a browser id, an account is itself; 1 to 4000 characters, 500 threads, 200 replies; and in `fjord-editor` **marks** over the text (`marks.ts`), drawn with the CSS Custom Highlight API rather than Lexical nodes (so a mark is never part of what is edited or saved, and works in view mode), with a click on a mark opening its thread.
- **Not here:** re-anchoring after outside changes and "outdated" (1d.2), live updates (1d.3), per-user and per-link limits (1d.4).

## 1d.2 Anchors

**Status:** ✅ Done

**Design:** §13

Text-quote selector beside each mark; re-anchoring after outside changes; outdated threads kept.

**Accepts when:** A test edits around, inside and over anchored text and checks each thread's fate.

- **Done as:** `fjord-editor`'s `reanchor.ts` finds a thread's quote in the text as it is now: word for word if it is there (`intact`, whatever was added around it), else the nearest place within 30% of the quote's characters different (`edited`; only for a quote of 12 characters or more; in a very large document only near where it was), else `outdated`: unmarked, but kept in the panel with an **Outdated** mark and found again if the words come back. The editor tells the app each thread's fate (`CommentsAdapter.anchored`); for an edited one the app, after a moment, asks `PATCH /doc/<id>/comments` `{ op: "reanchor", thread, from, to }` to keep the new words, so the next change is compared with them. The server moves a thread only from the anchor it was found with (a page that missed a move changes nothing) and only onto words like the old ones; it needs the right to comment but no name, works while comments are closed, and is in the log as the page's doing.
- **Tests:** `reanchor.test.ts` (around, inside and over the quote, the next edit, short and very large texts), the editor contract, `service.test.ts` on three databases, `access.test.ts`, `http.test.ts`, and an e2e that changes a document elsewhere.
- **Not here:** a viewer's page does not keep a move (only those who may comment do, so a thread seen only by readers is re-found by each page); Yjs positions (phase 3).

## 1d.3 Live updates

**Status:** ✅ Done

**Design:** §13

Server-sent events.

**Accepts when:** Two browsers see each other's comments without reloading.

- **Done as:** `GET /doc/<id>/comments/events` (`src/comments/events.ts`), a stream that says *that* a document's comments changed (`version`, `changed`, `gone`) and never what they are; the page reads them again through the ordinary route when the version is not the one it holds. The version is the last entry of the document's `comment_activity` log (which now also records the page moving a thread onto edited words), read first by every listing. Told at once in this process (`bus.ts`) and from the database every 4 seconds for another replica's changes (no `LISTEN`/`NOTIFY`); who may watch is who may read, checked on opening and every 15 seconds (revoked links and ended shares are told `gone`); five minutes at most per stream; 300 per process, then `503`.
- **Tests:** `events.test.ts` (opening, what it says, when it ends, the cap), `bus.test.ts`, the version in `service.test.ts` on three databases, `commentsWatch` in `access.test.ts`, and an e2e with two browsers that never reload.
- **Not here:** limits per user and per link (1d.4); a count of who is watching.

## 1d.4 Limits and abuse

**Status:** ✅ Done

**Design:** §13, §15

.

**Accepts when:** Limits enforced and tested.

- **Done as:** a general rate limiter counted in the database (`src/limits/rate.ts`, table `rate_bucket`, migration `0013`; one statement per count, exact under concurrent use) and, with it, comments written at most 30 a minute and 600 an hour by an account, 20 and 200 by a guest's browser, and 60 and 600 by a link's guests together (a new name or browser id is no way round the link's), refused with `429` and `Retry-After`; one author's share of a document (100 threads, 50 replies in a thread) and a link's guests' (200 threads) so that no one fills the document's 500; edits through a link at 240 a minute and 3000 an hour for the link; live streams 20 per account, 100 per link.
- **Tests:** `rate.test.ts` on three databases (windows, refusal that still counts, exactness under 25 at once, sweeping), `rates.test.ts` (the numbers, from the design), `access.test.ts` (what is counted and what is not, before the request is looked at), `service.test.ts` (shares), `guest.test.ts`, `events.test.ts`, and an e2e through a real link; each rule was seen to fail with it switched off.
- **Not here:** limits by network address (need a trusted proxy header); the numbers as settings (§17).

## 1d.5 Security review of phase 1

**Status:** ✅ Done

**Design:** §15

CSP (which has to allow the visual document editor's `style` attributes), sanitisation, auth, credentials, access matrix.

**Accepts when:** Findings fixed or recorded before phase 1 is called done.

- **Done as:** a nonce-based Content-Security-Policy and the other security headers on every response (`src/security/csp.ts`, `proxy.ts`), run under by the browser tests, which found and fixed the note editor's blocked stylesheet and allow two library styles by hash; a registry-driven test that every route refuses another site's request and callers with no business there, and changes nothing by trying; tests that the git host's token and the instance's secrets reach no browser, that hostile content in a document, comment or name is only text, that a password change ends other sessions, and that auth endpoints refuse a redirect to another site; the proxy's own tests put back into the run (they were not in it); the health check logs a name and not an error. Nine findings, five fixed and four turned into tests that hold; twelve things recorded and left ([`docs/security-review-phase-1.md`](../security-review-phase-1.md)). **Phase 1 is done.**
