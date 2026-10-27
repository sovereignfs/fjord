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
6. **Opening** a document (`name.fj.md`) goes to `/doc/<id>` and the document editor;
   opening a note (any other `.md`) goes to `/note/<id>` and the note editor (§9, §10).
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
`fjord.json` until the user picks another (see *The default vault*, below).

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
- **The repository page** is `/` for the default and `/repo/<connection>` for any of the account's own
  (the path inside it, `/repo/<connection>/<path>`, comes with the file browser, 1a.11). It names the
  repository and its branch, marks the default, and offers *Make this my default* on the others. With
  two or more it has the switcher: a list of the account's repositories, each a link. Someone else's
  `/repo/<id>`, or one that is not there, is a 404; choosing a default is an API call
  (`POST /api/connections/<id>/default`) with the same rules as the rest of §12: signed in, this site's
  `Origin`, the caller's own.
- **The default vault** is not here: which vault opens first is “the first vault listed in `fjord.json`”,
  and reading `fjord.json` is the format's, which is `fjord-core` through WebAssembly (ROADMAP P3, P4),
  not a parser of ours (the build brief's first rule). It is 1a.11's, below.

**A repository that is not a Fjord repository** (no `fjord.json`) is shown as such,
browsed read-only, with an offer to initialise it (decided, §19 #3; ROADMAP 1a.10):

- **What is written** is generated by `fjord-core` and not by the web client
  (`scaffold::plan_setup`, ROADMAP P6): a `fjord.json`, and one plaintext vault, its
  `fjord.vault.json` and a starter note. Not the `README.md`, `.gitignore` and line-ending rule
  that `fjord init` writes: in a repository that is somebody's already, each would clash with
  a file that is there or silently change how Git treats all of it. No encrypted vault:
  encryption is phase 2, and keys do not belong in the browser. It is **one commit** through
  the provider, never forced.
- **Additive.** Every file is new, with **one exception**: spec §9 requires a `.gitattributes`
  with a `*.age` merge guard (`fjord verify` reports E109 without it, even where no vault is
  encrypted yet), so where the repository has no such line the setup adds it: a new file, or
  one line appended to the one that is there, with everything in it kept. The preview shows it
  as an append. Nothing is changed, renamed or removed otherwise.
- **Nothing is written before a click.** The offer shows the repository, the branch and
  the exact list of files.
- **When it is not offered:** the token cannot write; or `fjord.json` is there but cannot
  be read (a broken file is not ours to overwrite; the page says so). If the vault's
  directory name is already used by something else (case aside), the next free one is
  chosen (`Public 2`), and a name that cannot be a directory is refused with the reason.
- **An empty repository** is not covered: connecting one is still refused until the provider
  can make a repository's first commit (the host's git-data API refuses an empty one).

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
  | `*.fj.md` | Document | Document editor, `/doc/<id>` |
  | `*.md` (any other) | Note | Note editor, `/note/<id>` |
  | anything else | greyed out | — (phase 1) |
  | anything in an encrypted vault | greyed out, with a lock | — (phase 2) |

- **Metadata beyond the listing** (a document's title, the last commit to touch a
  file) costs a blob read or a history query per file, so it is loaded lazily, for
  what is on screen, and cached by blob id.
- An encrypted vault with `fileNaming: "id"` shows identifiers, not names; that is
  what it is for (spec §7.2).

### Browsing, as built (ROADMAP 1a.11: the vaults, browsing them, and the default vault)

1a.11 was built in three steps: the vaults of a repository, browsing a vault's folders and files, and each
repository's default vault.

- **The format is `fjord-core` as WebAssembly, in Node** (`src/format/`): `crates/fjord-wasm`, built by
  `pnpm build:wasm` and loaded at run time from where it was built (`FJORD_WASM_DIR` overrides the monorepo
  default), through `process.getBuiltinModule` so the bundler leaves the path alone. Nothing in the web client
  knows the format: it hands the module a list of paths and a few manifests' text and parses the JSON it answers
  with (`src/format/types.ts`). It is built in each web job that needs it by one shared CI action, so the web is
  always tested against the current core, and web CI runs when the core, the module or the fixtures change.
- **What is read from the host** (`src/browse/repository.ts`): the **head** (one request), the **tree** of that
  commit (one request, none if cached), and the **manifests** it names: `fjord.json` and each vault's
  `fjord.vault.json`. Not one document is read to draw the list. A manifest over 256 KiB is not read (a hostile
  repository must not make the server fetch a gigabyte): that vault is shown as unreadable.
- **Cached by commit** (`tree_cache`, both dialects): a commit's tree never changes, so a cached tree is never
  stale; a new head is a new row. The host's answer is kept as it came, `complete` included, and only the latest
  three commits of a connection are kept; disconnecting forgets them. A manifest's text is cached by blob id in
  memory (bounded). The head is asked for at each view, which is what makes a push show; the webhook that makes
  that free is 1a.6.
- **What a file is comes from its name** (spec §2, §6.3, §8.4): a document (`*.fj.md`), a note (any other `.md`),
  another file (greyed, phase 1), an encrypted payload, or plaintext where there must be none. The page lists
  each vault with its counts and a lock for an encrypted one. Whether a document or a note is a Fjord Doc at all
  needs its contents, which are read lazily, later.
- **A listing the host cut short** (very large repositories) is not downloaded further: the vaults are found a
  directory at a time (the root, then each top-level directory, six at once) and the page says what is inside
  them is too large to list at once; browsing them is the next step.
- **No `fjord.json` is not an error**: vaults are found from the listing, which is the authority (spec §2.1), and
  the page says the file is missing (and, where there is no vault either, offers the setup: §7, as built below). A `fjord.json` that cannot be read is
  said too. Vault manifests where §2.3 allows none are listed as not shown.
- **What the host or the setup gets wrong is said, not thrown** (`src/browse/problems.ts`): a token GitHub no
  longer accepts, a repository or branch that is gone, a rate limit, an unreachable host, a stored token this
  instance cannot open, a module that is not built. No message carries a token or the host's own text; a bug
  still surfaces as one.
- **Browsing a vault** (`/repo/<connection>/<vault>/<folders…>/<file>`, `src/browse/location.ts`): the first
  segment is a vault (a directory at the root, spec §2.3) and the rest is inside it. A **folder** lists its
  subfolders first (with how many files are somewhere in each) and then its files, by name without regard to case;
  folders are derived from the paths of what they hold, since git has no empty directories and the host lists
  files. A **file** is named with its kind. A vault's machinery (its manifest, `.gitignore`, the recipients file) is
  not content and is not listed. Where the listing is whole, all of it comes from the tree already read; where the
  host cut it short, the one directory is listed from the host (a file is found in its parent's listing) and its
  files classified by the module with the vault's own manifest, so both read alike (a test holds them to each other).
- **What can be opened is told by name alone** (§8's table): a document (`*.fj.md`) and a note (any other `.md`)
  are links; any other file is named and greyed, not linked; in an encrypted vault every file is shown under its real
  name (the suffix removed; an identifier in an `id` vault, which is what it is for, spec §7.2) with a lock and no
  link. A document or note's own page is, for now, a placeholder saying opening it comes with the editors (1b); it
  names the file and its kind and is where the editor will open.
- **A path that is not a path is a 404 and never reaches the host**: an empty segment, `.`, `..`, a backslash, or a
  slash inside a segment (`%2f`), after decoding. So is a vault or folder or file that is not there, and anything at
  all in a repository that is not the caller's. A vault whose manifest cannot be read is said to be unreadable and
  lists nothing. Browsing reads no tree and no file: the head, and the tree and manifests that are kept.
- **The default vault** (`src/browse/default-vault.ts`) is the vault a repository opens on: `/` and `/repo/<connection>`
  show the list of its vaults and, under it, the top of that vault. It is **the one the account chose**, and until it
  chooses, **the first vault `fjord.json` lists**. The filesystem is authoritative (spec §2.1), so a vault `fjord.json`
  lists that is not there is skipped, one that is there and not listed can still be chosen, and with no usable
  `fjord.json` it is the first vault found. A choice that names a vault that has since gone is ignored, not an
  error: the next one stands in until the account chooses again. Which vaults exist and `fjord.json`'s order are the
  module's answers (§7); the rule only picks among them.
- **The choice is stored, the default is not.** The connection has a nullable `default_vault` (the vault's
  directory); it is written only by an explicit choice, so a repository whose `fjord.json` changes follows it. It is
  set with `PUT /api/connections/<id>/vault` and `{"vault": "<directory>"}`, or `{"vault": null}` to forget it, under
  §12's rules: signed in, this site's `Origin`, the caller's own connection (another's is a 404, before the git host
  is asked anything). A named vault must be one the repository has, checked against the repository as it is now (422
  if not, 502 if the host cannot be reached). Each vault on the list but the first offers *Open this one first*.
- **Tested** against the in-memory host and the real module on all three databases, holding the result to the
  CLI's walk over every conformance fixture (`tests/fixtures/discovery.json`); and in a browser against the
  git-backed fake GitHub, including that a second look reads no tree and no blob, that `fjord.json`'s order beats the
  directories', and that a choice is kept.

### Renaming, moving and deleting

Phase 1 can rename, move and delete **documents, notes and folders inside plaintext
vaults**, from the browser and from an open file's menu. Each is one commit through
the owner's connection: `Rename <old> to <new>`, `Move <name> to <folder>`, `Delete
<name>`.

- **Who:** the owner, in phase 1 (as for sharing, §12). An edit share edits content;
  it does not rename, move or delete.
- **Identity survives a rename or move.** A Doc's `id` is in its frontmatter, so
  `/doc/<id>`, `/note/<id>`, shares, comments and the id index follow the file; only its
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
- **As built (ROADMAP 1b.11), rename and move.** `POST /api/connections/<id>/files/move` takes `{ vault, type, path, blob | files,
  destination }`: what the page showed (the file's blob, the folder's file count) and the full new path. One commit puts the
  **same blobs** at the new paths and deletes the old ones, so every byte, a Doc's `id` and its header are untouched; the
  message is `Rename <old> to <new>` when the folder is the same and `Move <name> to <folder>` when it is not. The new name
  passes `fjord-core`'s path rules; **nothing is put over anything**: a path that is taken, a file where a folder must go and
  a name that differs only by letter case from one in the folder are refused and named, while a name that differs from the
  file's *own* only by case is allowed. A folder is never moved onto a folder that is there (that would be a merge), nor into
  itself; the extension must stay; a vault, its manifest, `fjord.json` and anything git stores as a link are not touched.
  Moving to another vault is allowed when both are plaintext with plain names; **into an encrypted vault is refused** (says
  why), as is a vault the page cannot read. As for deleting, the move is on top of the head that was read, never forced, and
  stops if the file or folder is not what was shown. A file with unsaved changes has them saved as a version first; a folder
  with any, or a place that has a draft of its own, is refused. The page offers *Rename* (the name before the extension) and
  *Move* (a folder from the plaintext vaults the repository lists, up to 300) beside Delete. The id index is moved with the
  files, so `/doc/<id>` and `/note/<id>` work at once; shares and comments, which follow an `id`, need nothing from a move
  and do not exist yet. Not here: converting a note to a document, and undoing a move (it is one commit, and moving back is
  another).
- **Deleting asks for confirmation**, naming what will go (for a folder, how many
  files). It is recoverable without a trash folder, which the spec leaves out
  (§12): the file is still in history, and the instance records each deletion (its
  path, id, kind, last blob and the deleting commit). **Undo** is offered at once,
  and **Recently deleted** lists the owner's deletions for a restore window (default
  30 days); restoring commits the last blob back at its path, or a chosen one if
  that path is taken. A deleted document's shares stop working and its comments are
  kept; restoring brings both back, because the id is the same.

**Deleting and putting back, as built (ROADMAP 1b.12).** Renaming and moving are not built yet (1b.11); deleting is.

- **Delete** is on a note's or document's page and on a folder's, after asking: the question names what will go and, for a folder,
  how many files. `POST /api/connections/<id>/files/delete` under §12's rules makes one commit through the owner's token, authored
  by the person, never forced, `Delete <name>`. **Only what was confirmed is deleted:** a file only if it is still the blob the
  page showed, a folder only if it still holds the number of files the question named; otherwise nothing is written and the page
  is read again. A head that moved without touching it is read again once. Not a vault, its manifest, `fjord.json`, or a folder
  with a manifest in it (phase 1 leaves those to the CLI), and not in an encrypted vault. At most 1000 files at once.
- **Unsaved changes are not thrown away.** A file with a draft has it saved as a version first (§11) and is deleted on top of
  that; if that cannot be done it is not deleted. A folder with a draft anywhere in it is refused: save or discard first. (§8
  above says this for folders too; asking first is the safer reading, since one commit per file is not "one commit".)
- **The record.** Each deleted file is a row of `deletion` (path, kind, last blob, the deleting commit, who, when, and the Doc's
  `id` when it was read: for a single document or note with a header). A folder is its files' rows with one deleting commit.
  Git has the file in its history for good; the row is how the app finds it and how long it offers it. If a row cannot be kept the
  deletion stands and only Undo is lost.
- **Undo** is on the page after a deletion, once. **Recently deleted** (`/deleted/<connection>`) lists what is within the restore
  window (`FJORD_RESTORE_WINDOW_DAYS`, default 30, §19 #11), newest first, a folder as one row. Putting back commits the last
  blobs at the paths they had; for a single file, at a path the person chooses (a plaintext vault, a name `fjord-core` accepts,
  the same kind of file: a document stays a document).
- **Never over anything.** Every path is checked against the head the commit goes on top of: it must be free, so must every
  folder on the way (a file where a folder must go is in the way), and no name in the folder may differ from it only by case. If
  any is taken, none is put back and the taken ones are named. A restore after the window, twice, or of another repository's
  record is refused.
- **One id, one file.** That a restored document's `id` is not now another file's (E401) is checked for a single file, whose deletion records its `id`: if a file has it now,
  nothing is put back and the files that have it are named. A folder's deletion records no ids (it would read every file), so a
  folder's documents are not checked, and the index only knows what it has read, so a copy nobody opened can be missed;
  `fjord verify` says so if a duplicate gets through. A deleted document's links and comments stopping and returning come with the shares
  (1c) and comments (1d); the row keeps the `id` for them.

## 9. Documents and notes

**The distinction is the file name.** A document is `name.fj.md`; any other `.md` in
a vault is a note. Both are ordinary Markdown files to every other tool: GitHub
renders both, Obsidian opens both, and both are Fjord Docs to the CLI when they
carry an `id`. The double extension keeps "readable without Fjord" true; a new
extension such as `.fjmd` would not (GitHub does not render it, Obsidian does not
show it). This needs a one-sentence spec amendment and CLI support (ROADMAP,
"Prerequisites in fjord").

**Identifiers and routes.**

- `/doc/<id>` for documents, `/note/<id>` for notes, where `<id>` is the Doc's `id`
  (spec §8.3, a lowercase ULID).
- **A note without frontmatter has no id**, and the spec forbids adding one merely
  because the file was opened (§8.2). Until its first edit it is addressed by path,
  `/repo/<connection>/<path>`; the first edit gives it frontmatter and an `id` (§8.2
  allows that on an explicit edit), and the page moves to `/note/<id>`. A new
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

*As built (ROADMAP 1b.5).* The page asks the module for a note's or a document's header (`src/browse/document.ts`,
`headerOf`): where the body starts, and the properties. `NoteView` gives the editor the body and keeps the header in front of
it, so a body edit leaves the header **byte for byte**, comments in it included. The panel (`DocumentProperties`) shows the
identifier and the day it was made, lets the **title** be set, and lists every other key as written. A title is sent with the
header alone to `POST /api/connections/<id>/files/header`, and the module rewrites it (`fjord_core::doc::with_title`): that
is the only edit that has YAML written again, so comments in a header are lost then and not before (spec §8.2 permits it),
and a title with a colon or a quote reads back as it was. The title is advisory: the file's name does not change (renaming
is 1b.11). **Promotion:** a file with no header is shown as it is, with a note in the panel that one is added; the first
edit gives it `id`, `title` (its first heading, else its name without `.md` or `.fj.md`) and `created`, made by the module
when the page is built, and editing back to what it was takes the header off again, so opening and undoing leave no draft.
The blank line the module puts between the header and the body is the body's, so a person can select it away. A text with a
carriage return or a byte order mark is not promoted (its endings would mix, or the mark would leave the first byte); a
header that cannot be read is not split, rewritten or shown in the panel, and the file is shown whole.

*As built (ROADMAP 1b.6).* **`/doc/<id>` and `/note/<id>`** show the file with that `id` among the signed-in account's own
repositories, in place and at that address (the page is the one `/repo/<connection>/<path>` shows, which is the same
screen); a note asked for as a document, or the other way round, is sent to the address that is its own. The id must be a
lowercase ULID, else it is a 404 before anything is looked up. **One match** opens; **several** (an id is unique within a
repository, spec E401, not across them, and a copy is a copy) are listed to choose from and nothing is guessed; **none** is a
404, and another account's file is none, which says nothing about whether the id exists. If a repository could not be read,
or the search stopped at its limit, the page says so instead of 404: a file that could not be looked for is not reported absent.
The lists of folders still link by path, since a listing reads no file and so knows no id; a file's page says its address by
id (`/note/<id>`) once it has been read, and that is the one to keep, because it is the one a rename or a move leaves true
(1b.11). The first edit of a note stays at the address it was opened at: its new id is in the draft, and is in the
repository, and so in the index, from the version after.

**The index** (`doc_index`, `src/browse/doc-index.ts`, `ids.ts`) records, for each Markdown file of a plaintext vault that has
been read, its `id` (or that it has none) and the blob it was read at. It is **filled on read** (opening a file notes it) and
by a **bounded search**: a lookup that finds nothing reads, up to 300 at a time, the files it has not read or that changed
(files with no `id` are recorded too, so they are read once), so repeating a lookup goes further. That search is what the
worker's background pass (1b.13) will do ahead of time; until the worker exists, the first lookup does a share of it. It is
**believed only where it is still true**: a row counts only if the repository now has that blob at that path; a file edited
elsewhere is read again, one moved is found by the search and its old row forgotten, one deleted is not found. Encrypted
vaults are never read, a file that is not text or is over 1 MB is recorded as having no `id`, and a repository whose listing the
host cut short names no files, so none is searched and what was known of it is kept. A copy that nobody has read is not in the
index, so a lookup can miss a duplicate that the worker's pass would find; the chooser is for the ones it knows.

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
  the editor does not model is never dropped: **as built (1b.3), a document the visual
  editor cannot hold without changing what it means is opened as Markdown instead**
  (below), rather than with opaque raw blocks inside the visual editor.
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

### The package, as built (ROADMAP 1b.1)

`packages/fjord-editor` exists (its own [`README.md`](../../packages/fjord-editor/README.md) and `CLAUDE.md`): the
interface of the sketch above, made exact, with a plain text area behind both editors until the real cores arrive
(1b.2, 1b.3).

- **The interface**: `DocumentEditor { value, onChange, role, comments, onNeedName }` and
  `NoteEditor { value, onChange, readOnly }`, and an `EditorHandle { focus() }` through a `ref`. `onChange` gets the
  whole new text and is never called for a change the app made by setting `value`, nor when the text may only be read.
  `role` is `view` (reads), `comment` (reads and starts threads) or `edit`.
- **`onNeedName: () => Promise<boolean>`** is called before an anonymous person's first edit or comment. `true`
  once the app has a name, `false` if they decline: nothing happens and it is asked again at the next attempt.
  Attempts made while it is still asking share one question, and one that fails is a no.
- **`comments` is a `CommentsAdapter`**: `threads()` (what to mark), `subscribe()` (live changes), `create(anchor)` (the
  person selected text and asked to comment), `open(threadId)`. The thread panel, replies, live updates and storage are
  the app's (§13). An `Anchor` is the tagged text-quote selector of §13, and `textQuoteAnchor(body, start, end)` makes
  one (UTF-16 offsets of the body as given, 32 characters of context either side).
- **Theming is custom properties**: the stylesheet uses `--fe-color-*`, `--fe-font-*`, `--fe-radius` and `--fe-space`,
  each with a default, and nothing else is a colour or a font. This app will map its `--sv-*` tokens onto them, which is
  how the package needs no design system.
- **One entry point**: a client can import `fjord-editor` and `fjord-editor/styles.css`, and nothing deeper.
- **A contract** (`src/contract.test.tsx`) says what an editor does whatever is behind it, and CodeMirror and MDXEditor
  must pass it unchanged. Checks of the package's promises about itself (MPL-2.0, React the only dependency, no
  `@sovereignfs`, styled only through its tokens, one entry point), every story rendering, and a build checked as a
  client takes it, run in CI (`.github/workflows/editor-ci.yml`) for a change to the package and nothing else.
- **Used by this app through the interface only** (1b.2): see *The note editor, as built* below.

### The note editor, as built (ROADMAP 1b.2)

`NoteEditor` is CodeMirror 6 (MIT) with light Markdown styling, and a note opens in it at its file page
(`/repo/<connection>/<vault>/<note>.md`).

- **Byte-faithful.** What goes in comes out unchanged but for what the person changed, which a text area cannot do (a
  browser turns every line ending into a line feed). CodeMirror is told what a line break is: CRLF when every break in the
  note is one, else LF, so a CRLF note stays CRLF and a note that mixes them keeps each carriage return as a character,
  shown as the control character it is. A byte order mark, trailing spaces, tabs, the absence of a final newline, NUL and
  U+2028 are kept. The text is read back with `sliceDoc`, since `doc.toString()` always joins with a line feed. A change the
  app makes by setting `value` is applied as the smallest change (so the cursor stays put), never reported as an edit, and
  not through the middle of a surrogate pair.
- **The round-trip corpus** (`packages/fjord-editor/corpus`): eleven real Markdown notes (meeting notes, a recipe, a
  README, Unicode, footnotes and HTML, whitespace, front-matter-like text, a very long line, an empty file, no final
  newline, math and tables), each tried as written, with CRLF, mixed and old-Mac endings, a byte order mark, no final
  newline, blank lines first and last, and a NUL and line and paragraph separators in it: open each, edit one word, and the
  result is the original with that word replaced. Each rule of the editor's state was seen to fail a test with it off.
- **What the page does.** It reads the note by its blob (once; the tree and manifests are already cached), strictly as
  UTF-8 with any byte order mark kept, to at most 1 MB, and shows it in the editor. What is typed is kept as a draft
  (§11, ROADMAP 1b.8); making it a version in the repository is 1b.9. A file that is not UTF-8, or is larger than 1 MB, says
  so and is not shown as a note. A document (`*.fj.md`) waits for its own editor (1b.3); an
  encrypted file stays locked.
- **Dressed in the design system's tokens.** The package knows only its own `--fe-*` custom properties; `app/globals.css`
  maps the `--sv-*` tokens onto them, so light, dark and any theme follow the page (checked in a browser in both).
- **How the package is consumed** (settled here, since this is the first page that renders it): it is a `link:` dependency
  on `../../packages/fjord-editor` and must be **built before the app is type-checked or built** (`pnpm build:editor`, the
  `build-editor` action in CI, a stage in the Dockerfile). The bundler's root is the repository's, so it follows the link
  (`next.config.ts`); the standalone server therefore sits under `clients/web/` in its output, and the image runs
  `clients/web/server.js`. Next's own React serves the app router, so the editor does not bring a second copy.

### The document editor, as built (ROADMAP 1b.3)

`DocumentEditor` is MDXEditor (pinned at 4.3.3 and upgraded on purpose: the safety check below depends on what it writes) for
the documents it can hold, and the note editor's byte-faithful Markdown for the rest. A document's page (`/repo/<connection>/<vault>/<name>.fj.md`)
reads the file and opens it like a note: the same draft as you type (§11), Save version, upstream changes and delete.

- **The editor is given the body, never the header.** `fjord-core` says where the body starts (`parseDocument`'s byte offset,
  turned into a place in the text), the app keeps the header in front of whatever the editor says, so a header with keys the
  app does not know comes back byte for byte (§9, spec §8.2). A header that cannot be read (not closed, not a mapping, not
  YAML) is not ours to split: the whole file is shown as Markdown.
- **A document opens in the visual editor only if its meaning survives it.** MDXEditor writes a document in its own style and
  refuses or normalises what it does not model. On opening, what it would write back must **parse to the same tree** as the
  text (`mdast`, with GFM tables, task lists and strikethrough) **with each paragraph's text as written, escapes included**, and
  the text must have **no carriage returns**; otherwise the document is shown in the Markdown editor, byte for byte, with a
  notice. Restyling (`-` for `*`, `*` for `_`, blank lines between blocks, a table's padding) is not a loss; what is: a
  tab-indented block turned into a list, two lists joined into one, a loose list made tight, a hard break made soft, a table row
  padded with a cell it did not have, and anything an extension reads that the editor would escape (`[[wiki links]]`, `[^1]`,
  `==highlight==`, `#tag`, `$maths$`). Raw HTML, footnotes, reference-style links and CRLF (which the editor would rewrite as LF
  from the first edit, in every line of the file) therefore open as Markdown. The check is made again whenever the app sets a
  different text, and once a document is shown as Markdown it stays so until it is opened again.
- **What the app is told.** Opening tells it nothing: no edit, no draft. An edit is the whole new body, in the editor's
  style, with the blank lines the body began and ended with (the one after the header, the final line break). An edit **undone** is
  no edit: the text the app gave comes back byte for byte, so typing and deleting again starts no draft. A person who declined to
  give a name has made no change: the document goes back to what the app holds.
- **The house style** until 1b.4 writes it down is what the editor is configured to write: `-` bullets, `*` emphasis and strong,
  `---` rules, fenced code. An edit restyles the whole document in it (not only the edited paragraph): the cost of the visual
  editor, and what the first-save preview in 1b.4 is for. Code blocks are edited in CodeMirror, in a short list of languages;
  a block in another language is kept as it is.
- **Comments are not built here.** The interface keeps the adapter and "Comment on selection" works for a selection of plain
  text, found in the Markdown by its text (nothing is anchored for one that crosses formatting or blocks). The marks that follow
  the document as it is edited, and their panel, are 1d.1 (§13).
- **The visual editor is loaded when a document first needs it** (`import()`), so a note's page is not slower for it. Its
  stylesheet is part of the package's (`fjord-editor/styles.css`), with the colour scales it sets on `:root` made local to the
  editor and its theme variables set from the design system's tokens, in light and dark (checked in a browser). The notices of
  what the editors are built on (242 packages, all permissive) are written when the package is built and carried by the image
  (`/usr/share/licenses/fjord-editor/THIRD_PARTY_NOTICES.txt`).
- **Not yet:** a strict Content-Security-Policy (§15, ROADMAP 1d.5) has to allow what the visual editor does, which is to set
  `style` attributes on the elements it draws; the house style written down (1b.4).

### Creating

Phase 1 can **create** documents and notes (name, vault and folder chosen; a valid
header written by `fjord-core`). Renaming, moving and deleting are in §8.

**As built (ROADMAP 1b.7).** A folder page of a plaintext vault has **New note** and **New document**. A person gives a
title and no more: the name and, for a document, the header are `fjord-core`'s, made on the server.

- **The name** is `fjord-core`'s `quick_note_name` / `free_name`, the one every client uses (a phone's quick note, the
  CLI). A note is named from its first line with the Markdown that makes a line something other than a title stripped, cut at
  60 characters on a word boundary, a name Windows reserves prefixed; with no title it is named after the writer's own local
  date and time (`2026-10-22 1430`, the browser says what that is) and is an empty file. A document is named from its title
  with `.fj.md`, and needs a title with something to name a file by. Either is numbered (`Plan 2.md`) past what the folder has,
  case aside (spec §5 rule 6). The text of a titled note is its heading, `# Title`. A document's header (`id`, `title`,
  `created`) is written by `fjord-core`'s `new_document`, with an identifier from the clock and `crypto.getRandomValues`.
