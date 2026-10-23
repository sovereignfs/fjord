# Fjord Web — design

**Status:** draft, written during the brainstorming and documentation phase
(2026-10-22). Nothing here is implemented. Where this file and
[`spec/SPEC.md`](../../spec/SPEC.md) disagree, the spec wins: this is the design
of one client, and the spec is the format every client follows.

[`ROADMAP.md`](ROADMAP.md) turns this into phases and tasks.

---

## 1. Purpose

Fjord is a way to keep your own simple cloud: files in a Git repository you
control, with optional end-to-end encryption, readable without Fjord. **Fjord Web**
is the hosted application that makes that usable in a browser, and the first step
towards a worthy alternative to Google Docs (and later Google Sheets).

What it must not give up, whatever the convenience:

- **The files stay plain.** A document edited in Fjord Web is a Markdown file in the
  user's repository that GitHub renders, Obsidian opens and `git diff` reads.
- **Git is the storage.** Fjord Web never keeps the authoritative copy of a
  document; the repository does. What the server keeps is state *about* files:
  connections, shares, comments, and drafts not yet committed.
- **Encrypted means the operator cannot read it.** When encrypted files arrive
  (phase 2), they are decrypted in the browser. The age identity never reaches the
  server.
- **One implementation of the format.** Fjord Web uses `fjord-core`, compiled to
  WebAssembly, for everything the spec defines. It never reimplements the format
  (root `CLAUDE.md`, "Adding a component").

## 2. Phases

| Phase | What it delivers |
| --- | --- |
| **1** | Accounts, GitHub repositories, a file browser, editors for **plaintext** documents and notes, renaming, moving and deleting them, versions as commits, sharing, and collaborative **comments**. |
| **2** | Encrypted files: browse, open and edit documents in encrypted vaults, decrypted in the browser; sealed shares of encrypted documents. |
| **3** | Collaborative **editing** in real time. |
| Later | Other git hosts (GitLab, Forgejo/Gitea, any git server), Sheets, search, notifications, the desktop and mobile clients and editor plugins reusing the editor package. |

Phase 1 ships in slices (§16), each usable on its own.

## 3. User journeys

1. **A visitor** opens `fjord.sovereign.fs` and sees the landing page: what Fjord
   is, why, and its features, with sign-in and sign-up.
2. **Signing up or in** uses whichever methods the instance enables (§6): email and
   password with passkeys and an authenticator app, and/or "Continue with
   Sovereign".
3. **The first time**, the user is asked to add a repository (§7): install the
   GitHub App and pick repositories, or give a repository URL and a fine-grained
   token. More can be added later. The first one added is the default repository,
   and each repository has a default vault.
4. **Each visit after that**, `/` is the default repository's view: its vaults, as
   in a file manager. The user switches repository from the header.
5. **Browsing** shows names, paths and sizes only, nothing downloaded (§8).
   Documents and notes are clearly openable; other files are shown greyed out.
   Encrypted vaults show a lock and are not openable yet (phase 2).
6. **Opening** a document (`name.fj.md`) goes to `/d/<id>` and the document editor;
   opening a note (any other `.md`) goes to `/n/<id>` and the note editor (§9, §10).
7. **Editing** saves continuously to a working copy on the server; a version (a git
   commit) is made on "Save version" or after a quiet period (§11).
   **Renaming, moving and deleting** a document, note or folder is one commit each;
   a deletion can be undone or restored later (§8).
8. **Sharing** a document: publicly by link, by link with a password, or with named
   users of the instance; each as view, comment or edit (§12).
9. **Comments**: anyone with comment or edit access can select text, comment, reply
   and resolve, and sees others' comments as they arrive (§13).
10. **Someone opening a shared link** sees the document; if the link allows editing
    they can switch to edit mode, and are asked for a display name first if they
    are not signed in.

## 4. Terminology

| Term | Meaning |
| --- | --- |
| **Instance** | One deployment of Fjord Web, such as `fjord.sovereign.fs`. |
| **Account** | A user of an instance. |
| **Connection** | An account's link to one repository through a provider (§7). |
| **Default repository / vault** | Where `/` lands, per account; and which vault opens first, per connection. |
| **Document** | A file named `*.fj.md`: a long-form Fjord Doc, edited in the document editor. |
| **Note** | Any other `.md` file in a vault: a short text, edited in the note editor. |
| **Working copy** | The server-side draft of a file being edited, not yet committed. |
| **Version** | A commit that changed the file. |
| **Share** | Access to one document granted by its owner: to named users, or by link. |
| **Owner** | The account whose connection the document is reached through. |

## 5. Architecture

```
            browser                                   server (one image, two processes)
 ┌────────────────────────────┐               ┌────────────────────────────────────────┐
 │ Next.js pages (React 19)   │  HTTPS / SSE  │ web:    Next.js routes, auth, API       │
 │ @sovereignfs/ui            │ ────────────▶ │ worker: idle commits, webhook jobs,     │
 │ fjord-editor (doc, note)   │               │         indexing                        │
 │ fjord-core (WASM) phase 2: │               │ fjord-core (WASM, in Node)              │
 │   decrypt / encrypt        │               │ provider: GitHub (App + PAT)            │
 └────────────────────────────┘               └───────────┬───────────────┬────────────┘
                                                          │               │
                                            SQLite (sqld or file)   GitHub REST API
                                             or PostgreSQL (§14)    (+ webhooks in)
```

- **Next.js with React 19**, to match `@sovereignfs/ui` (React 19 peer dependency)
  and the stack Sovereign itself uses.
- **A long-running server, not serverless.** Idle commits and webhook processing are
  background work. Default deployment is the same as Sovereign's: Docker on a VPS,
  one image run as a `web` and a `worker` process.
- **SQLite by default, in production too, and PostgreSQL if the operator prefers**,
  following Sovereign's pattern and planned for from the start (§14).
- **The server talks to GitHub**, not the browser: no CORS problems, and provider
  credentials never reach the browser.
- **`fjord-core` runs as WebAssembly in both places.** In Node for phase 1
  (frontmatter, ids, path rules, vault discovery, manifests); also in the browser
  from phase 2 (age encryption and the tar container). One artifact, one
  implementation.

### What runs where

| Concern | Browser | Server |
| --- | --- | --- |
| Rendering, editing, comment UI | ✓ | |
| Frontmatter parse and preserve | | ✓ (`fjord-core`) |
| Talking to GitHub, holding its credentials | | ✓ |
| Working copies, commits, conflict detection | | ✓ |
| Shares, permissions, comments | | ✓ |
| Decryption and encryption (phase 2) | ✓ (`fjord-core`) | never |

## 6. Authentication

Built on **better-auth**, the library Sovereign's own auth server uses, with the
same plugins. Which methods are offered is set by environment variables, so an
instance can run either or both:

| Method | Enabled by | Notes |
| --- | --- | --- |
| **Local**: email and password, plus passkeys and TOTP | `FJORD_AUTH_LOCAL=1` | better-auth email/password, `@better-auth/passkey`, `twoFactor` (authenticator app and backup codes). |
| **Sovereign** | `FJORD_AUTH_SOVEREIGN_ISSUER`, `…_CLIENT_ID`, `…_CLIENT_SECRET` | OIDC against a Sovereign instance's external OAuth/OIDC provider (Sovereign RFC 0072): authorization code flow, the client registered by that instance's admin with an exact redirect URI. Claims used: `sub`, `email`, `name`. |

