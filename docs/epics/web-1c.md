# Fjord Web — 1c — Share

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1c.1 Roles and access checks

**Status:** ✅ Done

**Design:** §12

View, comment, edit, enforced on every route and API.

**Accepts when:** A matrix test over roles × actions × share types.

- **Done as:** `src/access/policy.ts` (roles, actions, grants, `decide`: allow, forbidden = 403, hidden = 404) with a matrix test of roles × actions × ways in (owner, named user, link, expiring link) × targets (document, note, folder, encrypted), written from §12's table and not from the code; expired and revoked links allow nothing, several grants give the highest, and a share never makes a version, creates, renames, moves, deletes, restores, shares or moderates. `src/access/routes.ts` lists every page and API route with who may use it, and a test fails for any route without an entry (or an entry without a route, or with the wrong methods).
- **Not here:** finding the grants of a share (1c.2, 1c.3), and the document-keyed routes shares use (1c.6, 1d), which call `decide`; today's connection-keyed routes are the owner's by ownership, as before.

## 1c.2 Named-user shares

**Status:** ✅ Done

**Design:** §12

By exact email, existing accounts only, no account discovery.

**Accepts when:** Sharing with an unknown email reveals nothing.

- **Done as:** `POST /api/connections/<id>/shares` (+ `GET ?doc=` and `DELETE`), owner only, documents only; the answer is the same words, byte for byte, for an address with an account and one without (nothing is stored for the latter, nor for oneself), and the cap on shares is checked before the address is looked up; the address is matched whole, case aside. New `share_user` table (both dialects, migration `0009`), keyed by connection and Doc `id` so a share follows a rename or move. The account shared with opens `/doc/<id>` read-only (title and body; no header, path or repository), with the owner's token; unsharing ends it at once.
- **Not here:** link shares (1c.3), the management screen (1c.7), comments and editing for the roles that allow them (1d, 1c.6), a "shared with you" list, and a rate limit on trying addresses.

## 1c.3 Link shares

**Status:** ✅ Done

**Design:** §12

Public; several per document; role, optional expiry, revoke.

**Accepts when:** Revoking ends sessions using it; an expired link refuses.

- **Done as:** `POST/GET/DELETE /api/connections/<id>/links` (owner only, documents only; the token is in the answer to making a link and nowhere else, only its SHA-256 is stored; several per document, 50 at most; expiry optional, in the future); `/doc/<id>?token=` opens the document read-only for anyone, signed in or not, while the link is live and is of that document, and a token that opens nothing now is not told apart from none (the sign-in). Revoking, and an expiry (from its moment), end a link on the next request. New `share_link` table (both dialects, migration `0010`), keyed by connection and Doc `id`, so a link follows a rename or move.
- **Not here:** password links (1c.5), names and edit mode (1c.6), the management screen (1c.7). (The token's way out of the address bar and the logs is 1c.4.)

## 1c.4 Token handling

**Status:** ✅ Done

**Design:** §12

Swap for a scoped cookie, redirect to the clean URL, `Referrer-Policy: no-referrer`, log redaction.

**Accepts when:** The token is in no log line and not in the final URL.

- **Done as:** `proxy.ts` hands `/doc/<id>?token=` to `/api/links/enter` (the rewrite names no token, as Next sends it back in a header), which answers a **303 to the clean `/doc/<id>`** and a cookie `fjord_share` (that document's path, `HttpOnly`, `SameSite=Lax`, `Secure` on https, an hour at most and no longer than the link); the page checks the cookie against the store at every request, so revoking or expiry ends it at once; the answer is the same for a token that works and one that does not, and has `Referrer-Policy: no-referrer` and `no-store`; **every page sends `Referrer-Policy: no-referrer`**; the app logs no token or address, and a console redactor installed at start-up prints `token=…`, the cookie's value and a JSON `"token"` as `[redacted]`.
- **Not here:** sessions of a password link (1c.5), and the operator's own proxy logs.

## 1c.5 Password links

**Status:** ✅ Done

**Design:** §12

Argon2id, rate-limited at the swap.

**Accepts when:** Wrong passwords are slowed; the hash is all that is stored.

- **Done as:** `password` on `POST …/links` (8 to 200 characters), hashed with **Argon2id** by Node's own `crypto.argon2` (no new dependency; OWASP minimum parameters, a PHC string that carries them) and only that string stored (new `password_hash`, `failures` and `locked_until` columns on `share_link`, migration `0011`); the token alone does not open such a link (it waits ten minutes in a pending cookie and the page asks for the password, in a form that posts to a server action), and the right password gives `fjord_share=<token>.<proof>`, a keyed hash of the link and its password hash, so a hand-set cookie with the token opens nothing; tries are claimed one at a time in a single statement and each makes the next wait (a second, then five seconds doubling to a quarter of an hour after three wrong), a try that comes too soon is not checked, and a right password starts again.
- **Not here:** changing a password or expiry after the link is made (1c.7), and the management screen.

## 1c.6 Anonymous names and edit mode

**Status:** ✅ Done

**Design:** §12

Name before commenting or editing; edits go to the working copy.

**Accepts when:** A link editor's change appears in the next version, credited by name.

- **Done as:** a link with the `edit` role opens in the document editor after a **name** is given (1 to 40 characters, one line, kept in the browser; read-only until then); what is typed is kept as the document's **working copy** by `PUT /doc/<id>/draft` (under `/doc/<id>` so the link's cookie is sent; no session, the cookie is the credential and must be a live link of that document whose role may edit, with the password's proof if it has one; a bad cookie is a 404, a view or comment link a 403, writes from this site only); only the body is theirs, the header is put back as it is, and a document whose header cannot be read is not edited through a link; `editors` takes `{ type: "guest", link, name }` (50 at most), the owner's page names them, and **Save version** credits each by name as a `Co-authored-by:` with a `link-<n>-<hash>@users.noreply.fjord.invalid` address while the owner stays the author.
- **Not here:** a name before commenting (1d, same name), editing by a named account's edit share, live collaboration (phase 3).

## 1c.7 Share management UI

**Status:** ✅ Done

List, change role, revoke, copy link.

**Accepts when:** The owner sees and controls every share of a document.

- **Done as:** a **Sharing** panel on a document's page (notes and encrypted files have none): *People* (who it is shared with, a role to change, *Stop sharing*, *Share with* an address, answered the same whatever the address) and *Links* (each with role, active/expired/revoked, password, expiry; *Change*, *Revoke* with a confirmation; *Make a link* with a role, an optional expiry and an optional password, whose address is shown once with *Copy link*, since only a hash of the token is kept). New `PATCH …/links` changes a link's role, expiry (a later one revives an expired link) or password (a new one ends the cookies given for the old; `null` takes it away); a revoked link stays revoked.
- **Not here:** a "shared with you" list.
