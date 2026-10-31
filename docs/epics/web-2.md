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

**Status:** 📋 Planned

**Design:** DESIGN §2

Expose to JavaScript: parse an identity and a recipient; `encrypt(bytes, recipients)`; `decrypt(bytes, identity)`; the container's `pack(name, bytes)` and `unpack(bytes)` with every rejection of spec §6.4; generate an identity from supplied randomness. Secrets are `Uint8Array`s that are zeroed after use (the crate's `zeroize`), not strings that linger.

**Accepts when:** a file encrypted in Node through the module decrypts with the real `age` binary and the reverse; the §6.4 malformed-archive fixtures are all refused; the module's size and load time are recorded in the epic (it is built into the browser bundle).

## 2a — Keys in the browser

### 2a.1 Identities

**Status:** 📋 Planned

**Design:** DESIGN §2, §15 (to be written)

Make an age identity, or import one from a file or a pasted `AGE-SECRET-KEY-…`, in the browser. It is kept in IndexedDB only as an age **passphrase-encrypted** file (scrypt), never as the bare key; the page unlocks it for the session (memory only, locked again on sign-out, on closing the tab and after a quiet period). The recipient (public key) is shown for adding to a vault by the CLI.

**Accepts when:** a test reads everything the page sends over the network, every cookie and all storage, and finds no key and no passphrase; a wrong passphrase unlocks nothing; a locked page lists encrypted files but opens none.

### 2a.2 Content-Security-Policy for WebAssembly

**Status:** 📋 Planned

**Design:** DESIGN §15; phase 1's policy (1d.5)

The module needs `'wasm-unsafe-eval'` in `script-src` and nothing broader. Keep every other directive as it is; keep the nonce for scripts.

**Accepts when:** the security headers test names the one added token, and a page loads and runs the module under the policy in a browser test.

## 2b — Read and write

### 2b.1 Browse encrypted vaults

**Status:** 📋 Planned

**Design:** DESIGN §8; spec §6.2, §6.4

Today an encrypted vault is listed with a lock and nothing opens (1a.11). Show its files by name in `plain` naming (the suffix, from the manifest). In `id` naming the names are inside each container: list by id and show the real name only after the file is opened (decrypting every file to list a folder is not done).

**Accepts when:** both namings are listed correctly against the conformance fixtures; nothing is decrypted before the person asks to open a file.

### 2b.2 Open

**Status:** 📋 Planned

**Design:** DESIGN §9, §10

The server returns the ciphertext (the blob, by the existing read); the browser decrypts it with the unlocked identity, unpacks a container, and gives the plaintext to the same editors as phase 1. A file the identity is not a recipient of says so, and shows nothing.

**Accepts when:** a document encrypted by the CLI opens, in both namings; a file for another recipient is refused with that reason; the server's logs and responses hold no plaintext (a test greps them).

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
