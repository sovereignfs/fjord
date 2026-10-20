#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Cut a release of fjord-cli.
#
#   scripts/release.sh check   X.Y.Z               read-only preflight
#   scripts/release.sh prepare X.Y.Z [--skip-gates]
#                                                  bump, plan, gate, commit locally
#   scripts/release.sh publish X.Y.Z [--dry-run]   push, wait for CI, tag, verify
#   scripts/release.sh verify  X.Y.Z               check a published release
#
# The usual run is `prepare`, read what it committed, then `publish`.
# `prepare` never pushes and rolls its own edits back if anything fails, so
# a failed gate leaves the tree as it found it. `publish` is the step the
# world can see: it pushes the commit, waits for CI to be green on that exact
# commit, and only then creates the tag, which is what fires the release.
#
# Notes for a release come from CHANGELOG.md. Write them under
# `## [Unreleased]` as you go; `prepare` turns that into the version's
# section (heading, date and compare links), because `dist` reads the section
# at the tagged commit and fails *silently* without one.
#
# Why each check exists is in ROADMAP.md, under "Release checklist". Every
# one of them is there because a release went wrong without it.
#
# Needs: git, cargo, dist, jq. `publish` and `verify` also need gh (logged
# in), curl and tar. Written for bash 3.2, which is what macOS ships.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REPO_URL=$(grep -m1 '^repository' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')
# `gh` cannot work out the repository from an SSH host alias, so say it.
GH_REPO=${REPO_URL#https://github.com/}
export GH_REPO

WORK=""
PREPARING=""

# How long to wait for a workflow run to *appear* for a commit. Runs start
# within seconds, so two minutes means something is wrong; it is a variable so
# the tests can exercise that path without waiting two minutes.
RUN_START_TIMEOUT=${RELEASE_RUN_START_TIMEOUT:-120}

# --- Output -------------------------------------------------------------------

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
warn() { printf 'warning: %s\n' "$*" >&2; }
step() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok  %s\n' "$*"; }
say() { printf '      %s\n' "$*"; }

# --- Cleanup and rollback -------------------------------------------------------

# The four files `prepare` edits. Backed up before the first edit, so that a
# failure puts back exactly what was there — including a CHANGELOG.md with
# uncommitted notes in it, which a `git checkout` would destroy.
TOUCHED="CHANGELOG.md Cargo.toml Cargo.lock crates/fjord/Cargo.toml"

backup_files() {
  mkdir -p "$WORK/backup/crates/fjord"
  local f
  for f in $TOUCHED; do
    cp -p "$f" "$WORK/backup/$f"
  done
}

restore_files() {
  local f
  for f in $TOUCHED; do
    cp -p "$WORK/backup/$f" "$f"
  done
}

cleanup() {
  local status=$?
  if [ -n "$PREPARING" ] && [ "$status" -ne 0 ] && [ -d "$WORK/backup" ]; then
    printf '\nprepare failed; putting back the files it edited.\n' >&2
    restore_files
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

# --- Small helpers ----------------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required and was not found"
}

valid_version() {
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Whether $1 is a strictly greater version than $2.
version_gt() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  if [ "$a1" -ne "$b1" ]; then
    [ "$a1" -gt "$b1" ]
    return
  fi
  if [ "$a2" -ne "$b2" ]; then
    [ "$a2" -gt "$b2" ]
    return
  fi
  [ "$a3" -gt "$b3" ]
}

current_version() {
  awk '/^\[workspace\.package\]/ { f = 1; next } /^\[/ { f = 0 }
       f && /^version = / { gsub(/"/, "", $3); print $3; exit }' Cargo.toml
}

core_dependency_version() {
  sed -nE 's/^fjord-core = .*version = "([^"]+)".*/\1/p' crates/fjord/Cargo.toml
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

# --- The changelog ------------------------------------------------------------------

# The body of one section: from its heading to the next heading or to the
# link references at the foot of the file.
section_body() {
  awk -v h="## [$1]" '
    index($0, h) == 1 { f = 1; next }
    /^## \[/ { f = 0 }
    /^\[[^]]+\]: / { f = 0 }
    f' CHANGELOG.md
}

has_content() {
  grep -q '[^[:space:]]'
}

# What the changelog holds for $1: `section` (a filled-in section), `empty`
# (a heading with nothing under it), `unreleased` (notes waiting to be
# released) or `missing`.
changelog_state() {
  local vre=${1//./\\.}
  if grep -q "^## \[$vre\]" CHANGELOG.md; then
    if section_body "$1" | has_content; then
      echo section
    else
      echo empty
    fi
  elif section_body Unreleased | has_content; then
    echo unreleased
  else
    echo missing
  fi
}

# Turn `## [Unreleased]` notes into `## [$1] - <today>`, leaving Unreleased
# empty above it. This is the standard Keep a Changelog step, done here
# because a hand-typed heading or compare link is exactly the sort of thing
# that goes subtly wrong.
promote_unreleased() {
  local heading="## [$1] - $2"
  awk -v h="$heading" '
    !done && index($0, "## [Unreleased]") == 1 { print; print ""; print h; done = 1; next }
    { print }' CHANGELOG.md >"$WORK/changelog.new"
  cat "$WORK/changelog.new" >CHANGELOG.md
}

# Point [Unreleased] at the new version, and add the new version's compare
# link. Skipped, with a warning, if the file has no [Unreleased] link.
update_footer_links() {
  local version=$1 previous=$2 vre=${1//./\\.} has_link=no
  if grep -q '^\[Unreleased\]: ' CHANGELOG.md; then
    if grep -q "^\[$vre\]: " CHANGELOG.md; then
      has_link=yes
    fi
    awk -v url="$REPO_URL" -v v="$version" -v prev="$previous" -v has="$has_link" '
      index($0, "[Unreleased]: ") == 1 {
        print "[Unreleased]: " url "/compare/v" v "...HEAD"
        if (has == "no") print "[" v "]: " url "/compare/v" prev "...v" v
        next
      }
      { print }' CHANGELOG.md >"$WORK/changelog.new"
    cat "$WORK/changelog.new" >CHANGELOG.md
  else
    warn "CHANGELOG.md has no [Unreleased] link at the foot; compare links not updated"
  fi
}

# --- Preflight ------------------------------------------------------------------------

require_main_in_sync() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || die "releases are cut from main, and this is $branch"
  git fetch origin --tags --quiet || die "could not fetch from origin"
}

require_tag_free() {
  local v=$1
  # Origin first. The preflight has just fetched tags, so a tag that exists on
  # origin is also local by now, and saying "locally" would name the effect
  # and not the cause.
  if [ -n "$(git ls-remote --tags origin "refs/tags/v$v")" ]; then
    die "tag v$v already exists on origin"
  fi
  if git rev-parse -q --verify "refs/tags/v$v" >/dev/null; then
    die "tag v$v already exists locally (not on origin)"
  fi
  ok "tag v$v is free"
}

require_versions_agree() {
  local cur core
  cur=$(current_version)
  core=$(core_dependency_version)
  [ -n "$cur" ] || die "could not read the workspace version from Cargo.toml"
  [ "$cur" = "$core" ] ||
    die "Cargo.toml says $cur but the fjord-core dependency in crates/fjord/Cargo.toml says $core; fix that first"
  ok "both version declarations agree on $cur"
}

# Everything `prepare` needs to be true, without changing anything.
preflight_prepare() {
  local v=$1 cur unexpected state today heading_date
  step "Preflight for $v"

  valid_version "$v" || die "'$v' is not a version of the form X.Y.Z"
  need git
  need cargo
  need dist
  need jq

  require_main_in_sync
  ok "on main, fetched origin"

  # Said before the sync check, which would otherwise tell someone who has
  # already prepared to "push or pull first": the wrong advice.
  if [ "$(git log -1 --format=%s)" = "Release $v" ]; then
    die "already prepared: HEAD is the 'Release $v' commit. To release it: scripts/release.sh publish $v. To start over: git reset --hard origin/main"
  fi

  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
    die "main is not the same as origin/main; push or pull first, so that what is released is what is on GitHub"
  ok "main matches origin/main"

  # CHANGELOG.md may carry the release's notes, uncommitted. Nothing else.
  unexpected=$(git status --porcelain | awk '{ print $2 }' |
    grep -vE '^CHANGELOG\.md$' || true)
  [ -z "$unexpected" ] ||
    die "the working tree has changes other than CHANGELOG.md: $(echo "$unexpected" | tr '\n' ' ')"
  ok "working tree clean (apart from CHANGELOG.md)"

  require_versions_agree
  cur=$(current_version)
  version_gt "$v" "$cur" || die "$v is not greater than the current version $cur"
  ok "$v is greater than $cur"

  require_tag_free "$v"

  state=$(changelog_state "$v")
  today=$(date +%Y-%m-%d)
  case "$state" in
    section)
      heading_date=$(sed -nE "s/^## \[${v//./\\.}\] - ([0-9]{4}-[0-9]{2}-[0-9]{2}).*/\1/p" CHANGELOG.md | head -1)
      [ -n "$heading_date" ] ||
        die "the [$v] heading in CHANGELOG.md has no date; write it as '## [$v] - $today'"
      [ "$heading_date" = "$today" ] ||
        die "the [$v] heading is dated $heading_date but today is $today; correct it"
      ok "CHANGELOG.md has a [$v] section dated today"
      ;;
    unreleased)
      ok "CHANGELOG.md has notes under [Unreleased], to become [$v] - $today"
      ;;
    empty)
      die "the [$v] section of CHANGELOG.md is empty"
      ;;
    *)
      die "CHANGELOG.md has no notes for $v. Write them under '## [Unreleased]'; dist fails silently without them and the release would ship with generic notes"
      ;;
  esac
}

