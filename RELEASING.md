# Releasing

This repository releases more than one thing, each on its own schedule. A
release is cut with `scripts/release.sh`, one component at a time:

```bash
scripts/release.sh cli check   0.3.1                 # read-only preflight
scripts/release.sh cli prepare 0.3.1                 # branch, bump, gate, commit locally
scripts/release.sh cli propose 0.3.1 [--dry-run]     # push the branch, open a draft PR
scripts/release.sh cli tag     0.3.1 [--dry-run]     # after the PR merges: tag, watch, verify
scripts/release.sh cli verify  0.3.1                 # check a published release
```

`main` takes changes only through pull requests ([`CLAUDE.md`](CLAUDE.md)
§ Working conventions), and a release is a change like any other:

1. **`prepare`** cuts `chore/release-cli-0.3.1` from an up-to-date `main`,
   promotes `[Unreleased]` to the new version, bumps the version everywhere, runs
   the gates, and makes one commit, `Release fjord-cli 0.3.1`. Read it with
   `git show --stat HEAD`. It never pushes, and puts everything back, the branch
   included, if anything fails.
2. **`propose`** pushes that branch and opens a **draft** PR into `main` with the
   notes as its body, then stops.
3. A person marks the PR ready (which runs CI) and merges it with **rebase and
   merge**. That is the review.
4. **`tag`**, on `main` after `git pull`, checks that the latest commit is the
   release commit, waits for CI on that exact commit, tags it, watches the
   release workflow, titles the release and verifies it.

`tag` is separate from the merge because a rebase-and-merge gives the commit a
new SHA, and it is the merged commit that CI has to vouch for and that is
tagged. For the same reason CI also runs on pushes to `main`.

`publish`, which used to push `main` and tag in one go, no longer exists; it
prints this list and exits.

Why each check exists is in [`ROADMAP.md`](ROADMAP.md) under "Releasing". Every
one is there because a release once went wrong without it. The script has its
own tests, `scripts/test-release.sh`, run against throwaway repositories.

## Components

