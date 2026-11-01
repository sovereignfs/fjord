# fjord

The reference toolchain for the [Fjord](https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md) repository
format — a way to keep your documents in a Git repository you control, with
optional end-to-end encryption using [age](https://age-encryption.org/v1).

`fjord verify` decides whether a repository conforms to the specification.
Everything else in this tool is convenience; that command is the point.

## Install

Every build comes from a
[GitHub release](https://github.com/sovereignfs/fjord/releases). The
installers below are themselves release assets, so there is no other host
involved and nothing to trust beyond GitHub and this repository. This
repository also releases other things, so the CLI's releases are tagged
`fjord-cli-vX.Y.Z`, and only a CLI release is ever marked *Latest*: that is
what keeps the `latest` links below pointing at the CLI.

```bash
# macOS / Linux, with Homebrew
brew install sovereignfs/tap/fjord

# macOS / Linux, without it
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/sovereignfs/fjord/releases/latest/download/fjord-cli-installer.sh | sh

# Windows
powershell -c "irm https://github.com/sovereignfs/fjord/releases/latest/download/fjord-cli-installer.ps1 | iex"

# From source, from crates.io (the command is `fjord`; the package is `fjord-cli`)
cargo install fjord-cli

# From source, from the repository's latest commit
cargo install --git https://github.com/sovereignfs/fjord fjord-cli
```

Or take the archive for your platform straight from the
[releases page](https://github.com/sovereignfs/fjord/releases/latest)
and put `fjord` on your `PATH`. Every archive is published with a
`.sha256` checksum beside it, and `sha256.sum` covers the whole release.
Every archive also carries the licence and the README.

Builds are produced for macOS (Apple silicon and Intel), Linux (x86-64 and
arm64) and Windows (x86-64).

The Homebrew formula lives in the tap
[`sovereignfs/homebrew-tap`](https://github.com/sovereignfs/homebrew-tap) and is
written by the release workflow, so it is always the latest release. It installs
the same prebuilt archive as the shell installer, with its checksum, and builds
nothing from source. Homebrew holds one version of a formula; for an older one,
use the release archives above.

Linux builds are statically linked against musl, so one binary works on any
distribution — checked on every push, by inspecting the binary and then
running it.

Building from source needs Rust 1.89 or newer. That is not a style
preference: `time`, `ignore`, `age`'s own dependencies and the YAML library require it.

`cargo install fjord-cli` builds the release published on [crates.io](https://crates.io/crates/fjord-cli) (from 0.4.0). Mind the name: a
different crate called `fjord` exists, and `cargo install fjord` would install that one.

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

`fjord.json` records `"generator": "fjord <version>"` — the version of the
binary that ran, the same string `fjord --version` prints. It is useful for
working out which version made a repository. Two things to know about it:
it is written once, by `init`, and never updated, so it names the creator
and not the last tool to touch the repository; and, like the rest of
`fjord.json`, it is visible to anyone who can read the repository, including
the git host, so it tells them which version you run (spec §11.2).

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
    Private/Projects/01jag7q2m5x3v8kdqz9r4t6yhb.age
      E305  container is "none" but fileNaming is "id"

  2 errors, 0 warnings
```

`✓` conforms, `⚠` warnings only — which still exits `0` — and `✗` at least
one error.

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output. For CI. |
| `--fix` | Repair `fjord.json` where it disagrees with the disk — see [What `--fix` does](#what---fix-does). |
| `--vault <name>` | Check one vault, by directory or by label. |
| `--strict` | Treat warnings as errors. |

Exits `0` when conforming, `1` when any error is found. Warnings alone do not
change the exit code unless `--strict` is given.

The `--json` shape is published API, specified by
[`schema/verify.schema.json`](https://github.com/sovereignfs/fjord/blob/main/schema/verify.schema.json) and checked against
it on every test run.

### `fjord encrypt <path>`

Given a **vault**, this checks a [checkout](#working-on-a-whole-vault) back
in. Given a file, it encrypts one file in place inside an encrypted vault: `notes.md` becomes
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

Writes the plaintext of one file to **stdout**, so decrypted content never
lands in the repository by accident.

| Flag | Effect |
| --- | --- |
| `--out <path>` | Write to a file instead. Refused if it would land inside an encrypted vault (spec §6.5). |

```bash
fjord decrypt Private/notes.md.age            # to stdout
fjord decrypt Private/notes.md.age -o ~/notes.md
```

Give it a **vault** instead of a file and it starts a checkout — see
[Working on a whole vault](#working-on-a-whole-vault).

### Working on a whole vault

Editing an encrypted vault one document at a time is slow, and editors and
note applications expect the files to be where they belong. So you can check
a vault out:

```bash
fjord decrypt Private       # every document is decrypted beside its .age file
# … edit, add and delete files with any tool …
fjord encrypt Private       # check it back in
fjord sync
```

`notes.md.age` becomes `notes.md` in the same directory. The `.age` files
stay exactly as they were until check-in, and the vault's `.gitignore` keeps
the decrypted copies out of every `git add`, so even a plain `git commit`
cannot pick them up.

**This is the one place Fjord writes plaintext into an encrypted vault**
(spec §6.6), so it is fenced in:

- It only happens when you run `fjord decrypt <vault>`. Nothing else starts
  one.
- It refuses if the vault's guard `.gitignore` is missing (`E208`), if the
  vault already holds a file in the clear, or if it is already checked out.
- Every document is decrypted before any file is written, and a record of
  the checkout is written *before* the first one, under `.fjord/local/`
  (which git ignores).
- **While a vault is checked out, `fjord sync`, `rekey` and
  `vault add --commit` refuse** and say how to finish. `fjord status` and
  `fjord verify` show it too; `verify` still reports the files in the clear
  as `E201`, because they are.
- Decrypted files are created owner-only. Anything with access to the
  directory can read them until you check the vault back in.
- `fjord open` refuses a document in a checked-out vault: two copies of one
  document is how edits get lost.

`fjord encrypt <vault>` then:

- re-encrypts **only** the documents you changed (an untouched payload is
  left byte for byte as it was, so git sees no churn);
- encrypts new files, and removes the encrypted copies of files you deleted
  — **after listing them and asking** (`--yes` to skip the question; with
  `--no-input` it is a usage error without it). Git history still has them;
- removes editor and system files (`.DS_Store`, `*~`, `*.swp`, …) rather
  than encrypting them;
- checks that every payload it wrote decrypts to the document it was made
  from, and only then removes the plaintext and ends the checkout;
- **changes nothing at all** unless all of that can succeed, and refuses if a
  payload changed on disk since you decrypted (a pull, say) rather than
  overwrite it.

In an `id`-named vault a document keeps its payload name, which is its id, so
renaming a file in your editor is an edit of the same payload. A new Markdown
file that already carries an `id` is stored under it.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Say what would be re-encrypted, added and removed, and change nothing. |
| `--yes` | Do not ask before removing the payloads of deleted documents. |
| `--discard` | Throw the decrypted copies away without saving them, and end the checkout. Asks first. |

If `fjord decrypt <vault>` is interrupted, the record says so, and check-in
refuses (the files that were never written would otherwise look deleted). Run
`fjord encrypt <vault> --discard`, then decrypt again; your payloads were
never touched.

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

A Fjord Doc is a **document** if its name ends in `.fj.md` and a **note** if it
ends in plain `.md` (spec §8.4): the same format, told apart by name, so an
editor can treat a long-form document differently. `--document` makes it one —
`plan` and `plan.md` become `plan.fj.md` — and a name that already ends in
`.fj.md` is a document without the flag.

Names are checked against the path rules of spec §5 *before* anything is
written, so a document that could not be checked out on Windows or macOS is
never created in the first place.

| Flag | Effect |
| --- | --- |
| `--title <text>` | Set the title. Defaults to the file stem (without `.md` or `.fj.md`). |
| `--document` | Make it a document: name it `*.fj.md`. |
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
| `--json` | Machine-readable output. A Fjord Doc has `"kind": "doc"` and `"docKind": "document"` or `"note"` (spec §8.4); anything else has `"docKind": null`. |
| `--long` | Show size, date, and for a Fjord Doc its kind (`document` or `note`), id and title. |
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

### The commit guard

A vault's `.gitignore` (spec §6.5) keeps a stray decrypted file out of a
commit, but quietly: the file is *skipped*, so your edit is in no commit and
`fjord sync` used to answer "already up to date". Worse, if that `.gitignore`
has been deleted, the file was committed and pushed.

So the commands that stage and commit on their own authority — `fjord sync`,
`fjord rekey` and `fjord vault add --commit` — check first, and refuse with
exit `1`, naming the files, when an encrypted vault:

- is [checked out](#working-on-a-whole-vault) with `fjord decrypt <vault>`,
- holds a file in the clear (`E201`), or
- has no plaintext-guard `.gitignore` (`E208`).

Nothing is staged, committed, pushed, encrypted or deleted. Fix it with
`fjord encrypt <path>` (or `fjord open <path>` to edit a document without
decrypting it into the repository), or move the file out of the repository,
and run the command again. `fjord verify` reports the same two codes.

This covers Fjord's own commands only. A plain `git commit` is not
intercepted; the vault's `.gitignore` is what protects that, which is why a
missing one is treated as an error.

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

A key is checked as it is added: right shape is not enough, because a bech32
key carries a checksum and one mistyped character breaks it. A key that does
not check out, a secret key, an SSH recipient and a passphrase recipient are
each refused with their own reason.

**Adding a recipient does not grant access to existing files.** age encrypts
each file to the recipients present when it was written, so a newly added key
cannot read anything older. Either copy one identity to each of your devices,
or run `fjord rekey` after adding one.

**Removing a recipient revokes nothing.** Every version already in git
history stays readable by that key, permanently. `fjord key remove` says so
before it acts.

### `fjord rekey <vault>`

Re-encrypts every file in a vault to the current recipient list. Needed
after adding a device key if that device must read existing documents,
because age encrypts each file to the recipients present when it was
written. Rewrites the whole vault in one commit.

```bash
fjord key add <public-key> --vault Private
fjord rekey Private
```

| Flag | Effect |
| --- | --- |
| `--yes` | Skip the confirmation prompt. |

It asks before rewriting a vault. Without a terminal to ask on — a pipe, a
CI job, or `--no-input` — it refuses rather than hangs, and tells you to
pass `--yes`.

**It will not lock you out.** Re-encrypting to a recipient list that holds
none of your identities would make every document in the vault permanently
unreadable, and spec §11.4 leaves no way back from that. So one document is
re-encrypted and read back before anything is written, and a result Fjord
cannot read is refused. If handing a vault to someone else really is the
intent, use `age -R` directly.

**It revokes nothing.** Every version already committed stays decryptable
by every key it was written to, permanently, because Git keeps history.
Rekeying changes what happens from here. See
[Rotating and revoking keys](#fjord-key) above.

It refuses while any encrypted vault holds a file in the clear (`E201`) or
lacks its plaintext-guard `.gitignore` (`E208`), because it stages the whole
vault. Nothing is encrypted or moved for you: `fjord encrypt <path>` is the
repair. See [The commit guard](#the-commit-guard).

### `fjord vault`

```bash
fjord vault list
fjord vault add Archive                                  # plaintext
fjord vault add Secret --encrypted --recipient <key>     # encrypted, ready to use
fjord vault add Secret --encrypted --id-naming --recipient <key>
fjord vault add Secret --encrypted                       # encrypted, no keys yet
```

A vault is a directory at the repository root; its directory name is its
address. `add` writes the vault's manifest, its recipients file and its
plaintext guard, and adds it to `fjord.json` — preserving every other field
in that file, including ones this build does not understand. An encrypted
vault also brings spec §9's `*.age binary -diff -merge` line to `.gitattributes`
if the repository lacks it. The web client's *Add a vault* asks the same planner
(`fjord_core::scaffold::plan_vault`), so it writes the same files.

| Flag | Effect |
| --- | --- |
| `--encrypted` | Encrypt the vault with age. |
| `--id-naming` | Name files by ULID. Requires `--encrypted`. |
| `--recipient <key>` | Register an age **public** key, so the vault is writable immediately. Repeat for several. Requires `--encrypted`. |
| `--commit` | Commit the new vault, and only what adding it changed (`fjord.json`, and `.gitattributes` if it gained the guard). |
| `--json` | Machine-readable output: the vault's id, its settings, the recipients registered, whether it was committed, the files written in the vault (`files`) and the ones it changed outside it (`changed`). |

**Without `--recipient`, an encrypted vault is created unwritable.** Spec
§6.2 makes a vault with no recipients valid but unwritable, and `fjord
verify` warns about it (`W602`) until you run `fjord key add`. Giving
`--recipient` at creation skips that step: the first document can be written
straight away, and the new vault has nothing to warn about.

**`--commit` records the vault in one commit** — `Add vault <name>` — holding
the vault's files and its entry in `fjord.json`, and **nothing else**.
Anything you had already staged, edited or left untracked stays exactly as it
was: a plain `git commit` takes the whole index, so a commit that says it adds
a vault would otherwise carry whatever else was staged. Without `--commit`
nothing is committed, like `new`, `encrypt` and `key add`; `fjord sync` will
pick it up. It needs a git repository and refuses up front, creating nothing,
if there is none. If the vault is created but git then refuses the commit — an
unset `user.email`, most often — the error says the vault exists and how to
commit it by hand.

**Every key is checked before anything is written.** One mistyped character
leaves a key with the right length and alphabet and a failed checksum, and a
vault holding one — or holding some of its keys — looks usable and fails on
first write, often on someone else's machine. So a bad key refuses the whole
command and nothing is created. The same check applies to `fjord key add`.

A secret key given by mistake is refused and **never printed back**. It is
already in your shell history, and the message says to treat it as exposed.

SSH recipients are refused with the reason: this build links no RSA
implementation, on purpose, because of an unfixed key-recovery weakness in
it (RUSTSEC-2023-0071).

`--id-naming` requires `--encrypted`: naming files by id on a plaintext
vault conceals nothing and makes the vault unbrowsable, which spec §7.2
requires clients to reject. See [File naming](#file-naming) below.

### File naming

`fileNaming: "plain"` is the default: the file on disk is the document's
name plus `.age`, so `report.xlsx` becomes `report.xlsx.age`. Browsable,
and the original name and type survive decryption.

`fileNaming: "id"` names the file by the document's ULID instead:
`Projects/01jag7q2m5x3v8kdqz9r4t6yhb.age`. Directory names stay readable —
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

Bulk decrypt to a plain directory, and bring a directory of files in as
Docs. `export` is the escape hatch; it is deliberately simple and will keep
working.

```bash
fjord export Private ~/restored        # decrypt the whole vault
fjord import ~/incoming Private        # bring a directory in
```

**`export` writes outside the repository only.** Anything in a vault gets
committed, and anything in an encrypted vault must never be plaintext
(§6.5), so a destination inside the repository is refused. It will not write
over an existing directory's contents either. In a `fileNaming: "id"` vault
this is where the container earns its keep: files come out under their real
names rather than as ULIDs.

**`import` promotes Markdown to Docs.** A `.md` file without frontmatter
gains an `id`, a `created` timestamp and a `title` — taken from its first
`#` heading, else its file name. §8.2 permits that on an explicit
instruction while forbidding it on a mere scan, which is why importing does
it and `verify` never does. A file that already has an `id` comes in
untouched, keys and all. Everything that is not Markdown is stored as a
vault file, which is what §8 says it is.

Both are all-or-nothing about names: every path is checked against the rules
of §5, and against what already exists, *before* anything is written. A bulk
operation that stops halfway leaves a mess no error message can describe.

Symbolic links in the source directory are skipped rather than followed.

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output, listing what was transferred. |

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

### What `--fix` does

It repairs `fjord.json` where it disagrees with the disk, because the
filesystem is authoritative and the manifest is only a convenience (spec
§2.1). That is the whole of it:

- a vault on disk that `fjord.json` does not list (`W601`) is **added**, with
  the `id` its own `fjord.vault.json` declares;
- a listed vault whose directory is gone (`E106`) has its entry **removed**.

Unknown keys, their order, and the other entries are carried through
untouched. It leaves alone a vault whose own `id` is missing, malformed or
already listed under another path, because adding it would trade a warning
for an error. It changes nothing else and commits nothing: `git diff
fjord.json` shows what it did, and a second run reports `nothing to repair`.
It refuses to write to a repository made by a newer version of Fjord.

It does **not** rename or move anything to resolve a case collision, delete
or relocate plaintext found in an encrypted vault, merge duplicate ids,
write a missing `.gitattributes` or `.gitignore` guard (`E109`, `E208`), or
normalise a name to NFC. Those are reported and left for a human, because
each can lose data or has not been built; none of them is a disagreement
between the manifest and the disk. It never touches document content.

It will also not add an `id` to a file that has none. A Markdown file without
frontmatter is a vault file, not a broken Doc (spec §8.2), and a client "MUST
NOT rewrite files merely because it scanned them". Use `fjord new` to create
a Doc, or edit the file to promote one.

`fjord verify --fix --json` adds a `repairs` array saying what changed.

### Conformance

Spec §10 asks a client to declare which levels it implements. This build
declares **L0 through L3**: it reads and writes plaintext vaults, and reads
and writes encrypted ones. The declaration is published in
`fjord verify --json` as `conformance`, and a repository made by a newer
version of Fjord is read-only whatever it says.

One limit on L3: spec §6.2 lets a vault list SSH recipients and requires
every file to be encrypted to *all* recipients. This build links no RSA
implementation (RUSTSEC-2023-0071), so it **refuses** to write to such a
vault by name rather than encrypt to only the recipients it can handle. It
still reads that vault if you hold a key it supports. On such a vault it is an
L2 client.

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

## Changed since 0.1.0

The full history of every release is in [CHANGELOG.md](CHANGELOG.md).

**Identifiers are now lowercase** (spec §8.3). 0.1.0 wrote them uppercase,
so a repository it created does not conform to the current format, and
`fjord verify` says so — with a message that names the old spelling, so it
is not mistaken for a typo:

```
E105  field is not a valid ULID
      id is uppercase, but ids are lowercase (spec §8.3). Repositories made
      by Fjord 0.1.0 use the old spelling
```

Nothing is accepted in both forms. §8.3 permits exactly one, so that every
client can compare and sort identifiers without negotiating, and tolerating
the old spelling would quietly bring that negotiation back. The format is
still a draft and breaking changes are expected until it is declared stable.

If a 0.1.0 repository holds nothing you need, run `fjord init` again. If it
does, **do not hand-edit it**: identifiers also appear as file names in
`id`-named vaults and inside encrypted documents, where a text replacement
cannot reach.

## Known limitations

- **Comments in frontmatter are not preserved** when Fjord rewrites a file.
  Unknown *keys* always are, with their values and their order. Preserving comments needs an AST-level YAML
  parser; the specification permits losing them. A frontmatter block that Fjord could not write back exactly is reported as
  unparseable (`E402`) and is not rewritten: a key given twice, a YAML tag, and a whole number too large to be one
  (quote it to keep it as text). Numbers are read as the library reads them, which is slightly wider than YAML 1.2: `1_000` is the
  number 1000, as in YAML 1.1 and Obsidian, and is written back as `1000`.
- **`fjord grep` in an encrypted vault decrypts everything** to search it.
- **Shredding temporary files is best-effort** on SSDs and copy-on-write
  filesystems.

## Licence

[MPL-2.0](https://github.com/sovereignfs/fjord/blob/main/LICENSE) — the Mozilla Public License, version 2.0.

It is file-level copyleft, which means two things in practice:

- **Changes to Fjord come back.** If you modify one of these source files
  and distribute the result — as source or as a binary, free or paid — that
  file's source must be published under the MPL too.
- **What you build around it stays yours.** Fjord can be embedded in a
  larger work, including a proprietary or paid application, without that
  work becoming MPL. Only Fjord's own files are covered.

That bargain applies to everyone equally, including the authors: there is
no contributor licence agreement and no commercial exception, so nobody
holds rights here that you do not.

**The specification itself remains [CC0](https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md#licence)** — public domain,
deliberately. The format is meant to outlive this implementation, and
anyone should be able to write another one without asking.