# --- The checks dist is run for --------------------------------------------------------

check_plan() {
  local v=$1 out
  out=$(dist plan --tag="v$v" 2>&1) ||
    die "dist plan --tag=v$v failed:"$'\n'"$out"
  grep -q "announcing v$v" <<<"$out" ||
    die "dist plan did not announce v$v — is the crate version $v?:"$'\n'"$out"
  ok "dist plan announces v$v"

  dist plan --tag="v$v" --output-format=json 2>/dev/null |
    jq -e '.announcement_changelog' >/dev/null ||
    die "dist found no release notes for v$v in CHANGELOG.md"
  ok "dist found the release notes"
}

# Run one gate. A bare `set -e` exit would show the tool's own output and
# nothing saying which gate it was, which is no help at the end of a long run.
gate() {
  local name=$1
  shift
  if "$@"; then
    ok "$name"
  else
    die "the $name gate failed (its output is above); nothing was committed"
  fi
}

run_gates() {
  step "Gates"
  gate rustfmt cargo fmt --check
  gate clippy cargo clippy --workspace --all-targets --locked -- -D warnings
  gate tests cargo test --workspace --locked
  if cargo deny --version >/dev/null 2>&1; then
    gate "cargo deny" cargo deny check
  else
    warn "cargo-deny is not installed, so it was not run here; the Audit workflow will run it"
  fi
}

