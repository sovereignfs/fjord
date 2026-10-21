# Contributing to Fjord

Thank you for wanting to help. This is everything you need to get a change
merged. The agent-facing version of these rules is the "Working conventions"
section of [`CLAUDE.md`](CLAUDE.md); the two are meant to say the same thing.

## Contents

- [Development setup](#development-setup)
- [Branching and commits](#branching-and-commits)
- [Pull requests](#pull-requests)
- [Continuous integration](#continuous-integration)
- [Changing the format](#changing-the-format)
- [Releases](#releases)
- [Licence of contributions](#licence-of-contributions)

## Development setup

You need Rust 1.88 or newer, Git, and for the full test suite the reference
[`age`](https://github.com/FiloSottile/age) binary (the interop tests skip
without it, and CI always has it).

```bash
git clone https://github.com/sovereignfs/fjord.git
cd fjord
cargo build --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

[`CLAUDE.md`](CLAUDE.md) is the build brief: the invariants nothing may break,
the architecture, and what a new component owes the rest. Read its
"Non-negotiable invariants" before touching anything that reads or writes a
vault.

## Branching and commits

Always branch from an up-to-date `main`, and never commit to it directly:

```bash
git switch main && git pull
git switch -c feat/your-change
```

| Prefix   | Use for                                         |
| -------- | ----------------------------------------------- |
| `feat/`  | New features or capabilities                    |
| `fix/`   | Bug fixes                                       |
| `docs/`  | Documentation only                              |
| `chore/` | Tooling, scaffolding, dependencies, maintenance |

**Commit messages** explain *why*, not just *what*. Keep the subject under 72
characters and wrap the body at 100. One logical change per commit.

If an AI assistant helped write the code, say so with a trailer:

```
Co-Authored-By: Claude Code <noreply@anthropic.com>
```

## Pull requests

- **One logical change per PR.** Keep the scope tight.
- Open it as a **draft** while it is in progress; mark it *Ready for review*
  when it is. CI does not run on drafts.
- Before asking for review, make sure these pass locally:
  `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace`.
- If you change the format, change the spec, the fixtures and the code in the
  same PR (see below).
- If you change behaviour, add a line under `## [Unreleased]` in the component's
  `CHANGELOG.md`. Do **not** bump a version: releases are their own PR.
- PRs are merged with **rebase and merge**. No squash, no merge commits, so
  fix commit messages *before* the merge, because afterwards they are on `main`.

## Continuous integration

CI runs on pull requests targeting `main` and on pushes to `main`
(`.github/workflows/ci.yml`), but only when a change can affect the Rust crates:
`crates/`, `spec/`, `schema/`, `tests/`, `scripts/`, the workspace manifests and
the workflow itself. It checks that the crate and the reference `age`
implementation agree, runs the suite on Linux and macOS, builds on Windows,
holds clippy and rustfmt, and checks the minimum Rust version and a static musl
binary. A separate Audit workflow runs `cargo deny` when the dependency tree
changes.

On a pull request, CI is **skipped while the PR is a draft** and while it carries
the **`skip-ci`** label. Marking the PR ready runs it.

## Changing the format

The specification is [`spec/SPEC.md`](spec/SPEC.md) and it is canonical here.
A change to the format is one PR that changes the spec, adds or updates a
fixture under `tests/fixtures/` (every diagnostic has one that triggers exactly
it), and changes the code. A client that reads Fjord repositories is expected to
pass those fixtures.

## Releases

Maintainers cut releases with `scripts/release.sh`; see
[`RELEASING.md`](RELEASING.md). A release is its own pull request, tagged after
it merges. Contributors do not need to do anything for one.

## Licence of contributions

The reference implementation is licensed under the
[Mozilla Public License 2.0](LICENSE) and the specification is dedicated to the
public domain under CC0 ([`spec/LICENSE`](spec/LICENSE)). By contributing you
agree that your contribution is licensed under the same terms as the part of the
repository it changes.