- **Reuse from Sovereign.** The shared logic *is* better-auth, so Fjord Web uses it
  directly rather than calling into Sovereign's code. The sign-in, sign-up and
  enrolment screens are copied from Sovereign first, and extracted into a shared
  package once both apps use them and they have stopped changing.
### Local sign-in, as built (ROADMAP 1a.2)

- **better-auth 1.7**, through its Drizzle adapter, in the auth store (`fjord_auth`, §14), with
  its own migrations (`migrations/auth/`) and a record of what ran apart from the app's. 1.7
  rather than the 1.6 line Sovereign runs: it is current, it has no account-identity migration
  to face later, and its rewritten OIDC client is what 1a.3 needs. The tables are better-auth's
  (`user`, `session`, `account`, `verification`, `two_factor`, `passkey`, `rate_limit`), with its
  dates as real `Date`s and not our epoch milliseconds.
- **Off unless `FJORD_AUTH_LOCAL` is set**, and then off entirely: `/sign-in`, `/sign-up` and
  everything under `/api/auth` answer 404, as if they did not exist, and the server refuses to
  start on a setting that is wrong (a short secret, a non-https `FJORD_URL`, an SMTP host with
  no sender). Needs `FJORD_URL` (the address people use, from which the passkey origin and the
  links in email are made) and `FJORD_AUTH_SECRET` (32 characters or more; `_FILE` supported).
- **Who may sign up** is `FJORD_AUTH_SIGNUP`: `closed` (the default), where the first account is
  made and then sign-up is refused, by the server and not only hidden by the page; or `open`.
  Secure by default: a self-hoster who forgets is not an open registration.
- **Email is optional.** With `SMTP_*` set, an address must be verified before first sign-in
  (following the link signs the person in), and a forgotten password is reset by a mailed,
  single-use link that also ends every session. Without it, sign-up is immediate and there is no
  reset by email: no screen offers one and the endpoint is disabled. Sovereign's mailer is not
  published, so Fjord has its own small one (nodemailer), behind an interface a test can read.
- **Two-factor** is an authenticator app (QR code and a key to type) with ten single-use backup
  codes, turned on only once a code has been shown to work; each change asks for the password
  again. **Passkeys** can be added, named and removed, and sign a person in without a password.
  Both are from better-auth's plugins.
- **At `/`**, a signed-in person sees `/home` (a placeholder until repositories, ROADMAP 1a.9) by
  a rewrite in `proxy.ts`, so the address does not change and the landing page stays static for
  everyone else. The proxy only looks for a session cookie; the page checks the session.
- **Not yet:** deleting an account, listing and ending individual sessions, trusted devices,
  changing the email address.

- **A Sovereign account is identity, not authorization.** As Sovereign's own docs
  say of its OIDC clients, Fjord Web decides what an account may do.
- **When both methods are on**, an account is matched to a Sovereign login by `sub`,
  never by email alone. Linking an existing local account to Sovereign is done
  from a signed-in session, and only when the two use the same email address
  (as built below).

### Sovereign sign-in, as built (ROADMAP 1a.3)

- **Registered by the Sovereign instance's admin** (Console, External clients; no dynamic
  registration): redirect URI exactly `<FJORD_URL>/api/auth/callback/sovereign`, scopes `openid
  profile email`. Fjord Web holds the client id and secret (`FJORD_AUTH_SOVEREIGN_*`, the secret
  from a file if wanted); all three or none, and a partial set stops the server at start-up.
- **better-auth's `genericOAuth`** with the issuer's discovery document: authorization code with
  PKCE S256, the secret sent by basic auth, a `nonce` bound to the request. The ID token (EdDSA
  on Sovereign) must verify against the keys the document points to, and a document without
  them means no Sovereign sign-in at all (`requireIdTokenVerification`), not unchecked tokens.
  If Sovereign cannot be reached at start-up the instance still starts, and the button works
  once it can be.
- **Identity is the `sub`**, stored as the account id; `email` and `name` are copied when the
  account is made (a missing name becomes the part of the email before the `@`) and not
  overwritten on later sign-ins. A change of email at Sovereign does not change who someone is.
- **No implicit linking.** A Sovereign login whose email is a local account's is refused
  (`account_not_linked`, a message on the sign-in page), whether or not that address is
  confirmed, until the person links the two from a signed-in session (below). A Sovereign-only
  person has no password, two-factor or passkeys, so those settings (`/account/security`) answer
  404 on an instance with only Sovereign on.
- **Linking (ROADMAP 1a.4), when both methods are on.** On `/account/security` a signed-in person can
  *Link Sovereign*: they go to Sovereign and back, and Sovereign's `sub` is attached to **this**
  account. The rules are the server's, and each is tested:
  - **Only from a signed-in session**, so linking is something a person who has shown they control the
    account does. Nothing links by email at sign-in; an unlinked Sovereign login whose address is a
    local account's is refused with a message that says to link from the security page.
  - **Only when Sovereign's email address is the account's own** (case aside). A link with a different
    address would attach someone else's identity to this account; it is refused, with the reason and
    without naming either address, and nothing is linked. (Decided: the same address on both.)
  - **Sovereign is trusted to have verified its address** (its contract: `email` is verified), so a token
    that omits `email_verified` does not stop a link. That trust is for linking only: it never turns on
    implicit linking.
  - **An already-linked Sovereign identity** cannot be linked to a second account.
  - **Unlinking** is a fresh-session action and can never remove an account's last way to sign in: an
    account that came in through Sovereign has no password and cannot unlink it (the button says why).
    Unlinking a local account's Sovereign means the same address is refused at sign-in again.
  - After linking, signing in through Sovereign signs in the **local** account, by `sub`, whatever
    Sovereign's address or name later become; the account keeps its own name and email.
  - **Two-factor is Fjord's password's, not Sovereign's.** A person with Fjord two-factor on who links
    Sovereign is not asked for the Fjord code when they sign in through it: Sovereign has its own, and
    the page says so beside the button. (Making Sovereign sign-in ask for it would mean treating
    Sovereign as a first factor only; not done.)
  - **The page for an account that came in through Sovereign** has no password, two-factor or passkey
    sections (they would not work: two-factor asks for the password) and says so; the Sovereign section
    shows it linked, with *Unlink* disabled. Adding a password to such an account is later work.
- **Sign-up policy is one policy.** `FJORD_AUTH_SIGNUP=closed` refuses a second Sovereign person
  as it refuses a second local one, in the server's user-creation hook; the refusal carries a
  code (`SIGNUP_CLOSED`) so that the person is sent back to the sign-in page with the reason and
  not shown bare JSON.
- **Signing out is local.** `disableProviderLogout`: a person's Sovereign session is theirs, for
  other things as well, and ending Fjord's does not end it.
- **Tokens at rest.** The access and ID tokens Sovereign hands over are not used after sign-in;
  what better-auth stores is encrypted (`encryptOAuthTokens`). Credentials for repositories are a
  separate matter (ROADMAP 1a.8).
