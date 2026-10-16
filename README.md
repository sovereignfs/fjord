# fjord

The reference toolchain for the [Fjord](spec/SPEC.md) repository
format — a way to keep your documents in a Git repository you control, with
optional end-to-end encryption using [age](https://age-encryption.org/v1).

`fjord verify` decides whether a repository conforms to the specification.
Everything else in this tool is convenience; that command is the point.

## Install

```bash
# macOS / Linux
curl -fsSL https://fjord.sh/install.sh | sh

# Homebrew
brew install fjord-sh/tap/fjord

# Windows
powershell -c "irm https://fjord.sh/install.ps1 | iex"

# From source
cargo install fjord-cli
```

Linux builds are statically linked against musl, so one binary works on any
distribution.

**You do not need `age` installed.** Fjord links the age implementation
directly. Install the `age` CLI only if you want to decrypt files by hand —
which you can, and which is the whole point of the format.

## Quick start

```bash
fjord init my-documents
cd my-documents
fjord key new                    # an identity, kept outside the repository
fjord key add <public-key> --vault Private
fjord new Private/Inbox/first.md
git remote add origin git@github.com:you/Fjord.git
fjord sync                       # commits, pushes, and sets up tracking
```

## Commands

### `fjord init [path]`

Creates a conforming repository with a `Public` vault (plaintext) and a
`Private` vault (encrypted), initialises git on `main`, and makes the first
commit. It also writes a `README.md` explaining the whole format, so the
repository is comprehensible to anyone who clones it without Fjord
installed.

**It never writes over existing files.** The target must not exist, be
empty, or contain nothing but a `.git` directory — so `git init && fjord
init` works, and `fjord init` over your notes does not.

A fresh `Private` vault has **no recipients**, which spec §6.2 makes valid
and deliberately unwritable. `fjord verify` reports `W602` until you add a
key; that is expected, not a fault. Fix it with `fjord key new` followed by
`fjord key add`, or with the two `age-keygen` commands the generated
`README.md` gives.

| Flag | Effect |
| --- | --- |
| `--name <text>` | Repository display name. Defaults to the directory name. |
| `--no-encrypt` | Create `Private` as a plaintext vault. |
| `--no-git` | Skip `git init` and the first commit. |
| `--no-input` | Never prompt; take every default. |
| `--json` | Machine-readable summary of what was created. |

On a terminal it asks for the repository name and whether to encrypt
`Private`, writing the prompts to stderr so `--json` on stdout stays
parseable. Anywhere else — a pipe, a CI job, or with `--no-input` — it takes
the defaults without asking.

`--identity` is **not accepted here.** Registering a recipient is
`fjord key add`, so `init` refuses the flag rather than quietly creating a
repository you cannot write to. Exits `2` if you pass it.

If git itself fails — most often because `user.name` and `user.email` are
unset — the repository is still created, and the error says so along with
how to finish the commit by hand. Exits `3`.

### `fjord verify`

Checks the repository against the specification and reports coded
diagnostics. Mutates nothing.

```
$ fjord verify
  ✓ fjord.json          format version 1
  ✓ Public              plaintext · 12 docs · 3 files
  ✗ Private             2 problems

    Private/Inbox/notes.md
      E201  plaintext file in an encrypted vault
    Private/Projects/01JAG7Q2M5X3V8KDQZ9R4T6YHB.age
      E305  container is "none" but fileNaming is "id"

  2 errors, 0 warnings
```

`✓` conforms, `⚠` warnings only — which still exits `0` — and `✗` at least
one error.

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output. For CI. |
| `--fix` | Apply safe repairs only — see [What `--fix` will and will not do](#what---fix-will-and-will-not-do). |
| `--vault <name>` | Check one vault, by directory or by label. |
| `--strict` | Treat warnings as errors. |

Exits `0` when conforming, `1` when any error is found. Warnings alone do not
change the exit code unless `--strict` is given.

The `--json` shape is published API, specified by
[`schema/verify.schema.json`](schema/verify.schema.json) and checked against
it on every test run.

### `fjord encrypt <path>`

Encrypts one file in place inside an encrypted vault: `notes.md` becomes
`notes.md.age`, and the plaintext is removed. This is the repair for a file
that should never have been in the clear in a vault — the `E201` case.

The payload is read back and checked before the plaintext is deleted. When
one of your identities is among the vault's recipients, that check is a full
round trip and the recovered bytes are compared with the original; otherwise
only the header is parsed, and the command says so.

| Flag | Effect |
| --- | --- |
| `--keep` | Leave the plaintext in place. It then sits in the clear inside an encrypted vault, which `fjord verify` reports as `E201`. |

Refused if the vault has no recipients: spec §6.2 requires a client to
refuse rather than store plaintext.

### `fjord decrypt <path>`

Writes the plaintext to **stdout**, so decrypted content never lands in the
repository by accident.

| Flag | Effect |
| --- | --- |
| `--out <path>` | Write to a file instead. Refused if it would land inside an encrypted vault (spec §6.5). |

```bash
fjord decrypt Private/notes.md.age            # to stdout
fjord decrypt Private/notes.md.age -o ~/notes.md
```

### `fjord open <path>`

Decrypts a document to a private temporary file **outside the repository**,
opens your editor, re-encrypts when you are done, and shreds the temporary
copy.

This is how you use vim, VS Code, Obsidian or anything else on an encrypted
document without ever leaving plaintext in the repository.

```bash
fjord open Private/notes.md          # the `.age` is implied
fjord open Private/notes.md --commit
```

| Flag | Effect |
| --- | --- |
| `--editor <cmd>` | Editor to use. Overrides `$VISUAL` and `$EDITOR`. |
| `--commit` | Commit the re-encrypted document after a successful edit. |

- **GUI editors that fork on launch need to block.** Fjord appends `--wait`
  for editors it recognises (`code`, `code-insiders`, `codium`, `subl`,
  `sublime_text`, `zed`, `mate`); for anything else, include the flag
  yourself: `EDITOR="yourapp --wait"`.
- **If the content did not change, nothing is re-encrypted.** Merely reading
  a document does not create a new commit — which matters more than it
  sounds, because `age` output is non-deterministic, so a pointless
  re-encrypt writes a whole new object Git cannot delta-compress.
- **Interrupting the session cleans up.** `Ctrl-C` or `SIGTERM` shreds the
  decrypted file and releases the lock before exiting.
- **One session per document.** A second `open` of the same file is refused
  rather than letting one set of edits silently overwrite the other. The
  lock lives under `/.fjord/local/`, which is never committed.
- If your editor exits with an error but the document changed, the change is
  still saved: a GUI editor's exit code is not a reliable signal, and
  discarding your work on the strength of one would be worse.

A session is refused before anything is decrypted if the vault has no
recipients, since the edit could not be saved.

Shredding is best-effort on SSDs and copy-on-write filesystems; the operating
system may retain blocks regardless.

### `fjord new <path>`

Creates a Fjord Doc with valid frontmatter — a fresh ULID, `created`, and a
`title` — then opens it for editing. In an encrypted vault the document is
built in memory and written encrypted: the plaintext never touches the vault,
not even for the instant between creating a file and encrypting it.

`.md` is added if you leave it off. Another extension is refused, since a
PDF cannot carry frontmatter — bring those in with `fjord encrypt`.

Names are checked against the path rules of spec §5 *before* anything is
written, so a document that could not be checked out on Windows or macOS is
never created in the first place.

| Flag | Effect |
| --- | --- |
| `--title <text>` | Set the title. Defaults to the file stem. |
| `--no-edit` | Create the file without opening an editor. |

Paths in `open`, `encrypt`, `decrypt` and `new` may be given relative to the
working directory or to the repository root, whichever resolves — so `-C` and
shell completion both work.

### `fjord ls [path]`

Lists Docs and vault files. At the repository root each vault is one line;
inside a vault, subdirectories collapse into one row unless you pass `-R`.
Payloads are listed under their document name, so you never have to think
about `.age`.

A plain listing reads **no** document contents, so it needs no identity: in
a `fileNaming: "plain"` vault the names are already visible to anyone who
can read the repository. `--long` and `--json` do read frontmatter, which in
an encrypted vault means decrypting every Markdown file in scope — without
an identity they list what they can and say what they could not read.

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output. |
| `--long` | Show size, date, id and title. |
| `-R`, `--recursive` | Recurse into subdirectories. |

### `fjord grep <pattern> [path]`

Searches document contents. In an encrypted vault this decrypts every file
to search it, so expect it to be slower than `grep` on plaintext. Decrypted
content is held in memory and never written anywhere.

The pattern is a **literal substring, not a regular expression** — a regex
engine is not among this project's dependencies, and promising regex syntax
while implementing substring matching would be worse than saying which it
is.

| Flag | Effect |
| --- | --- |
| `-i`, `--ignore-case` | Case-insensitive. |
| `--json` | Machine-readable output, with a match count. |

Unlike `grep(1)`, **no matches is not an error**: exit `1` means "problems
found in the repository" throughout this tool, and a search that found
nothing is not a problem. Encrypted vaults your identity cannot open are
skipped with a note on stderr, not silently.

### `fjord status`

Repository health and sync state: vault summary, pending git changes,
commits to push or pull, unresolved conflicts, and whether `fjord verify`
would report anything.

An encrypted vault's summary gives no document count, deliberately: nothing
is decrypted to produce it, so a Doc is indistinguishable from any other
file. `fjord ls --long` reads frontmatter and can tell you.

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output. |

### `fjord sync`

Pulls, resolves conflicts, pushes.

```
$ fjord sync
  committed Sync local changes
  ↓ pulled 2 commits
  ⚠ Private/Inbox/groceries.md.age changed on both sides — merged
  ↑ pushed 2 commits
```

**This cannot be `git pull`.** Git cannot merge ciphertext, and spec §9.1
says clients must not ask it to: a textual three-way merge of two age
payloads produces a file that is neither side and decrypts to nothing. So
`.gitattributes` sets `*.age -merge`, which makes Git stop at a conflicting
payload instead of mangling it, and Fjord resolves it by **decrypting both
sides and their merge base, merging the plaintext, and re-encrypting.**
Plaintext vaults take the same path, so there is one implementation rather
than two.

Local changes are committed first — that is what "sync" means — and the
first sync after `git remote add` pushes and sets up branch tracking, so you
never need `git push -u` by hand.

| Flag | Effect |
| --- | --- |
| `--no-push` | Commit and pull, but do not push. |
| `--message <text>` | Commit message for local changes. Defaults to "Sync local changes". |

### When a merge cannot complete

**Neither version is ever discarded.** Yours stays exactly where it was, and
theirs is written alongside it as a new Doc with a fresh `id` — the remedy
spec §9.1 gives. The fresh id matters: two files sharing one id would
resolve a conflict by creating an `E401`.

```
  ✗ conflict Private/Inbox/groceries.md.age
    both sides changed the same lines
    your version is unchanged at Private/Inbox/groceries.md.age
    theirs is kept alongside it at Private/Inbox/groceries.conflict-8YX194D6.md.age

  held back: nothing was pushed. Resolve the documents above, then run
  `fjord sync` again.
```

The command exits `1` and **does not push**: everyone else would otherwise
inherit a conflict only you can resolve. Read both with `fjord decrypt` or
`fjord open`, fold them together, and delete the one you do not want.

Three cases take this path rather than merging:

- Both sides changed the same lines.
- The document is not text — a PDF has no lines to merge, and merging it as
  text would corrupt it.
- No identity of yours decrypts it, so there is nothing to merge. The two
  ciphertexts are kept as they are.

A file deleted on one side and changed on the other keeps the changed
version, since a deletion cannot be preserved as a file.

### `fjord key`

```bash
fjord key new                            # generate an identity
fjord key add <recipient> --vault Private
fjord key list
fjord key remove <recipient> --vault Private
```

`fjord key new` writes the identity to `~/.config/fjord/identity.txt` (or
`$FJORD_CONFIG_DIR`), readable only by you, and prints its **public key**.
The secret is never printed: a terminal is scrollback, a CI log, and
sometimes a screen share. It is in the file, which you own.

It refuses to write an identity anywhere inside a Fjord repository (spec
§11.3), and refuses to overwrite an existing one — doing so would make every
file encrypted to the old key unreadable.

**Adding a recipient does not grant access to existing files.** age encrypts
each file to the recipients present when it was written, so a newly added key
cannot read anything older. Either copy one identity to each of your devices,
or run `fjord rekey` after adding one.

**Removing a recipient revokes nothing.** Every version already in git
history stays readable by that key, permanently. `fjord key remove` says so
before it acts.

### `fjord rekey <vault>`

Re-encrypts every file in a vault to the current recipient list. Needed after
adding a device key if that device must read existing documents. Rewrites the
whole vault in one commit.

### `fjord vault`

```bash
fjord vault list
fjord vault add Archive                                  # plaintext
fjord vault add Secret --encrypted                       # encrypted
fjord vault add Secret --encrypted --id-naming           # names concealed too
```

A vault is a directory at the repository root; its directory name is its
address. `add` writes the vault's manifest, its recipients file and its
plaintext guard, and adds it to `fjord.json` — preserving every other field
in that file, including ones this build does not understand.

`--id-naming` requires `--encrypted`: naming files by id on a plaintext
vault conceals nothing and makes the vault unbrowsable, which spec §7.2
requires clients to reject. See [File naming](#file-naming) below.

### File naming

`fileNaming: "plain"` is the default: the file on disk is the document's
name plus `.age`, so `report.xlsx` becomes `report.xlsx.age`. Browsable,
and the original name and type survive decryption.

`fileNaming: "id"` names the file by the document's ULID instead:
`Projects/01JAG7Q2M5X3V8KDQZ9R4T6YHB.age`. Directory names stay readable —
only leaf names are concealed, and spec §11.2 is worth re-reading before
you decide that is enough.

Because the name is then nowhere on disk, it lives inside the payload: the
plaintext is a single-entry tar archive whose entry name is the document's
real file name. So **`age -d | tar -x` recovers the file under its correct
name**, for any file type, including binaries that cannot carry
frontmatter:

```bash
age -d -i ~/.config/fjord/identity.txt Secret/01JAG7Q….age | tar -xf -
```

Two consequences worth knowing:

- **Git history gets better.** An id never changes when a title does, so
  renaming a document rewrites one file in place instead of appearing as a
  delete plus an add. Git's rename detection cannot see through ciphertext,
  so in `plain` mode a rename does break the chain.
- **Other editors become useless for that vault.** Nothing is lost — the
  recovery command above is the whole procedure — but nothing is browsable
  either.

`fjord ls --long` and `fjord grep` read through the container, so they show
and search documents by their real names.

### `fjord export <vault> <dir>` / `fjord import <dir> <vault>`

Bulk decrypt to a plain directory, and bring a directory of files in as Docs.
`export` is the escape hatch; it is deliberately simple and will keep working.

## Diagnostics

Codes are stable published API. Once released, a code's meaning never
changes — new checks get new codes.

### Repository — `E1xx`

| Code | Meaning |
| --- | --- |
| `E101` | `fjord.json` missing |
| `E102` | `fjord.json` is not valid JSON |
| `E103` | Format version newer than this tool supports — read-only |
| `E104` | Required field missing |
| `E105` | Field is not a valid ULID |
| `E106` | Vault listed in the manifest does not exist on disk |
| `E108` | Vault `id` disagrees with its `fjord.vault.json` |
| `E109` | `.gitattributes` missing or lacks the `*.age -merge` guard |
| `E110` | Field value is not valid for its type or domain |

### Vault — `E2xx`

| Code | Meaning |
| --- | --- |
| `E201` | Plaintext file inside an encrypted vault |
| `E202` | `fjord.vault.json` is not valid JSON |
| `E203` | `encryption.tool` is not supported |
| `E204` | Recipients file named in the manifest is missing |
| `E206` | Passphrase recipient present — forbidden by spec §6.2 |
| `E207` | Nested vault — not permitted in version 1 |
| `E208` | Encrypted vault is missing its plaintext-guard `.gitignore` |
| `E209` | Malformed line in the recipients file |

### Encryption — `E3xx`

| Code | Meaning |
| --- | --- |
| `E301` | age payload is corrupt or unreadable. `fjord verify` checks the header, which needs no key; the body is authenticated when the file is read |
| `E302` | `.age` file inside a plaintext vault |
| `E303` | tar container is malformed: not exactly one regular file, or the entry name contains a path. Reported when a document is read — the archive is inside the ciphertext, so `fjord verify` cannot see it without your key |
| `E304` | `fileNaming` is `"id"` but the file name is not a valid ULID |
| `E305` | `container` is `"none"` but `fileNaming` is `"id"` |
| `E306` | `fileNaming` is `"id"` on a plaintext vault |

### Documents — `E4xx`

| Code | Meaning |
| --- | --- |
| `E401` | Duplicate `id` — two documents claim the same identity |
| `E402` | Frontmatter present but not parseable as a YAML mapping |
| `E403` | `id` present but not a valid ULID |
| `E404` | Frontmatter does not begin at byte 0, or a BOM precedes it |
| `E405` | Timestamp is not RFC 3339 in UTC — `createdAt` in either manifest, or a document's `created` |

### Paths — `E5xx`

| Code | Meaning |
| --- | --- |
| `E501` | Forbidden character in a file or directory name |
| `E502` | Name ends with a dot or a space |
| `E503` | Windows reserved device name |
| `E504` | Path component exceeds 255 bytes |
| `E505` | Two entries in one directory differ only by case |
| `E506` | Name is not Unicode NFC |
| `E507` | Manifest path is absolute or contains `..` |
| `E508` | Symlink resolves outside the repository |

`E107`, `E205` and `W603` are reserved: they were drafted and withdrawn
before release, and will never be assigned.

### Warnings — `W6xx`

| Code | Meaning |
| --- | --- |
| `W601` | Vault on disk is not listed in `fjord.json` |
| `W602` | Encrypted vault has no recipients — valid, but unwritable |
| `W604` | File exceeds 25 MB — Fjord is for documents, not media |
| `W605` | Path exceeds 240 bytes — may fail to check out on Windows |

### What `--fix` will and will not do

Will: normalise a name to NFC, write a missing `.gitattributes` guard, add a
missing plaintext-guard `.gitignore`, and add a vault present on disk to
`fjord.json` (`W601`).

Will not: rename or move anything to resolve a case collision, delete or
relocate plaintext found in an encrypted vault, merge duplicate ids, or touch
document content. Those need a human, because each of them can lose data.

It will also not add an `id` to a file that has none. A Markdown file
without frontmatter is a vault file, not a broken Doc (spec §8.2), and a
client "MUST NOT rewrite files merely because it scanned them". Use
`fjord new` to create a Doc, or edit the file to promote one.

`--fix` arrives with `fjord init`, which writes the same scaffolding. Until
then it is refused as a usage error rather than silently ignored.

## Environment

| Variable | Effect |
| --- | --- |
| `FJORD_IDENTITY` | Path to the age identity file. |
| `FJORD_CONFIG_DIR` | Overrides `~/.config/fjord`. |
| `EDITOR`, `VISUAL` | Editor used by `open` and `new`. |
| `NO_COLOR` | Disables colour. |

Identities are passed by path or on stdin, never as a command-line argument —
`argv` is visible to every process on the machine:

```bash
fjord --identity ~/.config/fjord/identity.txt decrypt Private/notes.md.age
pass fjord/identity | fjord --identity - decrypt Private/notes.md.age
```

Fjord warns if an identity file is readable by other users.

## Exit codes

| | |
| --- | --- |
| `0` | Success, or repository conforms |
| `1` | Problems found |
| `2` | Usage error |
| `3` | IO or git failure |

## Known limitations

- **Comments in frontmatter are not preserved** when Fjord rewrites a file.
  Unknown *keys* always are. Preserving comments needs an AST-level YAML
  parser; the specification permits losing them.
- **`fjord grep` in an encrypted vault decrypts everything** to search it.
- **Shredding temporary files is best-effort** on SSDs and copy-on-write
  filesystems.

## Licence

Apache-2.0 or MIT, at your option. The specification itself is CC0.