| Component | Tag | Notes live in | Released by | Marked *Latest* |
| --- | --- | --- | --- | --- |
| `cli` (`fjord-cli`, with `fjord-core`) | `fjord-cli-vX.Y.Z` | `crates/fjord-cli/CHANGELOG.md` | `dist`, from `.github/workflows/fjord-cli-release.yml` | **yes** |
| `web` (`fjord-web`) | `web-vX.Y.Z` | `clients/web/CHANGELOG.md` | `.github/workflows/web-release.yml`, written by hand | no (the image's `latest` tag is its own) |

Fjord Web's real artifact is its container image, and its release is the image and the notes.
Its version lives in `clients/web/package.json` (the lockfile does not record it), and the
component needs Node and pnpm, not Rust. A component that has never been released is at
`0.0.0`, and its first version's changelog link points at the release page, since there is
nothing to compare with.

### What a Fjord Web tag does

`web-release.yml`, in this order, and a failure at any step publishes nothing after it:

1. **Checks the app** at the tag: the tag names the version in `package.json`, and install,
   typecheck, tests and build pass.
2. **Builds the image** (`clients/web/Dockerfile`) for `linux/amd64` and `linux/arm64`, each on a
   runner of its own kind (the app has native modules, and arm64 under emulation would take most
   of an hour). Each is pushed by digest only, with no tag, so a half-published release cannot be
   pulled.
3. **Joins them** as `ghcr.io/<owner>/fjord-web:X.Y.Z`, `:X.Y` and `:latest`, checks both
   platforms are in it, and **attests its build provenance** (a signed statement of the commit
   and workflow that built it; `gh attestation verify oci://ghcr.io/<owner>/fjord-web:X.Y.Z
   --owner <owner>`).
4. **Pulls the published image by digest and brings it up** with `deploy-check.sh file`, as an
   operator would: healthy, the first account, a restart, signing in again.
5. **Publishes the GitHub release page**, whose notes are the changelog's section and the image's
   name. This is last, so a release page means an image that was pulled and run.

Run by hand from the Actions tab (*Web release*, on a branch) it does steps 1 and 2 and throws the
images away: that is how a change to the workflow or the Dockerfile is tried before a tag exists.

`scripts/release.sh web verify X.Y.Z` also looks at the registry (both platforms) and warns if it
cannot. **The first time**, GitHub creates the package private: open it (the organisation's
*Packages*, `fjord-web`, *Package settings*) and make it public, or nobody but the organisation
can pull it. That is the one step no workflow can do.

### Fjord Web versions

Fjord Web is `0.x` and follows [Semantic Versioning](https://semver.org/) as the CLI does, with
what that means for an application that has a database and settings:

| Release | May contain | Never contains |
| --- | --- | --- |
| **Patch** `X.Y.Z+1` | Fixes. | A migration, or a setting added, renamed or removed. `release.sh` refuses a patch release if anything under `clients/web/migrations/` changed since the previous release of that minor. |
| **Minor** `X.Y+1.0` | Features; migrations (forward-only, applied at start-up); new settings. While the major is `0` also changes that break (a setting renamed, behaviour changed), each marked **breaking** in the changelog. | A migration or a setting change that is not in the changelog. |
| **Major** `X+1.0.0` (from 1.0) | Breaking changes. | — |

What follows for someone running it (`clients/web/deploy/README.md` § Updating): a patch release can
be installed and, if it is bad, put back, without touching the database. A minor release changes the
database when it starts, and **going back means restoring the backup taken before**: migrations only
go forward, and the changelog says which release has one. A migration that has been released is
never edited; a fix is a new migration.

The format module and the editors are inside the image, so there is nothing else to upgrade. The
image reads and writes the format version `fjord-core` implements (`fjord verify` names it); a
repository that declares a newer one is opened read-only, never written to.

### Dependencies that are newer than the registry's age limit

`clients/web/pnpm-workspace.yaml` makes pnpm refuse a release younger than a minimum age. The
design system, `@sovereignfs/ui`, is ours and is exact-pinned and upgraded on purpose, so a fresh
release of it is added to `minimumReleaseAgeExclude` in the same change as the bump (pnpm writes
the entry). An entry is not removed when the release ages: it names one exact version and does no
harm. Anything else that needs one has to be argued in the PR, because the limit is there to stop
a freshly published, hijacked package from being installed.

Releases up to 0.2.0 were tagged `vX.Y.Z`, before there was more than one
component. They are finished and stay as they are; the script finds them when
it needs the previous release's tag for a compare link.

Write the notes under `## [Unreleased]` in the component's changelog as you go.
`prepare` turns them into the version's section, because the release tooling
reads that section at the tagged commit and falls back to generic notes
*silently* without one.

## Release titles

A release is titled `<component> <version>`, for example `fjord-cli 0.3.0`, with
no date; the date is in the changelog, where it belongs. dist builds the title
from the changelog heading (`0.3.0 - 2026-10-21`) and has no setting for it, so
`tag` retitles the release once the workflow has created it, and `verify`
warns if a title still has the date. That call is the one part of `tag` the
tests cannot exercise without publishing; the function it calls is tested.

## "Latest" is one slot, and it belongs to the CLI

GitHub marks one release in a repository as *Latest*. The README and the
installers use `releases/latest/download/...`, and they mean the CLI. So **only
the CLI's releases are marked Latest**, and every other component's must be
published with `--latest=false`. `verify` checks this both ways.

## Tags start the right workflow, and only that

The CLI's workflow is generated by `dist` with `tag-namespace = "fjord-cli"`,
so it wakes for tags starting `fjord-cli` and for nothing else. A `vscode-v0.1.0`
tag does not start it. Without the namespace, any tag that looks like a version
would, and the run would fail.

## Adding a component

1. Put it in its own directory, with its own `README.md` and `CHANGELOG.md`.
2. Write `scripts/release/<component>.sh`, setting the `C_*` variables and
   defining the `c_*` functions that `scripts/lib/release.sh` documents:
   the tag prefix, the changelog path, the files a version lives in, how to
   bump them, what must pass first, and how to check the published result.
3. Give it a tag prefix of its own, `<component>-vX.Y.Z`, and set `C_LATEST=no`.
4. Give it its own CI workflow that runs only for changes that can affect it.
   Prefer the `changes` job that `ci.yml` uses (it always reports, and skipped
   jobs count as passed, so the checks can be required). A workflow that is
   skipped altogether by `paths` filters never reports, so do not make that kind
   a *required* check in branch protection.
5. Add tests for what is particular to it to `scripts/test-release.sh`.
6. Add its ecosystem to `.github/dependabot.yml`.

## Homebrew

`brew install sovereignfs/tap/fjord`. Each CLI release publishes a formula to the
tap `sovereignfs/homebrew-tap`: `dist` writes `fjord.rb` (it installs the
prebuilt archives already on the release, so nothing is built from source, on
macOS and Linux) and a job in the release workflow pushes it to the tap. The
formula is named `fjord`, after the command, by `formula` in
`crates/fjord-cli/Cargo.toml`; the package is `fjord-cli`.

**It needs a token, which only the owner can make.** The job authenticates with
the repository secret `HOMEBREW_TAP_TOKEN`, a personal access token with write
access to the tap. A fine-grained token limited to the tap repository with
*Contents: read and write* is the narrow choice; the classic `repo` scope is what
`dist`'s documentation names and is the fallback if the narrow one is refused.
Set it, without it passing through anyone else:

```bash
gh secret set HOMEBREW_TAP_TOKEN --repo sovereignfs/fjord
```

**What goes wrong without it is quiet.** The release is created first and the
formula pushed after, so a missing or wrong token leaves a published release and
a stale tap. So `tag` looks for the secret and the tap *before* it tags, and
`verify` reads `Formula/fjord.rb` back from the tap afterwards, checks its version
and that it has a `sha256` for each of the four archives (a formula without them
installs unverified). If the publish job fails after the release exists, fix the
token and re-run that job from the Actions page; do not re-tag.

Homebrew keeps one version per formula, so each release replaces the last, and
publishing an older version after a newer one would put the older one back.
The commits in the tap are authored by `axo bot`, which `dist` hard-codes.

Not Homebrew core: that needs the project to be notable and builds from a source
tarball, and Homebrew's maintainers would own the formula. A tap is where this
starts.

## The release workflow is generated; do not edit it

`.github/workflows/fjord-cli-release.yml` is written by `dist generate`, and its
`plan` job fails if the file differs from what `dist` would write (it says "run
'dist init' to update the file"). So it is never edited by hand, and Dependabot
is told to leave it alone (`exclude-paths` in `.github/dependabot.yml`): a bump
of `actions/checkout` there once turned a PR red, and would have failed a real
release the same way.

The actions in it are bumped by upgrading `dist`. As of `dist` 0.33 and its
`main` branch, it generates `actions/checkout@v6`, so v6 stays until `dist`
moves. The two workflows written by hand, `ci.yml` and `audit.yml`, are on v7.

## Two components with release rules of their own

**Obsidian.** The community plugin directory needs `manifest.json`, `README.md`
and `LICENSE` at the root of the repository it points to, and a release whose
tag is exactly the manifest's version (`1.2.3`, no prefix). A plugin that lives
in `plugins/obsidian/` cannot meet that from here. When it exists it will be
released through a small repository that exists only to carry its releases, with
this repository's CI building and pushing to it. Nothing about the plugin's
development changes: it still lives and is tested here.

**VS Code.** The Marketplace publishes from any directory with `vsce`. Nothing
special is needed beyond the rules above.

## What is not proved until it runs

The renamed release workflow, `fjord-cli-release.yml`, is generated by the same
tool as the one it replaced and differs from it in one line (the tag pattern),
but it has not yet run on a real tag. The first `fjord-cli-vX.Y.Z` release is
its test, and `scripts/release.sh cli verify` is how to read the result. The same
goes for the PR-based flow: `prepare`, `propose` and the preflights of `tag` are
tested against a local origin and a stand-in for `gh`, but the first real
`propose` → merge → `tag` is what proves the whole of it.

## Publishing to crates.io

`fjord-core` and `fjord-cli` are on [crates.io](https://crates.io) (`cargo install fjord-cli` gives the `fjord` command), first published as **0.4.0** (2026-11-01). Before each publish run
`cargo publish --workspace --dry-run` from a clean tree; the checks it stands for are kept true by the workspace itself:

- **The names are free** (`fjord-core`, `fjord-cli`, checked 2026-11-01). A different crate called `fjord` exists (a stranger's, v0.4.12): the command is `fjord`, the package is `fjord-cli`,
  and the README says `cargo install fjord-cli`, so a bare `cargo install fjord` would install the wrong thing.
- **`fjord-cli` names `fjord-core` by version** as well as by path, as `cargo publish` requires; `release.sh` bumps both together.
- **The package is the crate and nothing else.** The conformance fixtures are the repository's, at its root, so the tests that read them are left out of the package (`exclude`) or skip when
  the fixtures are not there; the packaged `fjord-core`'s own tests pass on their own (246, run from the unpacked `.crate`).
- **docs.rs** builds `fjord-core` with its default features, and `cargo doc` is clean under `-D warnings`.
- **`fjord-wasm` is `publish = false`** and is not part of this.

Publishing is a person's step, after `tag` has verified the release, because it needs the owner's crates.io API token (never put in the repository or a workflow) and cannot be undone: a
version can be yanked but never replaced or deleted.

```bash
cargo login                              # once, with a token from https://crates.io/settings/tokens (scope: publish-new, publish-update)
cargo publish --workspace --dry-run      # from a clean checkout of the tagged commit
cargo publish --workspace                # fjord-core first, then fjord-cli, in the right order
```

The first publish of each name makes its publisher the crate's owner; add the other owners with `cargo owner --add`.

Things the first release taught:

- **crates.io wants a verified email** on the account (<https://crates.io/settings/profile>) before it accepts a publish; without one the first upload is refused with a 400, and nothing is uploaded.
- **Publish the tagged commit.** `0.3.1` was released as binaries before the crates were ready, and `main` had moved 128 commits on; publishing it would have put different code on crates.io under a
  version the binaries already used. `0.4.0` was cut for this, and a version is never reused.
- **A release can fail on the runner, not the code.** The 0.4.0 run's macOS 14 job was cancelled in a second by a GitHub brownout (the image retires on 2026-11-02); the Apple-silicon build is now pinned
  to `macos-15` in `dist-workspace.toml`, and the tag was moved onto that commit before anything was published. If a release run fails before `host`, nothing is public and the tag can be moved; once a
  release exists, cut the next version instead.
- **`cargo publish --workspace`** publishes `fjord-core` first, waits for it to be available, then `fjord-cli`.
