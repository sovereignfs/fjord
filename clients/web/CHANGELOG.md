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

- **A media library for sites** (RFC 0004). A site's page has a _Media library_: its pictures as tiles, found by name, added by a button or by dropping files (PNG, JPEG, WebP, GIF or AVIF, up to 10 MB each, up to 20 at a time, one commit), and deleted after being told which posts show them. Pictures go to an `images/` folder in the site's vault (an Astro site's `content/images`, a Jekyll site's `content/images`), and for a Jekyll site whose vault is `_posts`, which Jekyll cannot serve a folder from, to `assets/images`. A photo wider than 2560 px is scaled down in the browser first, which also drops where it was taken (_Keep the original_ uploads it as it is); an animated picture is never re-encoded. The server tells a picture's type from its first bytes: SVG, and a document named `.png`, are refused.
- **Pictures in a post.** The Markdown editor of a site's post has _Insert image_, and the visual editor's image button opens the library instead of asking for a URL. Choosing a picture asks for its alt text, and _Insert_ stays off until there is some (or the picture is marked as only for looks). A picture pasted or dropped into either editor goes to the library the same way. The reference written is the engine's own form (`../images/x.png` for Astro, `/content/images/x.png` for Jekyll), made by `fjord-core`.
- Routes `/api/connections/<id>/images`, `/images/file` and `/images/reference`, each checked for who may call it.

### Changed

- **The port is now 3001** (`sovereign.manifest.json`), in the image, the Compose setups and `pnpm dev`, so Fjord Web, Tusk (3002) and a Sovereign core (3000) run side by side on one machine. A Sovereign instance reads the port from the image and needs nothing. Run on your own, map the new port (`-p 127.0.0.1:3001:3001`, or keep the outside port: `-p 127.0.0.1:3000:3001`) and point the reverse proxy at it.

## [0.3.0] - 2026-11-07

### Added

