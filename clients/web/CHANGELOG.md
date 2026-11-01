# Changelog

All notable changes to `fjord-web` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release's section is also its GitHub release notes: the release workflow
reads this file when a release is cut. Write the notes under `## [Unreleased]`
as you go; `scripts/release.sh web prepare` turns them into the version's
section.

## [Unreleased]

### Security

- **The frontmatter parser is safe Rust** (the format module): the library behind it was replaced, so a document header from outside is read by code that forbids `unsafe` and limits what an alias can expand to. A header that cannot be kept exactly (a key given twice, a YAML tag, a whole number too large to be one) is shown as the file it is and is not rewritten. The headers the page writes now quote text and timestamps (`created: "2026-10-16T09:34:00Z"`), so the first title change or promotion of a file re-quotes those lines; nothing else about them changes. The module is 1.3 MB (495 KB compressed), up from 980 KB.
- **Review of phase 2** ([`docs/security-review-phase-2.md`](../../docs/security-review-phase-2.md), ROADMAP 2c.2): four defects fixed. *Put back* can no longer write plain text into an encrypted vault (or ciphertext into a plaintext or another encrypted one); a password-sealed link cannot ask your browser for more than age's default work to open it; an API call can no longer delete or move an encrypted vault's recipients file or guard; and a decrypted file larger than 1 MB is not put in an editor. The page now says how many recipients a file is encrypted to.

### Added

