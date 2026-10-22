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
| [`crates/fjord-cli`](crates/fjord-cli) | **`fjord`**, the command-line tool. | Released | [Install](crates/fjord-cli/README.md#install) |
| [`clients/web`](clients/web) | The hosted web client: browse, edit, share and comment on documents. | Building: a placeholder app ([plan](clients/web/ROADMAP.md)) | — |
| [`clients/mobile`](clients/mobile) | The iOS and Android client: browse, edit and capture quick notes, offline. | Design ([plan](clients/mobile/ROADMAP.md)) | — |
| [`clients/mcp`](clients/mcp) | **`fjord-mcp`**: Claude (and later ChatGPT) saves and manages documents in your repository. | Design ([plan](clients/mcp/ROADMAP.md)) | — |
| `clients/desktop` | The desktop app. | Planned | — |
| `plugins/vscode`, `plugins/obsidian` | Editor integrations. | Planned | — |

Directories for planned components are created when work on them starts.

[`tests/fixtures/`](tests/fixtures) is the format's conformance suite: a valid
repository, and one minimal broken repository per diagnostic. It belongs to the
format, not to the CLI, and every client is expected to pass it.

## The command-line tool

```bash
# macOS / Linux, with Homebrew
brew install sovereignfs/tap/fjord

# macOS / Linux, without it
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/sovereignfs/fjord/releases/latest/download/fjord-cli-installer.sh | sh

fjord init notes && cd notes
fjord verify
```

Everything it does is in the [CLI's README](crates/fjord-cli/README.md), and what
changed between versions is in its [CHANGELOG](crates/fjord-cli/CHANGELOG.md).

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

## Contributing

Work goes through pull requests: a short-lived branch from `main`, a draft PR,
rebase and merge. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the rules and
[`CLAUDE.md`](CLAUDE.md) the version for agents.

## Licence

The reference implementation is licensed under the
[Mozilla Public License 2.0](LICENSE). The specification is dedicated to the
public domain under [CC0](spec/LICENSE), so that anyone can implement it. Fjord Web
([`clients/web`](clients/web)) is licensed under the
[AGPL-3.0-or-later](clients/web/LICENSE), because it bundles `@sovereignfs/ui`.