- **A document's history is in the app.** `history` at the end of its title lists the commits that changed the file, with who and when, shows what any of them said, and puts one back. Putting back makes the text a draft, which is looked at and saved as any other: nothing is undone or forced, and every version stays in the repository. An encrypted file's are opened in the browser, and nothing readable is sent. `Provider.fileHistory`, optional, as `lastModified` is, and held by `providerContract`; it does not follow a rename, as `git log` without `--follow` does not, and the panel says so. Routes `/api/connections/<id>/history` and `…/history/file`.
- **An encrypted document has the visual editor and its properties**, as a plaintext one does, where it was Markdown with its header showing. A journal's stays in the note editor, with the date. The header is read and changed in the browser by the same format module the server uses for a plaintext document (`src/keys/header.ts`), and nothing of it is sent: a browser test holds that a title, a tag and typed words leave only as ciphertext.
- **A person can change their address**, under _Account_, _Profile_, with their password (`POST /api/account/email`; better-auth's own `/change-email` is turned off, because it takes a session alone). With email, a verified address is asked first and the new one after, and the change is made when both links are followed; without email it changes at once. An address that is Sovereign's to give stays Sovereign's.
- **A person can delete their own account**, under _Account_, _Profile_. It says what will go (a repository kept only on this server by name, and that a git repository is left as it is), asks for the address typed out and for the password where there is one (`POST /api/account/delete`, tries counted per account), and does what a Sovereign notice of a deleted account does. An encryption identity in the browser stays, and it says so. On an instance with `FJORD_AUTH_SIGNUP=closed`, deleting the only account means the next person to sign up is the first account again.
- **The first page says what is shared with you.** Someone with no repository of their own, who came for a document shared with them, was told only to connect one; now it says what is there and links to it.
- **Any file in a plaintext vault can be opened and saved.** A picture, a PDF or a CSV was greyed out in a listing, with no way to see it, save it, move it or delete it. Now it is a link to its page, with _Download_ and the move and delete a document has, and a raster picture is shown. It is served by `/raw/<repo>/<handle>/file`: a raster picture inline, everything else (an SVG and HTML above all) as an attachment with no type of its own, in a sandbox, to the repository's owner only, up to 25 MB.
- **A repository can be made on this server and connected to git later** (ROADMAP 3i, DESIGN.md §7a). _Create a repository_ (the first page, _Repositories_, and the rail's `+`, which now opens on _Create one here_ beside _Connect from GitHub_) takes a name and a kind, a drive or a journal; what it starts with is `fjord-core`'s setup plan, as setting up a repository in git is. Its files are kept in the instance's database behind the same `Provider` interface as GitHub's (`LocalProvider`, which passes `providerContract`), so browsing, new files and entries, editing, versions, moving, deleting and Undo, sharing, publishing and comments work unchanged. _Move to git_ (in the repository's settings) takes a GitHub repository and a token as connecting does, adds every file to it **in one import commit** on its default branch, never forced and never over a file that is there (a name that clashes, case aside, is refused and named, and nothing is written; `.gitattributes` gains the lines it lacks), reads the repository back to check each file is there with the same content, and only then switches the same connection to GitHub and **deletes the server's copy**, so drafts, shares, comments and addresses stay. It can be run again after any step; an edit made while it ran is refused and not lost. Migration `0024_local_repositories` (four tables, both dialects).
- **A limit per account on what is kept on the server**: `FJORD_LOCAL_MAX_REPOSITORIES` (default 3; `0` turns the feature off), `FJORD_LOCAL_MAX_MIB` (default 50) and `FJORD_LOCAL_MAX_FILES` (default 2000), enforced where the repository is written, so no way of writing gets round them. A write that would go over is refused with words that say what to do (`limit_reached`, 409); one that makes an account hold less is never refused. How much is used is shown on _Repositories_ and in the repository's settings. A deleted or replaced file stays for the restore window so Undo works, and no more of it than the byte limit again. A repository kept on the server is deleted with _Delete_ (not _Disconnect_), and with its account.
- **A published page's address is shown whenever its owner opens the dialog**, with a _Copy_ button, and no longer only when it is made. It is kept sealed under the instance key (`FJORD_ENCRYPTION_KEY`, in the credential store, as a repository's token is), and given only to the owner's own session; a page published before this has only a hash of its address, says so, and is given a new one by _Publish again_. Migration `0023_publication_token_credential` (both dialects).

### Fixed

- **A journal entry with no title is headed by when it was written**, and not by the name of its file (`00-03`); its line in the timeline has the time alone.
- **The account no longer runs off a phone's screen**: the row of sections scrolls, and does not widen the page.
- **A tab says which page it is**: the document, the folder or the repository, and not "Repository" on all of them.
- **A repository on the server is called by its name in its path** and on _Recently deleted_, not `local/Scratch drive`.
- **Sharing with your own address says so**, and does not say _Done_ having done nothing.
- **The landing page and the README say what is so.** They said connecting a repository and the editor were not available yet, that encryption comes after the first release, and that a document could be shared by link, where sharing is with people on the instance or as a published page.
- **Saving a version of an encrypted file does not ask for the passphrase again.** The page reloaded to show the new version, and a reload drops the unlocked identity; it now refreshes in place and opens the new version, with what was typed.
- **A link followed while signed out comes back after signing in.** A person asked to sign in on their way to a document went on to their default repository, and had to find the link again; now it is `/sign-in?next=…`, for a password, a passkey, two-factor and Sovereign alike. Only a path of this site is taken, and nothing that holds a token (`src/auth/next.ts`).
- **A folder named `.git` is refused with a reason**, not a 500; so is any other name starting with a dot, which other tools leave out of what they list. `..` as a new folder's name is told it is not a name, and not `Say which folder of the vault, by its path`.
- **A slash in a file's new name is refused, and does not make a folder and move the file into it.** _File name_ and _Rename_ say to use _Move_, and refuse a name that starts or ends with a dot.
- **Setting up a site where `content/` is already there says what to do**: a new site's posts have nowhere else to go, so it no longer says "Choose another name" on a form with no name to choose.
- **A new document whose title has `<` in it opens in the visual editor**, where its own first line used to send it to the Markdown fallback (`fjord-core`).
- **A published page's address no longer runs out of the dialog**: it wraps inside it.
- **The choices of where to move a file, move it to another vault, and which vault a repository opens on use the design system's select**, as the rest of the forms do, and not the browser's own.

### Changed

- **A Sovereign instance makes `FJORD_ENCRYPTION_KEY` itself.** The manifest's `generate` now lists it (32 bytes, once, kept), so hosting Fjord no longer needs `sv secret set FJORD_ENCRYPTION_KEY`. No change to the app or its settings. **An instance that already set one with `sv secret set`** has to remove it (`sv secret remove FJORD_ENCRYPTION_KEY --app fjord`), since a secret the manifest generates may not also be entered; the key it then gets is a new one, so repositories connected under the old key are connected again.
- **Everything that cannot be undone asks in the page.** _Disconnect_, _Delete_, _Move to git_, removing a passkey, unlinking Sovereign and removing an identity used the browser's own `confirm` (`src/ui/useConfirm.tsx`, on the design system's dialog). _Move to git_ now ends by saying it worked, with a way to open the repository, where the dialog just lost its form.
- **Repository settings has a title**, one size of text and a button in one line.
- **Dates are in one form**: `4 Nov 2026`, and `4 Nov 2026, 22:56 UTC` where the server draws them and a time matters (`src/ui/dates.ts`). They came in three, one of them `11/4/2026`.
- **A document's page gets to its text sooner.** The notice that was there on every document is gone: what has become of what you typed is one line under the title, in sight however long the document is. The address by identifier moved into _Properties_, and _Comment on selection_ is a quiet button. On a phone the text now starts on the first screen.
- **The comment box opens where you can see it**: choosing _Comment on selection_ goes to it and puts the cursor in it, where before it opened at the foot of the page. A comment can be made on any selection: across bold or a link, or across several paragraphs, where the button used to stay grey. Its mark is found again in the same rendered text it was taken from.

## [0.2.0] - 2026-11-04

### Added

- **Shared with you.** What other accounts on this instance have shared is a place of its own, `/shared` (a rail icon once there is anything): each document with who shared it, when and at what role; the files stay with their owners. An account at the **edit** role types into the document's working copy, and nothing of theirs reaches the repository; the owner's page says, by name, that changes are waiting, and saving a version accepts them and credits each editor by name, with an address that is nobody's (`account-<hash>@users.noreply.fjord.invalid`).
- **Published pages have an optional password, a setting for who may comment, and say who made them.** The password is asked of everyone, signed in or not, and nothing of the document (not its title) is sent before it is given; tries are slow, one at a time, and a new password ends the cookies of the old. _Save settings_ changes password and comments without a new address. Who may comment is chosen now (only _Off_ is built; the setting is kept for when comments are). The page shows who published it, when the document was made and when it last changed, and does not repeat the title above a document that begins with its own heading; its tables have borders and keep their columns' alignment. New migrations `0022_publication_password_and_comments` (both dialects).
- **Save is an icon among a document's others, with an arrow that saves with a message.** _Save version_ is the `save` icon at the end of the title (for Markdown and for documents, a note's too), beside Share, Move and Delete, and disabled when there is nothing to save. The arrow attached to it opens a small menu with _Save with a message…_, which asks for the message in a dialog; the icon alone saves with the message the repository would give it (_Edit <name>_). The form at the foot of the page is gone.
- **Sharing is one dialog with three tabs.** _People_ (add by the address of an account, with a role, in one row; the people with access under it, each with a role and _Remove_), _Links_ (make a link, with what it allows, an expiry and a password; the links there are, each with its state, _Change_ and _Revoke_) and _Page_ (publish as a page). A file with no identifier opens on one step in the same dialog (_Add the identifier and continue_), and when it is done the dialog stays open and becomes the sharing controls: the page behind moves to the file's address by identifier, and the dialog is open again where it was. It no longer closes and reloads.
- **A shared document is shown on a sheet of A4 paper (210 by 297 mm, one inch of margin) on a gray desk**, with its name and what it is shared as above the paper; a document that is only read has no formatting toolbar.

