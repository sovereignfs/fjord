# Changelog

All notable changes to `fjord-web` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release's section is also its GitHub release notes: the release workflow
reads this file when a release is cut. Write the notes under `## [Unreleased]`
as you go; `scripts/release.sh web prepare` turns them into the version's
section.

## [Unreleased]

### Added

- **Documents open in an editor** (ROADMAP 1b.3): a document (`*.fj.md`) opens like a note, in a **visual editor** with a toolbar of
  what Markdown can say (bold, italic, code, headings, lists, links, images by address, tables, rules), tables, task lists and
  code blocks. It has the same drafts as you type, Save version, upstream-change choices and delete. The header (`id`, `title`,
  `created` and any key Fjord does not know) is never in the editor: it is put back in front of the body byte for byte, so a
  saved edit leaves it as it was. **The visual editor is used only for a document it can hold without changing what it means.**
  Anything else (raw HTML, footnotes, maths, `[[wiki links]]`, reference-style links, loose lists, hard breaks written with
  spaces, or CRLF line endings) opens as Markdown instead, with a notice, and is edited byte for byte. Typing and deleting again
  starts no draft; the blank line between a header and its body, and a document's final line break, are kept. A document
  whose header cannot be read is shown whole as Markdown. The page's default message for a version of a document is
  `Edit <name>`, not `Edit <name>.fj`. The image carries the notices of what the editors are built on.
- **Delete and put back** (ROADMAP 1b.12): a note, a document or a folder can be deleted after asking (the question names it, and
  for a folder how many files go with it). It is one commit, authored by you, that removes it; nothing else is touched, and only
  what you were shown is deleted: a note that changed in the repository meanwhile, or a folder that gained a file, is left alone
  and the page looks again. A note with unsaved changes has them saved as a version first, so nothing typed is lost; a folder
  with any is refused. The next page offers **Undo**, and **Recently deleted** (`/deleted/<id>`, linked from the repository) lists
  what went within the last 30 days (`FJORD_RESTORE_WINDOW_DAYS`): a file is put back where it was or somewhere you choose, a
  folder's files all together, exactly as they were. Putting back is never over anything: if a path is taken, or something is in
  the way, nothing is put back and the taken ones are named. A vault, its manifest and `fjord.json` are never deleted from here.
  A new table, `deletion`, in both dialects (migration `0007`); disconnecting a repository deletes its records.
  `POST /api/connections/<id>/files/delete` and `…/files/restore`, under the same rules as the other routes. The format module's
  `parseDocument`, `checkName` and `caseCollisions` are now used by the app.
- **New notes and documents** (ROADMAP 1b.7): a folder of a plaintext vault has **New note** and **New document**. Give a title
  and the file is made in one commit, authored by you, and opened. The name is `fjord-core`'s, the one every client uses: a note
  from its first line (or, with no title, the date and time, as an empty file), a document from its title with `.fj.md`, numbered
  (`Plan 2.md`) past what the folder has, case aside. A document gets a header written by `fjord-core`. If someone makes the same
  name at the same moment, the next free name is taken and theirs is untouched. Encrypted vaults are not offered it.
  `POST /api/connections/<id>/files`, under the same rules as the other routes. What it makes is held to the real `fjord verify`
  (set `FJORD_CLI` to run that test locally; CI does). The format module gained `quickNoteName`, `titleFromText` and
  `freeName`.
- **Upstream changes** (ROADMAP 1b.10): when a note is changed in the repository (from the CLI, Obsidian or another device)
  while it is being edited here, the note's page shows both versions, side by side and read-only, and three ways to go on.
  **Combine** merges your changes with theirs exactly as the CLI's `sync` would (the same `fjord-core` merge); where both
  changed the same lines, both are kept between conflict markers for you to settle, and **Save version anyway** asks before
  a text with markers is saved. **Keep mine** moves your draft onto their version, so the next version is a commit on top
  of theirs, which stays in the history. **Take theirs** throws your changes away. Nothing is written to the repository by
  any of them, and a choice is made only about the version you were shown. Saving a version of a note that changed leads
  to the same page instead of an error. A note deleted in the repository keeps its draft visible, to copy and discard.
  `POST /api/connections/<id>/working-copy/resolve`, under the same rules as the other routes. The format module gained
  `mergeTexts`.

