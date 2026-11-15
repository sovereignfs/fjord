# Releasing Fjord

The sections above and below the shared one are this repository's own (what is particular to how each component publishes); the shared
one is written by `npm create @sovereignfs app sync` and is the same in every repository of the suite.

<!-- sovereign:shared:begin -->

This repository releases several components, each with its own version, tag and changelog, listed in `sovereign.json`. A release is a
promotion of `develop` into `main` that says which of them it publishes. There is no release script.

1. **Set each component's version and its changelog section on `develop`,** in the change that makes them: the version in the file
   `sovereign.json` names for it (semver: a fix is a patch, a feature a minor, a break a major), and a section `## [X.Y.Z] - YYYY-MM-DD`
   in its changelog, saying in plain words what changed for someone upgrading. The section is the release's notes.
2. **Open the promotion pull request** from `develop` into `main`, titled with the versions it carries, by their tags (each component's tag
   prefix, then `vX.Y.Z`, such as `web-v1.2.0`), and starting with **`Release`** when merging it is to publish them:
   `Release web-v1.2.0, cli-v0.6.0`. The **Promotion** check holds the title to the code: each version must be its component's current
   one, and under `Release` not tagged yet, with its changelog section. Editing the title runs it again.
3. **Merge it with a merge commit** (the only method `main` allows). For a `Release` title, the **Release** workflow checks the title
   against the merged code, tags the merge commit with each version, and calls each component's publish workflow with its tag.

A version promoted without `Release` can be published later by pushing its tag on the merge commit that brought it.