- **A document's page is headed by what the document says, with its size, and its actions are icons.** The title is its header's title, else its first heading, else its file's name; the size is beside it; the path above has the file's name without `.md`. At the end of the title are icons: _Share_ (a dialog with the people it is shared with, the links and publishing, or the offer to give the file an identifier), _Move_, _Move to another vault_ and _Delete_ (confirmed in a dialog). _Rename_ is not among them for a drive's document: its properties have the file's name (_File name_, which is what renaming is), the day it was made and, new, **when it last changed**, asked of the repository's history for that one file (`Provider.lastModified`, optional; GitHub's commits of the path). The draft notice is an information box, and the properties are a disclosure with a visible toggle and a panel of fields, without a _Title_ or a _Date_ for a drive.
- **Addresses begin with the repository's kind.** `/drive/<repo>/…`, `/journal/<repo>/…` and `/ssg/<repo>/…` replace `/repo/<repo>/…`, which is sent to the one that is the repository's (by its public id or the number it once had), as is an address of another kind than the repository now is (a drive that was made a journal). The vault, folder, file, note and post addresses under them are as they were; `…/deleted` is each one's. A connection says where its addresses begin (`address`, `<kind>/<public id>`).

- **A menu on the avatar.** The foot of the rail is the person's avatar, which opens a menu, to the right of the rail and level with the avatar (under it, at the right, when the rail is a bar along the top): who they are (name and address, with their picture where Sovereign gave one), _Account_, and _Sign out_ last. The fingerprint icon and the separate sign-out icon are gone from the rail.
- **The account is a dialog of three sections** (after the legacy Sovereign's), opened by _Account_, at `/account` as a page: _Profile_ (the display name, which a Fjord-signed-in person can change and which the menu shows at once; the address, read-only), _Security_ (what _Security_ was, moved here) and _Preferences_ (_Appearance_: system, light or dark; _Text size_: default, large or larger). The dialog is the design system's capped size (64rem), not the whole screen. Preferences are kept in this browser, apply at once and are in place before the page is painted (`src/theme/`). `?section=profile|security|preferences` opens one.
- **A new folder**, in every folder of a vault: a folder's name, and a first document in it (git has no empty folders, so a folder is made by its first file, which you can rename or delete). It is one level below a folder that is there, is refused where something of that name is (a file or a folder, case aside) or where the name is one a folder cannot have, and works in encrypted vaults whose file names are plain (the document is encrypted in the browser, as any new document is). `POST …/files` and `…/files/encrypted` take `newFolder: true`, and answer `folder_exists` and `bad_folder_name`.
- **Repository settings**: `settings-2` at the end of a repository's name opens a dialog with whether it is your default, its kind (_Change its kind_ moved here) and the way to _Connect or disconnect repositories_.

### Changed

- **Sharing is with people on this instance, and no link is made any more.** The dialog's tabs are _People_ and _Publish_, and _Links_ only while the document has a link from before, to change or revoke. The shared view's paper is wider (250 by 353 mm) and the document editor's tables are left-aligned, with narrow tools and their columns' alignment kept (it is set from each column's menu).
- **The page's name, its branch and the path are closer together** on every page that has them: the gaps above and below a title and its line were each large and added up.
- **The visual editor's block-type menu says which heading level each is** (it said _Heading {{level}}_ for all), and a document that begins with a heading begins at the top of the editor.
- **The listings' actions ask in dialogs, and their path is outside the card.** _Create a new vault_ (a primary button, which was _Add a vault_), _New folder_, _New document_, _Encrypt this vault…_, rename, move and delete each open a dialog for what they need, and no form is drawn among the files; the buttons are level with each other and with the view toggle, in the order _New folder_, _New document_, then the vault's own. The path (`repository / vault / folder`) is drawn between the repository's name and the card, not in it. Pointing at a row changes its background and nothing else (the icon no longer changes, and the name is not underlined).
- **No vault says it opens first.** The _Open this one first_ button and the _Opens first_ label are gone: which vault a repository opens on (where signing in lands) is a setting, _Default vault_ in the repository's settings, which names the vaults to choose from.
- **A repository's page is its vaults as folders, and a vault's page is its folders and files in the same listing, as rows or as tiles** (a toggle at the top right, remembered in this browser). A plaintext vault has a folder's icon and an encrypted one a locked folder's; the page no longer shows the first vault's files under the list (opening a vault does). Files have an icon by what they are, from their names (Markdown, images, PDF, HTML, any other), by one table that a new kind of file adds a line to, and a folder opens to an open folder's icon. The actions (_New document_, _New folder_, _Encrypt this vault…_, _Add a vault_, move and delete) are buttons at the top left of the listing.
- **What was deleted is at `/repo/<repo>/deleted`**, from `archive-x` at the end of the repository's name; `/deleted/<repo>` (and by number) is sent there.

- **A repository is called by a short generated name in an address, not by a number.** `/repo/k3x9m2qa`, eight lower-case characters (`src/connections/public-id.ts`), kept in a new `connection.public_id` column (migration `0021`, both dialects, unique); a connection made before it is given one the first time it is listed. No address shows how many repositories an instance holds or in what order they were connected. `/repo/3`, `/deleted/3` and the rest of the old addresses still arrive and are sent to the name. The numeric id is still what the database and `/api/…` use, and the API's connection now carries `publicId`.
- **The home page is Fjord's, and says what it is.** Its title is _Fjord_ ("Your private cloud, kept in your own Git repositories"), the section is _REPOSITORIES (3)_, and the way to connect and disconnect repositories is Lucide's `settings-2` at the end of that line, in place of the link under the tiles.
- **Connecting a repository is quieter.** The dialog is only the form (no _Connect with the GitHub App, or disconnect a repository_ link, which led to a page the dialog should not send you to), with the instructions in an information box, in smaller type, and its fields closer together. It closes when the repository is connected, always: a token that reaches other repositories is told to you in a notice that stays a while (it used to keep the dialog open). The repository is read once as it is connected (by a token or through the GitHub App), so its tile and its icon in the rail are its kind's at once, and not a drive's until it has been opened.
- **Security is a section of the account, which is `/account`.** Its two parts are _General_ (the password, two-factor, passkeys, the link to Sovereign), which opens, and _Encryption identity_ (`?section=security&tab=keys`). `/security`, `/account/security` and `/account/keys` still arrive, with what they carried (the way back from linking Sovereign), and are sent there; the Sovereign link flow's callback is `/account?section=security&linked=1`.

- **A site's post is at `/repo/<repo>/post/<id>`** (by handle when its file has no `id`), and the posts' timeline links straight to it; a post is a Doc, so it is shared at `/d/<id>` and published as a page as before. _Show files_ on a journal or a site is its one vault at its own address (`/repo/<repo>/v/<vault>`), and `?view=files` is sent there. The workstream is complete. Workstream 0003, leg 7.
- **A journal files an entry at `YYYY-MM-DD/hh-mm.md`, in an encrypted journal too, and a note has its own addresses.** A folder for each day and a file named by the minute it was made (a second in the same minute is `hh-mm-2.md`), with nothing of the title in the name: `fjord-core`'s `journal::entry_path`, the format module's `journalEntryPath(date)`, `fjord new` and the web alike. Entries filed the old way (`YYYY/MM/DD/HHMM-slug.md`, or flat) are still read and placed by their date. **An encrypted journal now shows which days have entries**: a directory name is never encrypted (spec §11.2, whose text now says so), by the owner's choice; the entry's file is still named by its id, and its time, title and text stay in the ciphertext. A journal's note is at `/repo/<repo>/n/<id>` (by handle when its id is in the ciphertext), the timeline links straight to it, and an old address by path or by `/d/<id>` ends there. A note is shared at `/n/<id>` (a link is given there, and its cookie works at both `/n/<id>` and `/d/<id>`); `/n/<id>` is no longer sent on to `/d/<id>`. Workstream 0003, leg 6.

### Added

- **An HTML page in a vault can be opened and run.** `.html` and `.htm` files of a plaintext vault are links (marked _Page_) to `/repo/<repo>/v/<vault>/…/html/<handle>`, which shows the page in a sandboxed frame: its script and style run, and it can reach neither this app's cookies, the page around it, nor the network (it is served from `/raw/<repo>/<handle>` with `Content-Security-Policy: sandbox allow-scripts`, so opening that address in a tab is boxed in too). For checklists and small tools made elsewhere. A page keeps nothing between visits, since a sandbox has no storage of this origin. Only the repository's owner is served it, to 2 MB; sharing a page is not built. Workstream 0003, leg 5.

### Changed

- **`/d/<id>` is the address a share is given, and the owner is sent from it to the Doc's address inside its repository.** Someone it is shared with, a share link (with its password), the comments and the draft route are as they were; the owner's own `/d/<id>`, `/doc/<id>` and `/note/<id>` now end at `/repo/<repo>/v/<vault>/…/d/<id>`. Workstream 0003, leg 4.
- **Addresses inside a repository are made of ids, never of a path.** A vault is `/repo/<repo>/v/<vault-id>`, a folder or a file in it `/repo/<repo>/v/<vault-id>/<folder>/<file>` by handle, and a Doc `…/<folder>/d/<doc-id>`; only the folder a thing is in is named, and the last id decides what is shown, so a moved file is still found and a stale address is redirected to the right one. Signing in lands in the default vault (`/open` → `/repo/<repo>/v/<vault-id>`; a journal or a site opens on `/repo/<repo>`). The old addresses (`/repo/<repo>/<path…>`, `/f/<handle>`) are sent on; links the page draws are direct, from handles made for a whole listing in two statements. `fjord-wasm`'s `discover` now says each vault's `id`. A Doc opened by path now lands at its long address, not `/d/<id>` (which is the one a share is given, and is next). Workstream 0003, leg 3.
- **Connecting a repository, and the account, are dialogs.** The rail's `+` opens _Connect a repository_ over the page you are on, and closes when it worked (the rail has the repository at once); _Connect with the GitHub App_ and _disconnect_ stay on `/repositories`. One icon (Lucide's _fingerprint-pattern_) replaces Keys, Security and the page header: it opens the account as a dialog with two tabs, _Encryption identity_ and _Security_, the second only where the instance has local sign-in. At `/account`, typed or refreshed, it is a page with the same content (an intercepting route, `app/@modal/(.)account`). `/account/keys` and `/account/security` still arrive there, and the way back from linking Sovereign opens the Security tab. The page header (`AccountHeader`) is gone: the deleted-files page and the page for a file by id are in the shell too. Workstream 0003, leg 2.
- **`/` is a page of tiles, one for each connected repository**, in the look of Sovereign's launcher, and the rail's first icon (now Lucide's _layout-grid_) opens it. Signing in lands on your default repository at `/open`, which is what `/` was. Each repository's icon in the rail is by its kind: a hard drive, a notebook with a pen, or a globe with code for a site (kept in `src/ui/icons.tsx`: worth offering to `@sovereignfs/ui`). The kind is the one the repository was last opened as, kept in a new `connection.repo_kind` column (migration `0020`), a hint for pictures that the repository's own manifest overrides; a repository never opened shows as a drive. Workstream 0003, leg 1.
- **A signed-in page has a rail down its left side and fills the rest**, as Sovereign's own shell does: the page is at least the height of the viewport, and the rail (64px, on a narrow screen a bar along the top) has, from the top, the instance's mark, the Index (the repository `/` opens on), an icon for each connected repository to move between them (its tooltip says which is the default), and _Connect a repository_; at the foot, Keys, Security (where there is a password to manage), Sign out and who is signed in. It is on the repository pages (`/`, `/repo/<id>`, a file or folder, `/d/<id>`) and _Repositories_; the other account pages keep their header until they move too. The list of _Your repositories_ that sat under a repository's page is the rail now. The shell is Fjord's own (`src/ui/AppShell.tsx`): worth offering to `@sovereignfs/ui` once a second app wants it.

### Fixed

- **A password link was opened without its password by a browser that held the cookie of another link to the same document**: entering a link with a password now ends that cookie.
- **In development, Next's own indicator (the round _N_ at the bottom left) is styled again.** The page's Content-Security-Policy refused the inline styles it is drawn with, leaving a bare grey box. `next dev` now allows inline style elements; the policy production sends is unchanged.

### Added

- **The sign-in screens are the design system's own**, the ones Sovereign's sign-in uses, so Fjord's and Sovereign's look the same: a centred card with the instance's mark (the first two letters of `FJORD_NAME`, "Fj"), _Sign in to <name>_, labels above their boxes with no asterisk, _Forgot password?_ beside the password's label, _or_ between the ways in, and _New to <name>? Create account_ under them. The same goes for sign-up, the reset pages and the second step, whose code is now one box for each digit (paste fills them, backspace goes back). The passkey button is shown only where the browser supports passkeys. There are no privacy or terms links, because this app has no such pages yet. The screens that are only a message and a link (sign-up closed, a link that does not work, a page that is not there) put the link under it, spaced and centred like the other small print. Needs `@sovereignfs/ui` with the auth components (`AuthCard`, `AuthField`, `AuthCodeInput` and the rest) and `BrandBadge`'s `mark`.
- **A whole vault can be made encrypted, or plaintext again, from the browser** (RFC 0003): a vault's top shows _Encrypt this vault…_ or _Make this vault plaintext…_. The page reads every file of the vault (`GET /api/connections/<id>/files/convert?vault=`), encrypts each to your key and opens it again to prove it is the file it was made from (or decrypts it), and sends the lot (`POST` to the same route) to be committed at once with the vault's new manifest, recipients file and guard, which are `fjord-core`'s and not the page's. It needs your key unlocked, asks first, and says that what was committed before stays in the history. The server refuses a request whose files are not exactly the vault's, whose blobs are not the ones shown, whose bytes are not the form the vault will hold, a draft in the vault, a site, and a vault of more than 300 files or 32 MB (the command line does those). Shares and handles follow the names. The command-line forms are `fjord encrypt <vault> --permanent` and `fjord decrypt <vault> --permanent`; the temporary decrypt of those (a checkout) has no counterpart here, because a browser opens an encrypted file, edits it and seals it again one at a time.

### Changed

- **Breaking: there is one kind of Doc, and the repository's kind chooses its editor** (spec §8.4, RFC 0002, ROADMAP 3e.1). A `.fj.md` name is an ordinary `.md`: every Markdown file opens at `/d/<id>`, a drive's in the document editor and a journal's or a site's in the byte-faithful Markdown editor, and _New document_ is the one way to make a file (a title is optional; with none the date and time name it and are its title, and a file the app makes has an `id` from the start). `/n/<id>`, `/note/<id>` and `/doc/<id>` are sent on for good to `/d/<id>` (a 308 that drops any token). Any Doc in a plaintext vault can be shared, by account or link, where only `*.fj.md` could; renaming keeps a file's extension, whatever it is. `FileKind` from the format module is `doc`, and the `doc_index` and `deletion` tables' `kind` column says `doc` (older rows say `note` or `document` and are read as `doc`; no migration).

### Added

- **A Doc can be published as a page, and so can a copy of a file from an encrypted vault** (ROADMAP 3h, RFC 0002). _Publish as a page_ (in the Sharing area of a Doc) makes `/p/<token>`: the saved version, read-only, to anyone with the address and no account, `noindex`, ended at once by _Unpublish_. The page is made by a renderer that writes only an allowlist of tags: raw HTML in the Doc is shown as text, a link is written only for `http`, `https`, `mailto` or an in-page address, and no picture or script is loaded. Only a hash of the token is kept, so the address is shown once; the log masks it. A file in an **encrypted** vault is published only as a **plaintext copy**, which this browser decrypts and hands over after a warning and a ticked box (the server refuses without it and never receives a key); the copy is kept until unpublished. New tables columns: `publication` (migrations `0018`, `0019`). New dependencies: the Markdown parser packages the editor already uses.
- **A site's posts can be edited visually, and their front matter has a form** (ROADMAP 3g.2, RFC 0002). A post opens as Markdown, kept as it was written; _Edit visually_ switches to the document editor, which holds a text only if its meaning survives (a post with an MDX component or other things it cannot hold stays Markdown, with the reason shown) and asks before it reformats one. The properties panel gains **Draft** and **Description** for a site, every other key whose value is text or a yes or no as an editable field, and _Add a field_; a key of another shape is shown and kept. A change is one key, written by `fjord-core` (`withField`) with every other key left where it was; `id`, `created` and `fjord` cannot be set from a form (`POST …/files/header` takes `{ field: { key, value } }`).
- **A site that already exists can be adopted where its engine reads its content** (ROADMAP 3g.1, RFC 0002): a repository that is not a Fjord repository and has `astro.config.*` or `_config.yml` at its root is offered _Use it as it is_, with `src/content` (Astro) or `_posts` (Jekyll) as the vault and nothing of the site changed or moved, ahead of _Start a new site here_. A vault may be at any depth in the browser: a path is looked up against the vault whose directory it begins with, and a post is made where the engine reads it (`src/content/posts/…`, or straight into `_posts/`; a Jekyll draft there is refused, since `_drafts` is outside the vault). Encrypted vaults below the root are read, not written, from here; a repository too large to list does not find them.
- **A journal opens as a writing view, and a new one is encrypted by default** (ROADMAP 3f, RFC 0002). _New entry_ is one action: it makes today's entry, dated in your own time, and opens it, with no form first. An entry's page shows the editor and its properties and nothing else; sharing, rename, move and delete are under _More_. Setting a repository up as a journal selects **encrypted** first (the entry's date, title and tags show nowhere), with plaintext as an explicit second choice; with no key in the browser, _Set up_ waits for one, or for plaintext to be chosen.
- **A file with no identifier is given one only when sharing needs it, after the person agrees** (ROADMAP 3e.3, RFC 0002; spec §8.2). Editing a file no longer gives it a header (1b.5's promotion is gone): it is edited as it is. _Sharing_ on such a file says what will be written, a few lines at the top, in one commit and nothing else changed; on yes `POST /api/connections/<id>/files/identify` adds the `id` (the file's other header keys kept in their order), on the version the person looked at, and the page moves to `/d/<id>`, where the sharing controls are. A file with unsaved changes asks for a version first; one whose header cannot be read, or that has Windows line endings or a byte-order mark, is left alone and says why.
- **No address shows a path** (ROADMAP 3e.2, RFC 0002): a file or a folder that has no Doc `id` is at `/f/<handle>`, an opaque 16-character handle kept in the instance's database (`file_handle`, migration `0017`) and never committed; a Doc is at `/d/<id>`. A place reached by its path (`/repo/<connection>/<path>`, which every link still draws) is sent on to the address that shows none, and a handle is made only for a path that is there. Fjord's own rename and move carry a handle to the new path, so the address stays; a file moved outside Fjord leaves its handle on a path where nothing is, which says _Moved or gone_ and never shows another file. Another account's handle is a 404. Disconnecting a repository deletes its handles.
- **The format module plans an adoption** (ROADMAP P17): `planAdopt` and `detectSite` give the web client `fjord init --adopt`'s planner, so that a directory that already has files, a vault below the root included, can be made a Fjord repository by the same bytes the CLI writes. The page for it comes with the site and drive tasks that need it (3g.1).

- **Tags can be edited on any note or document, with the journal's own offered as they are typed** (ROADMAP 3b.3): the properties panel has a Tags field (`POST …/files/header` takes `tags`), written as typed and in that order, never lower-cased, and in a plaintext journal it suggests the tags the journal already uses, so `Run` is not added beside `run`.
- **A site's unsaved changes can be previewed through its host** (ROADMAP 3d.1): _Preview_ puts the person's drafts of the site's posts on a branch of their own (`fjord/preview/<person>-<time>`, cut from the default branch and given one commit), the host builds it as it builds any branch, and the page shows the address the host gives for **that commit**. The default branch is never written, nothing is forced, and a draft of a file that has changed since is left out and named. A preview lasts until _Stop previewing_ deletes its branch (at most three at a time, and only a person's own can be stopped); a host that has reported nothing for three minutes is told to build no branches, rather than waited on. `Provider` gains `createBranch`, `deleteBranch` and `listBranches`. Fjord holds no credential of the host's: the address is what the host posted to the repository. `GET/POST/DELETE /api/connections/<id>/previews`.
- **A site's page shows its build** (ROADMAP 3c.3): building, built (with the site's address when the host gives one) or failed (with the host's link to why), as the host's own checks, statuses and deployments report the latest commit. Fjord configures nothing and builds nothing. It needs the token to read _Checks_, _Commit statuses_ and _Deployments_; without them the page says so and the rest is unchanged. `Provider` gains `getBuildStatus`, and GitHub's recorded answers (`scripts/record-github-fixtures.mjs --additions`) include a commit's.
- **A site opens on its posts** (ROADMAP 3c.2): a repository of the kind `ssg` shows its posts newest first, drafts marked, with _New post_. A post is a Markdown file put where the site's engine reads it, with what it reads: Astro's `content/posts/<title>.md` (a draft has `draft: true`), Jekyll's `content/_posts/YYYY-MM-DD-<title>.md`, whose name is a rule and uses the writer's own day, or `content/_drafts/<title>.md`. Both are decided by `fjord-core`. Jekyll refuses a tag with a space, which it would read as two (`422 bad_tag`, on any note of that site).
- **A journal's timeline** (ROADMAP 3b.2, and 3b.3's tag list and filter): a journal opens on its entries, newest first under the day each is about, with title, tags and the start of the text, paged. An entry is placed by its `date`, else its path, else its `created`, so a moved one keeps its place, and one whose `date` is not a date says so (W606). A plaintext journal's timeline is arranged on the server and reads each entry from the git host once per version (`journal_entry`, a derived table in both dialects); an encrypted one's is built in the browser from what it decrypts, and nothing of it is sent to the server or stored. Tags are listed with their counts and narrow the timeline, with a range of days, case aside and nested by `/` (spec §8.1).
- **A journal opens on _New entry_** (ROADMAP 3b.1): an entry is a note dated now in the writer's own time (`date` keeps the offset, spec §8.1), filed by `fjord-core` at `YYYY/MM/DD/HHMM-title.md` in a plaintext journal (`POST /api/connections/<id>/files/entry`), or written and encrypted in the browser, with no dated folder and nothing of it but ciphertext sent, in an encrypted one. The properties panel sets or takes away any note's `date`; the file is not moved.
- **Setting a repository up offers a kind, and a kind can be changed** (ROADMAP 3a.3): a repository that is not a Fjord repository can be set up as a drive (as before), a journal (plaintext, or encrypted to this browser's key) or an Astro or Jekyll site, each previewed and made by `fjord-core` in one commit that writes over nothing of the repository's own; a Fjord repository's kind is changed from its page (`PUT /api/connections/<id>/kind`), one commit of `fjord.json`, refused with the reason when the repository does not keep the new kind's rules.
- **A repository opens as its kind** (ROADMAP 3a.1, 3a.2; RFC 0001): what `/repo/<connection>` and `/` open on is chosen by the repository's `kind` (spec §3.1), through a module per kind (`src/kinds/`). A drive, and every repository made before kinds, opens on its vaults exactly as before; a kind this build has no module for opens as a drive, and any other kind offers _Show files_ (`?view=files`).
- **Signing out at a Sovereign instance signs the person out of Fjord Web, and deleting their account there deletes theirs.** The instance tells
  each app it signed them in to; `sovereign.manifest.json` now names the two addresses, `/api/sovereign/backchannel-logout` and
  `/api/sovereign/account-deleted`, and they check the signed notice with `@sovereignfs/sdk`. Every session of the person ends. A deletion removes everything held
  of them (repositories and their credentials, shares, drafts, comments on their own documents, sessions, sign-ins, the account itself, even a local
  password or passkey it had), their replies on other people's documents, and their name from those documents' logs; a thread of theirs that others answered
  stays with its first comment replaced. Nothing in a git repository is touched. [`deploy/README.md`](deploy/README.md#hosted-on-a-sovereign-instance) says
  what an operator sees. **`@sovereignfs/sdk` 2.1.0 is the first release with what this needs; `package.json` names it, and `pnpm-lock.yaml` cannot until it is published.**
- **A Sovereign instance can host Fjord Web.** `sovereign.manifest.json`, at the root of the app, is the manifest an instance's `sv app add` reads
  (manifest 2: the sign-in address and scopes, the health route, the icon, a database, the secret to make, the core versions), and the image carries it as
  its `io.github.sovereignfs.app-manifest` label, so that it can be read from the registry without pulling. [`deploy/README.md`](deploy/README.md#hosted-on-a-sovereign-instance) says what an operator sets, `FJORD_AUTH_SIGNUP: open` first.
  A fourth check in `scripts/deploy-check.sh`, `sovereign`, gives the image what an instance gives an app and checks that it listens on the
  `PORT` it is given, offers Sovereign and no password, serves its icon to someone with no session and stops on SIGTERM in seconds.

### Changed

- **A document's address is `/d/<id>` and a note's is `/n/<id>`**, shortened from `/doc/<id>` and `/note/<id>`. The comments, the guest edit route and a share link's cookie are under `/d/<id>` too, and the share link `POST …/links` makes is `/d/<id>?token=…`. **The old addresses still work:** `/doc/<id>` and `/note/<id>` are sent on to the new ones for good, and a share link given before this (`/doc/<id>?token=…`) still opens the document and ends on `/d/<id>`. A reader who held a link's cookie when this was installed is not sent it at the new address and opens their link again. If your proxy's access log is kept clean of tokens by a pattern on `/doc/`, add `/d/` (`deploy/README.md`).

- **Building the image needs the port, which `sovereign.manifest.json` now writes and nothing else does.** The image is built with
  `eval "docker build -f clients/web/Dockerfile $(node clients/web/scripts/manifest.mjs docker-args) -t fjord-web ."`, which gives it the
  port and its label; a plain `docker build` stops at once and prints that command. The Compose files, which build from a checkout, pass the
  port themselves (a test holds it to the manifest); the published image is unchanged to anyone who pulls it. The image's health check reads
  `PORT`, with no number of its own.
- **Every setting starts `FJORD_`, with the names of Sovereign's environment convention** (`contracts/env.md` in
  sovereignfs/sovereign), so that a Sovereign instance can host Fjord Web with the variables it gives every app, and an
  operator can set the rest in its `suite.yml`. The database is `FJORD_DB_DIALECT` (`sqld`, the default; `sqlite`, a
  file; or `postgres`) with `FJORD_SQLD_URL` and `FJORD_SQLD_ADMIN_URL`, `FJORD_SQLITE_URL`, or `FJORD_POSTGRES_URL`
  and `FJORD_POSTGRES_POOL_MAX`. The PostgreSQL address is now a secret that can come from a file
  (`FJORD_POSTGRES_URL_FILE`). Email is `FJORD_SMTP_*`. Sovereign sign-in is `FJORD_CORE_URL` (the core's address, its
  issuer), `FJORD_CORE_CLIENT_ID` and `FJORD_CORE_CLIENT_SECRET`. **Not breaking:** the old names (`DB_DIALECT`,
  `SQLITE_URL`, `SQLD_ADMIN_URL`, `POSTGRES_DB_URL`, `POSTGRES_POOL_MAX`, `SMTP_*`, `FJORD_AUTH_SOVEREIGN_*`) still work,
  and the server lists the ones it read at start-up; an old name set beside its new one stops the server. The compose
  files in `deploy/` use the new names.

## [0.1.0] - 2026-11-01

### Security

- **The frontmatter parser is safe Rust** (the format module): the library behind it was replaced, so a document header from outside is read by code that forbids `unsafe` and limits what an alias can expand to. A header that cannot be kept exactly (a key given twice, a YAML tag, a whole number too large to be one) is shown as the file it is and is not rewritten. The headers the page writes now quote text and timestamps (`created: "2026-10-16T09:34:00Z"`), so the first title change or promotion of a file re-quotes those lines; nothing else about them changes. The module is 1.3 MB (495 KB compressed), up from 980 KB.
- **Review of phase 2** ([`docs/security-review-phase-2.md`](../../docs/security-review-phase-2.md), ROADMAP 2c.2): four defects fixed. _Put back_ can no longer write plain text into an encrypted vault (or ciphertext into a plaintext or another encrypted one); a password-sealed link cannot ask your browser for more than age's default work to open it; an API call can no longer delete or move an encrypted vault's recipients file or guard; and a decrypted file larger than 1 MB is not put in an editor. The page now says how many recipients a file is encrypted to.

- **`@sovereignfs/ui` 0.89.1** (from 0.83.1).

### Added

- **Commit messages that say what changed** (ROADMAP 2e.1): `Edit “Q4 plan” (+4 −3)`, then the path, lines and words, and the sections that changed; a new file, a deletion, a move, a restore and a transfer say where and how many files; a version made after a quiet period says so. What the person wrote as a message stays first. An encrypted file's message says that it changed and nothing of what changed. The commits you already have are not rewritten.
- **The release publishes the container image** (ROADMAP 1a.12): a `web-v*` tag builds `ghcr.io/sovereignfs/fjord-web:X.Y.Z` (also `:X.Y` and `:latest`) for `linux/amd64` and `linux/arm64`, attests where it was built, pulls the published image and brings it up as an operator would, and only then publishes the release page. See `RELEASING.md`.
- **Versions mean something** (`RELEASING.md` § Fjord Web versions): a patch release carries no migration and no setting change, and `scripts/release.sh` refuses one that has a migration; a migration that was released is never edited or removed. `deploy/README.md` § Updating now says how to pin a version, what to read and back up first, that migrations run before the server serves and only go forward, and that going back to an older minor is restoring the backup taken before.
- **Add a vault** (ROADMAP 2d.1): _Add a vault_ on a Fjord repository's page makes a plaintext or an encrypted vault in one commit: a name, how the files are named, and the public keys (yours is put in), with the list of files shown first. The files are the ones `fjord vault add` writes, from the same planner in `fjord-core`; `.gitattributes` gains the merge guard if an encrypted vault is added to a repository that lacks it. An encrypted vault is added only with a key, so it can be written to at once. New API: `POST /api/connections/<id>/vaults`.
- **A written-down house style for documents, and a preview before it reformats anything** (ROADMAP 1b.4): the visual editor writes `-` bullets, `*italic*` and `**bold**`, `---` rules, `1.` on every numbered item, fenced code and compact tables, and a document already written that way is edited line for line. When you open a document written another way (Obsidian's `*` bullets, underlined headings, aligned tables), the page tells you how many lines editing it here would change, lists them, and waits: you choose _Reformat and edit here_ or _Edit as Markdown, unchanged_, which edits it byte for byte. Nothing is reformatted until you choose.

- **Share an encrypted file by a sealed link** (ROADMAP 2c.1): on an open encrypted file, _Make a sealed link_ encrypts a copy in your browser, either to a key that lives only in the link (after the `#`, which is never sent to a server) or to a password you tell the reader. The server keeps the sealed copy and serves it to the link, and cannot read it; the link opens in any browser, read-only, with no account. Revoking a link deletes its copy. A sealed link is a snapshot of the file as it was, and has no comments yet.

- **Move a file into, out of and between encrypted vaults** (ROADMAP 2b.6): _Move to another vault_ on a file's page. Into an encrypted vault the file is encrypted in your browser to that vault's recipients; out of one it is decrypted in your browser, after the page tells you it will be committed as plain text; between two it is decrypted and encrypted again. The server, which has no key, takes the old file away and adds the bytes your browser made in one commit, and refuses plain text for an encrypted vault. The plain text of a file moved in stays in the repository's earlier commits. Text files only for now.

- **Rename, move and delete in encrypted vaults** (ROADMAP 2b.5): files and folders of an encrypted vault are renamed, moved and deleted, and Undo and _Recently deleted_ put them back, all with no key on the server, which moves the encrypted bytes as they are. A rename keeps what a file is (`Plan.md.age` stays a note). In a vault that names its files by id, a file keeps its identifier and is renamed by the name kept inside it, from its own page once it is open. Between vaults is not possible yet.

- **New notes and documents in encrypted vaults** (ROADMAP 2b.4): _New note_ and _New document_ now work in an encrypted vault. The file is written and encrypted in your browser, to the vault's recipients, and only the ciphertext is sent, so it works with your identity locked. In a vault that names its files by their names, the title names the file (that is public, as every name there is); in a vault that names them by id, the file is a new identifier and its real name is inside it, and the title is not sent. The server accepts only an age-encrypted file, and `fjord verify` accepts what is made.

- **Encrypted files can be edited in the browser** (ROADMAP 2b.3): what you type in a file of an encrypted vault is encrypted in your browser, to the vault's recipients, before each send, so the draft the server keeps is ciphertext and the server never has the text. _Save version_ commits those bytes as they are, and so does the five-minute idle version, with no key on the server; the CLI opens what the browser saved. Typing keeps your identity unlocked. If the file changed in the repository meanwhile, you keep yours or take theirs: the server cannot combine two files it cannot read. The server refuses to keep or commit anything for an encrypted vault that does not begin as an age file.

- **Encrypted files open in the browser** (ROADMAP 2b.1, 2b.2): a file in an encrypted vault is a link with a lock. Its page asks for your identity's passphrase (or sends you to _Keys_ to make or bring one), fetches the stored bytes, and decrypts them in your browser, in vaults named by file name and in vaults named by id (whose real names are inside). The server never has a key and sends nothing decrypted; a file for another key says so and shows nothing.

- **An encryption identity kept in your browser** (ROADMAP 2a.1, 2a.2): _Keys_ in the header makes an age identity, or takes the one you have, and keeps it sealed with a passphrase in this browser only; nothing about it is sent to the server. It is opened into memory by the passphrase, and locks after fifteen minutes without use. The page may now compile WebAssembly (`'wasm-unsafe-eval'` in the script policy, and nothing broader) to do it: the format module is served from `/fjord-wasm/`. Reading and writing encrypted files comes next.

- **A repository the GitHub App loses is disconnected** (ROADMAP 1a.6): when GitHub says an installation was deleted or repositories were removed from it, the connections through the App to them end, as if each person had disconnected it. A connection made with a token is left alone.

- **Connect repositories through a GitHub App** (ROADMAP 1a.6): _Install on GitHub_ on Repositories, choose the repositories there, and they are connected, with no token to make or keep. Fjord asks GitHub for a short-lived token when it needs one. Only the repositories the signed-in person can reach themselves are connected, shown by their own one-use authorisation, and only by a trip this browser started. The operator registers the App and sets `FJORD_GITHUB_APP_ID`, `_SLUG`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_WEBHOOK_SECRET` and `_PRIVATE_KEY` (all or none; see `deploy/README.md`). A signed `push` webhook at `/api/webhooks/github` forgets the cached trees of the repository. Connecting with a token still works beside it.

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
  skipped, and with no usable `fjord.json` it is the first found). The page marks it _Opens first_, shows its top
  under the list of vaults, and offers _Open this one first_ on the others. The choice is stored per connection
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
  between repositories and _Make this my default_ (`POST /api/connections/<id>/default`, signed in,
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

[Unreleased]: https://github.com/sovereignfs/fjord/compare/web-v0.3.0...HEAD
[0.3.0]: https://github.com/sovereignfs/fjord/compare/web-v0.2.0...web-v0.3.0
[0.2.0]: https://github.com/sovereignfs/fjord/compare/web-v0.1.0...web-v0.2.0
[0.1.0]: https://github.com/sovereignfs/fjord/releases/tag/web-v0.1.0