- **Add a vault** (ROADMAP 2d.1): *Add a vault* on a Fjord repository's page makes a plaintext or an encrypted vault in one commit: a name, how the files are named, and the public keys (yours is put in), with the list of files shown first. The files are the ones `fjord vault add` writes, from the same planner in `fjord-core`; `.gitattributes` gains the merge guard if an encrypted vault is added to a repository that lacks it. An encrypted vault is added only with a key, so it can be written to at once. New API: `POST /api/connections/<id>/vaults`.
- **A written-down house style for documents, and a preview before it reformats anything** (ROADMAP 1b.4): the visual editor writes `-` bullets, `*italic*` and `**bold**`, `---` rules, `1.` on every numbered item, fenced code and compact tables, and a document already written that way is edited line for line. When you open a document written another way (Obsidian's `*` bullets, underlined headings, aligned tables), the page tells you how many lines editing it here would change, lists them, and waits: you choose *Reformat and edit here* or *Edit as Markdown, unchanged*, which edits it byte for byte. Nothing is reformatted until you choose.

- **Share an encrypted file by a sealed link** (ROADMAP 2c.1): on an open encrypted file, *Make a sealed link* encrypts a copy in your browser, either to a key that lives only in the link (after the `#`, which is never sent to a server) or to a password you tell the reader. The server keeps the sealed copy and serves it to the link, and cannot read it; the link opens in any browser, read-only, with no account. Revoking a link deletes its copy. A sealed link is a snapshot of the file as it was, and has no comments yet.

- **Move a file into, out of and between encrypted vaults** (ROADMAP 2b.6): *Move to another vault* on a file's page. Into an encrypted vault the file is encrypted in your browser to that vault's recipients; out of one it is decrypted in your browser, after the page tells you it will be committed as plain text; between two it is decrypted and encrypted again. The server, which has no key, takes the old file away and adds the bytes your browser made in one commit, and refuses plain text for an encrypted vault. The plain text of a file moved in stays in the repository's earlier commits. Text files only for now.

- **Rename, move and delete in encrypted vaults** (ROADMAP 2b.5): files and folders of an encrypted vault are renamed, moved and deleted, and Undo and *Recently deleted* put them back, all with no key on the server, which moves the encrypted bytes as they are. A rename keeps what a file is (`Plan.md.age` stays a note). In a vault that names its files by id, a file keeps its identifier and is renamed by the name kept inside it, from its own page once it is open. Between vaults is not possible yet.

- **New notes and documents in encrypted vaults** (ROADMAP 2b.4): *New note* and *New document* now work in an encrypted vault. The file is written and encrypted in your browser, to the vault's recipients, and only the ciphertext is sent, so it works with your identity locked. In a vault that names its files by their names, the title names the file (that is public, as every name there is); in a vault that names them by id, the file is a new identifier and its real name is inside it, and the title is not sent. The server accepts only an age-encrypted file, and `fjord verify` accepts what is made.

- **Encrypted files can be edited in the browser** (ROADMAP 2b.3): what you type in a file of an encrypted vault is encrypted in your browser, to the vault's recipients, before each send, so the draft the server keeps is ciphertext and the server never has the text. *Save version* commits those bytes as they are, and so does the five-minute idle version, with no key on the server; the CLI opens what the browser saved. Typing keeps your identity unlocked. If the file changed in the repository meanwhile, you keep yours or take theirs: the server cannot combine two files it cannot read. The server refuses to keep or commit anything for an encrypted vault that does not begin as an age file.

- **Encrypted files open in the browser** (ROADMAP 2b.1, 2b.2): a file in an encrypted vault is a link with a lock. Its page asks for your identity's passphrase (or sends you to *Keys* to make or bring one), fetches the stored bytes, and decrypts them in your browser, in vaults named by file name and in vaults named by id (whose real names are inside). The server never has a key and sends nothing decrypted; a file for another key says so and shows nothing. 

- **An encryption identity kept in your browser** (ROADMAP 2a.1, 2a.2): *Keys* in the header makes an age identity, or takes the one you have, and keeps it sealed with a passphrase in this browser only; nothing about it is sent to the server. It is opened into memory by the passphrase, and locks after fifteen minutes without use. The page may now compile WebAssembly (`'wasm-unsafe-eval'` in the script policy, and nothing broader) to do it: the format module is served from `/fjord-wasm/`. Reading and writing encrypted files comes next.

- **A repository the GitHub App loses is disconnected** (ROADMAP 1a.6): when GitHub says an installation was deleted or repositories were removed from it, the connections through the App to them end, as if each person had disconnected it. A connection made with a token is left alone.

- **Connect repositories through a GitHub App** (ROADMAP 1a.6): *Install on GitHub* on Repositories, choose the repositories there, and they are connected, with no token to make or keep. Fjord asks GitHub for a short-lived token when it needs one. Only the repositories the signed-in person can reach themselves are connected, shown by their own one-use authorisation, and only by a trip this browser started. The operator registers the App and sets `FJORD_GITHUB_APP_ID`, `_SLUG`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_WEBHOOK_SECRET` and `_PRIVATE_KEY` (all or none; see `deploy/README.md`). A signed `push` webhook at `/api/webhooks/github` forgets the cached trees of the repository. Connecting with a token still works beside it.

- **A draft nobody has edited for five minutes is saved as a version** (ROADMAP 1b.13), by a worker that runs inside the web process once a minute, with the same commit as Save version: on top of the
  draft's base only, never forced. The author is the repository's owner if they edited the draft, else the first editor, and the others are `Co-authored-by:`. Conflict markers and a file changed upstream
  are left to the person. `FJORD_IDLE_VERSION_MINUTES` sets the quiet period (1 to 1440, default 5; `0` turns it off); `FJORD_WORKER=off` keeps a process from running the worker.

### Fixed

- **`next dev` no longer warns "A Node.js API is used (process.exit)" at every request.** The start-up code that stops a server with a wrong setting is now in
  `instrumentation-node.ts`, which only the Node.js runtime imports, instead of in the file the Edge build also compiles.

### Changed

- **Looking at a repository again costs the git host no rate limit while nothing is pushed**: the head is asked for with the last `ETag`, and a `304` is the commit seen before. It is still asked at every view, so a push shows at the next look whether or not a webhook came.
- The landing page's link to the specification points at its new place, `docs/specs/Fjord.spec.md` (the spec's licence is now stated in the file itself).

### Security

- **Every page is sent with a Content-Security-Policy** (ROADMAP 1d.5): scripts run only with a nonce made for that request, nothing third-party loads (images,
  fonts and requests are this origin's own), nobody may frame a page, and a script, an inline handler or a `javascript:` address put into a page by a comment,
  a name or a document does not run. Pages are now rendered for each request, the landing page too. Also sent: `X-Content-Type-Options`, `X-Frame-Options`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and `Strict-Transport-Security` when the instance's address is https. Images in a document that come
  from another site no longer load (they would tell that site who read it).
- The proxy's tests (`proxy.test.ts`) were not part of `pnpm test`, and are now.
- The health check no longer logs the whole error it caught (which may carry a host or connection string), only its name.
- Tested, and found to hold: every route refuses another site's request and callers with no business there; the git host's token and the instance's secrets
  reach no browser; content written by others is only text; a password change ends other sessions; sign-in endpoints refuse a redirect to another site.

### Added

- **Limits on comments and on editing through a link** (ROADMAP 1d.4): comments can only be written so fast (an account 30 a minute, a guest's browser 20,
  and all of one link's guests together 60, with larger hourly limits), so a link cannot be used to flood a document whatever names its guests give; one person,
  or one link's guests together, cannot take all of a document's thread slots; edits through a link are limited for the link; and an account or a link can only
  keep so many live streams open. A refusal says what was met and for how long to wait. Counted in the database, so the limits hold across several server
  processes (new table `rate_bucket`).
- **Live updates for comments** (ROADMAP 1d.3): a new comment, reply, resolving, edit, deletion or closing appears for everyone looking at the
  document, without reloading. A page is told that the comments changed (never what they are, so that what a person may read is still decided
  each time they are read) and reads them again; a person who loses access (a link revoked, a share ended) stops being told within a quarter of
  a minute. Works across several server processes.
- **Comments follow the text when the document is changed elsewhere** (ROADMAP 1d.2): a thread stays on its words when text is added around
  them, follows them when a word of them is changed (the server then keeps the new words as the thread's place), and when its words are gone
  is not dropped but kept in the panel with an **Outdated** mark, and marked in the text again if the words come back.
- **Comments** (ROADMAP 1d.1): select text in a document and comment on it. Anyone who may comment can start a thread, reply, resolve it or
  open it again, and edit or delete their own comments; the owner can delete anyone's and close a document's comments. The text a thread
  is about is highlighted, in a document that is being edited and in one that is only being read, and choosing a highlight opens its thread. A
  panel beside the document lists the threads, for its owner, for an account it is shared with and for anyone with a link (view links read the
  comments; comment and edit links also write them, under a name they give once). Comments are kept on the server, not in the repository.
- **Manage who a document is shared with** (ROADMAP 1c.7): a document's page has a **Sharing** panel for its owner. It lists the people it is
  shared with and the links to it, and lets the owner share with another account's address, change a role, stop sharing, make a link (with a
  role, an expiry and a password if wanted), change a link's role, expiry or password, and revoke it. A link's address is shown once, when it is
  made, with a button to copy it; it cannot be shown again, so to hand one out again make another and revoke the old one.
- **Edit a document through a link** (ROADMAP 1c.6): someone with an edit link, and no account, gives a name and edits the document in
  the editor. What they type is kept as the document's working copy, where its owner sees it, who made it, and saves a version of it: the
  version is the owner's and credits each person who edited through the link by the name they gave. They cannot change the document's
  header. A view or comment link still only reads, and a link that is revoked stops taking changes at once.
- **Password links** (ROADMAP 1c.5): a share link can ask for a password. Whoever has the link is asked for it, and it is hashed with
  Argon2id (only the hash is kept), checked one try at a time with a growing wait after wrong ones (a second at first, up to a quarter of an
  hour), and never sent back, logged or put in an address. The token alone does not open such a link. The owner's list says which links
  have a password.
- **A share link's token no longer stays in the address** (ROADMAP 1c.4): opening `/doc/<id>?token=…` now sets a cookie for that one
  document (an hour at most, and no longer than the link lives, out of reach of the page's script) and redirects to the clean
  `/doc/<id>`, so the token is not left in the address bar, the history or a bookmark. Revoking a link, or its expiry, ends it on the
  next request, and a link that does not work looks the same as none. Every page now sends `Referrer-Policy: no-referrer`, and a token in
  anything the server prints (an address, the cookie, JSON) is printed as `[redacted]`.
- **Share links** (ROADMAP 1c.3): an owner can make a link to a document, as view, comment or edit, with an optional expiry, make several
  for one document, and revoke each on its own (an API for now; the screen comes later). Anyone who opens `/doc/<id>?token=…`, signed
  in or not, reads the document for as long as the link is good, and sees nothing of the repository, the file's place or its header.
  An expired or revoked link, or a wrong one, shows nothing. The token is shown once when the link is made; only a hash of it is kept.
- **Share a document with a named account** (ROADMAP 1c.2): an owner can share a document with the account that has an email
  address, as view, comment or edit, and stop again (an API for now; the screen for it comes later). The person it is shared
  with opens it at `/doc/<id>` to read, shown the title and the text and who shared it, and nothing of the repository, the file's
  place or its header. Sharing says the same thing whether or not the address has an account, so it cannot be used to find out who
  has one. Only documents can be shared, not notes; a share follows the document when it is renamed or moved, and ends the
  moment it is taken away or the repository is disconnected.
- **Roles and access rules** (ROADMAP 1c.1): the rules for sharing are written down in one place and held to a table by tests: what
  view, comment and edit may do (each including the ones before), that a share never makes a version, renames, moves, deletes,
  restores or shares, that an expired or revoked link allows nothing, that only documents (not notes, folders or encrypted files)
  can be shared, and whether a refusal is a 403 or a 404. Every page and API route is now listed with who may use it, and a
  test fails for a new route that is not. Nothing changes for anyone yet: sharing itself comes next.
- **Putting back never repeats an id** (ROADMAP 1b.12): restoring a deleted document is refused, naming the files, if another file in the
  repository has its `id` now (a copy made meanwhile), because that would make two documents of one. It applies to a single
  file's restore; a folder's deletion does not record ids.
- **Rename and move** (ROADMAP 1b.11): a note, a document or a folder can be renamed (the name before its extension, which stays)
  or moved to another folder, or another plaintext vault, from its page. It is one commit that puts the same files at the new
  paths, so nothing in them changes, and a document's `/doc/<id>` keeps working. Names follow the format's rules; nothing is
  ever replaced, and a name that is taken, or differs from one in the folder only by letter case, is refused and said so.
  Unsaved changes are saved as a version first. Moving into an encrypted vault is refused.
- **Open a file by its id** (ROADMAP 1b.6): `/doc/<id>` and `/note/<id>` show the file with that Doc `id` among your repositories,
  wherever it is in them, and keep working when it is edited, moved or renamed from another tool. An id that two files share is
  not guessed at: you choose between them. An id that is not there, not an id, or someone else's is a 404 and says no more; when
  a repository could not be read, or there are more files than one search covers, the page says that instead. A note asked for as
  a document, or a document as a note, goes to the right address. A file's page shows its address by id. Encrypted vaults are
  never read for this. A new `doc_index` table remembers which file has which id; it is filled as files are opened and by
  searching on a miss, and it is believed only where the repository still has the same version of the file.
- **Document properties** (ROADMAP 1b.5): a note or a document shows its header in a **Properties** panel beside the editor, which
  is given the body only: the identifier and the day it was made, the title (which can be changed there, and which does not rename
  the file) and every key Fjord does not know, shown as it is written and kept as it is. Editing the body leaves the header byte for
  byte, comments in it included; changing the title is the one edit that has the header written again (comments in it are lost
  then). A note with no header gets one (an identifier, a title from its first heading or its name, and the date) the first time it
  is edited, and not before; editing it back to what it was takes the header off again. A text with carriage returns or a byte
  order mark is left without one. A header that cannot be read is not split or rewritten, and the file is shown whole.
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