### Fixed

- **The note editor no longer reverts what was typed** when it is switched between reading and editing, or renamed, while the
  page still gives it the text it started with (`packages/fjord-editor`). This is what the page does while it saves a version.

### Added

- **Save version** (ROADMAP 1b.9): a note with changes has a **Save version** button, with an optional message, that makes
  one commit of the draft through the repository's token, on the branch the note was opened from. It is authored by the
  person who saved (their account's name and address, which a public repository then shows), with everyone else who edited
  the draft credited by `Co-authored-by:` lines; the message is theirs or `Edit <name>`. A commit is made only on top of the
  version the draft started from, never forced: if the note changed or was deleted in the repository nothing is written and
  the changes are kept (choosing between them is the next step), and a repository that merely moved on elsewhere is read
  again once. What was typed while the commit was being made is kept, not lost. `POST /api/connections/<id>/working-copy/version`,
  under the same rules as the other routes. Versions after a quiet period (by a worker) are not here yet.
- **Working copies** (ROADMAP 1b.8): a note can now be edited, and what is typed is kept as a **draft** on the server, a
  second after the last change (at most five seconds behind, however long the typing). Nothing typed is committed: the draft
  waits for a version to be saved (the next task). Closing the page and opening the note again finds the draft and says so,
  with **Discard changes** to go back to the note as the repository has it. A draft records the version of the note it was
  started from; if the note changes in the repository meanwhile the page says so and keeps the draft. A failed save is
  retried and a text that could not be kept warns before the page is left. `PUT` and `DELETE`
  `/api/connections/<id>/working-copy` keep and throw away a draft, under the rules of the other routes (signed in, this
  site's `Origin`, an account's own repositories only); a text with a NUL or an unpaired surrogate is refused, as is one over
  1 MB. A new table, `working_copy`, in both dialects (migration `0006`). Disconnecting a repository deletes its drafts.
- **Notes open in the note editor** (ROADMAP 1b.2): a note's file page (`/repo/<connection>/<vault>/<note>.md`) shows
  its text, exactly as stored, in the editors' package (`packages/fjord-editor`): CodeMirror with light Markdown styling.
  A file that is not UTF-8, or is larger than 1 MB,
  says so. The package is linked and must be built first (`pnpm build:editor`; CI and the image do it), the bundler's root is
  the repository's, and the image's server now starts as `clients/web/server.js`. The editor is dressed in the design
  system's tokens, in light and dark.
- **Setting up a repository that is not a Fjord repository** (ROADMAP 1a.10): a connected repository with no `fjord.json`
  and no vault is shown with an offer to set it up: the exact files, a vault name (`Public`, or the next free one), and
  nothing written until the button. It makes one commit, never forced, of what `fjord-core` plans: a `fjord.json`, one
  plaintext vault with a starter note, and spec §9's merge guard in `.gitattributes` only where it is missing (a line
  added to the end of the one that is there; nothing else that is there is changed). `POST /api/connections/<id>/setup`
  takes only the vault's name, under §12's rules; the plan is made again on the repository as it is, and a repository
  that changed meanwhile is left alone. A `.gitattributes` that is not valid text, or is large, is refused rather than
  rewritten.
