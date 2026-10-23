# The Fjord Repository Format

**Version:** 1 (draft)
**Status:** Draft. Not yet stable; breaking changes possible until declared stable.
**Date:** 2026-10-23

---

## 1. Introduction

Fjord is a specification for storing **documents** in a Git repository that
the owner controls, with optional end-to-end encryption using
[age](https://age-encryption.org/v1).

The specification is the product. Fjord client applications are
implementations of it, not owners of it. A conforming repository can be read,
edited and fully recovered using a text editor, `git`, and `age` — with no
Fjord software involved, at any point, ever.

### 1.1 Scope

Fjord stores documents and the attachments that belong to them: Markdown,
PDFs, spreadsheets, scanned pages, pasted images.

Fjord is **not** a photo or video store. Media libraries are explicitly out
of scope and there is no plan to extend the format to cover them. Git is a
poor fit for large binary files, and a format that invited them would fail
its users. Implementations SHOULD warn when a single file exceeds 25 MB, but
MUST NOT refuse it.

### 1.2 Transport

Git is the only transport defined by this version. History, ancestry and
three-way merge all come from Git, and the format depends on them.

All state defined here lives in ordinary files. Nothing is stored in Git
objects, refs, notes or hooks. A future version may therefore define
non-Git storage, with reduced guarantees, without breaking this one.

### 1.3 Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| Term | Meaning |
| --- | --- |
| **Repository** | A Git repository containing `fjord.json` at its root. |
| **Vault** | A top-level directory containing `fjord.vault.json`. The unit of encryption. |
| **Fjord Doc** | A `.md` file in a vault whose frontmatter contains a valid `id`. |
| **Document** | A Fjord Doc whose file name ends in `.fj.md`. See §8.4. |
| **Note** | Any other Fjord Doc. See §8.4. |
| **Vault file** | Any other file in a vault. First-class, synced and encrypted, but carries no Fjord metadata. |
| **Client** | Any software that reads or writes a repository. |
| **Identity** | An age private key, held by a user, never stored in the repository. |
| **Recipient** | An age public key to which files are encrypted. |

---

## 2. Repository structure

```
<root>/
├── fjord.json              REQUIRED
├── .gitattributes          REQUIRED
├── .gitignore              RECOMMENDED
├── .fjord/                 RESERVED
└── <Vault>/                zero or more
    ├── fjord.vault.json    REQUIRED
    ├── recipients.txt      REQUIRED if encrypted
    ├── .gitignore          REQUIRED if encrypted
    └── …                   documents and directories, nested freely
```

### 2.1 The filesystem is authoritative

A directory is a vault if and only if it contains `fjord.vault.json`.

`fjord.json` lists vaults as a convenience. It is **not** an index of
documents and MUST NOT be treated as authoritative. Where the manifest and
the filesystem disagree, the filesystem wins, and clients SHOULD repair the
manifest.

Clients MUST tolerate files and directories they did not create. A document
added by another editor, or arriving via `git pull`, is part of the vault
immediately and MUST NOT be quarantined, renamed or deleted.

### 2.2 Reserved paths

The following are reserved and MUST NOT be used to store user documents:

- `/fjord.json`
- `/.fjord/` and everything under it
- `<vault>/fjord.vault.json`
- the recipients file named by a vault's `encryption.recipients`

`/.fjord/` is reserved for client machinery. Its layout is not specified in
version 1. Clients MUST NOT assume anything they place there will be
understood, or preserved, by another client. Derived data — search indexes,
caches, decrypted working copies — MUST NOT be committed.

### 2.3 Vaults

A repository MAY contain any number of vaults, each independently encrypted
or not. Vaults MUST be directories at the repository root; nested vaults are
not permitted in version 1.

A vault's directory name is its address. Its `name` field is its label. The
two need not match.

---

## 3. `fjord.json`

Plaintext, at the repository root, UTF-8, no BOM.

```json
{
  "fjord": 1,
  "id": "01jagc4k7pqw2xn8rvty5zb3md",
  "name": "Fjord",
  "createdAt": "2026-10-16T09:34:00Z",
  "generator": "fjord 0.1.0",
  "vaults": [
    { "path": "Public",  "id": "01jagc4k7pr9tbm3ykwx6zq2hv" },
    { "path": "Private", "id": "01jagc4k7psd5vnz8qmt3yxb4k" }
  ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `fjord` | integer | yes | Format version. `1` for this specification. |
| `id` | ULID | yes | Identifies the repository. Immutable. |
| `name` | string | yes | Display label. |
| `createdAt` | RFC 3339 | yes | MUST be UTC, with `Z`. |
| `generator` | string | no | Tool and version that created the repository. |
| `vaults` | array | yes | Objects with `path` (relative, no `..`, no leading `/`) and `id` matching that vault's own `id`. |

---

## 4. `fjord.vault.json`

One per vault. **Always plaintext**, including in an encrypted vault — it
must be readable to discover how to decrypt. It MUST NOT contain secrets.
Public keys are not secrets; a vault's `name` is not protected.

```json
{
  "fjord": 1,
  "id": "01jagc4k7psd5vnz8qmt3yxb4k",
  "name": "Private",
  "createdAt": "2026-10-16T09:34:00Z",
  "encryption": {
    "tool": "age",
    "recipients": "recipients.txt",
    "suffix": ".age",
    "container": "none",
    "armor": false
  },
  "fileNaming": "plain"
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `fjord` | integer | yes | Format version. |
| `id` | ULID | yes | Immutable. MUST match the entry in `fjord.json`. |
| `name` | string | yes | Display label. |
| `createdAt` | RFC 3339 | yes | UTC. |
| `encryption` | object or `null` | yes | `null` for a plaintext vault. |
| `fileNaming` | string | yes | `"plain"` or `"id"`. See §7. |

### 4.1 `encryption`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tool` | string | yes | MUST be `"age"` in version 1. |
| `recipients` | string | yes | Path to the recipients file, relative to the vault. |
| `suffix` | string | yes | Appended to the file name. MUST be `".age"` in version 1. |
| `container` | string | yes | `"none"` or `"tar"`. See §6.4. |
| `armor` | boolean | yes | `true` for age ASCII armor, `false` for binary. `false` RECOMMENDED. |

---

## 5. Paths and names

These rules exist so a repository created on one operating system can be
checked out on another without loss.

Clients MUST, when creating or renaming any file or directory:

1. Encode names as **UTF-8, Unicode NFC**. macOS supplies NFD from some
   APIs; clients MUST normalise to NFC before writing, or Git will present
   the same name twice.
2. Reject the characters `/` `\` `:` `*` `?` `"` `<` `>` `|` and control
   characters `U+0000`–`U+001F`.
3. Reject names ending in `.` or a space.
4. Reject the Windows device names `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`
   and `LPT1`–`LPT9`, with or without an extension, case-insensitively.
5. Keep each path component at or below 255 bytes.
6. Not create two entries in one directory whose names differ only by case.
   Case-insensitive filesystems collapse them and data is lost.

Clients SHOULD keep a document's whole path under 240 bytes, for Windows
checkouts without long-path support.

Clients MUST NOT follow or create symbolic links that resolve outside the
repository, and MUST reject any path from a manifest containing `..`, a
leading `/`, or a backslash.

---

## 6. Encryption

### 6.1 Algorithm

Encrypted vaults use the age file format,
[`age-encryption.org/v1`](https://age-encryption.org/v1), unmodified. No
Fjord-specific cryptography is defined, and none may be added: the guarantee
that `age -d` suffices for recovery is load-bearing.

### 6.2 Recipients

The recipients file contains one age recipient per line. Blank lines and
lines whose first non-whitespace character is `#` MUST be ignored. This is
the format accepted by `age -R`, so the file is directly usable with the
`age` CLI.

Recipients MUST be X25519 recipients (`age1…`). SSH recipients
(`ssh-ed25519 …`, `ssh-rsa …`) MAY be used. Passphrase recipients MUST NOT
appear: age refuses to combine a passphrase recipient with any other, and a
passphrase-encrypted vault is a different threat model.

Every encrypted file MUST be encrypted to **all** recipients listed at the
time of writing, so any one identity can decrypt it. A vault with zero
recipients is valid but unwritable; clients MUST refuse to write to it rather
than storing plaintext.

### 6.3 File names

The suffix is **appended**, never substituted: `report.xlsx` becomes
`report.xlsx.age`. The original name and type therefore survive decryption.

### 6.4 Containers

`container` declares what the age payload contains.

**`"none"`** — the payload is exactly the file's bytes. `age -d` yields the
file. REQUIRED when `fileNaming` is `"plain"`.

**`"tar"`** — the payload is a POSIX `ustar` or `pax` archive containing
exactly one regular file entry, whose name is the document's real file name
with no directory component. `age -d | tar -x` yields the file under its
correct name. REQUIRED when `fileNaming` is `"id"`, because the name is not
on disk.

Clients MUST reject an archive containing more than one entry, a non-regular
entry, or an entry name containing `/` or `..`.

### 6.5 Plaintext must never enter an encrypted vault

Clients MUST NOT write an unencrypted document into an encrypted vault, and
MUST NOT commit one, except through a checkout (§6.6). Encrypted vaults MUST
carry a `.gitignore` that ignores
everything and re-permits only encrypted payloads and vault machinery:

```gitignore
*
!*/
!*.age
!fjord.vault.json
!recipients.txt
!.gitignore
```

This makes the common accident — decrypting a file to edit it elsewhere and
forgetting to clean up — fail safe.

That guard is a safety net, not a lock. It makes a commit *skip* a stray
plaintext file, so the edit is silently not saved, and it does nothing at all
if the `.gitignore` has been deleted. A client that commits on its own
authority (a sync, a bulk rewrite) MUST therefore check for a file in the
clear, and for a missing guard, before it stages anything, and MUST refuse
rather than proceed.

### 6.6 Checkouts

Editing an encrypted vault one document at a time is slow, and tools such as
editors and note applications expect the files to sit where they belong. A
client MAY therefore offer a **checkout**: at the user's explicit request,
decrypted copies of a vault's documents are written inside the vault
directory, beside their payloads. Checkouts are optional, and no conformance
level (§10) requires one.

A client that offers a checkout:

1. MUST begin one only on an explicit request that names the vault. Reading,
   searching, syncing and committing never create one.
2. MUST refuse unless the vault's guard `.gitignore` (§6.5) is present and
   correct, and MUST refuse if the vault already holds a file in the clear or
   is already checked out.
3. MUST decrypt every document before writing any, so that a failure leaves
   nothing behind.
4. MUST record the checkout durably, in client-local state that is outside
   version control and outside every vault, *before* writing the first
   plaintext file. A client that finds a file in the clear in an encrypted
   vault with no such record has found a violation of §6.5 and MUST report
   it as one.
5. MUST leave the encrypted payloads in place and unmodified while the
   checkout lasts.
6. MUST NOT commit, push, sync or otherwise publish while any checkout in the
   repository exists, including when it is acting on its own authority, and
   MUST say why and how to end the checkout.
7. MUST end a checkout only by re-encrypting: every changed or new document
   to all current recipients (§6.2), and unchanged payloads left byte for
   byte as they were. It MUST NOT delete a payload because its plaintext is
   gone without the user's confirmation, and MUST NOT overwrite a payload
   that has changed since the checkout began — in that case it refuses and
   changes nothing, since neither version may be destroyed (§9.1).
8. MUST confirm that each payload it writes decrypts to the document it was
   made from before removing any plaintext, and then MUST remove the
   plaintext and the record (§11.3). If any step fails, the plaintext and the
   record remain, and the prohibition on publishing continues to apply.
9. SHOULD tell the user that the contents are readable by anything with
   access to the directory for as long as the checkout lasts.

Other clients see a checked-out vault as a vault with files in the clear
(§6.5), and report it as such. That is accurate.

---

## 7. File naming

`fileNaming` controls how a document is named on disk.

### 7.1 `"plain"`

The file name is the document's name: `Projects/Fjord/sync-design.md.age`.
Browsable; other editors can navigate the vault. File and directory names
are visible to anyone who can read the repository.

### 7.2 `"id"`

The file name is the document's `id` plus the suffix:
`Projects/Fjord/01jag7q2m5x3v8kdqz9r4t6yhb.age`. Directory names remain
plaintext; only leaf names are concealed.

When `fileNaming` is `"id"`:

- `container` MUST be `"tar"`.
- `encryption` MUST NOT be `null`. Identifier names on a plaintext vault
  provide no protection and destroy browsability; clients MUST reject this
  combination.
- The on-disk name MUST equal the document's `id`, so it never changes when
  the document is renamed. Git therefore records a rename as a modification
  in place rather than a delete and an add.

---

## 8. Fjord Docs

A **Fjord Doc** is a `.md` file in a vault whose frontmatter contains a valid
`id`. Every other file is a **vault file**: stored, synced and encrypted
identically, but carrying no Fjord metadata and expected to carry none.

### 8.1 Frontmatter

```markdown
---
id: 01jag7q2m5x3v8kdqz9r4t6yhb
title: Sync design
created: 2026-10-16T09:12:04Z
tags: [fjord, architecture]
fjord:
  schema: 1
  starred: true
---

# Sync design
```

The block MUST begin at byte 0 — no byte-order mark, no leading blank line.
It opens with a line containing exactly `---` and closes with a line
containing exactly `---`. Between them is a YAML mapping.

Clients MUST parse it with a safe YAML loader: no custom tags, no arbitrary
object construction. Frontmatter is untrusted input.

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | ULID | yes | The document's identity. Immutable. Unique within the repository. |
| `title` | string | no | Display name. |
| `created` | RFC 3339 | no | UTC. Set once. |
| `tags` | array of string | no | |
| `aliases` | array of string | no | Obsidian-compatible. |
| `fjord` | mapping | no | Reserved for client state. Clients MUST NOT place their own keys outside it. |

### 8.2 Rules

**Unknown keys MUST be preserved**, with their values, when a client writes
the file back. Key order SHOULD be preserved. Comments SHOULD be preserved
where the YAML implementation allows; losing a comment is tolerable, losing a
key is not. This single rule is what makes "edit it in any tool" survive more
than one round trip.

**Absent frontmatter is valid.** A `.md` file with no frontmatter is a vault
file, not a malformed Doc. A client MAY assign an `id` and promote it to a
Doc when the user edits it, and MUST NOT rewrite files merely because it
scanned them.

**`id` is immutable.** It MUST NOT change on rename, move, or edit. Where two
documents share an `id` — typically a copy-paste — clients SHOULD retain it
on the one with the earlier `created` and assign a fresh `id` to the other.

**There is no `modified` field.** External editors would not maintain it, and
Git already records the answer.

**`title` is advisory.** Where it is absent, clients SHOULD fall back to the
first level-one heading, then to the file name.

### 8.3 Identifiers

An `id` MUST be a [ULID](https://github.com/ulid/spec) written in
**lowercase**: 26 characters of Crockford base32 — `0`–`9` and `a`–`z`
without `i`, `l`, `o` and `u` — whose first character is `0`–`7`. ULIDs sort
lexicographically by creation time, contain no characters that require
escaping in a path, and are valid file names — which §7.2 depends on.

The ULID specification names uppercase as its canonical form but defines
decoding as case-insensitive, so this is a profile of ULID rather than a
different identifier: the same 128 bits and the same sort order, with one
spelling.

Exactly one identifier form is permitted, so that every client can compare,
sort and validate identifiers without negotiation. An identifier in
uppercase or mixed case is therefore not valid, and a client MUST reject one
rather than fold it to lowercase.

Drafts of this specification before 2026-10-17 required uppercase, and
repositories created by Fjord 0.1.0 carry identifiers in that form. Those
repositories do not conform to this revision.

---

### 8.4 Documents and notes

A Fjord Doc is a **document** if its file name ends in `.fj.md`, with at least
one character before it, and a **note** otherwise. The two are the same
format: they have the same frontmatter, the same rules (§8.1, §8.2) and the
same identifiers, and a `.fj.md` file with no valid `id` is a vault file like
any other `.md` file (§8.2). The name is the only difference, and what it is
for is presentation: a client MAY offer a different way of editing a document
(long-form writing, say) from a note, and MAY treat them differently in other
ways it documents. A client MUST NOT infer anything about a file's content from
the distinction.

A file changes from one to the other only by changing its name, which is an
ordinary rename: its `id` is immutable (§8.2) and does not change with it.

Every `.md` Fjord Doc written before this section existed is a note, and
nothing in a repository has to change.

In an encrypted vault the name that counts is the file's real name: the name
without the suffix (§6.3), or, with `fileNaming` `"id"`, the name inside the
container (§6.4), which a client that has not opened the container does not have.

## 9. Git requirements

A conforming repository MUST contain a `.gitattributes` that prevents Git
from diffing or merging ciphertext:

```gitattributes
*         text=auto eol=lf
*.age     binary -diff -merge
```

Without `-merge`, Git will attempt a three-way textual merge of two
ciphertexts and write a conflicted, unusable file.

### 9.1 Conflicts

Git cannot merge encrypted payloads, and clients MUST NOT ask it to.

A client resolving a conflict in an encrypted vault MUST decrypt both sides
and their merge base, merge the plaintext, and re-encrypt the result. Clients
SHOULD use the same path for plaintext vaults, so one implementation serves
both.

Where a merge cannot be completed automatically, a client MUST NOT discard
either side. It MUST preserve both — for example by keeping one in place and
writing the other alongside it as a new Doc with a fresh `id` — and surface
the conflict to the user.

### 9.2 Commits

Commit granularity is not specified. Clients SHOULD commit per editing
session rather than per keystroke: age output is non-deterministic, so each
write of an encrypted document stores a complete new object that Git cannot
delta-compress.

---

## 10. Conformance

Clients declare one or more levels. A client MUST NOT perform an operation
above its declared level.

| Level | Name | Requirements |
| --- | --- | --- |
| **L0** | Plaintext reader | Parse `fjord.json` and `fjord.vault.json`; discover vaults from the filesystem; parse frontmatter; identify Docs and vault files. MUST NOT write. |
| **L1** | Plaintext writer | L0, plus: assign ULIDs to new Docs; preserve unknown frontmatter keys (§8.2); obey path rules (§5); repair `fjord.json` when it disagrees with disk. |
| **L2** | Encrypted reader | L0, plus: decrypt age payloads; handle both container modes (§6.4); resolve `fileNaming: "id"` names. |
| **L3** | Encrypted writer | L1 + L2, plus: encrypt to all recipients (§6.2); never write plaintext into an encrypted vault (§6.5) outside a checkout (§6.6); refuse to write to a vault with no recipients; merge conflicts by decrypting (§9.1). |

### 10.1 Version handling

A client encountering a `fjord` value greater than the version it implements
MUST NOT write to that repository. It MAY read, and SHOULD tell the user the
repository was made by a newer version.

Clients MUST preserve unknown fields in both manifests when rewriting them,
for the same reason as §8.2.

---

## 11. Security considerations

### 11.1 What an encrypted vault conceals

Document contents, and any metadata inside them — titles, tags, Fjord state.

### 11.2 What remains visible

To anyone who can read the repository, including the Git host:

- **Directory names**, in every mode. A path like `Legal/Divorce/` discloses
  the substance without a single file name. This is the most commonly
  underestimated leak in the format.
- **File names**, when `fileNaming` is `"plain"`.
- The **number of documents** and the **size of each**.
- **Commit timestamps**, and which file changed in which commit — so the
  editing history of one specific document is observable.
- The **recipient public keys**, and therefore the number of devices.
- The **commit author** name and email.
- The **`generator`** field of `fjord.json`, if one was recorded, which names
  the tool and its exact version.

Implementations MUST NOT describe an encrypted vault in terms that imply
metadata protection it does not provide.

### 11.3 Identities

An identity MUST NOT be stored in the repository it decrypts. Clients SHOULD
hold it in platform key storage — Keychain, Android Keystore, Windows
Hello, or a system keyring — and MUST make it exportable, because an identity
the user cannot extract is lock-in by another name.

Clients SHOULD zeroise key material and decrypted plaintext in memory when
no longer needed, and MUST remove temporary decrypted files when an external
editing session ends.

### 11.4 Revocation is not possible

Removing a recipient affects only subsequent writes. Every version already
committed remains decryptable by that key, permanently, because Git retains
history.

Retiring a compromised key requires re-encrypting every file **and**
rewriting history — in practice, a new repository. Clients MUST state this
plainly when a user removes a recipient, rather than implying revocation.

### 11.5 Untrusted input

Frontmatter, manifests, file names and tar entry names all arrive from
outside and MUST be validated before use: paths checked against §5, tar
archives against §6.4, YAML parsed without arbitrary object construction.

---

## 12. Not specified in version 1

Reserved, with no defined layout or behaviour yet:

- Trash and restore, under `/.fjord/`.
- Sharing a vault or document with another person.
- Publishing a plaintext vault to the web.
- Non-Git storage.
- Nested vaults.
- Metadata for vault files that are not Markdown.

A later version may define these. Version 1 clients MUST ignore, and
preserve, anything they encounter under `/.fjord/`.