# --- Commands ---------------------------------------------------------------------------

cmd_check() {
  preflight_prepare "$1"
  printf '\nready: scripts/release.sh prepare %s will do the rest.\n' "$1"
}

cmd_prepare() {
  local v=$1 skip_gates=$2 cur today state f body
  preflight_prepare "$v"

  cur=$(current_version)
  today=$(date +%Y-%m-%d)
  WORK=$(mktemp -d)
  backup_files
  PREPARING=yes

  step "Notes"
  state=$(changelog_state "$v")
  if [ "$state" = unreleased ]; then
    promote_unreleased "$v" "$today"
    ok "promoted [Unreleased] to [$v] - $today"
  fi
  update_footer_links "$v" "$cur"
  ok "compare links updated"

  step "Bump $cur -> $v"
  [ "$(grep -c "^version = \"$cur\"\$" Cargo.toml)" = 1 ] ||
    die "expected exactly one 'version = \"$cur\"' line in Cargo.toml"
  sed "s/^version = \"$cur\"\$/version = \"$v\"/" Cargo.toml >"$WORK/cargo.new"
  cat "$WORK/cargo.new" >Cargo.toml

  [ "$(grep -c "path = \"../fjord-core\", version = \"$cur\"" crates/fjord/Cargo.toml)" = 1 ] ||
    die "expected exactly one fjord-core dependency at version $cur in crates/fjord/Cargo.toml"
  sed "s|path = \"../fjord-core\", version = \"$cur\"|path = \"../fjord-core\", version = \"$v\"|" \
    crates/fjord/Cargo.toml >"$WORK/fjord.new"
  cat "$WORK/fjord.new" >crates/fjord/Cargo.toml
  ok "both declarations now say $v"

  cargo build --workspace --quiet
  ok "built, so Cargo.lock followed"

  # Nothing may have changed except the four files this command is for.
  f=$(git status --porcelain | awk '{ print $2 }' |
    grep -vE '^(CHANGELOG\.md|Cargo\.toml|Cargo\.lock|crates/fjord/Cargo\.toml)$' || true)
  [ -z "$f" ] || die "unexpected changes after the bump: $(echo "$f" | tr '\n' ' ')"
  ok "only the expected files changed"

  step "dist"
  check_plan "$v"

  if [ "$skip_gates" = yes ]; then
    warn "gates skipped: CI will still run them, but only after the push"
  else
    run_gates
  fi

  step "Commit"
  body=$(section_body "$v" | sed '/./,$!d')
  printf 'Release %s\n\n%s\n' "$v" "$body" >"$WORK/message"
  # shellcheck disable=SC2086  # the file list is deliberately word-split
  git add $TOUCHED
  git commit -q -F "$WORK/message"
  PREPARING=""
  ok "committed $(git rev-parse --short HEAD): Release $v"

  printf '\nPrepared, and nothing has been pushed. Read what it made:\n\n'
  printf '    git show --stat HEAD\n\n'
  printf 'then, to release it:\n\n'
  printf '    scripts/release.sh publish %s\n' "$v"
}

