# Fjord Web — security review of phase 2

The review of ROADMAP task 2c.2 ([`docs/epics/web-2.md`](epics/web-2.md)), as [`security-review-phase-1.md`](security-review-phase-1.md) was for phase 1: what phase 2 promises
(encrypted files that the server cannot read, an age identity that stays in the browser, sealed shares), tried against the running app and the code, what was found,
what was done, and what is left and why. Each promise that holds is a test, and each test was seen to fail with the protection switched off. It is a record of one review at
one time (November 2026); the promises stay in [`clients/web/DESIGN.md`](../clients/web/DESIGN.md) (§2, §8, §11, §12, §15).

## What the promise is, and what it is not

> The server never holds an encrypted file's plaintext or a key, and nothing it is sent, stores, logs or serves lets it, or anyone who reads its database or its network
> traffic, read one.

That is a promise about a **passive** server and everything around it: an operator reading the database or the logs, a backup, a network observer, another account, a
person who reads the repository. It is **not** a promise against a server, or a page script, that is *active*. End-to-end encryption in a web page cannot be: the page is
served by the party it is meant to be hidden from, so a server that wanted to could serve a script that reads the identity once it is unlocked, or the text once it is
shown. Nothing in this app can prevent that, and the review says so rather than pretend. What the app does is make it **not happen by accident and not happen to a page that
has not been changed**: a strict Content-Security-Policy (no third-party script, no `unsafe-eval`, WebAssembly only from this origin), the identity opened only by the person's
passphrase and locked after fifteen quiet minutes, nothing secret in a request, a URL or a log. Someone who needs more than that — a hostile operator in the threat model —
should use the command line or a desktop client, whose code is not served by the party being guarded against. The product says the same (§15).

## Who sees what

| | Plaintext of an encrypted file | The identity (secret key) | The key or password of a sealed link | Names, sizes, times |
| --- | --- | --- | --- | --- |
| **The server's process and database** | No: it holds age bytes (drafts, shares, and the repository's files), and refuses anything that does not begin as an age file | No: it is made, sealed and kept in the browser; no request carries it | No: the key is in the link's fragment, which no request carries; the password is typed in the viewer's browser | Yes (see the exceptions) |
| **Its logs and error messages** | No: unexpected failures are logged by name only; the redactor also masks `/s/<token>` | No | No | Paths only |
| **The network (TLS terminated at the proxy)** | Only a file *moved out* to a plaintext vault, after the page asks | No | No | As above |
| **The git host and anyone who reads the repository** | No (ciphertext). *Plain text that was in the repository before it was moved in stays in its history*, and the page says so | No | No | File names in a `plain`-named vault; identifiers in an `id`-named one |
| **Another account** | No: every route that reads or changes an encrypted file is the owner's, and another account's is the same 404 as a missing one | No | No | No |
| **A holder of a sealed link** | The one shared copy, as it was, read-only | No | The key, if the link has it | The copy's size and mode |
| **A hostile sharer** (their link, your browser) | They choose what is shown to you: it is text and nothing runs; they cannot make your browser do ruinous work | — | — | — |
| **A collaborator with write access to the repository** | Not what is already there; they can add a key to a recipients file, so later files are also encrypted to them (see the exceptions) | No | No | Yes |
| **A browser extension, malware, or a script changed in the server** | Yes, once decrypted and shown | Yes, once unlocked | Yes | Yes — see the section above |

