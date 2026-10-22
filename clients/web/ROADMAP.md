# Fjord Web — roadmap

**Status:** planning. Nothing is implemented yet. The design is
[`DESIGN.md`](DESIGN.md); this file is the order of work and how each piece is
known to be done. Section numbers (§) refer to `DESIGN.md` unless they say "spec".

| | |
| --- | --- |
| `done` | Implemented, tested, released. |
| `next` | Ready to start: its prerequisites are done. |
| `todo` | Not started. |
| `open` | Waits on a decision in `DESIGN.md` §19. |

Every task is one branch and one draft PR (root `CLAUDE.md`, Working conventions).
"Accepts when" is what review checks.

---

## Prerequisites in fjord

These change the format and the CLI, so they land in `fjord` itself, and come
before the web slices that need them.

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| P1 | **Spec: `*.fj.md` names a document.** One-sentence amendment to spec §8 (and §1.3): a Doc whose name ends in `.fj.md` is a *document*, any other a *note*; both remain Fjord Docs. A fixture for each. | `spec/SPEC.md` says it; `fjord verify` treats both as Docs; fixtures pass. | `todo` |
| P2 | **CLI: create and list documents.** `fjord new --document` writes `name.fj.md`; `ls` shows which is which. | Created file verifies; `ls --json` reports `kind`. | `todo` |
| P3 | **`fjord-core`: vault discovery from a listing.** A pure function from a list of paths (and the manifests' bytes) to vaults and classified files, so a client with no filesystem can use it. The CLI's walk calls the same function. | Same results as the filesystem walk over every fixture. | `todo` |
| P4 | **`fjord-core` to WebAssembly, pure subset.** A `fjord-wasm` crate (`wasm-bindgen`) exposing manifests, vault discovery (P3), path rules, frontmatter parse/preserve/promote and new-document headers. Time and randomness injected (the system clock panics on `wasm32-unknown-unknown`); the filesystem walker and `tempfile` excluded from the build. Runs in Node and the browser. | A JS test suite runs the conformance fixtures through the WASM build and gets the CLI's answers; bundle size recorded. | `todo` |
| P5 | **Component scaffolding.** `clients/web`, a placeholder Next.js app with its own lockfile, `README.md`, `CHANGELOG.md`, `LICENSE` (AGPL-3.0-or-later) and `CLAUDE.md`; `web-ci.yml` (a `changes` job like `ci.yml`'s; type-check and build; the tests on three legs, an sqld container, a `file:` database and PostgreSQL, ready for 1a.0); `scripts/release/web.sh` and `web-release.yml`; root layout tables updated. `packages/fjord-editor` is **not** created here: it starts with 1b.1, when its licence is decided (§19 #4). | CI runs only for web changes; a placeholder build passes; the release component dry-runs. | `done` |

P4 is the longest pole; 1a needs P3–P5, 1b needs P1, P2 and P4.

## Phase 1 — plaintext documents and notes, sharing, comments

### 1a — Sign in, connect, browse

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1a.0 | **Database layer, both dialects** (§14): `DB_DIALECT` (default `sqlite`); the libSQL client for sqld and `file:`; the PostgreSQL client; paired Drizzle schemas and migrations; the portability helper; the `event` table; the dev sqld script; CI legs for sqld, `file:` and PostgreSQL. | A fresh instance boots on each of the three from the documented variables; migrations apply cleanly from empty on each; the data-layer suite passes on all three in CI; the schema parity test is seen to fail when a column is added to one dialect only. | `done` |
| 1a.1 | **Landing page** (§3): what Fjord is, why, features; sign-in and sign-up. | Renders for visitors, as static HTML, in light and dark, on a phone; links to `/sign-in` and `/sign-up`. A signed-in user seeing the repository view at `/` needs a session, so it is 1a.9 (after 1a.2). | `done` |
| 1a.2 | **Local auth** (§6): email and password, passkeys, TOTP with backup codes; screens built from the design system and shaped by Sovereign's forms (leaving out its invites, terms and timezone). `FJORD_AUTH_LOCAL`. | Sign up, sign in, enrol and use a passkey and TOTP, recover with a backup code; off when the variable is unset. Done in a real browser (Playwright, with a virtual authenticator), and on all three databases. | `done` |
| 1a.3 | **Sovereign OIDC** (§6): authorization code flow against a Sovereign instance; `FJORD_AUTH_SOVEREIGN_*`. | Sign in through a real Sovereign instance; `sub`, `email`, `name` used; off when unset. | `todo` |
| 1a.4 | **Account linking when both are on** (§6). | Behaviour matches the decision. | `open` (§19 #2) |
| 1a.5 | **Provider interface + GitHub** (§7): list repos, head, tree, blob, multi-file commit, webhooks. | Contract tests run against a recorded GitHub API; a second fake provider passes the same tests. Done as: one contract, run against GitHub over a git-backed fake and against an in-memory provider; and GitHub's real answers replayed. | `done` |
| 1a.6 | **GitHub App connection** (§7): install, pick repositories, minimal permissions, short-lived tokens, `push` webhooks. | Install, pick two repos, see them; a push invalidates the cached tree. | `todo` |
| 1a.7 | **PAT connection** (§7): URL + fine-grained token; permissions checked on add. | A read-only token is refused with a clear message; a correct one works. | `todo` |
| 1a.8 | **Credentials at rest** (§7, §15): envelope encryption, key rotation. | No plaintext credential in the database; rotation re-wraps all. | `todo` |
| 1a.9 | **First run and defaults** (§3, §7): prompt to add a repository; default repo (first); default vault per repo; switcher. | New account is prompted; second visit lands on the default repo and vault. | `todo` |
| 1a.10 | **Not a Fjord repository** (§7). | Behaviour matches the decision. | `open` (§19 #3) |
| 1a.11 | **File browser** (§8): vaults from the listing (P3), documents and notes openable, others greyed, encrypted vaults locked; lazy metadata; tree cache by commit. | Matches `fjord ls` on the fixtures; a large repo falls back to per-directory listing; nothing downloaded to draw it. | `todo` |
| 1a.12 | **Deployment** (§17): image, `web` and `worker`, carrying the third-party notices (`@sovereignfs/ui`'s `NOTICE`: Lucide's ISC licence, which asks that its notice travel with copies); compose with the sqld service, a single-container `file:` example and a PostgreSQL overlay; backups for each; configuration; a staging instance. | A fresh instance comes up from the documented variables in each of the three database setups. | `todo` |

### 1b — Write and version

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1b.1 | **Editor package interface** (§10): creates `packages/fjord-editor`, with its own CI and licence; `DocumentEditor`, `NoteEditor`, props, events; stories. | The app uses only the package's interface. | `open` (§19 #4) |
| 1b.2 | **Note editor** (§10): CodeMirror 6, byte-faithful. | Round-trip corpus: open, edit one word, save → the diff is that word. | `todo` |
| 1b.3 | **Document editor** (§10): MDXEditor; Markdown-only toolbar; tables; images by URL; raw blocks preserved. | Every corpus file opens and saves; unknown syntax survives untouched. | `todo` |
| 1b.4 | **House style** (§10): documented, applied on save, first-save preview for documents written elsewhere. | The style is written down; the preview lists what changes. | `todo` (§19 #7) |
| 1b.5 | **Frontmatter** (§9): via `fjord-core`; Document properties panel; unknown keys shown and kept; promotion on first edit of a note. | A header with keys Fjord does not know round-trips byte for byte. | `todo` |
| 1b.6 | **Routes and the id index** (§9): `/d/<id>`, `/n/<id>`, `/p/<connection>/<path>`; index filled on read and by the worker; chooser for duplicates. | Each route opens the right file; a duplicate id shows the chooser. | `todo` |
| 1b.7 | **Create** (§10): documents and notes, in a chosen vault and folder. | Created files verify with the CLI. | `todo` |
| 1b.8 | **Working copies** (§11): debounced saves; base blob recorded. | Closing and reopening restores the draft; nothing is committed by typing. | `todo` |
| 1b.9 | **Versions** (§11): Save version; idle commits by the worker; author and `Co-authored-by`; default message. | Commits appear with the right author and trailers; an idle document is committed once. | `todo` (§19 #5) |
| 1b.10 | **Upstream changes** (§11): webhook flags; both versions shown; keep mine / take theirs / combine. | A push during an edit never loses either side; tested with a real concurrent commit. | `todo` |
| 1b.11 | **Rename and move** (§8): files and folders within plaintext vaults; names checked by `fjord-core`; extension kept; pending working copy saved first; ids, shares, comments and the index follow; into an encrypted vault refused. | One commit per action; `/d/<id>` and shares still work after a move; a case-only clash and an encrypted destination are refused; the CLI verifies the result. | `todo` |
| 1b.12 | **Delete and restore** (§8): confirmation, one commit, the `deletion` record, Undo, Recently deleted, restore to the old or a chosen path. | A deleted document's links stop and its comments survive; restoring brings both back; restoring onto a taken path never overwrites. | `todo` (§19 #11) |

### 1c — Share

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1c.1 | **Roles and access checks** (§12): view, comment, edit, enforced on every route and API. | A matrix test over roles × actions × share types. | `todo` |
| 1c.2 | **Named-user shares** (§12): by exact email, existing accounts only, no account discovery. | Sharing with an unknown email reveals nothing. | `todo` |
| 1c.3 | **Link shares** (§12): public; several per document; role, optional expiry, revoke. | Revoking ends sessions using it; an expired link refuses. | `todo` |
| 1c.4 | **Token handling** (§12): swap for a scoped cookie, redirect to the clean URL, `Referrer-Policy: no-referrer`, log redaction. | The token is in no log line and not in the final URL. | `todo` |
| 1c.5 | **Password links** (§12): Argon2id, rate-limited at the swap. | Wrong passwords are slowed; the hash is all that is stored. | `todo` |
| 1c.6 | **Anonymous names and edit mode** (§12): name before commenting or editing; edits go to the working copy. | A link editor's change appears in the next version, credited by name. | `todo` |
| 1c.7 | **Share management UI**: list, change role, revoke, copy link. | The owner sees and controls every share of a document. | `todo` |

### 1d — Comment

| # | Task | Accepts when | Status |
| --- | --- | --- | --- |
| 1d.1 | **Comment plugin** (§13): Lexical marks; threads, replies, resolve, edit and delete own; owner moderation. | All of it, by role, in the editor and in view mode. | `todo` |
| 1d.2 | **Anchors** (§13): text-quote selector beside each mark; re-anchoring after outside changes; outdated threads kept. | A test edits around, inside and over anchored text and checks each thread's fate. | `todo` |
| 1d.3 | **Live updates** (§13): server-sent events. | Two browsers see each other's comments without reloading. | `todo` |
| 1d.4 | **Limits and abuse** (§13, §15). | Limits enforced and tested. | `todo` |
| 1d.5 | **Security review of phase 1** (§15): CSP, sanitisation, auth, credentials, access matrix. | Findings fixed or recorded before phase 1 is called done. | `todo` |

## Phase 2 — encrypted files

In outline; tasks are written when phase 1 is done.

- `fjord-core` to WASM, the rest: age encryption and the tar container in the
  browser, identities that never leave it (passphrase-protected, unlocked per
  session).
- Browse encrypted vaults (names in `plain` naming; ids in `id` naming), open,
  edit, and commit ciphertext only. Drafts of encrypted files kept encrypted.
- Rename, move and delete in encrypted vaults, and moving files in and out of
  them (encrypting or decrypting on the way); in `id` naming a rename rewrites the
  name inside the container (spec §6.4, §7.2).
- Sealed shares of encrypted documents: copy and comments encrypted with a link key
  in the `#fragment`, or a key derived from a password.

## Phase 3 — collaborative editing

In outline.

- A shared Yjs document per open file, on the working copy (§11).
- `@lexical/yjs` in the document editor, or a replacement core behind the editor
  package's interface (§10).
- Comment anchors as Yjs relative positions beside the text-quote selectors.

## Later

GitLab, Forgejo/Gitea and other git servers (a provider each); search;
notifications; Sheets; the desktop client and the VS Code and Obsidian plugins
reusing `packages/fjord-editor`. The mobile client has its own plan:
[`../mobile/ROADMAP.md`](../mobile/ROADMAP.md).
