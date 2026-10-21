# Fjord

Keep your documents as plain files in a Git repository you control, with
optional end-to-end encryption using [age](https://age-encryption.org/v1).
Fjord is a **format**, written down in [`spec/SPEC.md`](spec/SPEC.md), and the
tools that read and write it. Anything that follows the specification can open
a Fjord repository, and a repository stays readable without any of them: the
files are plain files, and an encrypted one is recovered with `age -d` alone.

This repository holds the specification, the reference implementation, and the
clients and integrations built on it, so that a change to the format and the
code that implements it is one commit.

## What is here

| Component | What it is | Status | Install |
| --- | --- | --- | --- |
| [`spec/`](spec/SPEC.md) | The repository format. Canonical; CC0. | Draft | — |
| [`crates/fjord-core`](crates/fjord-core) | The format as a library: manifests, paths, Docs, encryption, `verify`. Built to run anywhere (desktop, mobile, WASM). | Released with the CLI | — |
| [`crates/fjord`](crates/fjord) | **`fjord`**, the command-line tool. | Released | [Install](crates/fjord/README.md#install) |
| `clients/web`, `clients/desktop`, `clients/mobile` | End-user apps. | Planned | — |
| `plugins/vscode`, `plugins/obsidian` | Editor integrations. | Planned | — |

Directories for planned components are created when work on them starts.

[`tests/fixtures/`](tests/fixtures) is the format's conformance suite: a valid
repository, and one minimal broken repository per diagnostic. It belongs to the
format, not to the CLI, and every client is expected to pass it.

## The command-line tool

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/sovereignfs/fjord/releases/latest/download/fjord-cli-installer.sh | sh

fjord init notes && cd notes
fjord verify
```

Everything it does is in the [CLI's README](crates/fjord/README.md), and what
changed between versions is in its [CHANGELOG](crates/fjord/CHANGELOG.md).

## Building

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

Rust 1.88 or newer. [`CLAUDE.md`](CLAUDE.md) is the build brief: the
invariants nothing may break, the architecture, and what a new component owes
the rest. [`ROADMAP.md`](ROADMAP.md) records what is done, what is not, and why.
[`RELEASING.md`](RELEASING.md) explains how each component is released.

## Licence

The reference implementation is licensed under the
[Mozilla Public License 2.0](LICENSE). The specification is dedicated to the
public domain under [CC0](spec/LICENSE), so that anyone can implement it.
