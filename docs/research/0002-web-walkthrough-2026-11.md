# 0002: a full run of Fjord Web, by hand

**What was run, and when.** 2026-11-04 and 05, at `1b724c1`: the production build (`next build`, `next start`) on a file
database of its own, with local sign-in, open sign-up, an encryption key and a git-backed fake of GitHub
(`src/providers/testing/fake-github.ts`) holding five repositories. Two accounts and a stranger in real Chromium, at
1280 by 860 and at phone width, in light and dark. Not run: real GitHub, Sovereign sign-in, passkeys, two-factor and email
(the browser tests hold those), and PostgreSQL or sqld. The unit suite was green throughout (2813 passed, 39 skipped).

**What held.** Every way of being refused worked and said why: a read-only token, a token that was wrong, an address that
was wrong, an empty repository. A second account got a 404 on everything not shared with it, a stranger got sign-in, a
write from another origin got a 403. Comments arrived live. A conflict with an upstream change kept both sides. A shared
editor's changes waited for the owner and were credited by name. Unpublishing and a page's password worked. `.git`
as a vault name was refused. An encrypted file reached the repository as `age` ciphertext. Nothing overflowed at phone
width but the account page.

## Bugs

| # | What happens | Status |
| --- | --- | --- |
| B1 | A document typed in the visual editor is told, when opened again, that it is "not written the way Fjord writes Markdown", and cannot be edited until a choice is made. An empty paragraph (Enter at the end of a heading) is written as a run of blank lines, which reads back as something to reformat | Fixed |
| B2 | A new folder named `.git` answers 500 and "Something went wrong on our side" | Fixed |
| B3 | A slash in *File name* quietly makes a folder and moves the file into it; a name ending in a dot or starting with one is taken though the form's own words forbid it | Fixed |
| B4 | Saving a version of an encrypted file reloads the page, which drops the unlocked identity: the passphrase is asked for after every save | Fixed |
| B5 | A signed-out person who follows a link to a document signs in and lands on their default repository, not on the document | Fixed |
| B6 | Sharing with your own address says *Done*, and does nothing | Fixed |
| B7 | Setting up a site where `content/` exists says "Choose another name", on a form with no name to choose | Fixed |
| B8 | A new vault's `recipients.txt` says it is for "the Private vault", whatever the vault is, and its instructions name that directory | Fixed |
| B9 | `crates/fjord-wasm/Cargo.lock` still has `fjord-core` 0.4.0: the release of 0.5.0 did not touch it, so `cargo clippy --locked` there fails | Fixed |
| B10 | A title with `<b>` in it makes a new document open in the Markdown fallback, for the raw HTML in its own first line | Fixed |
| B11 | The landing page says connecting a repository and the editor "are not available yet", and the README that "there is nothing to use yet" | Fixed |
| B12 | Words meant for the API reach people: `Say which folder of the vault, by its path, or "" for its top.`, `Say where it goes, by a path in the repository.`, `(spec §2.3)` | Fixed |
| B13 | Every repository page's tab is called "Repository · Fjord" | Fixed |
| B14 | A repository on the server is `local/Scratch drive` in its path | Fixed |
| B15 | The account page runs 12 px off a phone's screen | Fixed |

## UI and UX

| # | What is in the way | Status |
| --- | --- | --- |
| U1 | A document page has five bands before the text: a permanent notice, the address, up to one more notice, properties, and a large *Comment on selection*. On a phone the text starts below the fold | Fixed |
| U2 | *Comment on selection* opens its form at the foot of the page, out of sight on any long document, and stays grey with no reason on a selection across formatting | Fixed |
| U3 | A new journal entry is headed by the name of its file (`00-03`), on its page and beside its time in the timeline. (A note's actions under *More* are the writing view's design, and stay.) | Fixed |
| U4 | *Disconnect*, *Delete* and *Move to git* ask with the browser's own `confirm`, where everything else asks in the page, and *Move to git* ends with no word that it worked | Fixed |
| U5 | Repository settings has no title, three sizes of text and a button in two lines | Fixed |
| U6 | Dates come in three forms (`11/4/2026, 11:59:47 PM`, `4 Nov 2026`, `2026-11-04 22:56 UTC`) | Fixed |
| U7 | "1 comment thread" sits above "Comments 1 open" | Fixed |

## Gaps

| # | What is missing | Status |
| --- | --- | --- |
| G1 | A file that is not Markdown or HTML (a picture, a PDF, a CSV) is greyed out: it cannot be opened, downloaded, moved or deleted from a drive | Fixed |
| G2 | The first page of someone with no repository says nothing of what is shared with them | Fixed |
| G3 | An account cannot be deleted by the person who holds it; only a Sovereign notice does that | Fixed |
| G4 | An address cannot be changed ("Email changes aren't supported yet") | Open |
| G5 | A comment cannot be made on a selection across formatting: the anchor is a quote of the Markdown and the marks are drawn from it. Saying so is U2; doing it needs the anchor to change | Open |
| G6 | An encrypted file is edited as Markdown with its header showing: no visual editor, no properties panel | Open |
| G7 | There is no history of a document in the app: a version is a commit, read and rolled back with git. The landing page said otherwise (B11) | Open |