- **One commit, one file.** `POST /api/connections/<id>/files` with `{ vault, folder, kind, title?, localMinute }` under §12's
  rules (signed in, this site's `Origin`, own repositories only; another's is a 404). What is sent is a place and a title,
  never a name or a text. The commit is made through the owner's token, authored by the person, never forced, with the message
  `Create <name>`, and the new file opens in its editor.
- **Two files made at one path are two files.** The name is worked out against the folder **at the head the commit goes on
  top of**. If someone adds the same name meanwhile the head has moved, so the folder is read again once and the next free
  name is taken; the other file is untouched. A head that keeps moving is `head_moved`, and nothing is made.
- **Where.** Only into a folder that is there (git has no empty folders, so one with nothing in it is not one; making folders
  is not part of this), of a vault that is plaintext, has a manifest that can be read and plain file names. An encrypted vault
  is refused (and not offered): files cannot be made there in this version.
- **Held to the CLI.** The acceptance is that created files verify: `src/files/cli.test.ts` checks out the repository the
  files were made in and runs the real `fjord verify --strict` over it (titled, untitled, numbered, Unicode, long, reserved,
  nested, documents), and sees a broken header reported. CI builds the CLI for one leg.

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

### Working copies, as built (ROADMAP 1b.8)

What is built is the first bullet above, the draft; versions are 1b.9 and the upstream-change choice is 1b.10.

