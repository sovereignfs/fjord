# Fjord

A Git repository that stores documents as plain files, organised into
**vaults**, with optional end-to-end encryption using
[age](https://github.com/FiloSottile/age).

Nothing in this repository is specific to the Fjord app. Every document is a
real file at a real path, every format is documented below, and the
encryption is standard `age`. You can read, edit, search and fully recover
everything here with a text editor and two command-line tools — with Fjord,
without it, or long after it stops existing.

That is the point. Fjord is a convenient way to work with this repository,
not the thing that owns it.

## Scope

Documents, and the attachments that belong to them — Markdown, PDFs,
spreadsheets, scans, pasted images.

**Not photos or video.** Git handles large binary files badly, and encryption
makes it worse: `age` output cannot be delta-compressed, so every edit stores
a complete new copy. A media library here would be slow to clone and painful
to live with. This is a deliberate limit of the format, not a missing
feature.

---

## Layout

```
.
├── README.md                 this file
├── fjord.json                repository manifest
├── .gitattributes            diff/merge rules — see "Repository hygiene"
├── .gitignore
├── Public/                   a vault, not encrypted
│   ├── fjord.vault.json
│   └── welcome.md
└── Private/                  a vault, encrypted with age
    ├── fjord.vault.json
    ├── recipients.txt
    └── .gitignore            plaintext guard
```

A directory is a vault if, and only if, it contains a `fjord.vault.json`.
Inside a vault you can nest directories and files as deeply as you like.

**The filesystem is the source of truth.** `fjord.json` lists the vaults as
a convenience, but it is not an index of your documents and it is never
authoritative. If you add a file in VS Code, move a folder in Finder, or
`git pull` someone else's changes, those files are simply part of the vault.
If the manifest and the disk ever disagree, the disk wins.

This is what makes it safe to use other tools on this repository.

---

## The two default vaults

### `Public` — not encrypted

Plain Markdown and plain files. Readable by anything, diffable in Git,
openable in Obsidian as a vault with no setup.

> **"Public" is a name, not a permission.** This vault is not published
> anywhere. Nothing in this repository is visible to anyone who cannot
> already read the repository itself. If the repository is private, `Public`
> is private too. If you make the repository public, then everything here —
> including the ciphertext in `Private`, its file names, and its recipient
> keys — becomes visible to the world.

Use it for things you would not mind a collaborator, or your Git host,
reading.

### `Private` — encrypted

Every file is encrypted individually with `age`, to the public keys listed in
`Private/recipients.txt`. The directory structure and the file names stay
readable; only file *contents* are protected. See
[What the Git host can see](#what-the-git-host-can-see) before you decide
that is enough.

A fresh `Private` vault has no keys in `recipients.txt`, so nothing can be
written to it until you add one. See [Encryption](#encryption).

### Adding your own vaults

Create a directory at the repository root, put a `fjord.vault.json` in it,
and add it to the `vaults` array in `fjord.json`. Vaults can be encrypted or
not, independently of each other. There is no limit on how many you have.

---

## `fjord.json`

The repository manifest. Plaintext, at the root.

```json
{
  "fjord": 1,
  "id": "01jagc4k7pqw2xn8rvty5zb3md",
  "name": "Fjord",
  "createdAt": "2026-10-16T09:34:00Z",
  "generator": "fjord-init 0.1.0",
  "vaults": [
    { "path": "Public",  "id": "01jagc4k7pr9tbm3ykwx6zq2hv" },
    { "path": "Private", "id": "01jagc4k7psd5vnz8qmt3yxb4k" }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `fjord` | yes | Format version of this file. Currently `1`. |
| `id` | yes | ULID for the repository. Stable for its lifetime. |
| `name` | yes | Display name. Free text. |
| `createdAt` | yes | RFC 3339 timestamp, UTC. |
| `generator` | no | Tool and version that created the repository. |
| `vaults` | yes | Array of `{ path, id }`. `path` is relative to the root. |

Unknown fields must be preserved when rewriting this file.

---

## `fjord.vault.json`

One per vault, always plaintext — it has to be readable to know how to
decrypt the vault, so it must never contain a secret. Public keys are not
secrets; a vault's display name is not protected either.

Unencrypted vault:

```json
{
  "fjord": 1,
  "id": "01jagc4k7pr9tbm3ykwx6zq2hv",
  "name": "Public",
  "createdAt": "2026-10-16T09:34:00Z",
  "encryption": null,
  "fileNaming": "plain"
}
```

Encrypted vault:

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

| Field | Required | Meaning |
| --- | --- | --- |
| `fjord` | yes | Format version of this file. Currently `1`. |
| `id` | yes | ULID for the vault. Must match its entry in `fjord.json`. |
| `name` | yes | Display name. The directory name is the vault's address; this is what gets shown. |
| `createdAt` | yes | RFC 3339 timestamp, UTC. |
| `encryption` | yes | `null`, or the object below. |
| `fileNaming` | yes | `"plain"` or `"id"`. See [File naming](#file-naming). |

### `encryption`

| Field | Required | Meaning |
| --- | --- | --- |
| `tool` | yes | Currently only `"age"`. |
| `recipients` | yes | Path, relative to the vault, of the recipients file. |
| `suffix` | yes | Appended to the original file name. Conventionally `".age"`. |
| `container` | yes | `"none"`, or `"tar"` when `fileNaming` is `"id"`. |
| `armor` | yes | `false` for binary age output, `true` for ASCII armor. Binary is smaller; ciphertext is unreadable either way, so armor buys nothing for diffs. |

The suffix is **appended**, never substituted: `report.xlsx` becomes
`report.xlsx.age`, so the original type survives decryption.

---

## Frontmatter

Every Markdown document carries a YAML frontmatter block.

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

All merging happens in the app, never in git.
```

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | ULID. Assigned once, **never changed**. This is the document's identity: it survives renames and moves, and it is how history is tracked. |
| `title` | no | Display name. If absent, fall back to the first `#` heading, then the file name. |
| `created` | no | RFC 3339, UTC. Set once at creation. |
| `tags` | no | Array of strings. |
| `aliases` | no | Array of strings. Obsidian-compatible. |
| `fjord` | no | Fjord's own state, namespaced so it can never collide with another tool's keys. |

Rules that matter more than the field list:

- **Unknown keys are preserved verbatim.** If Obsidian, a static-site
  generator or your own script adds a key, Fjord writes it back untouched.
  Anything else turns "use any tool" into "use any tool once".
- **Missing frontmatter is valid.** A `.md` file dropped in from another
  editor is a legitimate document. An `id` is assigned on first edit, not on
  sight — scanning a vault never rewrites it.
- **There is no `modified` field,** deliberately. It would go stale the
  moment an external editor touched the file, and Git already knows the
  answer.
- **`id` is immutable.** On a duplicate — someone copy-pasted a file — keep
  the id on whichever has the older `created` and assign the other a new one.
- ULIDs are time-ordered, so documents sort by creation even if a
  `created` value is lost. Exactly one identifier form is permitted, so
  that every client can compare and sort ids without negotiating first.

Non-Markdown files (`.pdf`, `.xlsx`, …) have nowhere to put frontmatter.
They currently carry no Fjord metadata beyond their path and what Git
records. That is a known gap, not an oversight.

---

## File naming

`fileNaming` controls what a document is called on disk.

### `"plain"` (default)

The file name is the document's name: `Projects/Fjord/sync-design.md.age`.
Readable, browsable, and the only mode in which another editor can navigate
the vault. File and folder names are visible to anyone who can read the
repository.

### `"id"`

The file name is the document's `id`: `Projects/Fjord/01JAG7Q….age`.
Directory names stay readable; only leaf names are hidden.

Three consequences:

1. **`container` must be `"tar"`.** With the name gone from disk, the real
   file name lives in a single-entry tar inside the ciphertext, so
   `age -d | tar -x` hands back the correct name for any file type,
   including binaries that cannot carry frontmatter.
2. **Git history gets better.** An id never changes when a title changes, so
   renaming a document rewrites one file in place instead of appearing as a
   delete plus an add. Git's rename detection cannot see through ciphertext,
   so in `"plain"` mode a rename does break the chain.
3. **Other editors become useless for that vault.** Nothing is lost — see
   [Recovery](#recovery-without-fjord) — but nothing is browsable either.

`"id"` is only valid on an encrypted vault. On a plaintext vault it is pure
cost: readable content with meaningless names.

---

## Encryption

Install [age](https://github.com/FiloSottile/age) (`brew install age`,
`apt install age`, or a release binary).

### One-time setup

Generate an identity and keep it **outside** this repository:

```bash
mkdir -p ~/.config/fjord
age-keygen -o ~/.config/fjord/identity.txt
```

Add its public key as a recipient of the vault:

```bash
age-keygen -y ~/.config/fjord/identity.txt >> Private/recipients.txt
```

Repeat on each device, appending one public key per line. Every file is
encrypted to *all* recipients, so any one identity can decrypt it. There is
no shared master secret to move between devices.

### Read one file

```bash
age -d -i ~/.config/fjord/identity.txt Private/Inbox/groceries.md.age
```

### Write one file

```bash
age -R Private/recipients.txt -o Private/Inbox/groceries.md.age groceries.md
```

### Decrypt a whole vault

For `fileNaming: "plain"`:

```bash
cd Private
find . -name '*.age' -print0 | while IFS= read -r -d '' f; do
  out="../restored/${f%.age}"
  mkdir -p "$(dirname "$out")"
  age -d -i ~/.config/fjord/identity.txt "$f" > "$out"
done
```

For `fileNaming: "id"`, where the name comes out of the tar:

```bash
cd Private
find . -name '*.age' -print0 | while IFS= read -r -d '' f; do
  dir="../restored/$(dirname "$f")"
  mkdir -p "$dir"
  age -d -i ~/.config/fjord/identity.txt "$f" | tar -xf - -C "$dir"
done
```

### Rotating and revoking keys

Removing a line from `recipients.txt` only affects files encrypted *after*
that point. **It revokes nothing.** Every version already committed stays
decryptable by the removed key, because Git keeps history forever.

Genuinely retiring a compromised key means re-encrypting every file to the
new recipient set *and* rewriting history — in practice, starting a new
repository. Plan accordingly before you put a key on a device you do not
control.

---

## Working with other tools

For unencrypted vaults, there is nothing to do:

- **Obsidian** — open the vault directory as a vault. Frontmatter `title`,
  `tags` and `aliases` are understood natively.
- **VS Code** — open the repository. Search, multi-file edit, Git all work.
- **Static site generators** — point them at the vault directory.
- **`grep`, `rg`, `find`** — ordinary files, ordinary tools.

For encrypted vaults, decrypt what you need, edit, re-encrypt, and delete the
plaintext. `Private/.gitignore` is set up to refuse to commit a stray
decrypted file, but it cannot stop you leaving one on disk.

---

## What the Git host can see

Be precise about this, because "encrypted" is easy to over-trust.

Hidden in an encrypted vault:

- Document contents, including titles and tags that live in frontmatter.

Visible to anyone who can read the repository, encrypted or not:

- **Directory names** — in every mode. `Legal/`, `Medical/`, `Divorce/` can
  tell the whole story without a single file name.
- **File names** — in `fileNaming: "plain"`.
- **The number of documents, and the size of each.**
- **Commit timestamps**, and which file changed in which commit — so the fact
  that one specific document was edited forty times is observable.
- **The recipient public keys**, and therefore how many devices you use.
- **The commit author name and email**, if you set them.

If that is more than you want to leak, the available moves are
`fileNaming: "id"`, keeping sensitive material in a vault whose directory
names are bland, and using a pseudonymous commit identity.

---

## Repository hygiene

**Do not commit your identity file.** `.gitignore` catches the common names,
but keep it outside the repository.

**Do not commit decrypted plaintext into an encrypted vault.**
`Private/.gitignore` ignores everything by default and allows back only
`.age` files and vault machinery. Keep that pattern if you add new file types.

**`.gitattributes` matters.** `*.age binary -diff -merge` stops Git trying to
diff and merge ciphertext, which otherwise produces unreadable conflicts.
Fjord resolves conflicts by decrypting both sides, merging the plaintext,
and re-encrypting — Git should never attempt it directly.

**Encrypted repositories grow faster than you expect.** `age` output is
non-deterministic: re-encrypting an unchanged document produces entirely
different bytes, so Git cannot delta-compress it. A one-line edit to a 100 kB
document writes 100 kB of new objects, every time. Unencrypted vaults
delta-compress normally. For long-lived encrypted vaults, expect to want
shallow clones or periodic history squashing.

---

## Recovery without Fjord

The worst case: the app is gone, your devices are gone, and you have a clone
of this repository and your identity file.

Unencrypted vaults need no recovery. They are files.

For encrypted vaults, the "Decrypt a whole vault" commands above are the
entire procedure. Two standard tools, no Fjord, no network.

**Your identity file is the only thing that cannot be replaced.** There is no
recovery service, no reset, and no back door — that is what end-to-end
encryption means. Keep a copy somewhere you will still have it in five years.

---

## Status

This format is version `1` and is not yet stable.

Implemented in the specification: the layout, both manifests, frontmatter,
`fileNaming: "plain"`, and `age` encryption with `container: "none"`.

Specified but not yet implemented: `fileNaming: "id"` with
`container: "tar"`, trash under a reserved `.fjord/` directory, and
publishing an unencrypted vault to the web.