## What was found, and what was done

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | **Put back could cross between plain text and an encrypted vault.** *Put back* takes an optional path for a single file and checked that its kind (`.md`) was kept. Since 2b.5 made encrypted vaults writable, a deleted *plaintext* `.md` could be put back at `Vault/x.md` in an **encrypted** vault, which writes plain text into one (invariant 1); and a deleted `….age` could be put back into a plaintext vault or another encrypted vault (with other recipients and naming). Found by listing every route that writes and asking each what it does when the destination is the other kind of vault; shown first by a failing test. | **Fixed**: what is put back must be the form of the vault it goes to (`….age` in an encrypted vault and nothing else there), and an encrypted file goes back only to its own vault (`restore.ts`, `encryptedVault`; the page's server passes it from the repository). Unit tests, and the hostile-API test below. |
| 2 | **A sealed copy could ask the opener for ruinous work.** A password-sealed copy states its scrypt work factor in its own header, and the module accepts up to 2^20 (a gigabyte of memory and many seconds). The copy comes from whoever made the link, so a hostile link could hang or crash the viewer's tab before it said the password was wrong. | **Fixed**: the header is read first and a copy asking for more than age's own default (2^18) is refused with no work done (`seal.ts`, `MAX_SHARED_WORK_FACTOR`). Ours are 2^17. Unit test with a rewritten header (it also checks that it answers in well under a second) and a browser test. |
| 3 | **The vault's own files could be deleted, moved or sent by an API call.** The page offers these for encrypted files only, but the server accepted a call naming the recipients file or `.gitignore` of an encrypted vault, which would break the vault (plaintext guard and recipients). | **Fixed**: in an encrypted vault only an encrypted file (`….age`) is deleted, moved or sent from by a call that names it (`access.ts`). Unit and browser tests. |
| 4 | **A very large decrypted file was put in an editor.** A collaborator can encrypt a file of up to the 25 MB the server hands over to someone's key; opening it would freeze the tab. | **Fixed**: more than 1 MiB of decrypted text is not put in an editor (`files.ts`, `MAX_TEXT_BYTES`), in either naming, and the page says so. |
| 5 | **The recipients a file is encrypted to were invisible** at the moment of encrypting, though anyone who can write to the repository can add one. | **Partly addressed**: the page says how many recipients the vault lists and that anyone who can write to the repository can change the list; it already warned when the person's own key is not among them. Pinning the list and warning on a change is later work (exception E5). |
| 6 | Disconnecting a repository deleting its sealed copies was claimed and untested. | **Tested** (`connections/service.test.ts`). |
| 7 | The headers of the sealed share page, the content of a copy from a hostile sharer, and the no-referrer promise were claimed and untested. | **Tested** and held: the page is sent with the policy and a nonce, `frame-ancestors 'none'`, no `unsafe-eval`, `Referrer-Policy: no-referrer`, `noindex`; the copy's API is `no-store`; a name and text made of script, handler, `javascript:`, frame and remote-image markup are shown as text, nothing runs, no request goes to another site, no policy violation. |

## The checks, as tests

Each is a test that was seen to fail with the protection switched off (or, for finding 1, before the fix).

| Check | Test |
| --- | --- |
| No route writes plain text into an encrypted vault: a plain create, plain text as an encrypted file, a plain draft of an encrypted file, plain text as an encrypted draft, a move in, a transfer in, a put back, a sealed copy | `e2e/repositories.open.spec.ts` ("review of phase 2: nothing but ciphertext…") calls every one with hostile input, expects the refusal each time, and finds the repository unchanged and no file of the vault holding the marker. Unit: `working/service.test.ts`, `working/version.test.ts`, `files/create-encrypted.test.ts`, `files/transfer.test.ts`, `files/encrypted-changes.test.ts`, `sealed/http.test.ts` |
| No ciphertext in a plaintext vault, nor in another encrypted vault | the same test; `files/transfer.test.ts`, `files/encrypted-changes.test.ts` |
| The vault's own files are not changed by a call | `files/access.test.ts`; the browser test above |
| Another account reaches none of an encrypted file's routes, its recipients, or its sealed shares: the same 404 | the browser test above; `encrypted/http.test.ts`, `sealed/http.test.ts`; the registry matrix (`e2e` "every route that changes something…", `access/routes.test.ts`) covers each new route |
| Nothing the server is sent or says holds the plaintext, the identity, a passphrase, a link's key or password: identity, open, edit, create, rename, move, transfer, share | `e2e/keys.open.spec.ts`, and the encrypted-file tests of `e2e/repositories.open.spec.ts`, which search every request and answer |
| Only an age file is kept as a draft, a version, a new file, a transferred file or a sealed copy | the unit tests above; each check was switched off in turn |
| A sealed link: the key is only in the fragment; a private window opens it; revoking deletes the copy and the link stops working; disconnecting deletes it | `e2e/repositories.open.spec.ts` ("an encrypted file is shared by a sealed link…"), `sealed/service.test.ts`, `connections/service.test.ts` |
| Tokens are kept out of logs, `/s/<token>` included | `sharing/redact.test.ts` |
| The identity: sealed with scrypt (2^17), wiped when locked, locked after fifteen quiet minutes, never in a request, cookie or storage but its IndexedDB record | `keys/store.test.ts`, `e2e/keys.open.spec.ts` |
| The page may compile WebAssembly and run nothing else new: `'wasm-unsafe-eval'` and no `unsafe-eval`; the module is this origin's | `security/csp.test.ts`, `e2e/keys.open.spec.ts`, and the sealed page's headers in the browser test |
| A hostile sharer's content is text; their copy cannot ask for ruinous work | `e2e/repositories.open.spec.ts` ("review of phase 2: a sealed link from someone hostile…"), `sealed/seal.test.ts` |
| A file larger than a note is not put in an editor | `keys/files.test.ts` |
| The module agrees with the real `age` and the CLI on what it makes and opens; the repository verifies after every operation | `crates/fjord-wasm/tests/js/crypto.test.mjs`; `files/cli.test.ts` with `FJORD_CLI` and `age` (web CI installs both on one leg) |

## Recorded, not changed

Each is an exception that is argued, not an oversight.

- **E1. An active attacker on the server or the page** defeats end-to-end encryption in a web page (above). Mitigated by the policy and by there being no third-party code; not preventable here. A user who cannot trust the operator should use the CLI.
- **E2. Extensions, malware, shoulder-surfing and anything in the browser with the page's rights** see what the page sees. Out of scope.
- **E3. Decrypted text is a JavaScript string**, which a page cannot wipe. The page wipes every byte buffer (the identity, the passphrase, the plaintext before it becomes text) and drops the text when the person hides the file or the identity locks, and says so; the string lives until the garbage collector takes it.
- **E4. The identity at rest** is in IndexedDB sealed by a passphrase through scrypt at 2^17 (about 1.7 s a guess). Someone who copies the browser profile can guess offline; only the length (at least ten characters), not the strength, is enforced. The Keys page says the passphrase cannot be recovered.
- **E5. The recipients file is trusted as it is in the repository.** Anyone who can write to the repository can add a key to it, and files encrypted afterwards (in the web client or the CLI alike) are also encrypted to that key. The page shows how many recipients there are, and warns when the person's own is missing; it does not pin the list or warn when it changed. Later work.
- **E6. A sealed link's key can leak with the link**: browser history and its sync, a copied address, a screenshot. A fragment is not sent to any server or in a `Referer`, but it is part of the address. A password link has no key in it, but gives its ciphertext to anyone with the token, who can try passwords offline at one scrypt each; length (at least ten) and the work factor are the defence. A link has no expiry and is a snapshot (it does not follow the file; revoke it and make a new one). Comments on a sealed copy are not built.
- **E7. Reading a sealed copy is not rate-limited**, as reading is not in phase 1 (§15): the token is 256 bits, so there is nothing to guess; a holder can fetch the copy as often as they like. The number of copies is bounded (20 a file, 200 a repository), and each is at most about 1.5 MB.
- **E8. Metadata is not hidden.** The server (and the repository) know file names in a `plain`-named vault, folder names in both, sizes, who committed and when, the commit messages (which name no secret: an id-named file is only ever an identifier), the lists of editors and timestamps of drafts, and the records of deleted paths. An `id`-named vault hides names; nothing hides sizes or timing.
- **E9. The server can roll a file back or swap one valid ciphertext for another** to the same recipients (age authenticates a file, not its place in history). Git history is the check, as with the CLI; the page shows no such warning.
- **E10. The server cannot check who a draft or copy is encrypted to.** It sees only that the bytes are age. A page that encrypted to the wrong key (a bug, or finding 5's hostile page) would be believed. The recipients are the repository's, and the page encrypts to what it reads.
- **E11. Plain text moved in stays in git history**, and plain text moved out is committed. The page asks first and says both; history is not rewritten.
- **E12. A plaintext draft whose vault was later turned into an encrypted one** (someone edits the manifest without encrypting the files) would be committed as it is. The file at the draft's base would already be plain text in an encrypted vault by their own doing; not guarded.
- **E13. The unlock and the sealed password's key derivation run on the page's main thread** (about 1.7 s freeze). A Web Worker would keep it responsive; not a security matter.
- **E14. Not done in this review:** a penetration test by someone else; fuzzing of the module's age and tar readers beyond the conformance and cross-checks with the real `age`; reading a running instance's log output (the redactor is held by unit tests).
