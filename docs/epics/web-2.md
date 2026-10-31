# Fjord Web — 2 — Encrypted files

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) (§2, §6 of the spec for the format); where it and this file disagree, the design is right. Section numbers (§) refer to it unless they say "spec".

**Status of the whole phase:** 📋 planned on 2026-10-31, nothing built. Phase 1's plaintext vaults are the model: each task here is one branch and one draft PR.

## What the phase promises, and what it does not

- **The operator cannot read an encrypted file.** An age identity is made, imported and used in the browser only; the server receives ciphertext and never a key, a passphrase or a plaintext (DESIGN §2). What the server and the git host *can* see is what the repository shows them anyway: the names of files in `plain` naming, the sizes, the history, and the recipients' public keys. In `id` naming the names are inside the container (spec §6.4) and are not seen.
- **`age -d` stays enough to recover a file** (root `CLAUDE.md`, invariant): the browser writes the same bytes the CLI would, and the cross-validation against the real `age` binary (P7) covers the browser's build as it covers the CLI's.
- **Not in this phase:** changing a vault's recipients (`fjord rekey` is the CLI's, and a rekey re-encrypts every file); searching inside encrypted files; collaborative editing of an encrypted document (phase 3 is plaintext); Web Crypto as a second implementation of age (one implementation, `fjord-core`).

## Prerequisites in fjord

| # | Task |
| --- | --- |
| P7 | `fjord-core`: age and the tar container in the pure subset |
| P8 | `fjord-wasm`: encrypt, decrypt, pack and unpack |

### P7 `fjord-core`: age and the tar container in the pure subset

**Status:** ✅ Done

**Design:** DESIGN §2; spec §6

Today `age`, `tar` and the identity types are behind the `native` feature (root `CLAUDE.md`, Architecture). Give them a feature of their own that builds for `wasm32-unknown-unknown`: no `std::fs`, randomness and the clock passed in (as `new_ulid_from` does), `getrandom` with its JS source only in the wasm build. scrypt (a passphrase-protected identity) is slow: check its cost in the browser before relying on it.

**Accepts when:** `cargo build --target wasm32-unknown-unknown` passes with the feature on; the existing tests and the `age` cross-validation job pass unchanged; the pure subset still builds without it.

- **Done as:** a `crypto` feature (`age`, `tar`, `zeroize`) that `native` includes, gating `crypto`, `container` and the recipients' parser in `manifest` (which uses `age` to check a key's checksum). `crypto.rs` and `container.rs` were already over bytes in memory, so nothing in them changed. `fjord-wasm` takes `crypto` and chooses `getrandom` 0.2's `js` source (the browser's and Node's `crypto.getRandomValues`) in its own Cargo.toml, so the CLI's lockfile and `cargo deny` stay free of `wasm-bindgen`. Checked: the three builds (`native`, `crypto` alone, neither) on the host, and `fjord-wasm` for `wasm32-unknown-unknown`; fmt, clippy and the 258 core tests pass.
- **Not as planned:** randomness is not supplied by the caller for encryption: `age` 0.12 draws its own file key and ephemeral secret, so the wasm build needs `getrandom` there. The rest of the pure subset still takes its clock and randomness as arguments.

### P8 `fjord-wasm`: encrypt, decrypt, pack and unpack

**Status:** ✅ Done

**Design:** DESIGN §2

Expose to JavaScript: parse an identity and a recipient; `encrypt(bytes, recipients)`; `decrypt(bytes, identity)`; the container's `pack(name, bytes)` and `unpack(bytes)` with every rejection of spec §6.4; generate an identity from supplied randomness. Secrets are `Uint8Array`s that are zeroed after use (the crate's `zeroize`), not strings that linger.

**Accepts when:** a file encrypted in Node through the module decrypts with the real `age` binary and the reverse; the §6.4 malformed-archive fixtures are all refused; the module's size and load time are recorded in the epic (it is built into the browser bundle).