- **One draft per file**, in `working_copy`, unique on connection and path. It holds the text exactly as typed (the editor
  is byte-faithful), the **base** (the git object id of the file the draft was started from, which a save never changes),
  who has edited it since (`[{ "type": "account", "id": … }]`, tagged so that a person without an account, 1c.6, needs no
  migration), when it was started and when it was last edited. Typing never commits anything.
- **When it is sent.** The page's `DraftSaver` (`src/working/saver.ts`) sends the text a second after the last change, and
  at the latest five seconds after the first change not yet sent, so typing that never pauses is still kept. Never more than
  one request at a time, so an older text can never replace a newer one; a text equal to what the server holds (the draft, or
  the note when there is none) is not sent, so typing and deleting again starts no draft. A request that fails is retried
  after 2, 5, 15 and then every 30 seconds with the latest text, and typing does not put a retry off. Leaving the page (it is
  hidden, closed, or navigated away from) sends what is waiting, with `keepalive`; only a text that could not be sent asks
  the person before they go.
- **API.** `PUT /api/connections/<id>/working-copy` with `{ path, baseBlob, content }` keeps the text; `DELETE …?path=`
  throws the draft away. Both need a signed-in caller and this site's `Origin`; another account's connection is a 404.
  `409 base_mismatch` (the draft is of another version of the file; it is left as it is), `422 unstorable` (the text has a
  NUL or an unpaired surrogate, which PostgreSQL's `text` cannot hold and UTF-8 cannot spell), `422 too_many_drafts` (500 per
  connection), `422 not_editable`, `413` (a text is at most 1 MiB). An answer carries when, never the text.
