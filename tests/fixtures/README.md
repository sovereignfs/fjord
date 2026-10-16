# Fixtures

`conforming/` is one valid repository. `fjord verify` must exit 0 against it
with **no diagnostics at all** — not even a warning.

`broken/<code>/` is a minimal repository that triggers exactly diagnostic
`<code>` and nothing else: for example `broken/E201/` holds a plaintext file
inside an encrypted vault. Each is the same minimal conforming base — a
`fjord.json`, a `.gitattributes` with the `*.age -merge` guard, and one
plaintext `Public` vault — plus a single defect.

The suite lives in `crates/fjord-core/tests/fixtures.rs`, and
`every_diagnostic_is_covered` there fails if a code has no fixture and is not
recorded as deferred. Adding a diagnostic therefore means adding a fixture,
or saying in that file why it has none.

## Why some fixtures are not here

A fixture for most of the `E5xx` path rules **cannot** be a committed
directory, and the reason is the rules themselves:

- A repository holding both `Notes.md` and `notes.md` does not check out on
  macOS, where the two names collapse into one file.
- One holding `CON.md`, `a?b.md`, or a name ending in a dot or a space does
  not check out on Windows at all.
- A path component over 255 bytes cannot be created on any mainstream
  filesystem, so it is reachable only by validating a name *before* writing
  it.
- A 25 MB file to trigger `W604` has no business in version control.

Committing those would make this repository unclonable on the very platforms
the rules exist to protect. So they are synthesised into a temporary
directory at test time instead, from the same scaffold the committed
fixtures use. `crates/fjord-core/tests/fixtures.rs` lists which codes are
covered which way.

## Placeholders to replace at M3

Two things here are shaped correctly but are not real cryptography, because
M1 performs none:

- **The age recipient** in `conforming/Private/recipients.txt` and in the
  encrypted `broken/` fixtures is syntactically valid — `age1` plus 58
  bech32 characters — but it is **not a real public key**, and no identity
  exists that can decrypt to it. M3 must replace it with a generated
  keypair, and record the test identity outside the repository.
- **The `.age` payloads** in `broken/E302/` and `broken/E304/` are
  placeholder text. M1 never opens a payload. As soon as M3 parses one,
  these will need to be real age files, or those fixtures will start
  emitting `E301` as well as the code they are named for.

## A trap when adding one

An encrypted vault's `.gitignore` is the §6.5 plaintext guard: it ignores
everything and re-permits only payloads and machinery. Git applies it to the
fixture like any other `.gitignore` — so a fixture whose defect *is* a
plaintext file in an encrypted vault cannot be committed with the canonical
guard in place, because git will refuse to track the file under test.

`broken/E201/` handles this the way the real failure happens: its guard has
been weakened by hand with an extra `!notes.md`. The guard still contains `*`
and `!*.age`, so `E208` does not fire, and `E201` is the only code emitted.
