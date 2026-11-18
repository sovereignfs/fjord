# Contributing to Fjord

Thank you for wanting to help. This is everything you need to get a change
merged. The agent-facing version of these rules is [`AGENTS.md`](AGENTS.md), whose
shared section is the same in every repository of the suite.

## Contents

- [Development setup](#development-setup)
- [Branches](#branches), [continuous integration](#continuous-integration), [promoting `develop` into `main`](#promoting-develop-into-main),
  [shared files](#shared-files) and [repository settings](#repository-settings): the same in every repository of the suite
- [Before asking for review](#before-asking-for-review)
- [Which jobs run for a change](#which-jobs-run-for-a-change)
- [Changing the format](#changing-the-format)
- [Proposing a change: RFCs, research and workstreams](#proposing-a-change-rfcs-research-and-workstreams)
- [Licence of contributions](#licence-of-contributions)

## Development setup

You need Rust 1.89 or newer, Git, and for the full test suite the reference
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

<!-- sovereign:shared:begin -->

## Branches

| Branch    | What it is                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `develop` | The working branch. Every change lands here first. `npm create @sovereignfs app` leaves you on it. It can never be deleted or force-pushed.                        |
| `main`    | What is released. It is **protected**: a change reaches it only through a release pull request from `develop`, never by a push (an administrator may bypass this). |

There are two ways to get a change into `develop`; pick per change:

1. **Directly on `develop`.** Commit on an up-to-date `develop` and push it. Suits small, low-risk changes by a maintainer.

   ```bash
   git switch develop && git pull
   # edit, commit
   git push origin develop
   ```

2. **A feature branch.** Branch from an up-to-date `develop`, open a draft pull request **into `develop`**, and merge it with
   **rebase and merge** once it is reviewed. Suits anything that wants review, and every outside contribution.

   ```bash
   git switch develop && git pull
   git switch -c feat/your-feature-name
   ```

   Name a branch by its change: `feat/`, `fix/`, `docs/` or `chore/`, then a short slug.

Either way, a commit explains _why_, not only _what_: a subject under 72 characters such as `fix: end the session after sign-out`, and a
body that says what was checked. Pull requests into `develop` are merged with **rebase and merge**, never squashed and never with a merge
commit; fix commit messages before they reach `develop`, which is never rewritten.

## Continuous integration

CI runs only where a change is about to reach what is released:

- on a pull request into `main` that is not a draft (the promotion from `develop`); marking a draft ready for review runs it;
- before each release is published (the publish workflow runs the checks on the tagged commit);
- by hand, for any branch: **Actions → CI → Run workflow**.

It never runs on a push to `develop` or a feature branch, nor on a pull request into `develop`, so runner time is not spent on every
commit. Those are checked on your machine instead: where the repository has versioned hooks in `.githooks/` (an app's `npm install` turns
them on), the pre-push hook runs its checks (`npm run verify`) before anything is pushed. This is the CI strategy of every repository of
the suite.

## Promoting `develop` into `main`

`main` changes only through a promotion pull request from `develop`, merged with **a merge commit**, the one place a merge commit is
used; `develop` is never rewritten, so it stays an ancestor of `main` and the next promotion shows only what is new. Its title is the
version, **`vX.Y.Z`**, or **`Release vX.Y.Z`** when merging it is to publish that version, which [RELEASING.md](RELEASING.md) describes:
there is no release script, and no tag to push by hand.

The **Promotion** check, which `main` requires, holds the title to the code, refuses a commit whose agent trailer names a model, and
fails when a shared file differs from the template (below). Editing the title runs it again.

Once the promotion is merged, `.github/workflows/sync-develop.yml` moves `develop` forward to the merge commit. It is a fast-forward,
never a rewrite (`develop` is already in the merge commit's history), so `develop` is not shown as behind `main` and the release tags are
in its history. If a commit reached `develop` after the merge, the run leaves `develop` as it is and says so; pull before you start new
work either way.

## Shared files

Some files are the same in every app of the suite and are written, not edited: `.github/workflows/promotion.yml`, `release.yml` and
`sync-develop.yml`, `.github/repository.json`, `CLAUDE.md`, and the shared sections of this file, `RELEASING.md` and `AGENTS.md`. They come
from the template of the version of `@sovereignfs/create` that `package.json` pins:

```bash
npm create @sovereignfs app sync           # write them from the pinned version's template
npm create @sovereignfs app sync --check   # say which differ, and fail; the Promotion check runs this
```

To change one, change it in the template, in [sovereignfs/sovereign](https://github.com/sovereignfs/sovereign), and take it here by moving
the pin and running `sync`. A file this app keeps as its own is listed in `package.json` under `sovereign.unmanaged`, by its path from the
repository's root, and the check then leaves it alone.

## Repository settings

The repository's merge settings and its rulesets (what `main` and `develop` allow, and the checks `main` requires) are code, in
`.github/repository.json`, and are never set in GitHub's interface. Once the repository is on GitHub, push both branches and apply them,
signed in with `gh` as an owner of the repository:

```bash
git push -u origin main develop
npm create @sovereignfs app settings apply   # make GitHub match .github/repository.json
npm create @sovereignfs app settings check   # say what differs, and fail
```

`main` takes changes only by pull request, merged with a merge commit, and requires the Promotion check and the checks under
`sovereign.requiredChecks` in `package.json` (`requiredChecks` in `sovereign.json` for a repository of several components); `develop` can never be deleted or force-pushed, so merging a promotion (which would
otherwise delete its head branch) leaves it in place. A change to the settings is a commit like any other, applied after it lands.

<!-- sovereign:shared:end -->

## Before asking for review

- Make sure these pass locally: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo test --workspace`. For a change to Fjord Web, `pnpm typecheck`, `pnpm test` and `pnpm build` in `clients/web` instead.
- If you change the format, change the spec, the fixtures and the code in the same change (see below).
- A version a change sets comes with its section in the component's `CHANGELOG.md` (RELEASING.md).

## Which jobs run for a change

CI runs where the shared section above says, on promotions into `main` and by hand: the Rust
crates in `.github/workflows/ci.yml`, and Fjord Web in its own
`.github/workflows/web-ci.yml`. Each always starts, but its first job looks at what
the change touches (`scripts/ci-changes.sh`) and the others run only if it can be
affected:

| You changed | What runs |
| --- | --- |
| Documentation only: READMEs, CHANGELOGs, `docs/`, the roadmaps, `.github` templates | Nothing beyond that first job, a few seconds |
| `scripts/` only | shellcheck, and the classifier's tests |
| `crates/` (except a crate's own `README.md` and `CHANGELOG.md`), `schema/`, `tests/`, `Cargo.toml`, `Cargo.lock`, or the workflow itself | The full Rust jobs |
| `clients/web/` (except its own `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `DESIGN.md`, `ROADMAP.md` and `LICENSE`), or its workflow | Fjord Web's jobs: type-check and build, the tests against sqld, a SQLite file and PostgreSQL, and the browser tests |

The full Rust jobs check that the crate and the reference `age` implementation
agree, run the suite on Linux and macOS, build on Windows, hold clippy and
rustfmt, and check the minimum Rust version and a static musl binary. Markdown
that the build or tests read still counts as code: the `init` templates under
`crates/fjord-core/templates/` and the conformance fixtures under `tests/fixtures/`.
A separate Audit workflow runs `cargo deny` when the dependency tree changes, and
the generated release workflow checks its own plan on every PR.

CI is also skipped while a pull request carries the **`skip-ci`** label.

## Changing the format

The specification is [`docs/specs/Fjord.spec.md`](docs/specs/Fjord.spec.md) and it is canonical here.
A change to the format is one PR that changes the spec, adds or updates a
fixture under `tests/fixtures/` (every diagnostic has one that triggers exactly
it), and changes the code. A client that reads Fjord repositories is expected to
pass those fixtures.

## Proposing a change: RFCs, research and workstreams

- **An idea or a request:** open an issue.
- **An open question with no design yet:** a research document in [`docs/research/`](docs/research/): what was read or
  tried, and when, the findings, the options and a recommendation.
- **A design that needs review before anything is built**, and every change to the format: an RFC in
  [`docs/rfcs/`](docs/rfcs/), with its motivation, the design, the alternatives rejected and why, and its security
  considerations. An RFC that changes the format proposes the text. The spec itself changes with the code that implements it,
  as above.
- **A feature that crosses components**, once its RFC is accepted: a workstream in [`docs/workstreams/`](docs/workstreams/),
  which orders the epic tasks from several roadmaps into legs, with the decisions locked so the work can be run without the
  conversation that produced it. Each task in a leg is still its own branch and pull request.

Each directory's README has its index and naming rules.

## Licence of contributions

The reference implementation is licensed under the
[Mozilla Public License 2.0](LICENSE), the specification is dedicated to the
public domain under CC0 ([the licence section of the spec](docs/specs/Fjord.spec.md#licence)), and Fjord Web is
licensed under the AGPL-3.0-or-later ([`clients/web/LICENSE`](clients/web/LICENSE)).
By contributing you agree that your contribution is licensed under the same terms
as the part of the repository it changes.
