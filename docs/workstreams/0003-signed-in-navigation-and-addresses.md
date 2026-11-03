# Workstream 0003 — Signed-in navigation and addresses

**Status:** 🚧 In progress: legs 1, 2 and 3 done (the owner said on 2026-11-03 to commit each leg and go straight on, with no gate between, and to push everything once the last is done); the owner's answers are under [Answered questions](#answered-questions)\
**Date:** November 2026\
**Author:** Claude Code, from a design conversation with the owner\
**Goal owner:** the repository's owner (kasunben)\
**Governs:** `clients/web/DESIGN.md` §3, §9, §12, §15; changes what RFC 0002 said about addresses (see
[What this changes](#what-this-changes-from-earlier-decisions)); `crates/fjord-core/src/journal.rs` for the journal's layout\
**Research:** none

---

## Goal

A person who signs in lands in their default vault, and moves around from a rail: a home page of repository tiles, an icon per
repository that says what kind it is, a dialog to connect another and one dialog for keys and security. Every place in a
repository has a readable address made of ids, never a path: `/repo/<repo-id>/v/<vault-id>/…`. What is shared has a short address
with no repository or vault in it: `/d/<doc-id>`, `/n/<note-id>`, `/html/<file-id>`. A new plaintext journal entry is filed as
`<date>/<hh-mm>.md`.

## Definition of done

- [ ] The rail's first icon is `layout-grid`, and opens `/`: a grid of repository tiles in the look of the legacy launcher.
- [ ] Each repository's icon in the rail is `hard-drive`, `notebook-pen` or `globe-code` by its kind.
- [ ] `+` opens *Connect a repository* as a modal dialog.
- [ ] Keys and Account security are one modal dialog behind a `fingerprint-pattern` icon.
- [ ] Signing in lands in the default vault of the default repository.
- [ ] Every address in [the table below](#addresses) works, is what the app links to, and old addresses still arrive.
- [ ] A shared Doc and note open at their short addresses, with the rules sharing has today (an HTML file's sharing is deferred).
- [ ] A new journal entry, plaintext or encrypted, is filed by the new layout, in the CLI and the web alike; old entries still read.
- [ ] `DESIGN.md`, `CLAUDE.md`, the CLI README, `CHANGELOG.md`s and `routes.ts` say what is true. Every leg ends with typecheck,
      unit tests, build and the whole e2e suite passing.

## Addresses

`<repo-id>` is the connection's number, `<vault-id>` the vault's manifest `id`, `<doc-id>` and `<note-id>` a Doc's `id`
(spec §8.3). **`<folder-id>` and `<file-id>` are handles** (`src/browse/handles.ts`): folders and non-Doc files have no id in the
format, and handles are already opaque, derived, never committed, and followed by Fjord's own moves. Only the immediate parent
folder appears, never a chain.

| Place | Address |
| --- | --- |
| Home (the tile grid) | `/` |
| A repository (its vaults; a journal's timeline; a site's posts) | `/repo/<repo-id>` |
| A vault | `/repo/<repo-id>/v/<vault-id>` |
| A folder | `/repo/<repo-id>/v/<vault-id>/<folder-id>` |
| A file in a folder | `/repo/<repo-id>/v/<vault-id>/<folder-id>/<file-id>` |
| A Doc in a folder | `/repo/<repo-id>/v/<vault-id>/<folder-id>/d/<doc-id>` |
| A static HTML file in a folder | `/repo/<repo-id>/v/<vault-id>/<folder-id>/html/<file-id>` |
| The same at a vault's root | `/repo/<repo-id>/v/<vault-id>/<file-id>`, `…/d/<doc-id>`, `…/html/<file-id>` |
| A journal's note | `/repo/<repo-id>/n/<note-id>` |
| A site's post (proposed) | `/repo/<repo-id>/post/<post-id>` |
| A site's other file (proposed) | `/repo/<repo-id>/v/<vault-id>/…`, as a drive's |
| A journal or site shown as files | `/repo/<repo-id>/v/<vault-id>/…`, replacing `?view=files` |
| Shared Doc | `/d/<doc-id>` |
| Shared journal note | `/n/<note-id>` |
| Shared HTML file | Deferred (answered question 4) |
| Shared site post (proposed) | `/d/<post-id>`: a post is a Doc. A published page stays `/p/<token>` |
| Sealed copy, published page | `/s/<token>`, `/p/<token>`, unchanged |

**Rules of the addresses:**

- **The last id decides what is shown.** The vault and folder in an address only describe it. A file that was moved is still
  found by its own id, and the page redirects to its address as it is now, so a bookmark never breaks.
- **Who may see it is decided as it is today:** the connection must be the account's own, anything else is a 404 that says
  nothing. An id is looked up only within that connection.
- **A Doc with no `id`** (a Markdown file with no header, and every encrypted file, which the server cannot read) is addressed
  by its handle as a file. A journal's encrypted note is `/repo/<repo-id>/n/<handle>`.
- **No ambiguity:** a handle is 16 characters and a ULID 26; `d`, `html`, `v`, `n` and `post` are neither.
- **Old addresses still arrive:** `/repo/<id>/<path…>`, `/f/<handle>`, `?view=files`, `/note/`, `/doc/` all redirect to the new
  form. A vault whose directory is named `v` is told apart because `<vault-id>` must be a ULID.

## Decisions locked

Settled with the owner on 2026-11-03, except those marked *proposed*, which are defaults until the owner says otherwise.

| Decision | Choice | Rejected alternative and why |
| --- | --- | --- |
| Home | `/` is the tile grid, for everyone signed in | `/` opening the default repository, as now: the owner wants the Index to be a launcher |
| Where signing in lands | `/open`, a new page that redirects to the default vault of the default repository; `/` if there is none yet. Every sign-in, not only the first (*proposed*) | Tracking "first login" per account: a column for no benefit, and the owner said "always" |
| A journal or site as default | `/repo/<repo-id>`, since their one vault is never shown (workstream 0001) (*proposed*) | Their vault's address, which would show them as a drive |
| `/repo/<repo-id>` for a drive | Unchanged: the list of vaults and the top of the one that opens first. Built so in leg 3, to keep the blast radius down; `/open` is what lands in the vault's own address | The list only: the owner's spec names the repository page and the vault page separately, and the list-only page can follow once the rest is in |
| Ids in addresses | Handles for folders and non-Doc files | Adding folder ids to the format: a format change for a client's URLs, and an encrypted vault's folders could not carry one |
| Nesting | Only the immediate parent, per the owner | The whole chain of folders |
| The kind in the rail | A derived column, `connection.repo_kind`, refreshed whenever the repository is read and when its kind is changed; null shows `hard-drive` | Reading every repository's manifest from the git host on every page: one API call per repository per page |
| Icons | Copied from lucide into Fjord (`src/ui/icons.tsx`, ISC notice kept), with a comment to consider offering them to `@sovereignfs/ui`; the owner said no contribution now | Bumping the package for them |
| Sites' addresses (*proposed*) | `/repo/<repo-id>` is the posts and build status; `/repo/<repo-id>/post/<post-id>` a post, the word because `/p/` and `/s/` already mean published and sealed; shared as `/d/<id>` | `/repo/<id>/p/<id>`: reads as a published page |
| Both dialogs | Modal, with `Dialog` from `@sovereignfs/ui` | Pages |
| Account dialog's address | `/account`, shown as a modal over the current page by an intercepting route (`@modal/(.)account`), and over the home page when opened directly. `/account/keys` and `/account/security` redirect to it (*proposed*) | Fetching its data through new APIs from a client-only dialog: more routes to secure. A dialog with no address: Sovereign's link flow must come back to it |
| Where disconnecting goes | `/repositories` stays, linked from the home page; connecting moves to the dialog (*proposed*) | Removing it: disconnecting needs a home |
| Commits | Direct to `main` for this session, by the owner's instruction, one commit per task. Pushed when the owner says | One PR per task, the repository's standing rule, which is unchanged |

## What this changes from earlier decisions

An agent reading the older documents will find these contradicted. Each is corrected when its leg lands.

- **RFC 0002, "the canonical address of a Doc is `/d/<id>`":** `/d/<id>` becomes the *shared* address. Someone whose own repository
  holds the Doc is redirected to the long one. "No address shows a path" still holds: every segment is an id.
- **RFC 0002, "`/n/<id>` is sent on for good to `/d/<id>`":** `/n/<id>` is a page again. The old redirect was a 308, which browsers
  may have kept, and they will land on `/d/<id>`, which still works. A `/n/<id>` that is not a journal's goes to `/d/<id>` with a 302.
- **`/f/<handle>`** stops being what the app links to, and only redirects.
- **Workstream 0001, "`YYYY/MM/DD/HHMM[-slug].md`":** replaced for plaintext journals by the new layout. This is `fjord-core`'s
  convention and not the spec's (the spec has no such text, and `date` wins over any path), so no RFC is needed and old entries stay valid.

## Prerequisites

- The owner's go-ahead, and answers to the [open questions](#open-questions), which only block legs 5 and 6.
- `pnpm build:wasm` and a Rust toolchain for leg 6.

## Legs

| Leg | Name | Gate? | Done when |
| --- | --- | --- | --- |
| 1 | Home grid and rail icons | No | `/` is the grid; the rail shows `layout-grid` and a kind's icon per repository |
| 2 | The two dialogs | No (the owner waived the gates) | `+` and `fingerprint-pattern` open modals, and every flow in them still works |
| 3 | Addresses | **Yes**: the biggest change, and everything else builds on it | Every drive address works and is what the app links to; signing in lands in the default vault |
| 4 | Shared addresses | No | `/d/<id>` redirects its owner; a share, a link and a password all still work |
| 5 | Static HTML | **Yes**: security review, new ground | An HTML file runs, sandboxed, at its addresses |
| 6 | Journal notes and layout | No | `/repo/<id>/n/<id>`, `/n/<id>`, and the new layout in core, WASM, CLI and web |
| 7 | Site addresses | No | `/repo/<id>/post/<id>` works and `?view=files` is gone |

## Leg detail

### Leg 1 — Home grid and rail icons

**Technical notes:**

- `src/ui/icons.tsx`: `layout-grid` is in the package's set; `hard-drive`, `notebook-pen`, `globe-code`, `fingerprint-pattern` are not.
  Take their paths from lucide at the version that has them, and check each name exists there (some were renamed). They take
  `currentColor` and the package's icon sizes. `AppShell.tsx` already carries the note about offering the shell to the package.
- `connection.repo_kind`: both schemas in `src/db/schema/*/app.ts`, migrations with `pnpm db:generate`. The existing `kind` column means
  `pat` or `app`, hence the name. Written by `readConnection` when the manifest answers a different kind, and by `ChangeKind`. It is a
  hint for an icon: every decision about what a repository *is* still reads the manifest through `kindFor`.
- `ConnectionInfo` gains `repoKind`; `ShellRepository` gets `kind` and drops the monogram.
- `app/home/page.tsx` renders the grid and `FirstRun` when there is nothing to show. The proxy's rewrite of `/` to `/home` is unchanged.
- The tile copies the legacy launcher: centred icon, name, description, a hairline, a small mono chip. Find it in
  `sovereign-legacy/runtime/app/(platform)/page.module.css`. Name is `owner/name`, description the kind's label and branch, chip the kind.
  No git host call to draw the grid. The default repository is marked.
- The Index's `active` is now `/` only; the default repository's own icon is no longer lit by it.

**Done early, from leg 3:** `/open` (a page that redirects to the default repository, or to `/` when there is none) and the sign-in landing on it, because `/` stopped being the default repository's page. Leg 3 makes it go to the default *vault*.

**Interactions:** many e2e tests `goto("/")` and expect a repository heading. They move to `/open` or the tile.

### Leg 2 — The two dialogs

**Technical notes:**

- *Connect:* a client `ConnectDialog` around `ConnectForm` and, when `gitHubApp()` is set, `GitHubAppPanel`, whose `github_app` return
  parameters must reopen it. The rail's `+` becomes a button, still named *Connect a repository*. On success: `router.refresh()` and close.
- *Account:* one dialog, two tabs in the order *Encryption identity*, *Security*, the latter only with `localAuthConfig()`.
  **Read `node_modules/next/dist/docs/` on parallel and intercepting routes first**; the root layout gains a `modal` slot, with `default.tsx`.
- The Sovereign link flow's `callbackURL` and its `?error`, `?linked`, `?unlinked` must land on `/account`. Check that passkey and two-factor
  ceremonies still work in a dialog, and that the QR code's white box survives.
- `routes.ts` gains `/account`. The rail loses Keys and Security for one icon, and the e2e `getByRole("link", { name: "Security" })` tests follow.
- Remaining `AccountHeader` users (`deleted`, and `IdPage`'s lists) move to `SignedInShell`, and `AccountHeader` is deleted.

**Do not proceed if:** the intercepting route cannot be made to carry the CSP's nonce. Stop and say.

### Leg 3 — Addresses

**Technical notes:**

- A new pure module, `src/browse/addresses.ts`, with the only code that knows the shape: `parseAddress(segments)` and a builder per place.
  Tested on every row of the table, including a vault named `v`, and a directory with a ULID-like name.
- `repositoryHref(connectionId, ...path)` has about 15 callers that draw links from paths, on the client too. A client cannot look up a
  handle, so: **links drawn by the server are direct** (`FolderView`, `VaultList`, the timeline), by building a map of handles for the listing
  in one query (`FileHandles.forPaths`, new, one statement, not one per row). **Links made after a client action** (`NewFile`, `MoveButtons`,
  `DeleteButton`, `TransferControl`) keep the old form, or take the address from their API's answer, and arrive by the redirect.
- `RepositoryScreen` takes a parsed address and resolves it to a path, then runs as it does now. Its redirect to `/d/` or `/f/` becomes a
  redirect to the canonical address, and that is where a moved file's address is corrected. Resolving a `<doc-id>` uses `src/browse/ids.ts` scoped
  to the connection. Vault ids come from the manifests already read.
- `/open`: `requireSession`, the default connection, `defaultVault`, redirect. `SignInForm`, `TwoFactorForm`, `SignUpForm` and the
  Sovereign `callbackURL` go there. A repository that cannot be read goes to its `/repo/<id>`, which says why.
- Breadcrumbs, `permalink` and *Copy link* follow; the permalink stays the shared form.
- Encrypted vaults: a folder's name is not in the address, which is an improvement. Handles are made per path as before.

**Interactions:** `e2e/repositories.open.spec.ts` asserts on addresses throughout, so expect this to be most of the leg's work. `isHandle` paths with
no match show "moved or gone", as `/f/` does.

**Do not proceed if:** drawing a large folder's handles costs more than one query per listing.

### Leg 4 — Shared addresses

**Technical notes:**

- `IdPage`: a single match in the person's own repository redirects to the long address; a share or link is shown at `/d/<id>`, as now; several
  matches still list. `/d/<id>/draft` and `/d/<id>/comments` are API and do not move.
- `IdentifyAndShare`, the Sharing panel and `linkUrl` keep giving `/d/<id>`.

### Leg 5 — Static HTML

New ground: today an HTML file is an "other file" with no viewer. The owner's need is to run checklists made with Claude (single HTML files with their
own script and style) without finding them in Claude again.

**Technical notes:**

- **A file's HTML is someone else's code, and must never run with this app's origin or cookies.** It is served by its own route, `…/html/<file-id>/raw`,
  as its own response (not `srcdoc`: a `srcdoc` frame inherits the embedding page's policy, whose scripts need our nonce, and the file's inline script
  would be blocked). The response carries its own header, `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'`, so that the document has an opaque
  origin **even if someone opens the address directly**, and cannot call this app's API or send anything out. `allow-same-origin` is never set. The page
  shows it in `<iframe sandbox="allow-scripts" src>` below the toolbar; `csp.ts` opens `frame-src` to `'self'` for this page only, held by its test.
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and the route is the same owner check as any file.
- **What will not work, and the owner should know:** an opaque origin has no `localStorage`, cookies or IndexedDB, so a checklist that remembers its ticks
  that way will run but forget them on reload. Offered later, if wanted: a small shim injected into the page that keeps that state in Fjord per file
  (through `postMessage` to the frame's parent), which is a feature of its own. No network means a checklist cannot fetch a library from a CDN either.
- Which files: `.html` and `.htm`, plaintext vaults first. In an encrypted vault the browser decrypts, then the frame is given a `blob:` document with the same
  sandbox (so `img-src blob:` and the frame source `blob:` are needed): a second step, only if the plaintext one is right.
- The address `/repo/<repo-id>/v/<vault-id>/<folder-id>/html/<file-id>` is the viewer; its file is addressed by handle like any other.
- **Not in this leg:** sharing (answered question 4), so no change to the sharing tables or the cookie paths.

**Do not proceed if:** the sandbox header cannot be made to apply to the direct address, which is what makes it safe. Test it by opening `/raw` in a tab and
reading `document.cookie`, `fetch("/api/connections")` and `parent` from a script in the file.

### Leg 6 — Journal notes and layout

**Technical notes:**

- `fjord-core/src/journal.rs`: `entry_path` writes `<yyyy-mm-dd>/<hh-mm>.md` for a plaintext journal, and for an encrypted one the same folder with the file
  named by id inside it (answered question 2); the reading of a date from a path accepts the old layouts too (old journals, flat encrypted ones included, stay filed
  correctly). `fjord-wasm` `journalEntryPath` loses `slug`; `journalSlug` goes if unused. CLI `fjord new`, its README and tests, `templates/README-journal.md`, and fixtures.
- Two notes in one minute: `entries.ts` already retries on a taken path. Decide the suffix in core, default `hh-mm-2.md`.
- **Encrypted journals now show their dates in folder names.** Update `README-journal` for encrypted journals, `clients/web/DESIGN.md` §15's claim and `encrypted-timeline.test.ts`
  (which should now assert that titles, tags and times are still absent from what the server sees, and that the day is the one thing that is not). The timeline of an
  encrypted journal is still built in the browser.
- `src/sharing/enter.ts`: cookies are set with `Path=/d/<id>`. A share entered at `/n/<id>` must also send to `/d/<id>/comments` and `/d/<id>/draft`, so set
  both paths. `proxy.ts`: `/n/<id>?token=` goes to the entry, and `/n/` leaves the 308 list.
- `TimelineView`, `NewEntry` link to `/repo/<id>/n/<id>`. `kindFor(...).id === "journal"` decides whether `/repo/<id>/n/` applies.

### Leg 7 — Site addresses

Mirrors leg 6's addressing with no format change. `NewPost` and the posts list link to `/repo/<id>/post/<id>`; `RepositoryView`'s *Show files* link becomes the
vault's address, and `?view=files` redirects.

## Answered questions

Answered by the owner on 2026-11-03; they are decisions now.

1. **The date folder is `2026-11-03/14-30.md`**: four-digit year, ISO date, `hh-mm`.
2. **Encrypted journals have dated folders too.** The owner accepts that directory names are not encrypted (spec §11.2), so **an encrypted
   journal's entry dates are visible to the git host and to the server**. This overturns workstream 0001's "an encrypted journal's dates never reach
   the server" and the flat layout of RFC 0001/0002, and `encrypted-timeline.test.ts`, which holds that guarantee, changes with it (leg 6). Titles and
   tags still never leave the browser, and the entry files are still named by id (`fileNaming: "id"`), so what is visible is the day each entry was
   written, not the time or what it says. The README of a new encrypted journal says so. Existing flat encrypted journals keep reading.
3. **HTML files run their scripts.** The owner's use is checklists made with Claude, to be run in Fjord rather than found again in Claude's
   artifacts. So a script runs, but never with this app's origin or cookies: see leg 5.
4. **Sharing an HTML file is deferred**, so `/html/<file-id>` as a shared address is not built in leg 5 and no sharing table changes.

## Open questions

1. **The site addresses and the other rows marked *proposed*** above: the owner asked for a proposal, and these are it. Say if any should change.

## Risks

- **Leg 3 reaches everything.** Most e2e tests assert addresses. Mitigation: the pure module, redirects from every old form, and the full suite at each leg's end.
- **A dead handle.** Handles live in the database, so a restored or moved instance loses them and with them these addresses. Doc ids survive, as they are in the file.
- **The rail's kind can be stale** after a change made outside Fjord, until the next read. It is an icon, and nothing decides by it.