- **A draft is started only for an editable note**: a file that is, in the repository as it is now, a note in a plaintext
  vault. That asks the git host, so it is asked once, when the draft is started, and not at every save.
- **Concurrent saves lose nothing.** A save is a compare-and-swap on the time of the last edit (which only moves forward),
  retried a few times, so two saves at once both leave their editor in the list, on every database, with no transaction
  held across anything.
- **What the page does.** It finds the draft when the note is opened and shows it instead of the repository's text, saying so,
  with **Discard changes** (asks first) to go back to the note as the repository has it. If the note has changed upstream since
  the draft was started (its base is no longer the file's blob) the page says so and keeps the draft editable; choosing between
  the versions is 1b.10. Disconnecting a repository deletes its drafts, like its cached trees.

### Versions, as built (ROADMAP 1b.9)

**Save version** is built: one commit from the draft. The quiet-period commits by the worker are 1b.13, since there is no worker yet (§19 #5 stays at five minutes until then).

- **API.** `POST /api/connections/<id>/working-copy/version` with `{ path, message? }` under §12's rules (signed in, this
  site's `Origin`, own repositories only; another's is a 404). It answers `201 { commit }`, or refuses with a code and words
  for a person: `no_draft`, `nothing_to_save` (the draft is the file; it is dropped), `upstream_changed`, `gone`,
  `head_moved` (all 409), `read_only`, `bad_token` (422), `unavailable` (502). Nothing is written for any refusal, and the
  draft is kept except for `nothing_to_save`.
- **Only on top of the base.** The file at the branch's head must still be the blob the draft started from, and a regular
  file: otherwise nothing is written. A head that moved without touching the file is read again, once, and the commit goes on
  top of the new head; the commit is never forced and never retried blindly (`head_moved` is the cue to read again and decide,
  CLAUDE.md). The choice when the file did change is the next section.
- **Author and co-authors.** The author is the person who saved, as their account names them (name and address); the draft's
  other editors, found by account, are `Co-authored-by:` trailers after a blank line, once each, never the author again and
  never an account that is gone. A name is stripped of what could break a commit (angle brackets, control characters). The
  host's own identity commits. The address is the account's own: it is in the repository's history, so a public repository
  shows it.
- **The message** is the person's, up to 1000 characters, else `Edit <name>` (a note's file name without `.md`).
- **The draft ends with the version**, unless something was typed meanwhile (compare-and-delete on the time of the last
  edit): that is not in the version and is kept. The page makes the editor read-only while it commits, keeps what is on screen
  first (`flush`), and reads the page again after, saying "Version saved" once.