- **Done as:** `generateIdentity`, `identityRecipient`, `checkRecipient`, `isWellFormed`, `encrypt`, `decrypt`, `wrapContainer` and `unwrapContainer` (`api.rs`, wrapped in `lib.rs`; `fjord-core` gained `crypto::recipient_of`). Secrets are `Uint8Array`s in and out, and the module wipes what it holds. Tested natively (5 tests) and from Node (`tests/js/crypto.test.mjs`): encrypt here and `age -d` there, and the reverse, binary and armored; an `age-keygen` identity; a wrong identity, no recipients and a secret given as a recipient refused; the container refusing two entries, a path in the name and a directory, built with the system `tar`. 102 JavaScript tests pass.
- **Size:** the module went from 553 KB (233 KB gzipped) to 961 KB (390 KB gzipped). That is a page load for a browser that does not need it, so 2a.1 loads the module that does the encrypting only when an encrypted vault is opened; the load time in a browser is for 2a.2 to measure.
- **Passphrase sealing, added the same day** (`fjord_core::crypto::seal_with_passphrase` / `open_with_passphrase`; `sealWithPassphrase`, `openWithPassphrase`, `passphraseWorkFactor` in the module): `age -p` over bytes, to keep an identity at rest. It is not a vault recipient (spec §6.2 still forbids that; a test says a recipients file cannot name one). A sealed file names its own work factor, so opening refuses more than 2^20 (age's default is 2^18) instead of holding a page for minutes; age 0.12's own message for that case overflows in a debug build, so it is replaced by ours.
- **Measured:** scrypt at age's default work factor (2^18) takes **about 3.5 s to seal and 3.5 s to open** in Node's WebAssembly, on this machine; a browser is of the same order. That is the cost of unlocking an identity once per session. 2a.1 decides between 2^18 and 2^17 (about 1.7 s, half the guessing cost for an attacker with a copy of the sealed file): the module takes the work factor as an argument, and opens a file made at either.

## 2a — Keys in the browser

### 2a.1 Identities

**Status:** ✅ Done

**Design:** DESIGN §2, §15 (to be written)

Make an age identity, or import one from a file or a pasted `AGE-SECRET-KEY-…`, in the browser. It is kept in IndexedDB only as an age **passphrase-encrypted** file (scrypt, P8's `sealWithPassphrase`: about 3.5 s at age's default work factor, measured), never as the bare key; the page unlocks it for the session (memory only, locked again on sign-out, on closing the tab and after a quiet period). The recipient (public key) is shown for adding to a vault by the CLI.

**Accepts when:** a test reads everything the page sends over the network, every cookie and all storage, and finds no key and no passphrase; a wrong passphrase unlocks nothing; a locked page lists encrypted files but opens none.

- **Done as:** `src/keys/`. `KeyStore` (`store.ts`) makes an identity (`create`) or takes one the person has (`import`: a file's text or the `AGE-SECRET-KEY-1…` line; only the key is kept), seals it with the passphrase (scrypt **2^17**) into IndexedDB beside its public key, and opens it into memory on `unlock`. `lock()` wipes it, so does a quiet fifteen minutes (`onLock` says so), and `with(fn)` lends the secret for one use and counts as use. Making or importing never replaces an identity that is kept (`exists`): it has to be removed first. A passphrase under 10 characters is refused. `/account/keys` (`KeyManager.tsx`) has the forms, shows the public key to add to a vault's recipients, and says that nothing is sent. The module loads from `/fjord-wasm/` the first time (`module.ts`).
- **2^17, not age's 2^18:** scrypt asks for 128 MB of memory at 2^17 and 256 MB at 2^18, which a phone's browser may refuse, and takes about 1.7 s instead of 3.5. Opening a file made at 2^18 still works.
- **Tested:** `store.test.ts` (10, with the real module: sealed at the work factor chosen, locked/unlocked, the wipe seen by holding the lent buffer, the idle lock under fake timers, import, refusals; breaking the wipe fails one) and `e2e/keys.open.spec.ts` in Chromium under the real policy: made, reloaded to locked, wrong then right passphrase, the IndexedDB record is `{sealed, recipient, createdAt}` with age's header and no text of the key, no request carries the passphrase or a key, no cookie or web storage does, no policy violation, and removal.
- **Not done:** the heavy call runs on the page's main thread (about 1.7 s, with a message showing); a Web Worker would keep the page responsive and is later work. Recovery is the person's own copy of the key: there is none to give (the page says so).

### 2a.2 Content-Security-Policy for WebAssembly

**Status:** ✅ Done

**Design:** DESIGN §15; phase 1's policy (1d.5)

The module needs `'wasm-unsafe-eval'` in `script-src` and nothing broader. Keep every other directive as it is; keep the nonce for scripts.

**Accepts when:** the security headers test names the one added token, and a page loads and runs the module under the policy in a browser test.

- **Done as:** `'wasm-unsafe-eval'` added to `script-src` (`src/security/csp.ts`) and nothing else: the unit test lists the four tokens and that `'unsafe-eval'` is not among them. The browser build of the module is copied to `public/fjord-wasm/` by `pnpm build:wasm` and by the image (Dockerfile), and served from this origin. The browser test above runs the module under the policy with a violation listener, and was seen to fail (the identity is never made) with the token removed.

## 2b — Read and write

### 2b.1 Browse encrypted vaults

**Status:** ✅ Done

**Design:** DESIGN §8; spec §6.2, §6.4

Today an encrypted vault is listed with a lock and nothing opens (1a.11). Show its files by name in `plain` naming (the suffix, from the manifest). In `id` naming the names are inside each container: list by id and show the real name only after the file is opened (decrypting every file to list a folder is not done).

**Accepts when:** both namings are listed correctly against the conformance fixtures; nothing is decrypted before the person asks to open a file.

- **Done as:** the listing was already there from 1a.11 (`discovery.json` holds both namings and the reading is held to it, `repository.test.ts`): a `plain` vault's files by their names without the suffix, an `id` vault's by their ids, all from the tree and none read. What changed is that each encrypted file is now a link, with a lock (`FolderView.tsx`), to the page that opens it (2b.2). In an `id` vault the list shows the id, not the name: the name is inside the container, and decrypting every file to draw a folder is not done (the page of a file shows the real name once it is opened).

### 2b.2 Open

**Status:** ✅ Done

**Design:** DESIGN §9, §10

The server returns the ciphertext (the blob, by the existing read); the browser decrypts it with the unlocked identity, unpacks a container, and gives the plaintext to the same editors as phase 1. A file the identity is not a recipient of says so, and shows nothing.

**Accepts when:** a document encrypted by the CLI opens, in both namings; a file for another recipient is refused with that reason; the server's logs and responses hold no plaintext (a test greps them).

- **Done as:** `GET /api/connections/<id>/ciphertext?path=` (`src/encrypted/`) hands the owner one encrypted payload of an encrypted vault, as stored (no key, nothing decrypted, `no-store`, at most 25 MB); a note in a plaintext vault, a file that is not there and another account's connection are the same 404, and the path is validated before anything is read. The file's page (`EncryptedFile.tsx`, in the file view of `/repo/…`) fetches it, decrypts it with the identity kept in the browser (`KeyStore.with`: the secret is lent for the call), unpacks the container of an `id` vault, and shows the text read-only in the note editor under the file's real name, or says that it is not text. A locked identity asks for its passphrase on the page; none sends the person to the Keys page; a file for another key is refused in words and shows nothing. **Hide** drops the text; the plaintext bytes are wiped as soon as they are a string; locking by itself (the quiet period) hides it too.
- **Tested:** `src/encrypted/http.test.ts` (26: who may ask, what may be asked, each refusal; the sign-in and path rules switched off to see their tests fail) and, in Chromium, a file encrypted in Node by the same module the CLI's format shares: a `plain` file and an `id` file in a container (its name read from inside), a wrong passphrase, a file for another key, hide and open again, and the server's requests and answers searched for the plaintext, the file name, the passphrase and the key (none), the ciphertext seen among them, no policy violation, and the route's 401 and 404.
- **Not here:** editing (2b.3); documents shown in the visual editor (they are shown as Markdown, read-only, in the note editor); a file shared to someone else (a sealed share is 2c.1); opening with the CLI-made fixtures of `tests/fixtures/` rather than ones made by the module (the module is held to the real `age` both ways in P8).

### 2b.3 Edit and drafts

**Status:** 📋 Planned

**Design:** DESIGN §11

A draft of an encrypted file is **kept encrypted to the vault's recipients**: the browser encrypts the text before each debounced send, and the working copy holds ciphertext (a flag on the row). A version is then the draft's bytes as they are, committed with no key on the server, by the person's Save version or by the worker's idle version (1b.13), which needs no change because it never reads a draft. Combining with an upstream change (1b.10) happens in the browser, on plaintext, then is encrypted again.

**Accepts when:** a database dump taken while a draft exists holds no plaintext; an idle version of an encrypted draft is committed without any key; the CLI opens what the browser saved, and the reverse.

### 2b.4 Create in encrypted vaults

**Status:** 📋 Planned

**Design:** DESIGN §9; spec §6

New notes and documents in an encrypted vault: the file name in `plain` naming, a generated id in `id` naming (a container inside), the recipients read from the vault's manifest.

**Accepts when:** `fjord verify` passes on what is created, in both namings.

### 2b.5 Rename, move and delete

**Status:** 📋 Planned

**Design:** DESIGN §8; spec §6.4, §7.2

In `plain` naming the same one-commit operations as phase 1 (the name is public). In `id` naming a rename **rewrites the container** (the name is inside it), so it decrypts, repacks and encrypts again. Undo and Recently deleted restore a ciphertext blob as they restore a plaintext one.

**Accepts when:** each operation in each naming leaves a repository that verifies and that `age -d` still recovers.

### 2b.6 Moving files in and out of vaults

**Status:** 📋 Planned

**Design:** DESIGN §8

Between a plaintext and an encrypted vault the file is encrypted or decrypted in the browser on the way, and the moves that would leave plaintext where there must be none (invariant 1) are refused.

**Accepts when:** a move into an encrypted vault leaves no plaintext of the file anywhere in the new commit; a move out asks first.

## 2c — Sealed shares

### 2c.1 Sealed link shares

**Status:** 📋 Planned (§19 #13)

**Design:** DESIGN §12

A share of an encrypted document cannot be read by the server, which has no key. A sealed share is a **link whose key is in the `#fragment`** (never sent to the server), or derived from a password by a slow hash: the sharer's browser re-encrypts a copy of the document, and later comments, to that key, and the server stores and serves only that ciphertext. Revoking deletes the copy.

**Accepts when:** a test of the server's stored copy, requests and logs finds neither the key nor the plaintext; a link opened in a private window reads the document; revoking ends it.

### 2c.2 Security review of phase 2

**Status:** 📋 Planned

**Design:** DESIGN §15

As 1d.5 was for phase 1: what each role and each process can see, written down and turned into tests, including the identity's life in the browser, extensions and a compromised page script, which end-to-end encryption in a web page cannot defend against and the review says so.

**Accepts when:** the review is in `docs/` and each of its checks is a test or an explicit, argued exception.