- **A repository's vaults** (ROADMAP 1a.11, first step): a connected repository's page lists its vaults and what is
  in each (documents, notes, other files, a lock on an encrypted vault), read from the git host as the design
  says: the head, the tree once per commit, and the vault manifests, never a document. The format is
  `fjord-core` as WebAssembly (`pnpm build:wasm`, `FJORD_WASM_DIR`). A commit's tree is cached (`tree_cache`); a
  repository too large for the host to list is searched directory by directory; a missing `fjord.json` is said,
  not an error; and what the host gets wrong (a revoked token, a missing branch, a rate limit) is said plainly.
  Each vault opens to its folders and files (`/repo/<connection>/<vault>/<path>`), told by name alone: a document
  (`*.fj.md`) and a note are links, any other file is greyed, and an encrypted vault's files are shown by name and
  locked; a repository too large for the host to list is browsed a directory at a time, reading the same; and a path
  that is not there, that climbs (`..`), or that is in someone else's repository is a 404. Opening a document or
  note is the editors' (1b) and shows a placeholder for now.
- **A container image and the three ways to run it** (ROADMAP 1a.12): `clients/web/Dockerfile` builds the format module
  and the app into one small image (a Node runtime, the app, the module and the licences, `@sovereignfs/ui`'s `NOTICE`
  among them), and `clients/web/deploy/` has Docker Compose files for sqld (the default), a single container with a
  database file, and a PostgreSQL overlay, with `.env.example` and a README covering configuration, a reverse proxy,
  backups and updating. `/api/health` also says whether the format module loaded. A server that cannot start now exits
  with `[fjord] cannot start: <the setting>` instead of staying up and failing every request. CI builds the image and
  brings each setup up from nothing (`scripts/deploy-check.sh`).
- **A repository's default vault** (ROADMAP 1a.11, third step): `/` and `/repo/<connection>` now open on a vault: the
  one the account chose, or until it does the first vault `fjord.json` lists (a listed vault that is not there is
  skipped, and with no usable `fjord.json` it is the first found). The page marks it *Opens first*, shows its top
  under the list of vaults, and offers *Open this one first* on the others. The choice is stored per connection
  (`connection.default_vault`, a migration on both dialects) and set with `PUT /api/connections/<id>/vault`: signed
  in, this site's origin, the caller's own connection, a vault the repository has, or `null` to forget it.
- **Link Sovereign to a local account** (ROADMAP 1a.4): on the security page of an instance with both
  sign-in methods, a signed-in person can link a Sovereign account, **only when it uses the same email
  address** as the account (a different one is refused, with the reason, and nothing is linked). After that,
  signing in through Sovereign signs in that account, by Sovereign's `sub`. Unlinking is a fresh-session
  action and never removes an account's last way in. An account that came in through Sovereign has no
  password, so its security page has no password, two-factor or passkey sections, and says why. Signing in
  through Sovereign does not ask for the Fjord two-factor code (Sovereign has its own); the page says so.
- **First run and defaults** (ROADMAP 1a.9): an account with no repository is prompted, at `/`, to
  connect its first. The first repository an account connects is its default, and `/` is that
  repository's page (`/repo/<connection>` for any of its own, a 404 for anyone else's), with a switcher
  between repositories and *Make this my default* (`POST /api/connections/<id>/default`, signed in,
  this site's origin, the caller's own). Disconnecting the default moves it to the first one left. New
  `account_default` table. The default vault is not here: it needs `fjord.json` read by `fjord-core`
  (P3, P4), and moves to 1a.11.
- **Connect a repository with a token** (ROADMAP 1a.7): on `/repositories`, an address and a
  fine-grained GitHub token. It is checked before anything is kept (accepted, can see the
  repository, not empty, can write, found out by a no-op update of the branch, never forced), a
  token that fails leaves nothing behind, and the one that passes is stored encrypted. A token that
  can reach other repositories is accepted with a warning. `/api/connections` answers only the
  signed-in account's own, from this site's own pages. New `connection` table and
  `FJORD_GITHUB_API_URL` (for Enterprise Server). Nothing yet reads a connected repository: browsing
  and defaults are 1a.9.
