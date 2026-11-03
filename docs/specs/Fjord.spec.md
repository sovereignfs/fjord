<!-- SPDX-License-Identifier: CC0-1.0 -->

# The Fjord Repository Format

**Version:** 1 (draft)
**Status:** Draft. Not yet stable; breaking changes possible until declared stable.
**Date:** 2026-11-03
**Licence:** [CC0 1.0](#licence) (public domain)

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
| **Kind** | What a repository is for: `drive`, `journal` or `ssg`. Changes presentation only. See §3.1. |
| **Vault** | A directory containing `fjord.vault.json`, at any depth but never inside another vault. The unit of encryption. See §2.3. |
| **Fjord Doc** | A `.md` file in a vault whose frontmatter contains a valid `id`. |
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
├── <Vault>/                zero or more, at any depth (§2.3)
│   ├── fjord.vault.json    REQUIRED
│   ├── recipients.txt      REQUIRED if encrypted
│   ├── .gitignore          REQUIRED if encrypted
│   └── …                   documents and directories, nested freely
└── …                       other files and directories, outside any vault
```

Files and directories outside every vault are permitted: a `README.md` at
the root, or the configuration and layouts of a site's engine (§3.1). They
are ordinary files of the repository. They are never Fjord Docs or vault
files, whatever their names, and nothing in this specification applies to
them beyond the path rules of §5.

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
or not. A vault MAY be a directory at any depth below the root: `Private/`
beside `fjord.json`, or `src/content/` in a site whose engine reads its
content there (§3.1). The root itself is never a vault. Two rules hold
wherever a vault is:

- **No vault inside another.** A directory that contains `fjord.vault.json`
  MUST NOT have an ancestor directory that also contains one. Nested vaults are not permitted in version 1 (§12): what a file's
  encryption is would otherwise depend on which manifest a client found
  first.
- **Never in reserved places.** A vault MUST NOT be `/.fjord/` or under it
  (§2.2), nor under `.git/`. Neither is part of the repository's content.

Discovery (§2.1) therefore looks for `fjord.vault.json` throughout the tree
outside those two, not only at the root. The root itself is never a vault: a
`fjord.vault.json` beside `fjord.json` is as wrong as one inside another vault. A vault's path in `fjord.json` (§3) is its
path from the root, such as `src/content`.

The directories above a vault are ordinary directories of the repository,
outside every vault (§2), and their names are plaintext like every
directory name (§11.2).

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
| `kind` | string | no | What the repository is for. See §3.1. Absent means `"drive"`. |
| `<kind>` | object | no | Settings for the kind, under a key named after it, such as `ssg`. See §3.1. |
| `vaults` | array | yes | Objects with `path` (the vault's directory from the root, such as `Private` or `src/content`: relative, `/`-separated, no `..`, no leading `/`) and `id` matching that vault's own `id`. |

### 3.1 Kinds

A repository's **kind** says what it is for, and therefore how a client
presents it: as a set of vaults and folders, as a timeline of entries, as a
website's content. This revision defines three.

| Kind | Vaults | Encryption | Settings |
| --- | --- | --- | --- |
| `drive` | Any number | Per vault, as §4 and §6 allow | None |
| `journal` | Exactly one | As §4 and §6 allow | None |
| `ssg` | Exactly one | None: the vault MUST be plaintext | `ssg`: `{ "engine": "astro" }` or `"jekyll"` |

```json
{
  "fjord": 1,
  "id": "01jagc4k7pqw2xn8rvty5zb3md",
  "name": "Notebook",
  "createdAt": "2026-11-02T09:34:00Z",
  "kind": "ssg",
  "ssg": { "engine": "astro" },
  "vaults": [{ "path": "content", "id": "01jagc4k7pr9tbm3ykwx6zq2hv" }]
}
```

A kind changes how a repository is presented, never what its files mean. It
is also what decides how a client presents each Doc in it: a drive's Docs as
documents to write at length, a journal's as entries, a site's as posts and
pages. Nothing in a file's name or content says which (§8.4). For every kind:

- A client that does not know a repository's kind, or the `engine` of an
  `ssg` repository, MUST treat the repository as a `drive`. A kind added by a
  later revision therefore needs no new format version.
- A client MUST be able to present any repository as a `drive`, and MUST NOT
  refuse to read a repository because of its kind.
- A client MUST preserve `kind` and every settings object when it rewrites
  `fjord.json` (§10.1), including those it does not know.
- A kind MAY be changed by editing the field. Nothing else changes, and the
  repository then has to meet the new kind's rules.

The vault of a `journal` or an `ssg` repository is found as every vault is,
by its `fjord.vault.json` (§2.1). Its directory name and its depth are not
fixed (§2.3); the one vault is the kind's content, and a client SHOULD present
the repository as that content rather than as a list of one vault. With one
vault, choosing its encryption is choosing the repository's.

A journal is personal by nature. A client that creates one SHOULD encrypt its
vault unless the user asks otherwise. This is a default, not a rule: a
plaintext journal conforms.

An `ssg` repository is a static site whose engine builds it from the vault.
The vault MAY be the folder the engine already reads its content from, such
as `src/content` for Astro or `_posts` for Jekyll, so that an existing site
can become a Fjord repository without moving a file. The engine's own files
(its configuration, layouts and package files) are files outside any vault
(§2). The vault is plaintext because a site is published: one built from
ciphertext would need its key in the build.

A repository that breaks its kind's rules is still readable, and a client
SHOULD say which rule it breaks rather than refuse it.

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

A checkout MAY also begin when a client makes an existing directory of
plaintext files an encrypted vault, at the user's explicit request naming
that directory. There are then no payloads yet, and rule 2's refusal of
files in the clear does not apply; rules 4 to 9 do, from before the
manifest is written. The client MUST tell the user, before it begins, that
every version of those files already committed stays readable in Git's
history (§11.4). Ending the checkout encrypts every file (rule 7) and
removes the plaintext from version control as well as from the disk.

Other clients see a checked-out vault as a vault with files in the clear
(§6.5), and report it as such. That is accurate.

### 6.7 Changing a vault's encryption

A client MAY make a plaintext vault an encrypted one, or an encrypted vault a
plaintext one, at the user's explicit request naming the vault. The vault is
the same vault afterwards: its `id`, its `name` and every other field of its
manifest, known or not (§10.1), are kept.

To **encrypt** a plaintext vault the client:

1. MUST refuse unless it has at least one recipient to encrypt to (§6.2), and
   MUST refuse a vault of a repository whose kind forbids it (§3.1: a site's
   content is never encrypted).
2. MUST tell the user, before it begins, that every version of the vault's
   files already committed stays readable in Git's history (§11.4).
3. MUST write the vault's recipients file and its plaintext guard (§6.5), set
   `encryption` as §4.1 describes, and set `fileNaming` to `"plain"`, and MUST
   begin the checkout of §6.6 for adopting a directory *before* the manifest
   says the vault is encrypted: the plaintext then in the vault is what that
   checkout is for.
4. MUST end that checkout as §6.6 requires (rules 7 to 9), which is what
   encrypts the files and removes the plaintext.

To **decrypt** an encrypted vault the client:

1. MUST begin an ordinary checkout (§6.6), which decrypts every document
   before it writes any, and MUST tell the user, before it begins, that the
   files will be readable by anyone who can read the repository, that they stay
   so in the history once committed, and that the encrypted copies stay there
   too.
2. MUST NOT remove a file in the clear. It then sets `encryption` to `null` and
   `fileNaming` to `"plain"`, removes the payloads and, if it is the one §6.5
   describes, the guard, removes the recipients file, and only then removes
   the checkout's record. An interruption leaves every document readable and
   the record in place.

Neither is a checkout that the user can work in: both are over when the
command ends, and a vault that is still checked out is not one that either
accepts.

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
| `date` | RFC 3339 date-time or full-date | no | The moment the Doc is about. Keeps the writer's local offset. See below. |
| `tags` | array of string | no | Compared as below. |
| `aliases` | array of string | no | Obsidian-compatible. |
| `fjord` | mapping | no | Reserved for client state. Clients MUST NOT place their own keys outside it. |

**`date`** is the moment a Doc is about: the day and time of a journal entry,
the publication date of a post. It is not `created`, which records when the
file was made and is set once; `date` may be set and changed by the writer.
It is an RFC 3339 date-time with any offset (`2026-11-02T08:14:00+05:30`),
or an RFC 3339 full-date alone (`2026-11-02`).

Unlike every other timestamp in this specification, `date` keeps the
writer's **local offset** rather than UTC. A Doc is read by the writer's day:
an entry written at 01:00 in Colombo falls on the previous day in UTC, and
would be shown on the wrong day. A client writing `date` SHOULD write the
local offset of the moment it records.

Other tools write dates in other forms (Jekyll writes
`2026-11-02 08:14:00 +0530`), and §2.1 requires them to be tolerated. A
`date` that is neither form is therefore not an error: a client SHOULD warn,
and SHOULD fall back to the path, then to `created`, wherever it needs the
Doc's date.

**Tags** are compared case-insensitively. Clients SHOULD treat two tags as
the same when they are equal after NFC normalisation and Unicode's default
lowercase mapping, and SHOULD treat `/` as nesting: `project/fjord` is a tag
under `project`. Comparison never rewrites a file; a tag is kept as it was
written. Only the frontmatter's `tags` are tags; a `#word` in the text is not.

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

### 8.4 One kind of Doc

Every Fjord Doc is the same kind of file. A client MUST NOT infer anything
about a Doc from its name beyond §8: how it is edited or presented is decided
by the repository's kind (§3.1) and by the client, never by an extension.

Drafts of this specification from 2026-10-23 to 2026-11-02 called a Doc whose
name ends in `.fj.md` a *document* and any other a *note*. That distinction
is withdrawn. A `.fj.md` file is a `.md` file like any other: a Fjord Doc if
its frontmatter has a valid `id`, a vault file otherwise, and nothing in a
repository has to change.

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

A client that chooses paths for the user in an encrypted vault SHOULD NOT
put in them what the encryption is meant to hide. A journal's entries, for
instance, are not filed in dated directories in an encrypted vault, because
`2026/11/02/` would show which days have entries; they sit at the vault's
root with `fileNaming` `"id"` (§7.2), and their dates stay inside them.

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
- Nested vaults: a vault inside another vault (§2.3).
- Metadata for vault files that are not Markdown.

A later version may define these. Version 1 clients MUST ignore, and
preserve, anything they encounter under `/.fjord/`.

---

## Licence

This specification is dedicated to the public domain under the Creative Commons
CC0 1.0 Universal Public Domain Dedication.

To the extent possible under law, the authors have waived all copyright and
related or neighbouring rights to this specification. You can copy, modify,
distribute and implement it, even for commercial purposes, without asking
permission.

The full legal text of the dedication is at
<https://creativecommons.org/publicdomain/zero/1.0/legalcode>.

The rest of this repository, including the reference implementation, is
licensed under the Mozilla Public License 2.0; see the `LICENSE` file at the
repository root. The licence of this document is the one stated here, and it
travels with the document if it is copied or moved.