- **Tested against a fake that is checked against a real one.** `src/auth/testing/fake-sovereign.ts`
  is a strict OIDC provider (exact redirect, PKCE, client secret, single-use codes, EdDSA tokens)
  that the tests, and the browser tests as a process of its own, sign in through; and
  `sovereign-discovery.test.ts` ties its discovery document to a recording of a real instance's
  (`node scripts/record-sovereign-discovery.mjs`).

## 7. Repository connections

A **provider** interface, so GitHub is the first implementation and not an
assumption:

- list the repositories the connection can reach;
- read a branch's head and its full tree listing (paths, sizes, blob ids);
- read one blob;
- commit several file changes atomically on top of a known head;
- receive change notifications (webhooks), or poll where a host has none.

**GitHub, two ways in:**

1. **The GitHub App** (preferred). The user installs it and picks repositories;
   the App asks for *Contents: read and write* and *Metadata: read* only. Fjord Web
   uses short-lived tokens, and receives `push` webhooks. A GitHub App is used
   rather than "Sign in with GitHub" OAuth because an OAuth App's `repo` scope
   reaches every private repository the user has.
2. **A repository URL and a fine-grained personal access token**, limited to that
   repository with *Contents: read and write*. Its permissions are checked when it
   is added.

### The provider interface, as built (ROADMAP 1a.5)

Everything the app asks of a git host goes through `Provider` (`src/providers/types.ts`); nothing
else imports a host's HTTP client. Everything is by git object id, so a result never changes under
its reader: the tree read for a commit is that commit's tree for ever, which is what the cache of
§8 relies on.

- **Reading:** `listRepositories`, `getRepository`, `canWrite` (below), `getHead` (with an etag, so a poll that finds
  nothing new costs no rate limit), `getTree` (every path with its size and id, in one request,
  and `complete: false` when the host cut it short), `listDirectory` (the fallback for that, one
  directory at a time), `readBlob` (bytes, with a size limit).