The promotion check and the release are workflows every repository of the suite shares, kept in
[sovereignfs/sovereign](https://github.com/sovereignfs/sovereign/tree/main/.github/workflows) and run with the version of
`@sovereignfs/create` that `sovereign.json` pins.

<!-- sovereign:shared:end -->

## What the old release script checked, and nothing checks now

Until the move to the shared release (sovereignfs/sovereign, research 0007), `scripts/release.sh` also did these. The promotion check holds
the title, the versions and the changelog sections; the rest is a person's, until a check of its own replaces it:

- **A Fjord Web patch with a migration.** It refused a patch release when anything under `clients/web/migrations/` changed since the
  previous release of that minor. Before titling one `Release …, web-vX.Y.Z+1`, run `git diff web-vX.Y.Z -- clients/web/migrations/`.
- **The Homebrew secret, before tagging.** Check `HOMEBREW_TAP_TOKEN` is set before a `Release` that names the CLI (Homebrew, below).
- **Reading the release back.** It checked the registry had both platforms of a Fjord Web image, read `Formula/fjord.rb` back from the
  tap (its version, a `sha256` for each archive), and checked that only the CLI's release is marked *Latest*. Look at each after a release.
- **The CLI's release title.** It retitled dist's `0.3.0 - 2026-10-21` to `fjord-cli 0.3.0`; titles now keep dist's form.
- **`fjord-core`'s pinned version.** It bumped `fjord-core = { version = … }` in `crates/fjord-cli/Cargo.toml` with the workspace version;
  a CLI version change now changes both by hand (crates.io, below).

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
4. **Pulls the published image by digest and brings it up** with `deploy-check.sh file sovereign`, as an
   operator would: healthy, the first account, a restart, signing in again; and as a Sovereign
   instance would host it: the label is `sovereign.manifest.json`, it listens on the `PORT` it is given
   and stops on SIGTERM within seconds.
5. **Publishes the GitHub release page**, whose notes are the changelog's section and the image's
   name. This is last, so a release page means an image that was pulled and run.

Run by hand from the Actions tab (*Web release*, on a branch) it does steps 1 and 2 and throws the
images away: that is how a change to the workflow or the Dockerfile is tried before a tag exists.

After a release, `docker buildx imagetools inspect ghcr.io/<owner>/fjord-web:X.Y.Z` shows both platforms. **The first time**, GitHub creates the package private: open it (the organisation's
*Packages*, `fjord-web`, *Package settings*) and make it public, or nobody but the organisation
can pull it. That is the one step no workflow can do.

### Fjord Web versions

Fjord Web is `0.x` and follows [Semantic Versioning](https://semver.org/) as the CLI does, with
what that means for an application that has a database and settings:

| Release | May contain | Never contains |
| --- | --- | --- |
| **Patch** `X.Y.Z+1` | Fixes. | A migration, or a setting added, renamed or removed. Nothing refuses such a patch now; check `clients/web/migrations/` first (above). |
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
component. They are finished and stay as they are.

A version's notes are its section in the component's changelog, written with the version (the shared section
above). The promotion check refuses a `Release` without one, because the release workflows read that section at
the tagged commit. The CLI's changelog still has an `[Unreleased]` section from before the move: it becomes the
next CLI version's section when that version is set.

## Release titles

A promotion is titled with the tags it releases (the shared section above). A GitHub release's own title is
the CLI's as dist builds it from the changelog heading (`0.3.0 - 2026-10-21`), and Fjord Web's as
`web-release.yml` writes it.

## "Latest" is one slot, and it belongs to the CLI

GitHub marks one release in a repository as *Latest*. The README and the
installers use `releases/latest/download/...`, and they mean the CLI. So **only
the CLI's releases are marked Latest**, and every other component's must be
published with `--latest=false` (`web-release.yml` does). Nothing checks it afterwards now (above).

## Tags start the right workflow, and only that

The CLI's workflow is generated by `dist` with `tag-namespace = "fjord-cli"`,
so it wakes for tags starting `fjord-cli` and for nothing else. A `vscode-v0.1.0`
tag does not start it. Without the namespace, any tag that looks like a version
would, and the run would fail.

## Adding a component

1. Put it in its own directory, with its own `README.md` and `CHANGELOG.md`.
2. Add it to `sovereign.json`: its `name`, its `version` file (a `package.json` or a `Cargo.toml`), a `tagPrefix` of its own
   (`<component>-`), its `changelog`, and its `publish` workflow, which must be callable with the tag (`workflow_call` with a `tag`
   input, checking out that tag). Then `npm create @sovereignfs app sync` writes the release workflow that calls it.
3. Publish its releases with `--latest=false`: the *Latest* slot is the CLI's.
4. Give it its own CI workflow that runs only for changes that can affect it.
   Prefer the `changes` job that `ci.yml` uses (it always reports, and skipped
   jobs count as passed, so the checks can be required). A workflow that is
   skipped altogether by `paths` filters never reports, so do not make that kind
   a *required* check in branch protection.
5. Add its ecosystem to `.github/dependabot.yml`, targeting `develop`.

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
a stale tap. So check the secret before a `Release` that names the CLI, and read
`Formula/fjord.rb` back from the tap afterwards: its version, and a `sha256` for each
of the four archives (a formula without them installs unverified). The old release
script did both; nothing does now (above). If the publish job fails after the release exists, fix the
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

**One change in it is made by hand**: it can be called with the tag (`workflow_call` and a `tag` input, which
the plan, the checkouts and the release step read), because the release on merge makes the tag with a token that
starts no workflow and so has to call this one (RELEASING's shared section). `allow-dirty = ["ci"]` in
`dist-workspace.toml` lets dist accept the file with it. After a `dist generate` or a `dist` upgrade, put that
change back; `git diff` shows it.

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

The release on merge has published for Sovereign's own toolkit and image, but not yet here: the first promotion
titled `Release` that names `fjord-cli-v…` or `web-v…` is its test, and calling `fjord-cli-release.yml` from it
(the change made by hand, above) is the part most worth watching.

## Publishing to crates.io

`fjord-core` and `fjord-cli` are on [crates.io](https://crates.io) (`cargo install fjord-cli` gives the `fjord` command), first published as **0.4.0** (2026-11-01). Before each publish run
`cargo publish --workspace --dry-run` from a clean tree; the checks it stands for are kept true by the workspace itself:

- **The names are free** (`fjord-core`, `fjord-cli`, checked 2026-11-01). A different crate called `fjord` exists (a stranger's, v0.4.12): the command is `fjord`, the package is `fjord-cli`,
  and the README says `cargo install fjord-cli`, so a bare `cargo install fjord` would install the wrong thing.
- **`fjord-cli` names `fjord-core` by version** as well as by path, as `cargo publish` requires; a CLI version change bumps both, by hand (above).
- **The package is the crate and nothing else.** The conformance fixtures are the repository's, at its root, so the tests that read them are left out of the package (`exclude`) or skip when
  the fixtures are not there; the packaged `fjord-core`'s own tests pass on their own (246, run from the unpacked `.crate`).
- **docs.rs** builds `fjord-core` with its default features, and `cargo doc` is clean under `-D warnings`.
- **`fjord-wasm` is `publish = false`** and is not part of this.

Publishing is a person's step, after the release on merge has published and you have read it back, because it needs the owner's crates.io API token (never put in the repository or a workflow) and cannot be undone: a
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