### Upstream changes, as built (ROADMAP 1b.10)

When the file at the branch's head is not the blob a draft started from, the note's page does not show an editor: it shows **both versions** (the draft and the repository's now), read-only and side by side, and three choices. It is the CLI's rule that a conflicting version is never destroyed (spec §9.1), for the web.

- **Combine** merges the draft's base, the draft and the repository's text by lines with `fjord-core`'s `merge3`, which the CLI's `sync` uses, through the format module's `mergeTexts`; it is one merge for every client. Edits in different places are simply both there. Edits of the same lines are both there between `<<<<<<< Your changes`, `=======` and `>>>>>>> In the repository` lines. The result becomes the draft, on the repository's version; nothing is written to the repository. The page says beforehand whether the two combine cleanly or in how many places they do not.
- **Keep mine** moves the draft onto the repository's version with its text as it is. The next **Save version** is then a commit on top of what is in the repository; theirs is not destroyed, it is the previous commit.
- **Take theirs** throws the draft away (the same call as Discard).
- **The server decides, not the browser.** The request names the choice and the blob the person was shown, never a text; the merge is made from the blobs. A choice is refused, changing nothing, if the file changed again since (`upstream_moved`), if the draft was typed into meanwhile (`draft_changed`, compare-and-swap on its last edit), or if it is no longer different (`up_to_date`); each makes the page look again. A version that cannot be read as UTF-8 text, or a merge that cannot be kept as a draft (a NUL from the repository, over 1 MB), cannot be combined and the page offers the other two.
- **Conflicts left in the text.** A text that still has marker lines is a draft like any other, with a warning above it, and its button reads **Save version anyway**: the person is asked, not stopped, since a note may say such lines for its own reasons.
- **When it is found.** When the page is opened, and when a version is saved: that leads to the same page, with nothing written. The `push` webhook that would flag it while the person is editing needs the GitHub App (ROADMAP 1a.6).
- **A note deleted upstream** keeps its draft: the page shows the unsaved text, read-only so that it can be copied out, and Discard. Making a note again from it comes with creating notes (1b.7).

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

**Link URLs** are `/doc/<id>?token=<token>`. A document id is not a secret (it is in
the file's frontmatter, so in the repository, its history and its commits), so a
link carries its own random token. On first use the server swaps the token for a
short-lived cookie scoped to that share and redirects to the clean `/doc/<id>`, so
the token does not stay in the address bar, history or `Referer`. Pages send
`Referrer-Policy: no-referrer`; tokens are redacted from logs. A password-protected
link asks for its password at that swap; passwords are hashed with Argon2id and
attempts are rate-limited.

**Signed-in users with a named share** use the plain `/doc/<id>`.

**Anonymous link users** choose a display name before they comment or switch to
edit mode; it is kept in the browser and shown on their comments and edits.

**Who can share:** the owner, in phase 1. Lifetime: until revoked; an expiry is
optional per link. Revoking a link, or a named share, ends sessions that used it.

*As built (ROADMAP 1c.1).* `src/access/policy.ts` is the one place that says what a role is: `decide(grants, action, target, now)`
answers `allow`, `forbidden` (let in, but not to this: a 403) or `hidden` (not let in at all, or nothing there to be let into: a
404, which does not say whether it exists). Grants are `owner`, a named `user` share or a `link` share with an optional expiry
that may be revoked; an expired or revoked link allows nothing, and when someone holds several the highest role wins. Roles
are the table above, each including the ones before; **a share never allows** making a version, creating, renaming, moving,
deleting, restoring, sharing or moderating comments, which are the owner's in phase 1. A note, a folder and a document in an
encrypted vault have no share, so a share finds nothing there. Finding someone's grants is not in it: the owner's is the
connection's ownership, and each way to share (1c.2, 1c.3) adds its own source, so the policy does not change as they arrive.
`src/access/routes.ts` lists every page and API route with who may use it (public; an account's own data; or a connection
owner doing a named action), and `routes.test.ts` reads `app/` and fails for a route with no entry, an entry with no route or
a method that does not match, so a new endpoint cannot be added without saying who may call it. The connection-keyed routes
stay the owner's, since a share never holds a connection; shares reach a document by routes keyed by its id, which arrive
with 1c.2 to 1c.6 and 1d and ask the policy for their action.

*As built (ROADMAP 1c.2), sharing with named accounts.* `POST /api/connections/<id>/shares` with `{ doc, email, role }` shares a
document with the account that has exactly that address; `GET …/shares?doc=<id>` lists who it is shared with (name, address,
role) and `DELETE` with `{ doc, accountId }` stops. The owner only (policy `manage_shares`; another's connection is a 404),
writes from this site, and only a document: a note, or an id the repository does not have, is refused. **The answer to sharing
is the same words whether or not the address has an account**: nothing is stored for an address with none (only existing accounts
are named), naming oneself stores nothing and says the same, and the cap of 100 shares a document is checked before the address
is looked up so that it cannot tell them apart either. The address is compared whole and without regard to case, never as a
prefix or pattern. The owner's list names the accounts a document is shared with (it is their own sharing, and the design allows
them to read it); an address that has no account never appears in it. A share is keyed by the connection and the Doc `id`, so it
follows the file when it is renamed or moved (1b.11). The account it was shared with opens it at the plain `/doc/<id>` (when it is
none of theirs): read with the owner's token, as it is in the repository now (a draft the owner has not saved is not shown), as the
title and the body in the document editor with the `view` role, saying who shared it and at what role. The header, the path
and the repository are not shown, nothing else of the owner's is reachable, and taking the share away ends it on the next
request. Comments (1d) and editing (1c.6) arrive for the roles that allow them. Not here: link shares (1c.3), the screen for managing
shares (1c.7), a list of what has been shared with you, and a limit on how fast an owner can try addresses.

*As built (ROADMAP 1c.3), share links.* `POST /api/connections/<id>/links` with `{ doc, role, expiresAt? }` makes a link and answers
`{ id, token, url }`, **the one time the token is seen**: it is 32 random bytes (43 URL-safe characters) of which only the SHA-256 is
stored, so a copy of the database opens no link. `GET …/links?doc=<id>` lists a document's links with their role, expiry and what has
become of each (`active`, `expired`, `revoked`) and never a token; `DELETE` with `{ doc, linkId }` revokes one and no other. Several
links per document (50 at most), each its own. The owner only (policy `manage_shares`; another's connection is a 404), writes from
this site, documents only, and an expiry must be in the future and within ten years. A link is of the connection and the Doc `id`, so
it follows the file when it is renamed or moved. `/doc/<id>?token=<token>` opens the document for **whoever has the link, signed in
or not**: the token must be one that was made, for **that** document (a link to one opens no other), and live: the policy is given its
role, expiry and revocation, and a link that has expired (from the moment of its expiry) or been revoked is as if it had never
been. A token that opens nothing now is not told apart from none given, so the page is then what it is for anyone: the sign-in.
The reader gets the title and the body at the link's role, read-only for now (comments and editing arrive with 1d and 1c.6), and not
the header, the path, the repository or who made it. Revoking ends a link on the next request. Not here: password links (1c.5), a
name before commenting or editing (1c.6), the screen for managing links (1c.7).

*As built (ROADMAP 1c.4), token handling.* A link's address carries its token, and a token left in the address bar stays in the
history, a bookmark, a screenshot and any log of the address, so **the first request is not a page**. `proxy.ts` hands
`/doc/<id>?token=…` to `/api/links/enter` (the rewrite names no token, since Next sends a rewritten address back in a response header),
which answers **a 303 to the clean `/doc/<id>` and a cookie**: `fjord_share=<token>`, `Path=/doc/<id>` (that document only),
`HttpOnly`, `SameSite=Lax`, `Secure` on https, and an hour at most and no longer than the link has to live. The page checks the cookie's
token against the store at every request, so **revoking or expiring a link ends what it opened on the next request**, with no session to
find and end. The answer is the same for a token that works and one that does not (the redirect, without the cookie); the token is
in neither the redirect nor the body, and the answer carries `Referrer-Policy: no-referrer` and `no-store`. **Every page sends
`Referrer-Policy: no-referrer`** (`next.config.ts`). **Tokens are redacted from logs**: the app never logs a token or a whole address
(an unexpected failure is logged by its name alone, and `next start` prints no request lines), and what it does not control is covered
by `src/sharing/redact.ts`, which the server installs over the console at start-up (`instrumentation.ts`) so that a `token=` in
an address, the share cookie's value, or a `"token"` of JSON is printed as `[redacted]`, in strings and in errors. It marks the token by
where it sits and does not guess at strings of its length, since a hash or an id looks the same and is no secret; a reverse proxy in front of the
app logs the address it is asked for, which is the operator's to set not to (`deploy/README.md`). The cookie holds the token itself,
which is acceptable because it is `HttpOnly`, scoped and re-checked on every use, and never put in a URL.

*As built (ROADMAP 1c.5), password links.* `POST …/links` takes an optional `password` (eight to two hundred characters). It is **hashed
with Argon2id** (Node's own `crypto.argon2`: no dependency to choose or keep up; 19 MiB, two passes, one lane, a random salt) and **only
the PHC string is stored**, with its parameters in it so they can be raised; the password is in no answer, no log and no list, which says
only `passwordProtected`. **A password link is not opened by its token**, which anyone with the link has: entering it leaves the token for
ten minutes in a pending cookie (`fjord_share_pending`, that document's path, `HttpOnly`) that opens nothing, and the page asks for the
password in a form that posts to a server action (so the password is in a request body, never an address). The right password gives the
cookie that opens it, `fjord_share=<token>.<proof>`, where the proof is a keyed hash (the server's secret, `FJORD_AUTH_SECRET`) of the
link and its password hash, so **setting the cookie by hand with only the token opens nothing**, a proof is no use for another link even
with the same password, and changing a link's password would end every cookie given for the old one. **Tries are rate-limited and one
at a time**: a try is first *claimed* in a single statement that only one of several at once can win, and each claim makes the next wait,
a second at first and after three wrong passwords five seconds doubling to a quarter of an hour; the right password starts again. A try
that comes too soon is not checked, so even the right password is refused then and a guess costs the same either way, and a password that
could not be one (too short, too long) is wrong without being hashed. The wait is the link's, not a visitor's, so someone who knows
the link can make its password wait for others for up to a quarter of an hour; the cost of that is a wait, and what it buys is that the
password cannot be guessed at speed. Revoking or expiring the link still ends the cookie on the next request. Not here: changing a
link's password or expiry after it is made, and the screen for managing links (1c.7).

*As built (ROADMAP 1c.6), editing through a link.* A link whose role is **edit** opens the document in the document editor, **with a name asked for
first**: until the person has given one (one line, up to 40 characters, no control characters or angle brackets, kept in their
browser) the editor can only be read, and the name is shown beside it. What they type is kept as the document's **working copy**,
the same draft the owner sees (a second after they stop, as for the owner), by `PUT /doc/<id>/draft`. That route is under `/doc/<id>` because
the link's cookie (1c.4) is sent there and nowhere else; there is no session, and the cookie is the credential: it must hold a token of a link of
*this* document that is live, whose role may `edit`, and for a link with a password the proof that it was given. A cookie that is absent,
wrong, for another document, expired or revoked is a 404 (not told apart from there being no document); a good one on a view or comment
link is a 403, which it may be told. Writes come from this site only. **Only the body is theirs**: the client sends the body, and the header
(the `id`, the title and whatever else) is the working copy's or the file's own, put back in front, so a guest cannot change what the
document is; a document whose header cannot be read is not edited through a link. The draft keeps the base it was started from whoever saves
it, and two people typing at once is last-write-wins until real-time editing (phase 3). `editors` gains the tag the design left room for,
`{ type: "guest", link, name }`, one entry per link and name (at most 50 per draft, then a new name is refused until a version is saved).
When the owner opens the document its page says the draft was made by them *and by* the names, and **Save version** credits each guest
by name: the author is the owner, and each guest is a `Co-authored-by:` trailer with an address that is nobody's
(`link-<link>-<hash of the name>@users.noreply.fjord.invalid`, so two names on one link are two credits and the address says it was a link, not
an account). A name is whatever the guest gives; it is not checked against anyone, which is what "the display name they gave" means. Not here:
a name before **commenting** (comments are 1d, which will use the same name), edit mode for a named account's `edit` share (the policy
allows it; the page does not yet), and seeing other guests type as they do (phase 3).

*As built (ROADMAP 1c.7), managing shares.* A document's page, for its owner, has a **Sharing** panel (closed until opened, which reads the two
lists). **People**: everyone it is shared with, by name and address, each with a role to change and *Stop sharing*, and *Share with* an
address at a role, answered in the same words whatever the address (sharing again with an address changes the role). **Links**: every link,
revoked ones included, with its role, whether it is active, expired or revoked, whether it has a password, and when it expires or whether it
does not; *Change* (role, expiry, a new password or none) and *Revoke* (asks first; a revoked link stays revoked and cannot be changed);
and *Make a link* with a role, an optional expiry and an optional password. A link's address is **shown once**, when it is made, with *Copy
link*: only a hash of its token is kept, so an existing link's address cannot be shown or copied again, and to share a link again one makes
another and revokes the old one. Changing a link is `PATCH /api/connections/<id>/links` with `{ doc, linkId, role?, expiresAt?, password? }`
(owner only, from this site; `expiresAt` a time in the future or `null`, `password` text or `null` to take it away; what is left out
stays): a later expiry revives a link that had expired, a new password forgets the wrong tries at the old one and ends every cookie given for
it (the proof in a cookie is bound to the password's hash), and a role change is in force on the next request. Notes, and anything in an
encrypted vault, have no panel. Not here: a list of what has been shared *with* you, and changing the address a person was shared with.

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
| `connection` | account, provider, how it is reached (`kind`), repository, branch, the id of its credential in `credential` (§7), when; where `/` lands is `account_default`, one row per account (§7); the vault chosen to open first is its nullable `default_vault` (§8) |
| `tree_cache` | connection, commit id, listing |
| `doc_index` | connection, path, `id` (null for a file read that has none), kind (document/note), blob id, when (§9). Only plaintext vaults; the blob it was read at decides whether a row is believed |
| `working_copy` | connection, path, base blob id, content, editors since last version (JSON), when started, last edit (§11). Whether the file changed upstream is not stored: it is the base compared with the file's blob when the page loads (a `push` webhook flag comes with 1b.10) |
| `deletion` | connection, path, `id`, kind, last blob id, deleting commit, deleted by, timestamp, restored (§8) |
| `share_user` | connection, Doc `id`, account, role, who shared it, when (§12); unique per document and account |
| `share_link` | connection, Doc `id`, token hash (never the token), role, expiry, revoked at, who made it, when (§12). a password hash for a link with one, and the failures and wait that rate-limit tries at it (1c.5) |
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

### Setting up a repository, as built (ROADMAP 1a.10)

The offer of §7, as it works (`src/browse/setup.ts`, `src/browse/screens/SetupOffer.tsx`):

- **When it is offered:** the repository has no `fjord.json` **and** no vault at its root. A `fjord.json` that cannot be read,
  or a repository with vaults and no `fjord.json`, is not offered it: the page says what is wrong, as before, and
  repairing a manifest is not this. The offer shows the repository, the branch, the vault's name (`Public`, else the next
  free one; the person may type another) and the exact list of files, each marked *New* or, for the one existing file that
  grows, *One line added*. Nothing is written until the button.
- **Looking is not writing.** To make the preview it reads the root of the repository (one request) and, as the connection
  did, tries a write that changes nothing (`canWrite`): a token that can no longer write is told why, instead of being
  offered what would fail.
- **The request carries only the vault's name** (`POST /api/connections/<id>/setup`, §12's rules: signed in, this site's
  `Origin`, the caller's own connection, another's a 404). The server reads the head, makes the plan again with the format
  module on the repository as it is then, and commits it on that head, never forced. If anything landed in between, nothing
  is written and the person is told to look again (`head_moved`, 409).
- **`.gitattributes` is read exactly.** The line is appended to the whole file, so the file is decoded strictly, byte order
  mark kept; one that is not valid UTF-8, is larger than 64 KiB, or is not a file is refused (`gitattributes_unreadable`)
  rather than rewritten from a lossy reading.
- **What it refuses**, in words and with nothing written: a repository that already has a `fjord.json` or vaults (409), a
  token that cannot write (422), and a vault name that is taken (case aside) or cannot be a directory (422, with the reason).
- **The commit** is authored by the host's identity for the token, with a message saying what was added. The tree cache is
  by commit, so the next view reads the new head.
- **Tested** against the in-memory host and the real module on all three databases (what is written, what is left alone,
  every refusal, a race), and in a browser against the git-backed fake GitHub (the preview, the commit and what it
  contains, a name taken, a race, who may call it).

### Deployment, as built (ROADMAP 1a.12)

- **The image** (`Dockerfile`, built from the repository's root because the format module is built from `crates/`):
  four stages. A Rust stage builds `fjord-wasm` with the `wasm-bindgen` version its lockfile names; a Node stage builds
  the editors' package (`packages/fjord-editor`); a second Node stage builds the app against it as a self-contained Next.js
  server (`FJORD_STANDALONE=1`, `next.config.ts`; the server comes out under `clients/web/`, since the bundler's root is the
  repository's, and the image runs `clients/web/server.js`); the runtime stage is Node and nothing else, about 100 MB, as an
  unprivileged user, with the migrations beside the server (it reads them from its working directory), the module in `/app/wasm` (marked CommonJS: the app's `package.json` says `"type": "module"`, and
  Node would otherwise read the module's glue as ESM and fail), and the licences in `/usr/share/licenses/`, including
  `@sovereignfs/ui`'s `NOTICE`, which a standalone build prunes. Its health check is `/api/health`, which also says
  whether the format module loaded (`"format": "ok"`), so an image without a working module is found by looking there.
- **Three setups** (`deploy/`): `compose.yaml` (the web service and sqld, which the web service waits for through a
  health check), `compose.file.yaml` (one container, `SQLITE_URL=file:/data/fjord.db` on a volume) and
  `compose.postgres.yaml`, an overlay that removes sqld and adds PostgreSQL. The port is published on the loopback
  address only, for a reverse proxy; the database services are not published at all. `deploy/README.md` has the
  configuration, the proxy, backups (each tried: back up, wipe, restore, sign in) and updating.
- **A server that cannot start stops.** `next start` exits when the start-up hook (`instrumentation.ts`) fails, but the
  standalone `server.js` the image runs logs it and keeps serving, every request an error, which a container manager
  sees as a container that is merely unhealthy. In production `register` now exits with `[fjord] cannot start: <why>`
  and a non-zero code, whichever way the server was launched.
- **Checked by CI** (job `image`): `scripts/deploy-check.sh` builds nothing and, given the image, brings each setup up
  from nothing, checks the database and the format module through `/api/health`, makes an account, takes the stack
  down keeping its volumes and up again, signs in, and checks that sign-in without a secret stops the container and names it.
- **Not built yet:** the `worker` (nothing to run until idle commits, 1b.13, and webhooks, 1a.6, exist; it will be another
  command of the same image), and publishing the image to a registry (a release step, with the `web-vX.Y.Z` tag).
  Continuous backups and a staging instance are the operator's.

## 18. Licence

`clients/web` is **AGPL-3.0-or-later**, because it bundles `@sovereignfs/ui`, which
is AGPL-3.0-or-later. The rest of the repository stays MPL-2.0 and the spec CC0.
`packages/fjord-editor` is meant to be reused by the desktop app, editor plugins and the
mobile client, so it is **MPL-2.0** and does not depend on `@sovereignfs/ui` (decided, §19 #4):
it takes its look from CSS custom properties, which this app maps its `--sv-*` tokens onto,
and carries its own small toolbar and menu components. MPL-2.0 may be combined into this
AGPL application. The design system bundles
icons derived from Lucide (ISC), whose notice must accompany a distributed copy: the
container image carries `@sovereignfs/ui`'s `NOTICE` (ROADMAP 1a.12, §17), and Next's
standalone output would otherwise prune it.

## 19. Open questions

| # | Question | Default until decided |
| --- | --- | --- |
| 1 | Moving an existing instance between dialects (SQLite ↔ PostgreSQL) | Not in phase 1; a documented export and import later |
| 2 | ~~When both auth methods are enabled, how are a local account and a Sovereign login linked?~~ **Decided (1a.4):** by `sub`, only from a signed-in session, and only when both use the same email address | — |
| 3 | ~~Offer to initialise a repository that is not a Fjord repository? With which vaults?~~ **Decided (2026-10-26):** offer, after a preview and a click, one plaintext vault, additive only, one commit; not for an empty repository yet (§7) | — |
| 4 | ~~Licence of `packages/fjord-editor`: AGPL with the design system, or MPL-2.0 without it?~~ **Decided (2026-10-26):** MPL-2.0, with no dependency on `@sovereignfs/ui` (§18) | — |
| 5 | Idle-commit interval | Five minutes |
| 6 | Branch: always the default branch, or choosable per connection? | Default branch; choosable later |
| 7 | House style for documents: exact list and emphasis markers, table layout | Write it down in 1b, with the round-trip corpus |
| 8 | Can an editor (not only the owner) share further? | Owner only in phase 1 |
| 9 | Notes in phase 1: sharing and comments? | Neither |
| 10 | Path route for notes without an id: `/repo/<connection>/<path>` | As written |
| 11 | Restore window for deleted files | 30 days, per instance |
| 12 | Converting a document to a note or back (changing the extension) | Not in phase 1; rename keeps the extension |

## 20. Decision log

| Date | Decision | Instead of |
| --- | --- | --- |
| 2026-10-22 | An account-based app at `fjord.sovereign.fs`, landing page for visitors, the default repository for users | The anonymous "scratchpad" playground (abandoned) |
| 2026-10-22 | Auth: better-auth, local (password + passkeys + TOTP) and/or Sovereign OIDC, by environment | — |
| 2026-10-22 | GitHub App, with a fine-grained PAT fallback; provider interface for other hosts | OAuth App (scope reaches every private repo); PAT only |
| 2026-10-22 | Documents are `*.fj.md`, notes any other `.md` | A new `.fjmd` extension (not rendered by GitHub, hidden by Obsidian); a frontmatter field (needs every file read to tell) |
| 2026-10-22 | Routes `/doc/<id>` and `/note/<id>`; path route until a note has an id | — |
| 2026-10-26 | The routes are spelled out: `/doc/<id>`, `/note/<id>` and `/repo/<connection>/<path>` | Single letters (`/d/`, `/n/`, `/p/`): shorter, but not readable in a link someone shares |
| 2026-10-22 | Document editor on MDXEditor; note editor minimal and byte-faithful; both in `packages/fjord-editor` | — |
| 2026-10-22 | Server-side working copies; versions on save or after a quiet period | A commit per save; copy-and-approve |
| 2026-10-22 | Shares: named users and links (public or password); view, comment, edit; until revoked, expiry optional | Expiring anonymous shares |
| 2026-10-22 | Link URL `/doc/<id>?token=…`, swapped for a cookie on first use | A separate share route |
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
| 2026-10-26 | A repository that is not a Fjord repository is offered the setup of one plaintext vault: a preview, a click, one additive commit of what `fjord init` writes | Never offering (a web-only person is stranded without the CLI); offering encrypted vaults (keys do not belong in the browser) |
| 2026-10-26 | `packages/fjord-editor` is MPL-2.0 and does not depend on `@sovereignfs/ui` | AGPL with the design system (every client that embeds it, the MPL-2.0 mobile client included, would have to be AGPL) |
| 2026-10-27 | The visual document editor is used only for a document it can hold without changing what it means, tested on opening; any other (raw HTML, footnotes, maths, CRLF, a loose list…) is shown as Markdown in the byte-faithful editor | Opaque raw blocks inside the visual editor (they need custom Lexical nodes, and the editor normalises silently what it does not refuse) |