- **Credentials at rest** (ROADMAP 1a.8): a `credential` table that holds secrets only as
  envelope encryption (AES-256-GCM, a data key per credential wrapped under an instance key
  from `FJORD_ENCRYPTION_KEY`), bound to its row and purpose so it cannot be moved to another.
  Rotation is a restart with the old key in `FJORD_ENCRYPTION_KEY_PREVIOUS`: every credential is
  re-wrapped, none re-encrypted. The server will not start with credentials it could never
  open. Nothing stores a credential yet; the connections (1a.6, 1a.7) will.
- **Sovereign's typeface and a new icon.** The app is set in Hanken Grotesk, loaded as
  Sovereign's own apps load it, through `next/font`: it is downloaded when the app is built
  and served from our own origin, so visitors' browsers never contact Google (the build needs
  network access to fetch it). The tab icon now reads "Fj".
- **Sign-in through Sovereign** (ROADMAP 1a.3): OpenID Connect against a Sovereign instance
  (RFC 0072), by authorization code with PKCE, switched on by `FJORD_AUTH_SOVEREIGN_ISSUER`,
  `_CLIENT_ID` and `_CLIENT_SECRET`. Either way in, or both, can be on; with neither, sign-in
  is off. A person is known by their Sovereign `sub`, never by an email address that matches a
  local account (such a login is refused until linking exists, 1a.4); `email` and `name` are
  copied; the ID token must verify against the issuer's keys, and the tokens are stored
  encrypted. Signing out of Fjord does not sign out of Sovereign. `FJORD_AUTH_SIGNUP` applies
  to both ways in, and a refused Sovereign login comes back to the sign-in page with the
  reason. Tested over real requests against a fake Sovereign on all three databases, in the
  browser, and against a recording of a real instance's discovery document.
- **The git host interface and GitHub** (ROADMAP 1a.5): list repositories, read a branch's
  head (with etags), a commit's whole tree or one directory, and a file; make several file
  changes as one atomic commit, never forced and never retried; verify `push` webhooks.
  Errors are typed (`head_moved`, `rate_limited`, `forbidden`, ...). Not yet connected to
  anything: the GitHub App and token connections are the next tasks.
- **Local sign-in** (ROADMAP 1a.2): email and password, passkeys, and two-factor with an
  authenticator app and ten backup codes, on better-auth 1.7. Off unless `FJORD_AUTH_LOCAL`
  is set, and then off entirely (404). Sign-up is the first account only unless
  `FJORD_AUTH_SIGNUP=open`. Email is optional: with `SMTP_*`, addresses are verified and a
  password can be reset by a mailed link that ends every session. Screens for sign-in,
  sign-up, the two-factor step, reset, and an account security page; a signed-in person sees
  `/home` at `/`. Run it behind a proxy that sets `X-Forwarded-For`.
- Browser tests (Playwright, Chromium, a virtual authenticator for passkeys), and a CI job.
- **The landing page** (`/`, ROADMAP 1a.1): what Fjord is, why, what it does, how it
  works and a FAQ, with sign-in and sign-up links. It is static HTML in the design
  system's tokens (`@sovereignfs/ui`, pinned), follows the visitor's light or dark
  setting, works without JavaScript and on a phone, and says plainly that Fjord Web is
  still being built. The sign-in and sign-up pages are the next task.
- **The database layer** (`DESIGN.md` §14): SQLite by default, as an sqld service or a
  plain file, or PostgreSQL by choice, selected by `DB_DIALECT`. The server makes its
  own namespaces, schemas and tables when it starts and refuses to start if it
  cannot. Paired Drizzle schemas and generated migrations, an `event` table for
  worker-to-web notices, portable query helpers, `GET /api/health`, and
  `pnpm db:dev` for a local sqld or PostgreSQL. CI runs the tests against all three
  databases.
- A placeholder app: Next.js 16 with React 19 and TypeScript, which type-checks,
  tests and builds in CI. Nothing in it is usable yet; the work is planned in
  [`ROADMAP.md`](ROADMAP.md).

[Unreleased]: https://github.com/sovereignfs/fjord/commits/main/clients/web