wait_for_workflow() {
  local workflow=$1 sha=$2 required=$3 id="" waited=0 conclusion
  while [ -z "$id" ]; do
    id=$(gh run list --workflow "$workflow" --branch main --limit 20 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -1 || true)
    if [ -z "$id" ]; then
      if [ "$waited" -ge "$RUN_START_TIMEOUT" ]; then
        if [ "$required" = yes ]; then
          die "no $workflow run appeared for ${sha:0:7} after ${RUN_START_TIMEOUT}s"
        fi
        warn "no $workflow run for ${sha:0:7}; its path filters may have skipped it. Continuing"
        return 0
      fi
      sleep 5
      waited=$((waited + 5))
    fi
  done
  say "$workflow run $id"
  gh run watch "$id" --exit-status --interval 15 >/dev/null 2>&1 || true
  conclusion=$(gh run view "$id" --json conclusion --jq .conclusion)
  [ "$conclusion" = success ] ||
    die "$workflow finished as '$conclusion' on ${sha:0:7}, so the tag was not created. See: gh run view $id --log-failed"
  ok "$workflow is green on ${sha:0:7}"
}

wait_for_release_run() {
  local v=$1 id="" waited=0 conclusion
  while [ -z "$id" ]; do
    id=$(gh run list --workflow Release --limit 10 --json databaseId,headBranch \
      --jq ".[] | select(.headBranch == \"v$v\") | .databaseId" | head -1 || true)
    if [ -z "$id" ]; then
      [ "$waited" -lt 90 ] || die "the Release workflow did not start for v$v"
      sleep 5
      waited=$((waited + 5))
    fi
  done
  say "Release run $id"
  gh run watch "$id" --exit-status --interval 20 >/dev/null 2>&1 || true
  conclusion=$(gh run view "$id" --json conclusion --jq .conclusion)
  if [ "$conclusion" != success ]; then
    printf '\nThe release run finished as %s. Nothing may have been published; check with:\n' "$conclusion" >&2
    printf '    gh run view %s --log-failed\n    gh release list\n' "$id" >&2
    printf 'The tag v%s is on origin. If nothing was published, fix the cause, then move it:\n' "$v" >&2
    printf '    git push --delete origin v%s && git tag -f v%s <fixed-commit> && git push origin v%s\n' "$v" "$v" "$v" >&2
    exit 1
  fi
  ok "the Release workflow succeeded"
}