- **Writing:** `commit(ref, { branch, expectedHead, message, author, changes })`: several file
  changes as one commit, on top of the head the caller read. It is made the way git makes one
  (blobs, a tree on the head's, a commit, then a fast-forward of the branch), so it is atomic.
  **It is never forced.** A branch that has moved gives `head_moved` and writes nothing to the
  branch; the early look makes that cost one request, and the host's own fast-forward rule is the
  real guarantee for the race after it. A commit that would change nothing gives `no_changes`, so
  an idle save makes no empty commit. A move is a blob put at a new path (nothing re-uploaded) and a
  delete. A folder is changed by changing each of its files; the caller has the tree.
- **`canWrite(ref, branch)` finds out by trying something that changes nothing**: it points the
  branch at the commit it is already on, never forced, which needs the same permission as a real
  commit's last step. A repository's reported permissions are not enough for this (a fine-grained
  token's grants are not what the repository says about its user), and the host's own refusal is the
  only answer to trust. `false` is "can read, cannot write"; a rejected token or a branch that is not
  there throws as it does anywhere else.
- **Paths are checked by every provider**: nothing may write `.git/…`, `..`, an absolute path or
  a duplicate. (The format's own path rules, spec §5, are `fjord-core`'s and are applied before a
  commit is built.)
- **Errors are ours, not the host's**: `unauthorized`, `forbidden`, `not_found`,
  `empty_repository`, `head_moved`, `no_changes`, `too_large`, `rate_limited` (with when to try
  again), `unavailable`, `invalid_request`, `invalid_webhook`. An error never carries a credential.
- **Retries:** a read is tried again after a network failure or a 502, 503 or 504, twice. A write
  never is: a commit whose answer was lost may have happened, and sending it again is how a history
  gets a duplicate. The caller reads the head and decides.
- **Webhooks:** `verifyWebhook` checks `X-Hub-Signature-256` (HMAC-SHA256 over the exact body, in
  constant time) before reading a byte of it, and reports a push to a branch. A host without
  webhooks says so (`webhooks: false`) and is polled with `getHead`.
- **Tested three ways, against one contract** (`src/providers/testing/contract.ts`): GitHub's
  provider over a fake whose storage is a **real git repository** (object ids, trees and the
  fast-forward rule are git's, not my belief about git's), the in-memory provider (the second
  implementation, which the rest of the app is tested against), and GitHub's **real answers**,
  recorded from a public repository and replayed byte for byte, which also check that the fake
  emits the shapes GitHub does. `node scripts/record-github-fixtures.mjs` records them again, with
  no credential, to see whether GitHub's shapes have changed.

**Every credential is encrypted at rest** (envelope encryption with an instance key
from the environment; rotation is supported). Credentials are never sent to the
browser.

### Connecting a repository with a token, as built (ROADMAP 1a.7)

- **What a person does:** on `/repositories`, gives the repository's address (`https://github.com/o/r`,
  with or without `.git`, `git@github.com:o/r`, or `o/r`) and a fine-grained personal access token
  limited to that repository with *Contents: Read and write*. Only GitHub so far, and the address is
  refused with a reason if it is another host, a page inside a repository, or has a password in it.
- **Checked before anything is kept** (`src/connections/service.ts`), in the order a person would fix
  things: GitHub accepts the token; it can see the repository (the repository's own spelling is what is
  kept); the default branch has something in it (a branch that is not there is an empty repository, and
  is said to be: there is nothing to work on yet); it is not connected already; and the token can
  **write**, by `canWrite`. Each refusal is a message of ours saying what to do (“create the token with
  *Contents: Read and write*”), never GitHub's text, never the token. A token that fails leaves nothing
  behind, and neither does one whose connection could not be recorded.
- **A token that reaches more than it needs to** is accepted with a warning naming how many other
  repositories it can reach: the design's advice is a token for one repository, but a person's choice
  is theirs.
- **Kept encrypted:** the token goes to the credential store (§7, 1a.8) and the `connection` row holds
  its id, with the account, the repository (as GitHub spells it), the branch (the default branch when it
  was connected, DESIGN §19 #6) and when. `account_id` is better-auth's user id; that table is in the
  other store, so it is not a foreign key. One account cannot connect the same repository twice; two
  accounts can, each with a token of their own. Disconnecting deletes the connection and its token.
  The default flag and default vault are 1a.9's.
- **The API (`/api/connections`, `src/connections/http.ts`)** is where §12 is applied: nobody who is
  not signed in (401, before anything is read); a write must come from this instance's own pages, its
  `Origin` checked against `FJORD_URL`, so another site cannot make a signed-in person's browser
  connect a repository with a token it chose; an account sees and changes only its own connections, and
  another's is 404, as if it were not there; the token is in one request and in no response, log line
  or error. Without `FJORD_ENCRYPTION_KEY` the page says why it cannot connect and the API answers 503.
- **`FJORD_GITHUB_API_URL`** is where GitHub's API is when it is not github.com's (an Enterprise Server's
  `https://host/api/v3`, or a stand-in on localhost in the browser tests). Tokens are sent there, so it
  must be https, except on localhost.
- **Tested** against a GitHub whose storage is a real git repository (`FakeGitHub`) on all three
  databases, in a browser, and each safeguard switched off to see its test fail. Not yet tested against
  real GitHub with a real fine-grained token: the one thing assumed of it is that pointing a branch at
  its own head is accepted when the token can write and refused (403) when it cannot, which a first
  real connection confirms.

### Credentials at rest, as built (ROADMAP 1a.8)

- **Envelope encryption** (`src/crypto/`): a credential is encrypted in AES-256-GCM with a random
  data key of its own, and that data key is wrapped, also in AES-256-GCM, under the instance key.
  Node's `crypto` only: no dependency. Each encryption has a fresh random nonce.
- **Bound to where it lives.** The credential's id and purpose are in the authenticated data of
  both layers, and the wrapped key's also names the instance key. A sealed value copied onto
  another row, or given another purpose, is refused as corrupt and never decrypted for someone
  else. The id is random (not a counter) because the encryption is bound to it before the row
  exists.
- **The `credential` table** (both dialects, §14): `id`, `purpose`, `kek_id`, `wrapped_key`,
  `ciphertext`, `created_at`, `rewrapped_at`. Whatever stores a credential (a connection, 1a.6
  and 1a.7) holds its id. The server asks for the secret only where it is used; nothing returns
  it to the browser, and no error, log line or URL carries it.
- **The instance key** is `FJORD_ENCRYPTION_KEY` (or `_FILE`): 32 random bytes, base64 or hex.
  It is known by a fingerprint (a domain-separated SHA-256, 16 hex characters), so a stored
  credential says which key it needs without saying anything about the key. It is optional until
  something is stored: storing a credential without one is refused, with a message saying so.
- **Rotation is a restart.** Put the new key in `FJORD_ENCRYPTION_KEY` and the old in
  `FJORD_ENCRYPTION_KEY_PREVIOUS`; when the server starts it wraps every credential's data key
  under the new key (32 bytes each, the credentials untouched) and logs when the previous key
  can be removed. Credentials are readable throughout, from any replica; the update names the
  key it replaces, so two processes doing it at once is safe.
- **It refuses to start rather than lose a credential quietly:** with credentials stored and no
  key, or a key that some credentials were sealed under dropped from both settings, the server
  stops at start-up and names the fingerprints. A lost key means connecting the repositories
  again; the key belongs with secrets, not with database backups.
- **Not covered by this:** better-auth's own tokens (Sovereign's, §6) are encrypted with its own
  setting and are not used after sign-in; share-link tokens are hashes (§12).

**Defaults.** The first repository connected is the default; with two or more the
user can change it. Each connection has a default vault: the first vault listed in
`fjord.json` until the user picks another.

### First run and defaults, as built (ROADMAP 1a.9)

- **First run:** a signed-in account with no repository sees, at `/`, the one thing to do: connect its
  first (the form of §7's token connection, in place). With no instance key the same page says why it
  cannot. Without a repository there is nothing else to show.
- **The default repository** is where `/` lands. It is stored per account in `account_default` (one
  row, an account's id and a connection id, both dialects) and is **the first connection an account
  makes**, until the account chooses another. One that is not the account's first never takes it.
  Disconnecting the default moves it to the account's first remaining connection (or none); a row that
  names a connection that is gone any other way is ignored on reading, so `/` never lands on a
  repository that is not there.
- **The repository page** is `/` for the default and `/p/<connection>` for any of the account's own
  (the path inside it, `/p/<connection>/<path>`, comes with the file browser, 1a.11). It names the
  repository and its branch, marks the default, and offers *Make this my default* on the others. With
  two or more it has the switcher: a list of the account's repositories, each a link. Someone else's
  `/p/<id>`, or one that is not there, is a 404; choosing a default is an API call
  (`POST /api/connections/<id>/default`) with the same rules as the rest of §12: signed in, this site's
  `Origin`, the caller's own.
- **Not here: the default vault.** Which vault opens first is “the first vault listed in `fjord.json`”,
  and reading `fjord.json` is the format's, which is `fjord-core` through WebAssembly (ROADMAP P3, P4),
  not a parser of ours (the build brief's first rule). It moves to 1a.11, which needs the same. Nothing
  is stored for it yet.

**A repository that is not a Fjord repository** (no `fjord.json`) is shown as such,
with an offer to initialise it: a commit adding `fjord.json` and one plaintext vault,
generated by `fjord-core` exactly as `fjord init` would. Nothing is written without
the user's confirmation. (Open: §19.)

## 8. Browsing

- **One listing per head.** The tree is read once per commit, from the provider's
  tree listing, and cached by commit id; a `push` webhook invalidates it. Very large
  repositories, where GitHub's tree listing is truncated, fall back to listing
  directory by directory.
- **Vaults are discovered from the listing**, as the spec says (§2.1): a directory
  is a vault if and only if it contains `fjord.vault.json`. `fjord.json` is a
  convenience, not the authority. Discovery is `fjord-core`'s, given the listing.
- **What can be opened** is decided from the name alone, so nothing is downloaded to
  draw the browser:

  | File | Shown as | Opens in |
  | --- | --- | --- |
  | `*.fj.md` | Document | Document editor, `/d/<id>` |
  | `*.md` (any other) | Note | Note editor, `/n/<id>` |
  | anything else | greyed out | — (phase 1) |
  | anything in an encrypted vault | greyed out, with a lock | — (phase 2) |

- **Metadata beyond the listing** (a document's title, the last commit to touch a
  file) costs a blob read or a history query per file, so it is loaded lazily, for
  what is on screen, and cached by blob id.
- An encrypted vault with `fileNaming: "id"` shows identifiers, not names; that is
  what it is for (spec §7.2).

### Renaming, moving and deleting

Phase 1 can rename, move and delete **documents, notes and folders inside plaintext
vaults**, from the browser and from an open file's menu. Each is one commit through
the owner's connection: `Rename <old> to <new>`, `Move <name> to <folder>`, `Delete
<name>`.

- **Who:** the owner, in phase 1 (as for sharing, §12). An edit share edits content;
  it does not rename, move or delete.
- **Identity survives a rename or move.** A Doc's `id` is in its frontmatter, so
  `/d/<id>`, `/n/<id>`, shares, comments and the id index follow the file; only its
  path changes. A note without an id keeps none: a rename is not an edit of its
  content, so the file moves byte for byte (spec §8.2) and its path route changes.
- **The extension stays.** The rename field edits the name before `.fj.md` or
  `.md`, so a rename never turns a document into a note or back; converting is a
  separate action, later, because a note cannot carry shares (§12).
- **Names are checked by `fjord-core` before anything is committed**: the path rules
  of spec §5, including the reserved names and two names in one folder that differ
  only by case. A name that is already taken is refused, never overwritten.
- **Where a file can move:** to any folder of a plaintext vault in the same
  repository. Into an encrypted vault is refused: it would put plaintext in the
  vault (CLI invariant 1), and moving in means encrypting, which is phase 2.
  Between repositories is not a move (ids are unique only within one, spec E401).
- **A folder** is renamed, moved or deleted with everything in it, in one commit.
  Vault directories themselves, `fjord.vault.json` and `fjord.json` are not
  touched by these actions in phase 1; they belong to the CLI.
- **Nothing in progress is lost.** A file with a working copy that differs from its
  last version is saved as a version first (§11); then the rename, move or delete
  is committed on top. People editing it through a share see it move or close.
- **On top of the head the browser showed.** If any path involved has changed
  upstream since, the action stops and shows what changed, as for edits (§11).
- **Deleting asks for confirmation**, naming what will go (for a folder, how many
  files). It is recoverable without a trash folder, which the spec leaves out
  (§12): the file is still in history, and the instance records each deletion (its
  path, id, kind, last blob and the deleting commit). **Undo** is offered at once,
  and **Recently deleted** lists the owner's deletions for a restore window (default
  30 days); restoring commits the last blob back at its path, or a chosen one if
  that path is taken. A deleted document's shares stop working and its comments are
  kept; restoring brings both back, because the id is the same.

## 9. Documents and notes

**The distinction is the file name.** A document is `name.fj.md`; any other `.md` in
a vault is a note. Both are ordinary Markdown files to every other tool: GitHub
renders both, Obsidian opens both, and both are Fjord Docs to the CLI when they
carry an `id`. The double extension keeps "readable without Fjord" true; a new
extension such as `.fjmd` would not (GitHub does not render it, Obsidian does not
show it). This needs a one-sentence spec amendment and CLI support (ROADMAP,
"Prerequisites in fjord").

**Identifiers and routes.**

- `/d/<id>` for documents, `/n/<id>` for notes, where `<id>` is the Doc's `id`
  (spec §8.3, a lowercase ULID).
- **A note without frontmatter has no id**, and the spec forbids adding one merely
  because the file was opened (§8.2). Until its first edit it is addressed by path,
  `/p/<connection>/<path>`; the first edit gives it frontmatter and an `id` (§8.2
  allows that on an explicit edit), and the page moves to `/n/<id>`. A new
  document is created with an id.
- **Resolving an id** uses a server-side index of `id → connection, path`, filled
  as files are read and by a background pass over each connection's Markdown files,
  keyed by blob id so unchanged files are not re-read. Ids are unique within a
  repository (spec E401) but not across repositories, so an id found in more than
  one place gets a chooser page.

**Frontmatter** is parsed, preserved and written by `fjord-core`, never by the
editors: unknown keys and their order survive (spec §8.2, CLI invariant 3). The
editors receive the body only, and the header is shown in a **Document properties**
panel: `title`, `id` and `created` are editable or shown; keys Fjord does not know
are shown read-only, so the user can see they are kept.

## 10. Editors

Both editors live in their own package, **`packages/fjord-editor`**, behind a stable
interface, so they can be improved, or a core replaced, without touching the app.
Roughly:

```ts
<DocumentEditor
  value={body}               // Markdown body, frontmatter removed
  onChange={(body) => …}
  role="view" | "comment" | "edit"
  comments={adapter}         // threads, anchors, live updates (§13)
  onNeedName={() => …}       // ask an anonymous user for a display name
/>
<NoteEditor value={body} onChange={…} readOnly={…} />
```

The package has its own tests and stories, and a **round-trip corpus**: real
Markdown in, Markdown out, compared.

### Document editor (`*.fj.md`)

- **Core: [MDXEditor](https://mdxeditor.dev/)** (MIT; React 18/19; built on
  **Lexical**, with `mdast` for Markdown and CodeMirror for code blocks).
- **A Google-Docs-like surface:** a continuous canvas (no print pagination), one
  document at a time, a menu bar and a formatting toolbar, comments in a side panel.
- **The toolbar offers only what Markdown can hold**: headings, bold, italic,
  strikethrough, inline code, links, bullet, numbered and task lists, quotes, code
  blocks, horizontal rules, tables. Nothing that would silently vanish on save:
  no fonts, sizes, colours, alignment or underline.
- **Images by URL** (or a path to a file already in the repository); no uploads in
  phase 1.
- **House style.** MDXEditor re-serialises the whole document on save. For
  documents, which Fjord creates and owns, that is acceptable: the output follows
  one documented house style (list markers, emphasis markers, table layout), and the
  first save of a document written elsewhere shows what will be reformatted. Syntax
  the editor does not model is kept as an opaque raw block, never dropped.
- **Frontmatter is not given to MDXEditor** (its own YAML handling would rewrite
  it); see §9.
- **Comments** use Lexical's mark nodes, which MDXEditor does not provide as a
  plugin, so the comment plugin is ours (§13).
- **Phase 3 risk, recorded now.** Collaborative editing means `@lexical/yjs` inside
  MDXEditor's Lexical instance, which MDXEditor does not do out of the box. The
  package interface is what lets us extend MDXEditor, or replace it, when we get
  there.

### Note editor (`*.md`)

- **Minimal and byte-faithful**: CodeMirror 6 editing the Markdown source, with
  light styling. A note is often edited by hand or in Obsidian too, so an edit
  changes only what the user changed.
- No toolbar beyond the essentials; no comments; no sharing in phase 1.

### Creating

Phase 1 can **create** documents and notes (name, vault and folder chosen; a valid
header written by `fjord-core`). Renaming, moving and deleting are in §8.

## 11. Working copies and versions

- **Editing writes to a working copy** on the server, debounced, as the user types.
  A working copy records the file, the blob it started from (its *base*), the
  current content, and who has edited it since the last version.
- **A version is made** when someone chooses **Save version** (with an optional
  message), or **after a quiet period** (default five minutes without edits;
  configurable per instance). The worker makes idle versions.
- **The commit** is made through the owner's connection, on the branch the document
  was opened from. Its author is the person whose save triggered it; everyone else
  who edited since the last version is credited with a `Co-authored-by:` line.
  Someone editing through a link without an account appears under the display name
  they gave, with a no-reply address.
- **Default message:** `Edit <title>`.
- **Nothing is ever overwritten.** A commit is made only on top of the working
  copy's base. When the file has changed upstream (someone committed from the CLI,
  Obsidian or another device; a `push` webhook flags it), the working copy is kept,
  and the editor shows both versions before anything is committed: keep mine (commit
  on top), take theirs (discard the working copy), or combine by hand. This is the
  CLI's rule that a conflicting version is never destroyed (spec §9.1), applied to
  a web editor.
- **Phase 3** carries real-time collaboration on this same working copy (a shared
  Yjs document per open file), which is why it exists now rather than later.

## 12. Sharing and permissions

Documents (`*.fj.md`) can be shared in phase 1. Notes cannot.

**Roles**, each including the ones before it:

| Role | May |
| --- | --- |
| **View** | read |
| **Comment** | read, comment, reply, resolve |
| **Edit** | read, comment, edit (into the working copy) |

**Ways to share**, any number of each per document:

- **With named users of the instance**, by exact email, each with a role. Only
  existing accounts can be named, and the lookup does not reveal whether an email
  has an account to someone who is not sharing with it.
- **By link**: public (anyone with the link), or with a password. Each link has a
  role, an optional expiry, and can be revoked; a document can have several links,
  for example a comment link for reviewers and an edit link for collaborators.

**Link URLs** are `/d/<id>?token=<token>`. A document id is not a secret (it is in
the file's frontmatter, so in the repository, its history and its commits), so a
link carries its own random token. On first use the server swaps the token for a
short-lived cookie scoped to that share and redirects to the clean `/d/<id>`, so
the token does not stay in the address bar, history or `Referer`. Pages send
`Referrer-Policy: no-referrer`; tokens are redacted from logs. A password-protected
link asks for its password at that swap; passwords are hashed with Argon2id and
attempts are rate-limited.

**Signed-in users with a named share** use the plain `/d/<id>`.

**Anonymous link users** choose a display name before they comment or switch to
edit mode; it is kept in the browser and shown on their comments and edits.

**Who can share:** the owner, in phase 1. Lifetime: until revoked; an expiry is
optional per link. Revoking a link, or a named share, ends sessions that used it.

**Encrypted documents** are shared in phase 2, as sealed copies: the copy and its
comments encrypted in the browser with a key carried in the link's `#fragment` (or
derived from a password), so the server never sees the content.

## 13. Comments

Comments are collaborative in phase 1; editing is not (phase 3).

- **Threads** on a selection, with replies; resolve and un-resolve (anyone with
  comment access); edit or delete your own; the owner can delete any comment and
  close comments on a document.
- **Anchors survive edits.** Inside the document editor a thread is a Lexical mark
  over its text. Stored alongside, independent of the editor, is a **text-quote
  selector**: the quoted text, some text before and after it, and an approximate
  position, over a plain-text projection of the body. When the document changes
  outside the editor (a commit from elsewhere), threads are re-anchored from the
  selector: exact match near the hint, then a fuzzy match, otherwise the thread is
  marked **outdated** and kept in the panel, never dropped. The anchor is a tagged
  type, so phase 3 can add Yjs relative positions beside it without a migration.
- **Live:** new comments, replies and resolutions arrive over server-sent events.
- **Identity:** signed-in users by account; anonymous link users by display name and
  a random browser id (spoofable by design; that is what anonymous means).
- **Storage:** on the server, per document, not in the repository. A later, opt-in
  option could write them to a sidecar under `/.fjord/`, which the spec reserves for
  client data (§2.2, §12); opt-in, because a repository's history can be public.
- **Limits:** size per comment, threads per document, and rate limits per user and
  per link.
- **Model:** threads, replies, resolve state and an activity log, following
  [Annotate.js](https://github.com/kasunben/Annotate.js); not its anchoring (XPath
  into a static page, which an edited document breaks).

## 14. Data model and database

### Tables

Roughly, beyond better-auth's own:

| Table | Holds |
| --- | --- |
| `account_default` | account, the connection `/` lands on |
| `connection` | account, provider, how it is reached (`kind`), repository, branch, the id of its credential in `credential` (§7), when; where `/` lands is `account_default`, one row per account (§7); the default vault comes with 1a.11 |
| `tree_cache` | connection, commit id, listing |
| `doc_index` | connection, path, `id`, kind (document/note), blob id |
| `working_copy` | connection, path, base blob id, content, editors since last version, last edit, upstream-changed flag |
| `deletion` | connection, path, `id`, kind, last blob id, deleting commit, deleted by, timestamp, restored (§8) |
| `share_user` | document, account, role |
| `share_link` | document, token hash, role, password hash, expiry, revoked |
| `thread`, `reply` | document, anchor (tagged), body, author (account or anonymous id + name), timestamps, resolved |
| `activity` | document, actor, event, timestamp |
| `event` | cross-process notices (worker → web): kind, subject, timestamp |

A document is identified by connection and `id` (or path, for a note without one).

The auth store holds better-auth's tables (§6): `user`, `session`, `account`, `verification`,
`two_factor`, `passkey` and `rate_limit`. Both stores are migrated at start-up whatever the
sign-in settings, so the tables of a method that is switched off are simply unused.

### Database

The database is not where documents live; the repository is. It holds accounts,
connections, shares, comments, working copies and caches: small rows and modest
writes. That is what makes SQLite a good default, **in production too**, with
**PostgreSQL** for an operator who prefers it. This follows Sovereign's pattern, and
is planned in from the start rather than added later.

**The switch.** `DB_DIALECT` is `sqlite` or `postgres`, read in one place; nothing
infers the dialect from a URL. It **defaults to `sqlite`**, where Sovereign requires
it to be set: Fjord's pitch is a simple self-hosted cloud, so the zero-configuration
path is the default one.

**SQLite, in two forms through one libSQL client**, chosen by `SQLITE_URL`:

| `SQLITE_URL` | Form | For |
| --- | --- | --- |
| `http://sqld:8080` (**default**) | an **sqld** service (libSQL server), as Sovereign runs | most installs: the web process and the worker can be separate containers, replicas reach it over the network, app containers hold no state, and operating Fjord is the same as operating Sovereign |
| `file:/data/fjord.db` | a plain file | the smallest self-host: one container, no database service |

- With sqld, the app and auth databases are the namespaces `fjord` and `fjord_auth`,
  created through `SQLD_ADMIN_URL`; every request names its namespace in the
  `x-namespace` header. With a file, auth is `fjord_auth.db` beside it.
- **sqld must be 0.24.33 or later.** Earlier releases ignore `x-namespace`, so every
  "namespace" is the one default database and the app's tables and better-auth's would
  share it, with no error to say so. The newest GitHub *release* is 0.24.32, but the
  image `…/libsql-server:v0.24.33` (the same as `latest`) exists, and is what CI and
  the dev script pin. A test checks that the two stores really are separate.
- **The file form has limits, stated plainly:** every process that writes must run on
  the same host (one container, or containers sharing a *local* volume); there are no
  replicas on other hosts; and the file must never sit on a network filesystem, which
  is a known way to corrupt SQLite.
- **The cost of sqld** is a network round trip for each statement, against
  microseconds in-process for a file. Next to the provider API calls this app is made
  of, each a hundred milliseconds or more, that is noise; it was not measured, and
  does not decide the question. What decides it is the shape of the deployment.
- Both forms are the same dialect and the same code; only the URL differs. Sovereign
  dropped its file form for reasons Fjord does not share (a namespace per plugin, and
  an at-rest encryption experiment it later retired), so offering it here is a
  deliberate difference.

**PostgreSQL** through `POSTGRES_DB_URL`, with `PGSSLROOTCERT` for TLS verification
and `POSTGRES_POOL_MAX` for the pool, as in Sovereign. The app and auth tables are
the schemas `fjord` and `fjord_auth`.

**Schema and migrations.** Drizzle, with a schema file and a migration set per
dialect (`schema/{sqlite,postgres}`, `migrations/{sqlite,postgres}`), generated with
`drizzle-kit generate` and never `drizzle-kit push`, and applied at start-up.
better-auth uses its Drizzle adapter, in `fjord_auth`.

**Portable by rule.** Each kind of value has one representation in both dialects:
booleans, timestamps, 64-bit integers (SQLite returns booleans as `0/1` where
PostgreSQL returns `true/false`, and a 64-bit integer needs a declared mode). Queries
use standard SQL only (`ON CONFLICT … DO UPDATE` is portable); anything raw goes
through one small dialect-aware helper, as Sovereign's `packages/db/src/exec.ts` does.

**No `LISTEN/NOTIFY`.** PostgreSQL has it and SQLite does not, so nothing depends on
it: when the worker needs to tell web processes something (an upstream change was
detected, an idle version was committed), it writes to the `event` table, which web
processes read. That works the same on both dialects and with several replicas.

**Transactions are short**, and none is held open across a call to a provider.

**At rest, neither dialect encrypts.** Sensitive fields are encrypted by the
application instead: the connection credentials (§7), as already planned.

**The dialect is chosen at install time.** Moving an existing instance from one to the
other is not supported in phase 1 (§19 #1).

**How it starts.** The server brings the database up once, in `instrumentation.ts`
before it serves anything, and does not start if it cannot: it reads the configuration
(`src/db/config.ts`, the only place the variables are read), makes the stores that
must exist (the sqld namespaces `fjord` and `fjord_auth`, the directory of the SQLite
files, the PostgreSQL schema `fjord_auth`), opens the app's database and applies the
migrations. It waits up to `FJORD_DB_CONNECT_TIMEOUT_MS` (30 s) for a database that is
still starting, since in a compose file the two come up together. `GET /api/health`
answers from the live database, for a container health check and for CI.

- **Migrations** are read from `migrations/` in the directory the server runs from, or
  `FJORD_MIGRATIONS_DIR`; the image copies the folder next to the server (1a.12).
  Concurrent starts are safe: PostgreSQL takes an advisory lock on one pinned
  connection; SQLite has no such lock, so a run that loses the race retries and finds
  the work done.
- **Two libSQL clients, one dialect.** An sqld service is reached with
  `@libsql/client/web`, the HTTP-only build, so an sqld or PostgreSQL instance never
  loads a native addon. Only the `file:` form loads libSQL's native client, which has
  no build for every platform (it has none for musl): the image for the `file:` form
  must be a glibc one, or check for a prebuilt binary (1a.12). A file database runs in
  WAL mode with a busy timeout, since the web and worker processes may share it.
- **`bigint` is a number.** PostgreSQL returns 64-bit integers as strings unless told
  otherwise; every 64-bit column declares `mode: "number"` and the client parses
  `int8` the same way for raw SQL (on `pg`'s own registry: Drizzle gives each query
  its own parsers, so a pool option is ignored). A value past 2^53 is an error, not a
  rounded number. Ids and epoch milliseconds are far below it.
- **The column vocabulary** (`src/db/schema/*/columns.ts`) is how the portable rule is
  kept: a table is written with `id64` and `epochMs`, not with a dialect's own types.
  It grows by one word at a time as tables need one, in both dialects at once.
- **`event`** (the first table) has an `id` that only grows, so a reader's cursor stays
  valid after old events are pruned.

**Tested on every form, from the first task.** CI runs the whole data-layer suite
three times, against an sqld service, a `file:` database and a PostgreSQL service,
not as optional suites that someone has to remember to write, and before it boots a
built instance from an empty database on each, as an operator would. A **schema parity
test** checks that the two dialects' schemas declare the same tables, columns and
indexes, and a CI step fails if generating migrations from the committed schemas would
write anything. The tests read `FJORD_TEST_*` variables and not the app's, because they
drop whole schemas and namespaces: a developer's exported `POSTGRES_DB_URL` must never
be wiped by `pnpm test`. In development `pnpm db:dev` starts a local sqld or PostgreSQL
in Docker, as Sovereign's script does; a `file:` URL works with no Docker at all, and
it is what the tests use when nothing else is set.

## 15. Security and privacy

- **What the server can read:** every plaintext file in a connected repository. That
  is inherent to editing on a server, and stated in the product. **What it cannot:**
  encrypted files' contents (phase 2), because age identities stay in the browser.
- **Credentials:** GitHub App with minimal permissions, or fine-grained single-repo
  PATs; encrypted at rest; never sent to the browser.
- **Rendering untrusted Markdown:** shared documents, comments and display names
  come from other people, so rendered Markdown is sanitised (no raw HTML execution),
  pages send a strict Content-Security-Policy, and nothing third-party is loaded.
- **Auth:** better-auth's session handling, CSRF protection and rate limits; passkeys and
  TOTP for local accounts. What is relied on, and tested:
  - **Passwords** are hashed, never stored or returned; a wrong password and an unknown
    address get the same answer; the minimum length is enforced by the server.
  - **A request from another site is refused**: a state-changing request carrying a session
    cookie must have this instance's `Origin` (missing is refused too). better-auth skips this
    check when `NODE_ENV` is `test`, so it is set explicitly, or a test would pass on behaviour
    production does not have.
  - **Limits are counted in the database**, so they hold across every process: three sign-in
    attempts in ten seconds per address. They key on the `X-Forwarded-For` header, so Fjord
    Web **must run behind a reverse proxy that sets it** (1a.12's deployment does); reachable
    directly, a client can name its own address and defeat the per-address limit. The limits
    that do not depend on an address still hold: two-factor locks an account after ten wrong
    codes across sign-ins for fifteen minutes, and a wrong code spends a guess from five.
  - **A password reset ends every session**, and so does a password change.
  - **Cookies** are `HttpOnly`, `SameSite=Lax`, prefixed `fjord`, and `Secure` on https.
  - **`FJORD_URL` is the origin people use.** The passkey relying party and the origin check
    are made from it, so a proxy that serves another name needs `FJORD_URL` set to it.
- **Abuse:** limits on comments, links and anonymous edits; owners can revoke and
  close.
- **Deletion:** deleting an account removes its connections, shares, comments and
  working copies; it never touches the repositories.

## 16. Phase 1 slices

| Slice | Delivers | Usable as |
| --- | --- | --- |
| **1a** | The database layer on both dialects, landing page, auth (both methods), connections (GitHub App and PAT), defaults, file browser | Sign in, connect a repository, browse it |
| **1b** | Note editor and document editor, create, rename, move and delete (with restore), working copies, versions, upstream-change handling | Write, organise and version documents and notes |
| **1c** | Sharing: named users, links, passwords, roles, revocation | Share documents |
| **1d** | Comments: threads, anchors, live updates, anonymous names | Review documents together |

Each slice ends usable, tested and released. The tasks are in
[`ROADMAP.md`](ROADMAP.md).

## 17. Deployment

- One container image, run as `web` and `worker`, and a reverse proxy with TLS. The
  same shape Sovereign uses (`sovereign-infra`).
- **The database** (§14), three ways:
  - **Default:** compose includes an `sqld` service, and the app waits for it to be
    healthy.
  - **Smallest:** a single-container example with `SQLITE_URL=file:/data/fjord.db`
    on a local volume, web and worker in the one container.
  - **PostgreSQL:** an overlay compose file replaces `sqld` with a `postgres`
    service, or `POSTGRES_DB_URL` points at an existing server.
- **Backups:** a snapshot of the sqld volume; for the file form, continuous
  replication (for example Litestream) or `sqlite3 .backup`; for PostgreSQL,
  `pg_dump` or the operator's usual process.
- **Configuration** by environment: instance URL; `DB_DIALECT`, `SQLITE_URL`,
  `SQLD_ADMIN_URL`, `POSTGRES_DB_URL`, `PGSSLROOTCERT`, `POSTGRES_POOL_MAX`; the
  instance encryption key; which auth methods are on and their settings; the GitHub
  App's id, private key and webhook secret; the idle-commit interval; limits.
- **Each instance registers its own GitHub App.**
- **Releases** follow the monorepo's flow: a `web` component in `scripts/release/`,
  tagged `web-vX.Y.Z`, never marked *Latest* on GitHub (the CLI's install URLs depend
  on that slot), with its own CI workflow that runs only for changes that can affect
  it.

## 18. Licence

`clients/web` is **AGPL-3.0-or-later**, because it bundles `@sovereignfs/ui`, which
is AGPL-3.0-or-later. The rest of the repository stays MPL-2.0 and the spec CC0.
`packages/fjord-editor` is meant to be reused by the desktop app and editor plugins;
whether it depends on `@sovereignfs/ui` decides its licence (§19). The design system bundles
icons derived from Lucide (ISC), whose notice must accompany a distributed copy: the
container image carries `@sovereignfs/ui`'s `NOTICE` (ROADMAP 1a.12), and Next's
standalone output would otherwise prune it.

## 19. Open questions

| # | Question | Default until decided |
| --- | --- | --- |
| 1 | Moving an existing instance between dialects (SQLite ↔ PostgreSQL) | Not in phase 1; a documented export and import later |
| 2 | ~~When both auth methods are enabled, how are a local account and a Sovereign login linked?~~ **Decided (1a.4):** by `sub`, only from a signed-in session, and only when both use the same email address | — |
| 3 | Offer to initialise a repository that is not a Fjord repository? With which vaults? | Offer, one plaintext vault, after confirmation |
| 4 | Licence of `packages/fjord-editor`: AGPL with the design system, or MPL-2.0 without it? | Decide before 1b |
| 5 | Idle-commit interval | Five minutes |
| 6 | Branch: always the default branch, or choosable per connection? | Default branch; choosable later |
| 7 | House style for documents: exact list and emphasis markers, table layout | Write it down in 1b, with the round-trip corpus |
| 8 | Can an editor (not only the owner) share further? | Owner only in phase 1 |
| 9 | Notes in phase 1: sharing and comments? | Neither |
| 10 | Path route for notes without an id: `/p/<connection>/<path>` | As written |
| 11 | Restore window for deleted files | 30 days, per instance |
| 12 | Converting a document to a note or back (changing the extension) | Not in phase 1; rename keeps the extension |

## 20. Decision log

| Date | Decision | Instead of |
| --- | --- | --- |
| 2026-10-22 | An account-based app at `fjord.sovereign.fs`, landing page for visitors, the default repository for users | The anonymous "scratchpad" playground (abandoned) |
| 2026-10-22 | Auth: better-auth, local (password + passkeys + TOTP) and/or Sovereign OIDC, by environment | — |
| 2026-10-22 | GitHub App, with a fine-grained PAT fallback; provider interface for other hosts | OAuth App (scope reaches every private repo); PAT only |
| 2026-10-22 | Documents are `*.fj.md`, notes any other `.md` | A new `.fjmd` extension (not rendered by GitHub, hidden by Obsidian); a frontmatter field (needs every file read to tell) |
| 2026-10-22 | Routes `/d/<id>` and `/n/<id>`; path route until a note has an id | — |
| 2026-10-22 | Document editor on MDXEditor; note editor minimal and byte-faithful; both in `packages/fjord-editor` | — |
| 2026-10-22 | Server-side working copies; versions on save or after a quiet period | A commit per save; copy-and-approve |
| 2026-10-22 | Shares: named users and links (public or password); view, comment, edit; until revoked, expiry optional | Expiring anonymous shares |
| 2026-10-22 | Link URL `/d/<id>?token=…`, swapped for a cookie on first use | A separate share route |
| 2026-10-22 | `fjord-core` as WebAssembly, in Node and (phase 2) the browser | A TypeScript reimplementation of the format |
| 2026-10-22 | `clients/web` is AGPL-3.0-or-later and open | Dual-licensing the design system; tokens only |
| 2026-10-22 | Phase 1 is plaintext only; encryption phase 2; collaborative editing phase 3 | — |
| 2026-10-22 | Phase 1 ships in slices | One release |
| 2026-10-22 | Rename, move and delete in phase 1 (owner only, plaintext vaults, one commit each), with undo and a restore window recorded by the instance | Leaving them for later; a trash folder in the repository (spec §12 leaves trash out) |
| 2026-10-22 | SQLite by default, in production too; PostgreSQL by the operator's choice; `DB_DIALECT` defaults to `sqlite` | PostgreSQL only; requiring the dialect to be set, as Sovereign does |
| 2026-10-22 | SQLite as an sqld service by default, or a `file:` URL for a single-container install, through one libSQL client | sqld only, as Sovereign; a plain file only |
| 2026-10-22 | Every data-layer test runs on sqld, a file and PostgreSQL in CI, with a schema parity test | Dialect suites that run only when their database URL is set |
| 2026-10-22 | Local sign-in on better-auth 1.7 through its Drizzle adapter, in the auth store with migrations of its own | The 1.6 line Sovereign runs (an account-identity migration before 1a.3); better-auth's own Kysely adapter (the design chose Drizzle) |
| 2026-10-23 | Sovereign sign-in through better-auth's `genericOAuth` and discovery, identity by `sub`, no implicit linking by email, the same sign-up policy as local, local sign-out only, with a fake Sovereign checked against a recording of a real one | Linking by verified email (the takeover case 1a.4 has to decide); signing out of Sovereign too; tests against the live service |
| 2026-10-23 | A local account and a Sovereign login are linked from a signed-in session by `sub`, only when both use the same email address; Sovereign is trusted to have verified it; unlinking never removes the last way in; an account that came in through Sovereign sees no password settings | Linking by email at sign-in (the takeover case); allowing a different address (it attaches a stranger's identity); letting Sovereign-created accounts add a password now |
| 2026-10-22 | Sign-up is `closed` by default (the first account, then refused) and `open` by choice | Open by default; invites (they need email) |
| 2026-10-22 | Email is optional: with SMTP, verified addresses and reset by email; without it, neither | SMTP required; no email at all |
| 2026-10-22 | The browser tests run the built app in Chromium with Playwright, and a virtual authenticator stands in for a passkey device | Server-level tests only, leaving passkeys to a manual check |
| 2026-10-22 | One `Provider` interface, tested by one contract against GitHub over a git-backed fake, an in-memory provider, and GitHub's recorded real answers | A recording of the real API alone (cannot show a write); a hand-written fake of git's rules |
| 2026-10-22 | A commit is blobs, a tree, a commit and a fast-forward, never forced, and never retried | The Contents API (one file at a time, no atomic multi-file commit); forcing the branch; retrying a lost write |
| 2026-10-22 | The landing page is static, server-rendered HTML in `@sovereignfs/ui`'s tokens, with the design system reached through one `"use client"` module, a theme script that follows the system, and a native `<details>` FAQ | A client-rendered page; a bespoke palette; importing the package from Server Components (it fails: the bundle calls `createContext` at module scope) |
