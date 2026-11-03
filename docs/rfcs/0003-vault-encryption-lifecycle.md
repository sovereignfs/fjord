# RFC 0003: Encrypting and decrypting a vault

**Status:** Implemented
**Amends:** spec §6 (adds §6.7)
**Touches:** `fjord-core` (`scaffold`), `fjord-cli` (`fjord encrypt --permanent`, `fjord decrypt --permanent`)

## Summary

`fjord encrypt <vault> --permanent` makes a plaintext vault an encrypted one in one command, and `fjord decrypt <vault> --permanent`
makes an encrypted vault a plaintext one again. **Without the flag, `fjord decrypt <vault>` and `fjord encrypt <vault>` stay what they
were: the checkout (spec §6.6), which decrypts a vault for editing and puts it back, and changes nothing about what the vault is.** The
flag is never the default.

## Motivation

The CLI could make an *encrypted vault* (`vault add --encrypted`, `init`), check one out and back in, and encrypt a directory when
adopting it (`init --adopt --encrypt-existing`, which then needed a key, `key add` and `fjord encrypt <vault>` by hand). It could not
take a vault that already exists and encrypt it, and it could not make an encrypted vault plaintext at all: `fjord decrypt <vault>` is a
checkout that ends in `fjord encrypt`, and `export` writes a copy elsewhere. The commands' help also did not say which was which.

## Gaps this closes

| Gap | Closed by |
| --- | --- |
| No way to encrypt an existing plaintext vault in one command | `fjord encrypt <vault> --permanent` |
| No way to make an encrypted vault plaintext | `fjord decrypt <vault> --permanent` |
| Whether the manifest, recipients file, guard and merge guard are all right was the user's to get right | `fjord_core::scaffold::plan_encrypt_vault`, `plan_decrypt_vault`: the same files as `vault add`, with the vault's own fields kept |
| The spec had no rule for either direction | spec §6.7 |
| `encrypt` and `decrypt` of a vault were a checkout and could not be told from a conversion | the checkout is the default and `--permanent` the conversion, in the help and the README |
| `fjord open --commit` could commit during a checkout (spec §6.6 (6)) | it refuses, as `sync`, `rekey` and `vault add --commit` do |

## Design

Both are built on the checkout and write no plaintext into an encrypted vault any other way (invariant 1).

- **Encrypt:** the recipients (`--recipient`, else the identity's own public key), the identity (to prove each payload opens before the
  plaintext goes, §6.6 (8)), a question that says history keeps what was committed; then the adoption checkout is begun, the recipients
  file, guard and manifest are written, and the checkout is checked in.
- **Decrypt:** an ordinary checkout, then the manifest, the payloads, the recipients file and the guard, and the record last; plaintext is
  never removed.
- `--commit` commits the vault, and what the conversion changed outside it, and nothing else; `--yes` is required without a terminal.

## Not here

- Changing a vault to or from `id` naming (names would have to be moved into containers or out of them).
- Converting a vault in the web client. It can make an encrypted vault and move a file into one, and a whole-vault
  conversion would need every file rewritten in the browser; it is a task of its own.
- Rewriting history. Neither direction does, and both say so.

## Changelog

| Date | Change |
| --- | --- |
| 2026-11-03 | Written and implemented with the commands. |
| 2026-11-03 | The conversions moved from `fjord vault encrypt` and `decrypt` to `--permanent` on `encrypt` and `decrypt`: the checkout is the default. |