# What a platform's archive is called, or nothing if this machine is not one
# we publish for.
host_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    Linux-x86_64) echo x86_64-unknown-linux-musl ;;
    Linux-aarch64 | Linux-arm64) echo aarch64-unknown-linux-musl ;;
    *) echo "" ;;
  esac
}

verify_release() {
  local v=$1 base json missing target archive want got
  need gh
  need curl
  need jq
  need tar
  [ -n "$WORK" ] || WORK=$(mktemp -d)
  base="https://github.com/$GH_REPO/releases/download/v$v"

  step "Verify the published release v$v"

  gh release view "v$v" --json isDraft,isPrerelease,body,assets >"$WORK/release.json" ||
    die "there is no release v$v"
  jq -e '.isDraft == false and .isPrerelease == false' "$WORK/release.json" >/dev/null ||
    die "v$v is a draft or a prerelease, which 'releases/latest' skips"
  ok "published, not a draft or prerelease"

  if [ "$(gh release list --json tagName,isLatest --jq ".[] | select(.tagName == \"v$v\") | .isLatest")" = true ]; then
    ok "marked Latest"
  else
    warn "v$v is not marked Latest; fine for an older version"
  fi

  # The expected assets come from the release's own manifest, plus the
  # manifest itself, which it does not list: no number to keep in sync.
  json="$WORK/dist-manifest.json"
  curl -fsSL "$base/dist-manifest.json" -o "$json" ||
    die "could not download dist-manifest.json from the release"
  {
    jq -r '.artifacts | keys[]' "$json"
    echo dist-manifest.json
  } | sort >"$WORK/expected"
  jq -r '.assets[].name' "$WORK/release.json" | sort >"$WORK/actual"
  missing=$(comm -23 "$WORK/expected" "$WORK/actual")
  [ -z "$missing" ] || die "assets missing from the release: $(echo "$missing" | tr '\n' ' ')"
  ok "all $(wc -l <"$WORK/expected" | tr -d ' ') expected assets are present"

  jq -r .body "$WORK/release.json" | grep -q '^## Release Notes' ||
    die "the release page has generic notes: dist found no section for v$v in CHANGELOG.md"
  ok "the release page carries the changelog notes"

  target=$(host_target)
  if [ -z "$target" ]; then
    warn "no published binary for $(uname -sm); skipped the download and run checks"
    return 0
  fi

  archive="fjord-cli-$target.tar.xz"
  curl -fsSL "$base/$archive" -o "$WORK/$archive" || die "could not download $archive"
  curl -fsSL "$base/$archive.sha256" -o "$WORK/$archive.sha256" ||
    die "could not download $archive.sha256"
  want=$(cut -d' ' -f1 "$WORK/$archive.sha256")
  got=$(sha256_of "$WORK/$archive")
  [ "$want" = "$got" ] || die "checksum mismatch for $archive: published $want, downloaded $got"
  ok "$archive matches its published checksum"

  # The real installer, in its mode meant for CI, with HOME pointed at
  # scratch: it installs where it is told and edits no shell profile.
  curl -fsSL "$base/fjord-cli-installer.sh" -o "$WORK/installer.sh" ||
    die "could not download the installer"
  mkdir -p "$WORK/home" "$WORK/bin"
  HOME="$WORK/home" FJORD_CLI_UNMANAGED_INSTALL="$WORK/bin" sh "$WORK/installer.sh" >"$WORK/installer.log" 2>&1 ||
    die "the installer failed:"$'\n'"$(cat "$WORK/installer.log")"
  got=$("$WORK/bin/fjord" --version)
  [ "$got" = "fjord $v" ] || die "the installed binary reports '$got', not 'fjord $v'"
  ok "the installer works, and the binary reports '$got'"

  # And the binary does what it should: it records the version that ran.
  (
    export GIT_AUTHOR_NAME=release GIT_AUTHOR_EMAIL=release@example.invalid
    export GIT_COMMITTER_NAME=release GIT_COMMITTER_EMAIL=release@example.invalid
    "$WORK/bin/fjord" init "$WORK/repo" >/dev/null
  )
  got=$(jq -r .generator "$WORK/repo/fjord.json")
  [ "$got" = "fjord $v" ] || die "init recorded generator '$got', not 'fjord $v'"
  ok "init records \"generator\": \"fjord $v\""

  printf '\nhttps://github.com/%s/releases/tag/v%s\n' "$GH_REPO" "$v"
}

cmd_publish() {
  local v=$1 dry_run=$2 cur subject sha
  step "Preflight for publishing $v"
  valid_version "$v" || die "'$v' is not a version of the form X.Y.Z"
  need git
  need cargo
  need dist
  need jq
  need gh
  gh auth status >/dev/null 2>&1 || die "gh is not logged in"
  require_main_in_sync

  cur=$(current_version)
  [ "$cur" = "$v" ] ||
    die "the crate version is $cur, not $v; run 'prepare $v' first"
  require_versions_agree
  subject=$(git log -1 --format=%s)
  [ "$subject" = "Release $v" ] ||
    die "HEAD is '$subject', not 'Release $v'; run 'prepare $v' first and publish straight after"
  ok "HEAD is the Release $v commit"
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
  ok "working tree clean"
  require_tag_free "$v"
  git merge-base --is-ancestor origin/main HEAD ||
    die "origin/main has commits that HEAD does not; pull and re-run prepare"
  check_plan "$v"

  sha=$(git rev-parse HEAD)

  if [ "$dry_run" = yes ]; then
    printf '\nDry run, so nothing was changed. It would now:\n\n'
    printf '    1. push main (%s) to origin, if it is not there already\n' "${sha:0:7}"
    printf '    2. wait for CI and Audit to be green on %s\n' "${sha:0:7}"
    printf '    3. create and push the tag v%s on that commit\n' "$v"
    printf '    4. watch the Release workflow to the end\n'
    printf '    5. verify the published release, including running its installer\n'
    return 0
  fi

  step "Push"
  if [ "$sha" = "$(git rev-parse origin/main)" ]; then
    ok "main is already on origin"
  else
    git push origin main
    ok "pushed main"
  fi

  step "Wait for CI on ${sha:0:7}"
  wait_for_workflow CI "$sha" yes
  # Audit only runs when the dependency tree or deny.toml changed, which a
  # version bump does; if its path filters skip it, carry on with a warning.
  wait_for_workflow Audit "$sha" no

  step "Tag"
  git tag -a "v$v" -m "fjord $v" "$sha"
  git push origin "v$v"
  ok "pushed v$v, which starts the release"

  step "Release workflow"
  wait_for_release_run "$v"

  verify_release "$v"
}

# --- Entry point --------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/release.sh check   X.Y.Z                  read-only preflight
  scripts/release.sh prepare X.Y.Z [--skip-gates]   bump, plan, gate, commit locally
  scripts/release.sh publish X.Y.Z [--dry-run]      push, wait for CI, tag, verify
  scripts/release.sh verify  X.Y.Z                  check a published release

The usual run is prepare, read what it committed, then publish. The header
of this file says what each one does and why.
EOF
  exit 2
}

main() {
  [ $# -ge 2 ] || usage
  local command=$1 version=$2 dry_run=no skip_gates=no
  shift 2
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run) dry_run=yes ;;
      --skip-gates) skip_gates=yes ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done

  case $command in
    check) cmd_check "$version" ;;
    prepare) cmd_prepare "$version" "$skip_gates" ;;
    publish) cmd_publish "$version" "$dry_run" ;;
    verify)
      valid_version "$version" || die "'$version' is not a version of the form X.Y.Z"
      verify_release "$version"
      ;;
    *) usage ;;
  esac
}

# Run only when executed, so the tests can source this file and call single
# functions without `main` firing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
