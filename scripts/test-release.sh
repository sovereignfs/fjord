#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Tests for scripts/release.sh and what it sources (scripts/lib, scripts/release).
#
#   scripts/test-release.sh           fast: everything except the full gates
#   scripts/test-release.sh --full    also runs `prepare` with the real gates
#
# A release script is the kind of code that breaks silently and is only ever
# run on the day you can least afford it, so it is tested the way the rest of
# this repository is: against real git repositories, through its failure
# modes as well as its success.
#
# Each test builds a throwaway repository from this checkout — a bare
# "origin" and a clone of it, with this working tree laid over it (so what is
# tested is what is on disk, committed or not) — so
# nothing here touches this repository, its remote, or GitHub. The one thing
# it does reach for is `gh auth status`, in the `publish` preflight tests,
# which are skipped if gh is not logged in.
#
# Needs git, cargo, dist and jq. Written for bash 3.2.

# The commands handed to check_in are single-quoted on purpose: they are
# eval'd inside the scratch repository, so $NEXT, $CUR and friends must expand
# there and not here.
# shellcheck disable=SC2016
set -u

ROOT=$(git rev-parse --show-toplevel)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
# Its OWN target directory, never this repository's. This used to share
# $ROOT/target to save build time, and that is a trap: Cargo hashes workspace
# crates by their path relative to the workspace root and judges freshness by
# file modification times, so a build from a scratch clone can be reused from
# the real checkout, with CARGO_MANIFEST_DIR compiled in pointing into a
# directory that no longer exists. It did exactly that: `prepare` failed its
# tests gate looking for fixtures under /tmp, because of an earlier run of
# this script. It costs a few minutes per run; being wrong costs more.
export CARGO_TARGET_DIR="$T/target"

FULL=no
[ "${1:-}" = "--full" ] && FULL=yes

PASSED=0
FAILED=0
TODAY=$(date +%Y-%m-%d)

# Where the CLI component keeps its notes.
CL=crates/fjord-cli/CHANGELOG.md
# Read by commands that check_in eval's, which shellcheck cannot follow.
# shellcheck disable=SC2034
REPO=https://github.com/sovereignfs/fjord

# The version under test: far from anything real, so it can never collide
# with a tag that exists.
CUR=$(awk '/^\[workspace\.package\]/ { f = 1; next } /^\[/ { f = 0 }
           f && /^version = / { gsub(/"/, "", $3); print $3; exit }' "$ROOT/Cargo.toml")
NEXT=$(echo "$CUR" | awk -F. '{ print $1 "." $2 "." $3 + 1 }')

pass() {
  PASSED=$((PASSED + 1))
  printf '  pass  %s\n' "$1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf '  FAIL  %s\n' "$1"
  shift
  [ $# -eq 0 ] || printf '%s\n' "$@" | sed 's/^/          /'
}

# Run a command inside a scratch repository and record whether it held.
# The command is eval'd there, so it can use $NEXT, $CUR and $TODAY.
check_in() {
  local dir=$1 name=$2 command=$3
  if (cd "$T/$dir" && eval "$command") >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name" "command: $command"
  fi
}

# A fresh scratch repository: bare origin, plus a clone with the script.
fresh() {
  local name=$1
  git clone -q --bare "$ROOT" "$T/$name.git"
  git clone -q "$T/$name.git" "$T/$name"
  (
    cd "$T/$name" || exit 1
    git config user.name "Release Test"
    git config user.email "release-test@example.invalid"
    # Always on main, whatever branch this checkout is on: the script under test
    # cuts releases from main.
    git checkout -q -B main
    # The working tree, not HEAD: replace every tracked file with what this
    # checkout has, so the script is tested as it stands.
    git rm -rq --quiet .
    (cd "$ROOT" && git ls-files -co --exclude-standard -z | xargs -0 tar cf -) | tar xf -
    # Whatever notes are waiting under [Unreleased] in the real changelog are
    # not these tests' business: they start from an empty one, and add their own.
    awk '/^## \[Unreleased\]/ { print; print ""; skip = 1; next }
         /^## \[/ { skip = 0 }
         !skip { print }' "$CL" >"$CL.new"
    mv "$CL.new" "$CL"
    git add -A
    git commit -q -m "scratch: this working tree under test"
    git push -q -u origin main
  )
}

# Run the script in a scratch repository, keeping its output and status.
OUT=""
RC=0
rel() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && /bin/bash scripts/release.sh cli "$@" 2>&1)
  RC=$?
}

# Add notes under [Unreleased].
notes() {
  (
    cd "$T/$1" || exit 1
    awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; print "- A note for the release under test."; d = 1 }' \
      "$CL" >"$CL.new"
    mv "$CL.new" "$CL"
  )
}

# Commit everything in a scratch repository and push it, so that main still
# matches origin: for setting up states that preflight must tolerate or refuse.
commit_push() {
  (
    cd "$T/$1" || exit 1
    git add -A
    git commit -q -m "$2"
    git push -q origin main
  )
}

# The script must refuse, and say why.
refuses() {
  local test=$1 want=$2
  if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF -- "$want"; then
    pass "$test"
  else
    fail "$test" "expected a refusal containing: $want" "exit $RC" "$OUT"
  fi
}

accepts() {
  local test=$1
  if [ "$RC" -eq 0 ]; then
    pass "$test"
  else
    fail "$test" "expected success, got exit $RC" "$OUT"
  fi
}

# --- Preflight refusals -------------------------------------------------------

printf '\npreflight: what it refuses\n'
fresh pre

rel pre check abc
refuses "a version that is not X.Y.Z" "not a version of the form X.Y.Z"

rel pre check "$CUR"
refuses "the current version again" "is not greater than"

rel pre check 0.0.1
refuses "a version lower than the current one" "is not greater than"

rel pre check "$NEXT"
refuses "no notes anywhere in the changelog" "no notes for $NEXT"

# An empty section heading is not notes.
(cd "$T/pre" && awk -v h="## [$NEXT] - $TODAY" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; d = 1 }' $CL >c.new && mv c.new $CL)
rel pre check "$NEXT"
refuses "a section heading with nothing under it" "is empty"
(cd "$T/pre" && git checkout -q $CL)

# A section with the wrong date: it would be dated for a different day.
(cd "$T/pre" && awk -v h="## [$NEXT] - 2000-01-01" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; print ""; print "- notes"; d = 1 }' $CL >c.new && mv c.new $CL)
rel pre check "$NEXT"
refuses "a section dated for another day" "dated 2000-01-01"
(cd "$T/pre" && git checkout -q $CL)

# Dirty tree: something other than the changelog.
notes pre
(cd "$T/pre" && echo "stray" >>Cargo.lock)
rel pre check "$NEXT"
refuses "changes other than the changelog" "changes other than $CL"
(cd "$T/pre" && git checkout -q Cargo.lock)

# Not on main.
(cd "$T/pre" && git checkout -q -b elsewhere)
rel pre check "$NEXT"
refuses "a branch that is not main" "releases are cut from main"
(cd "$T/pre" && git checkout -q main)

# main ahead of origin: what would be released is not what is on GitHub.
(cd "$T/pre" && git stash -q && echo x >local.txt && git add local.txt && git commit -q -m "local only" && git stash pop -q)
rel pre check "$NEXT"
refuses "main ahead of origin/main" "main is not the same as origin/main"
(cd "$T/pre" && git reset -q --hard origin/main)

# A tag that already exists on origin.
(cd "$T/pre" && git tag "fjord-cli-v$NEXT" && git push -q origin "fjord-cli-v$NEXT" && git tag -d "fjord-cli-v$NEXT" >/dev/null)
notes pre
rel pre check "$NEXT"
refuses "a tag that already exists on origin" "already exists on origin"
(cd "$T/pre" && git push -q --delete origin "fjord-cli-v$NEXT")

# The two version declarations disagree.
fresh skew
(cd "$T/skew" && sed -i.bak 's|path = "../fjord-core", version = "[^"]*"|path = "../fjord-core", version = "9.9.9"|' crates/fjord-cli/Cargo.toml && rm crates/fjord-cli/Cargo.toml.bak)
commit_push skew "scratch: skew the versions"
notes skew
rel skew check "$NEXT"
refuses "the two version declarations disagreeing" "fjord-core dependency"

# --- check: the success path ------------------------------------------------------

printf '\ncheck: what it accepts\n'
fresh ok
notes ok
rel ok check "$NEXT"
accepts "notes under [Unreleased]"
if printf '%s' "$OUT" | grep -qF "to become [$NEXT] - $TODAY"; then
  pass "...and says what [Unreleased] will become"
else
  fail "...and says what [Unreleased] will become" "$OUT"
fi

# --- prepare ------------------------------------------------------------------------

printf '\nprepare: what it makes\n'
rel ok prepare "$NEXT" --skip-gates
accepts "prepare, with the gates skipped"

# A release is a change like any other: it gets a branch, and main is not touched.
check_in ok "prepare left us on the release branch" \
  '[ "$(git branch --show-current)" = "chore/release-cli-$NEXT" ]'
check_in ok "main still matches origin/main" \
  '[ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ]'
check_in ok "the release branch is one commit ahead of main" \
  '[ "$(git rev-list --count main..HEAD)" = 1 ]'
check_in ok "one commit, subject 'Release fjord-cli $NEXT'" \
  '[ "$(git log -1 --format=%s)" = "Release fjord-cli $NEXT" ]'
check_in ok "the working tree is clean afterwards" \
  '[ -z "$(git status --porcelain)" ]'
check_in ok "the commit message carries the release notes" \
  'git log -1 --format=%b | grep -qF "A note for the release under test."'
check_in ok "[Unreleased] is left empty above the new section" \
  'awk "/^## \\[Unreleased\\]/{f=1;next} /^## \\[/{exit} f&&NF{bad=1} END{exit bad}" $CL'
check_in ok "the new section is headed '## [$NEXT] - $TODAY'" \
  'grep -qxF "## [$NEXT] - $TODAY" $CL'
check_in ok "the notes moved under the new heading" \
  'awk -v h="## [$NEXT]" '"'"'index($0,h)==1{f=1;next} /^## \[/{f=0} f'"'"' $CL | grep -qF "A note for the release"'
check_in ok "[Unreleased] compares from the new version" \
  'grep -qF "[Unreleased]: $REPO/compare/fjord-cli-v$NEXT...HEAD" $CL'
# The previous release carries a per-component tag, so the comparison starts
# from it. (The fallback to an old-style tag is tested under "components".)
check_in ok "a compare link was added for the new version, from the previous tag" \
  'grep -qF "[$NEXT]: $REPO/compare/fjord-cli-v$CUR...fjord-cli-v$NEXT" $CL'
check_in ok "the previous version's link is still there" \
  'grep -qF "[$CUR]: " $CL'
check_in ok "the workspace version is bumped" \
  'grep -qx "version = \"$NEXT\"" Cargo.toml'
check_in ok "the fjord-core dependency version is bumped" \
  'grep -q "fjord-core = .*version = \"$NEXT\"" crates/fjord-cli/Cargo.toml'
check_in ok "Cargo.lock followed" \
  'grep -A1 "^name = \"fjord-cli\"" Cargo.lock | grep -q "version = \"$NEXT\""'
check_in ok "only the four expected files changed" \
  '[ -z "$(git diff --name-only HEAD~1 | grep -vE "^(crates/fjord-cli/CHANGELOG\\.md|Cargo\\.toml|Cargo\\.lock|crates/fjord-cli/Cargo\\.toml)$")" ]'
check_in ok "nothing was pushed" \
  '[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]'
check_in ok "dist can find the notes in the result" \
  'dist plan --tag=fjord-cli-v$NEXT --output-format=json 2>/dev/null | jq -e .announcement_changelog'

# Running prepare again must refuse: the version is no longer greater.
rel ok prepare "$NEXT" --skip-gates
refuses "preparing the same version twice" "already prepared"
if printf '%s' "$OUT" | grep -qF "scripts/release.sh cli propose $NEXT"; then
  pass "...and says to propose it"
else
  fail "...and says to propose it" "$OUT"
fi

# --- prepare, when it fails: nothing is left behind -----------------------------------

printf '\nprepare: when a gate fails\n'
fresh roll
# Misformatted code, committed and pushed so that main still matches origin
# and preflight lets the run reach the gates.
(
  cd "$T/roll" || exit 1
  sed -i.bak 's/^pub const FORMAT_VERSION: u32 = 1;/pub const   FORMAT_VERSION:u32=1;/' crates/fjord-core/src/lib.rs
  rm -f crates/fjord-core/src/lib.rs.bak
)
commit_push roll "scratch: misformatted code, so the fmt gate fails"
notes roll
BEFORE_HEAD=$(cd "$T/roll" && git rev-parse HEAD)
rel roll prepare "$NEXT"
refuses "a failing gate fails the run" "rustfmt"
check_in roll "no commit was made" '[ "$(git rev-parse HEAD)" = "'"$BEFORE_HEAD"'" ]'
check_in roll "we are back on main" '[ "$(git branch --show-current)" = main ]'
check_in roll "the release branch is gone" \
  '! git rev-parse -q --verify "refs/heads/chore/release-cli-$NEXT"'
check_in roll "Cargo.toml is back at $CUR" 'grep -qx "version = \"$CUR\"" Cargo.toml'
check_in roll "the fjord-core dependency is back at $CUR" \
  'grep -q "fjord-core = .*version = \"$CUR\"" crates/fjord-cli/Cargo.toml'
check_in roll "the uncommitted notes survived the rollback" \
  'grep -qF "A note for the release under test." $CL'
check_in roll "...and are still under [Unreleased], not promoted" \
  '! grep -q "^## \\[$NEXT\\]" $CL'
check_in roll "the only modified file is the changelog" \
  '[ "$(git status --porcelain | awk "{print \$2}")" = "$CL" ]'

# --- propose and tag, against a stand-in for gh ------------------------------------------
#
# Opening a pull request and tagging a release are the two steps the world can
# see. Their preflights are tested here, and propose is run for real against a
# local bare origin; only gh is replaced, by a script that answers "logged in"
# and records what it was asked to do.

printf '\npropose and tag: the preflights, and propose itself\n'
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'SHIM'
#!/bin/sh
echo "$*" >>"$GH_RECORD"
case "$1 $2" in
  "auth status") exit 0 ;;
  "secret list") printf 'HOMEBREW_TAP_TOKEN\tUpdated 2026-10-21\n' ;;
  "pr list") exit 0 ;;
  "pr create") echo "https://github.com/example/example/pull/1" ;;
esac
SHIM
chmod +x "$T/bin/gh"
GH_RECORD="$T/gh-record"
: >"$GH_RECORD"

# Like rel, with the stand-in first on PATH.
relg() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && PATH="$T/bin:$PATH" GH_RECORD="$GH_RECORD" /bin/bash scripts/release.sh cli "$@" 2>&1)
  RC=$?
}

relg ok propose "$NEXT" --dry-run
accepts "a dry run of propose on a prepared release"
if printf '%s' "$OUT" | grep -qF "Dry run, so nothing was changed"; then
  pass "...and says it changed nothing"
else
  fail "...and says it changed nothing" "$OUT"
fi
check_in ok "...and really did not push the branch" \
  '! git ls-remote --exit-code --heads origin "chore/release-cli-$NEXT"'

# Not prepared: we are on main, not on a release branch.
fresh unprep
relg unprep propose "$NEXT" --dry-run
refuses "proposing something that was never prepared" "Run 'prepare $NEXT' first"

# Prepared, then something else committed on top of the release commit.
(cd "$T/ok" && echo y >extra.txt && git add extra.txt && git commit -q -m "something else")
relg ok propose "$NEXT" --dry-run
refuses "a commit on top of the release commit" "HEAD is 'something else'"
(cd "$T/ok" && git reset -q --hard HEAD~1)

# Proposing for real: the branch is pushed, a DRAFT PR into main is opened, and
# main is not touched.
relg ok propose "$NEXT"
accepts "propose, with gh stood in for"
check_in ok "the release branch is on origin" \
  'git ls-remote --exit-code --heads origin "chore/release-cli-$NEXT"'
check_in ok "main on origin did not move" \
  '[ "$(git ls-remote origin refs/heads/main | cut -f1)" = "$(git rev-parse main)" ]'
if grep -qF "pr create --draft --base main --head chore/release-cli-$NEXT --title Release fjord-cli $NEXT" "$GH_RECORD"; then
  pass "the pull request is a draft into main, titled for the release"
else
  fail "the pull request is a draft into main, titled for the release" "$(cat "$GH_RECORD")"
fi
if printf '%s' "$OUT" | grep -qF "scripts/release.sh cli tag $NEXT"; then
  pass "...and it says to run tag after the merge"
else
  fail "...and it says to run tag after the merge" "$OUT"
fi

# tag, before the PR is merged: we are on the release branch, then on a main
# that does not have the release commit.
relg ok tag "$NEXT" --dry-run
refuses "tagging from the release branch" "releases are cut from main"
relg unprep tag "$NEXT" --dry-run
refuses "tagging before the release commit is on main" "not 'Release fjord-cli $NEXT'"

# Simulate the merge, which is a fast-forward of main to the release commit.
(cd "$T/ok" && git switch -q main && git merge -q --ff-only "chore/release-cli-$NEXT" && git push -q origin main)
relg ok tag "$NEXT" --dry-run
accepts "a dry run of tag once the release commit is on main"
if printf '%s' "$OUT" | grep -qF "Dry run, so nothing was changed"; then
  pass "...and says it changed nothing"
else
  fail "...and says it changed nothing" "$OUT"
fi
check_in ok "...and created no tag" '[ -z "$(git tag -l "fjord-cli-v$NEXT")" ]'

# A tag that already exists on origin.
(cd "$T/ok" && git tag "fjord-cli-v$NEXT" && git push -q origin "fjord-cli-v$NEXT" && git tag -d "fjord-cli-v$NEXT" >/dev/null)
relg ok tag "$NEXT" --dry-run
refuses "tagging a version whose tag already exists" "already exists on origin"
(cd "$T/ok" && git push -q --delete origin "fjord-cli-v$NEXT")

# The old one-step command says what replaced it, and does nothing.
relg ok publish "$NEXT"
refuses "publish, which no longer exists" "publish no longer exists"
if [ "$RC" -eq 2 ]; then
  pass "...and exits 2"
else
  fail "...and exits 2" "exit $RC"
fi

# --- Homebrew: the token must exist before a release, and the tap after --------------------

printf '\nhomebrew: the secret before the tag, the formula after\n'

# Run a command from this checkout with gh replaced by $1 (a function body) and
# the CLI component loaded. The stand-in must `return`, not `exit`: in a function,
# exit ends the whole shell.
hb_call() {
  local stub=$1 command=$2
  OUT=$(cd "$ROOT" && bash -c '
    source scripts/lib/release.sh
    source scripts/release/cli.sh
    gh() { '"$stub"'; }
    '"$command" 2>&1)
  RC=$?
}

hb_call 'case "$1 $2" in "repo view") return 0 ;; "secret list") printf "HOMEBREW_TAP_TOKEN\tx\n" ;; esac' c_check_publish
accepts "the tap exists and the token is set"

hb_call 'case "$1 $2" in "repo view") return 0 ;; "secret list") printf "SOMETHING_ELSE\tx\n" ;; esac' c_check_publish
refuses "the token is not set" "HOMEBREW_TAP_TOKEN is not set"

hb_call 'case "$1 $2" in "repo view") return 1 ;; esac' c_check_publish
refuses "the tap does not exist" "does not exist"

# The formula, as the tap would hold it after a release.
formula() {
  printf 'class Fjord < Formula\n  version "%s"\n' "$1"
  for _ in 1 2 3 4; do printf '  url "https://example/x.tar.xz"\n  sha256 "%s"\n' "$2"; done
}
MANIFEST="$T/dist-manifest.json"
printf '{"artifacts":{"fjord.rb":{},"fjord-cli-installer.sh":{}}}' >"$MANIFEST"
printf '{"artifacts":{"fjord-cli-installer.sh":{}}}' >"$T/old-manifest.json"
b64() { base64 | tr -d '\n'; }
GOOD=$(formula 9.9.9 deadbeef | b64)
WRONGVER=$(formula 1.0.0 deadbeef | b64)
NOSHA=$(printf 'class Fjord < Formula\n  version "9.9.9"\n' | b64)

hb_call 'printf "%s" "'"$GOOD"'"' "c_verify_formula 9.9.9 $MANIFEST"
accepts "a formula at the right version with a checksum per platform"
if printf '%s' "$OUT" | grep -qF "brew install sovereignfs/tap/fjord"; then
  pass "...and says how to install it"
else
  fail "...and says how to install it" "$OUT"
fi
hb_call 'printf "%s" "'"$WRONGVER"'"' "c_verify_formula 9.9.9 $MANIFEST"
refuses "a formula left at an older version" "not version 9.9.9"
hb_call 'printf "%s" "'"$NOSHA"'"' "c_verify_formula 9.9.9 $MANIFEST"
refuses "a formula with no checksums, which would install unverified" "would install unverified"
hb_call 'return 1' "c_verify_formula 9.9.9 $MANIFEST"
refuses "a release that carries a formula the tap does not have" "has no Formula/fjord.rb"
hb_call 'return 1' "c_verify_formula 9.9.9 $T/old-manifest.json"
accepts "an older release, from before the tap, is not checked"

# --- Waiting on GitHub, against real completed runs ------------------------------------------
#
# These call the script's own functions. They read the real, finished runs for
# the v0.1.2 release, so they cannot publish anything.

printf '\nwaiting on GitHub: against the real v0.1.2 runs\n'
# `git -C` rather than `cd ... && git ... || true`: that shape is `A && B || C`,
# which is not if/else, and the older shellcheck on the CI runners flags it.
RELEASED_SHA=$(git -C "$ROOT" rev-parse -q --verify "refs/tags/v0.1.2^{commit}" 2>/dev/null || true)
# That release was cut by the workflow that was `release.yml`, deleted when the
# tag namespace arrived. GitHub stops listing a deleted workflow but keeps its
# runs, reachable by the workflow's numeric id, which a run of it still knows.
OLD_WORKFLOW=""
if gh auth status >/dev/null 2>&1; then
  OLD_RUN=$(gh run list --repo "${REPO#https://github.com/}" --limit 200 --json databaseId,headBranch,workflowName \
    --jq '.[] | select(.headBranch == "v0.1.2" and .workflowName == "Release") | .databaseId' 2>/dev/null | head -1 || true)
  if [ -n "$OLD_RUN" ]; then
    OLD_WORKFLOW=$(gh run view "$OLD_RUN" --repo "${REPO#https://github.com/}" --json workflowDatabaseId \
      --jq .workflowDatabaseId 2>/dev/null || true)
  fi
fi
if gh auth status >/dev/null 2>&1 && [ -n "$RELEASED_SHA" ]; then
  # In a subshell: sourcing installs the script's EXIT trap and `set -e`.
  gh_call() {
    OUT=$(cd "$ROOT" && RELEASE_RUN_START_TIMEOUT=6 bash -c "source scripts/lib/release.sh; source scripts/release/cli.sh; $*" 2>&1)
    RC=$?
  }
  gh_call "wait_for_workflow CI $RELEASED_SHA yes"
  accepts "CI on the real v0.1.2 commit is found and green"
  gh_call "wait_for_workflow Audit $RELEASED_SHA no"
  accepts "Audit on the real v0.1.2 commit is found and green"
  if [ -n "$OLD_WORKFLOW" ]; then
    gh_call "wait_for_release_run v0.1.2 $OLD_WORKFLOW"
    accepts "the real v0.1.2 release run is found and green"
  else
    printf '  skip  could not find the v0.1.2 release run on GitHub\n'
  fi

  FAKE=0000000000000000000000000000000000000001
  gh_call "wait_for_workflow CI $FAKE yes"
  refuses "a required workflow that never appears is a hard failure" "no CI run appeared"
  gh_call "wait_for_workflow Audit $FAKE no"
  accepts "an optional one that never appears is only a warning"
  if printf '%s' "$OUT" | grep -qF "warning: no Audit run"; then
    pass "...and says so"
  else
    fail "...and says so" "$OUT"
  fi
else
  printf '  skip  needs gh logged in and the v0.1.2 tag in this checkout\n'
fi

# --- Several components share one repository --------------------------------------------

printf '\ncomponents: one repository, several things released from it\n'

# A tag belonging to another component must not be mistaken for this one's.
fresh other
(cd "$T/other" && git tag "vscode-v$NEXT" && git push -q origin "vscode-v$NEXT")
notes other
rel other check "$NEXT"
accepts "another component's tag at the same version does not block this one"

# Releases up to 0.2.0 were tagged before there was more than one component.
# When the previous release has only an old-style tag, the compare link starts
# from it instead.
fresh legacy
# On origin as well as here: prepare fetches tags, and would bring it back.
(cd "$T/legacy" && git tag -d "fjord-cli-v$CUR" >/dev/null && git push -q origin ":refs/tags/fjord-cli-v$CUR" && git tag "v$CUR")
notes legacy
rel legacy prepare "$NEXT" --skip-gates
accepts "prepare, when the previous release has only an old-style tag"
check_in legacy "the compare link starts from the old-style tag" \
  'grep -qF "[$NEXT]: $REPO/compare/v$CUR...fjord-cli-v$NEXT" $CL'

# The dispatcher refuses what it cannot run, and cannot be pointed elsewhere.
dispatch() {
  OUT=$(cd "$T/ok" && /bin/bash scripts/release.sh "$@" 2>&1)
  RC=$?
}
dispatch nope check 1.0.0
refuses "a component that does not exist" "there is no component 'nope'"
dispatch ../lib/release check 1.0.0
refuses "a component name that is a path" "is not a component name"
dispatch cli
if [ "$RC" -eq 2 ] && printf '%s' "$OUT" | grep -qF "Usage:"; then
  pass "missing arguments print the usage and exit 2"
else
  fail "missing arguments print the usage and exit 2" "exit $RC" "$OUT"
fi

# "Latest" is one slot shared by every component, and the CLI's install URLs
# depend on it being the CLI's. Run against a stand-in for gh.
if command -v gh >/dev/null 2>&1; then
  latest_call() {
    OUT=$(cd "$ROOT" && bash -c '
      source scripts/lib/release.sh
      source scripts/release/cli.sh
      C_LATEST='"$1"'
      gh() {
        case "$1 $2" in
          "release view") echo "{\"isDraft\":false,\"isPrerelease\":false,\"body\":\"\",\"assets\":[]}" ;;
          "release list") echo '"$2"' ;;
        esac
      }
      verify_release_page fjord-cli-v9.9.9' 2>&1)
    RC=$?
  }
  latest_call yes true
  accepts "a component that should be Latest, and is"
  latest_call no false
  accepts "a component that should not be Latest, and is not"
  latest_call no true
  refuses "a component that must not be Latest, but is" "must not be"
  latest_call yes false
  accepts "an older release of the CLI is allowed not to be Latest"
else
  printf '  skip  gh is not installed, so the Latest tests were not run\n'
fi

# A release is called by its component and version, with no date. Run against
# a stand-in for gh that records what it is asked to do.
if command -v gh >/dev/null 2>&1; then
  RECORD="$T/gh-calls"
  : >"$RECORD"
  title_call() {
    OUT=$(cd "$ROOT" && RECORD="$RECORD" bash -c '
      source scripts/lib/release.sh
      source scripts/release/cli.sh
      gh() { printf "%s\n" "$*" >>"$RECORD"; }
      '"$1" 2>&1)
    RC=$?
  }
  title_call 'retitle_release fjord-cli-v9.9.9 9.9.9'
  accepts "a published release is retitled"
  if grep -qxF "release edit fjord-cli-v9.9.9 --title fjord-cli 9.9.9" "$RECORD"; then
    pass "...to the component and version, with no date"
  else
    fail "...to the component and version, with no date" "$(cat "$RECORD")"
  fi

  # verify reads the title back: a dated one is reported, not fatal.
  name_call() {
    OUT=$(cd "$ROOT" && bash -c '
      source scripts/lib/release.sh
      source scripts/release/cli.sh
      gh() {
        case "$1 $2" in
          "release view") echo "{\"name\":\"'"$1"'\",\"isDraft\":false,\"isPrerelease\":false,\"body\":\"\",\"assets\":[]}" ;;
          "release list") echo true ;;
        esac
      }
      verify_release_page fjord-cli-v9.9.9 9.9.9' 2>&1)
    RC=$?
  }
  name_call "fjord-cli 9.9.9"
  accepts "a release titled as it should be"
  if printf '%s' "$OUT" | grep -qF "titled 'fjord-cli 9.9.9'"; then
    pass "...and says so"
  else
    fail "...and says so" "$OUT"
  fi
  name_call "9.9.9 - 2026-10-21"
  accepts "a release whose title still has the date is not fatal"
  if printf '%s' "$OUT" | grep -qF "gh release edit fjord-cli-v9.9.9 --title 'fjord-cli 9.9.9'"; then
    pass "...but the warning says how to fix it"
  else
    fail "...but the warning says how to fix it" "$OUT"
  fi
fi

# --- Fjord Web --------------------------------------------------------------------------------

printf '\nthe web component\n'
WL=clients/web/CHANGELOG.md
# A scratch repository for the web component: its notes start empty, and the
# version is the one given, so what is tested does not depend on how far the real
# package has got. Its first release is from 0.0.0.
freshw() {
  local name=$1 version=$2
  fresh "$name"
  (
    cd "$T/$name" || exit 1
    awk '/^## \[Unreleased\]/ { print; print ""; skip = 1; next }
         /^## \[/ { skip = 0 }
         /^\[[^]]+\]: / { skip = 0 }
         !skip { print }' "$WL" >"$WL.new"
    mv "$WL.new" "$WL"
    sed "s/^  \"version\": \".*\",\$/  \"version\": \"$version\",/" clients/web/package.json >package.new
    mv package.new clients/web/package.json
    git add -A
    git commit -q -m "scratch: web at $version"
    git push -q origin main
  )
}
notesw() {
  (
    cd "$T/$1" || exit 1
    awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; print "- A note for the web release under test."; d = 1 }' \
      "$WL" >"$WL.new"
    mv "$WL.new" "$WL"
  )
}
# Like relg, for the web component.
relw() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && PATH="$T/bin:$PATH" GH_RECORD="$GH_RECORD" /bin/bash scripts/release.sh web "$@" 2>&1)
  RC=$?
}

# Each component demands the tools its own commands run, and no others: releasing
# Fjord Web must not need a Rust toolchain, nor the CLI a Node one.
tools_of() {
  OUT=$(cd "$ROOT" && bash -c '
    source scripts/lib/release.sh
    source scripts/release/'"$1"'.sh
    need() { echo "$1"; }
    need_component_tools' 2>&1 | tr '\n' ' ')
}
tools_of web
if [ "$OUT" = "node pnpm " ]; then
  pass "the web component needs node and pnpm, and no Rust tools"
else
  fail "the web component needs node and pnpm, and no Rust tools" "$OUT"
fi
tools_of cli
if [ "$OUT" = "cargo dist " ]; then
  pass "the CLI component needs cargo and dist, and no Node tools"
else
  fail "the CLI component needs cargo and dist, and no Node tools" "$OUT"
fi

freshw web 0.0.0
rel_web_next=0.1.0
relw web check "$rel_web_next"
refuses "web: no notes in its changelog" "no notes for $rel_web_next"

notesw web
relw web check "$rel_web_next"
accepts "web: notes under [Unreleased]"
relw web check 0.0.0
refuses "web: the current version again" "is not greater than"

relw web prepare "$rel_web_next" --skip-gates
accepts "web: prepare, with the gates skipped"
check_in web "web: on the release branch chore/release-web-$rel_web_next" \
  '[ "$(git branch --show-current)" = "chore/release-web-0.1.0" ]'
check_in web "web: one commit, subject 'Release fjord-web $rel_web_next'" \
  '[ "$(git log -1 --format=%s)" = "Release fjord-web 0.1.0" ] && [ "$(git rev-list --count main..HEAD)" = 1 ]'
check_in web "web: package.json says the new version" \
  '[ "$(jq -r .version clients/web/package.json)" = 0.1.0 ]'
check_in web "web: only the changelog and package.json changed" \
  '[ "$(git diff --name-only HEAD~1 | sort | tr "\n" " ")" = "clients/web/CHANGELOG.md clients/web/package.json " ]'
check_in web "web: the working tree is clean afterwards" '[ -z "$(git status --porcelain)" ]'
check_in web "web: the notes moved under the new heading" \
  'grep -qxF "## [0.1.0] - $TODAY" $WL && awk -v h="## [0.1.0]" '"'"'index($0,h)==1{f=1;next} /^## \[/{f=0} f'"'"' $WL | grep -qF "A note for the web release"'
check_in web "web: [Unreleased] compares from the new version" \
  'grep -qF "[Unreleased]: $REPO/compare/web-v0.1.0...HEAD" $WL'
# Nothing was released before, so there is nothing to compare with: the first
# version links to its release, and not to a compare URL that would be a 404.
check_in web "web: a first release links to its release page, not a comparison" \
  'grep -qF "[0.1.0]: $REPO/releases/tag/web-v0.1.0" $WL && ! grep -qF "web-v0.0.0" $WL'

relw web propose "$rel_web_next" --dry-run
accepts "web: a dry run of propose"
check_in web "web: ...which did not push the branch" \
  '! git ls-remote --exit-code --heads origin "chore/release-web-0.1.0"'

# Simulate the merge, then tag: which waits on web-ci.yml and not on the Rust CI.
(cd "$T/web" && git switch -q main && git merge -q --ff-only "chore/release-web-$rel_web_next" && git push -q origin main)
relw web tag "$rel_web_next" --dry-run
accepts "web: a dry run of tag once the release commit is on main"
for expected in "web-ci.yml" "web-v0.1.0" "web-release.yml"; do
  if printf '%s' "$OUT" | grep -qF "$expected"; then
    pass "web: ...which names $expected"
  else
    fail "web: ...which names $expected" "$OUT"
  fi
done
check_in web "web: ...and created no tag" '[ -z "$(git tag -l "web-v0.1.0")" ]'

# A later release compares from the previous one's tag.
freshw web2 0.1.0
notesw web2
relw web2 prepare 0.1.1 --skip-gates
accepts "web: prepare of a second release"
check_in web2 "web: the compare link starts from the previous web tag" \
  'grep -qF "[0.1.1]: $REPO/compare/web-v0.1.0...web-v0.1.1" $WL'

# What a tag would start has to exist, or tagging would start nothing.
freshw web3 0.0.0
(cd "$T/web3" && git rm -q .github/workflows/web-release.yml && git commit -q -m "scratch: no release workflow" && git push -q origin main)
notesw web3
relw web3 prepare "$rel_web_next" --skip-gates
refuses "web: no release workflow to start" "would start nothing"
check_in web3 "web: ...and prepare put everything back" \
  '[ "$(git branch --show-current)" = main ] && [ -z "$(git status --short | grep -v CHANGELOG)" ]'

freshw web4 0.0.0
(cd "$T/web4" && sed -i.bak 's/web-v/web-x/g' .github/workflows/web-release.yml && rm .github/workflows/web-release.yml.bak && git add -A && git commit -q -m "scratch: wrong tag filter" && git push -q origin main)
notesw web4
relw web4 prepare "$rel_web_next" --skip-gates
refuses "web: a release workflow that does not trigger on web-v tags" "does not trigger on web-v tags"

# An unusable version declaration is refused before anything is changed.
freshw web5 0.0.0
(cd "$T/web5" && sed 's/^  "version": ".*",$/  "version": "next",/' clients/web/package.json >p.new && mv p.new clients/web/package.json && git add -A && git commit -q -m "scratch: bad version" && git push -q origin main)
notesw web5
relw web5 check "$rel_web_next"
refuses "web: a version in package.json that is not X.Y.Z" "not of the form X.Y.Z"

# A patch release carries no migration (RELEASING.md § Fjord Web versions). The scratch repository
# has been released at 0.1.0 (a local tag stands in for it) and then gained a migration.
freshw web6 0.1.0
(
  cd "$T/web6" || exit 1
  git tag web-v0.1.0
  mkdir -p clients/web/migrations/sqlite
  echo "ALTER TABLE x ADD COLUMN y;" >clients/web/migrations/sqlite/9999_scratch.sql
  git add -A
  git commit -q -m "scratch: a migration"
  git push -q origin main
)
notesw web6
relw web6 prepare 0.1.1 --skip-gates
refuses "web: a patch release with a migration since the last release" "A patch release carries none"
check_in web6 "web: ...and prepare put everything back" \
  '[ "$(git branch --show-current)" = main ] && [ -z "$(git status --short | grep -v CHANGELOG)" ]'
relw web6 prepare 0.2.0 --skip-gates
accepts "web: ...but the same changes are fine in a minor release"

freshw web7 0.1.0
(cd "$T/web7" && git tag web-v0.1.0)
notesw web7
relw web7 prepare 0.1.1 --skip-gates
accepts "web: a patch release with no migration since the last release"

# A migration that was released is never edited or removed, in any kind of release.
freshw web8 0.1.0
(
  cd "$T/web8" || exit 1
  mkdir -p clients/web/migrations/sqlite
  echo "CREATE TABLE a (x);" >clients/web/migrations/sqlite/9998_released.sql
  git add -A
  git commit -q -m "scratch: a migration, released"
  git push -q origin main
  git tag web-v0.1.0
  echo "CREATE TABLE a (x, y);" >clients/web/migrations/sqlite/9998_released.sql
  git commit -q -am "scratch: the released migration, edited"
  git push -q origin main
)
notesw web8
relw web8 prepare 0.2.0 --skip-gates
refuses "web: a released migration that was edited" "A released migration is never changed"
(cd "$T/web8" && git rm -q clients/web/migrations/sqlite/9998_released.sql && git commit -q -m "scratch: the released migration, removed" && git push -q origin main)
relw web8 prepare 0.2.0 --skip-gates
refuses "web: a released migration that was removed" "A released migration is never changed"
(cd "$T/web8" && git checkout -q web-v0.1.0 -- clients/web/migrations/sqlite/9998_released.sql && echo "CREATE TABLE b (z);" >clients/web/migrations/sqlite/9999_new.sql && git add -A && git commit -q -m "scratch: restored, and a new one" && git push -q origin main)
relw web8 prepare 0.2.0 --skip-gates
accepts "web: ...but a new migration beside the released ones is fine in a minor release"

# A long changelog section is notes all the same (a pipe that closes early must not read as none).
freshw web9 0.0.0
notesw web9
(cd "$T/web9" && awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; for (i = 0; i < 20000; i++) print "- note " i; d = 1 }' "$WL" >"$WL.new" && mv "$WL.new" "$WL")
relw web9 check "$rel_web_next"
accepts "web: a changelog section too long to be read in one go"

# --- The full gates, once ---------------------------------------------------------------

if [ "$FULL" = yes ]; then
  printf '\nprepare: with the real gates (slow)\n'
  fresh full
  notes full
  rel full prepare "$NEXT"
  accepts "prepare, with fmt, clippy, tests and deny all running"

  freshw webfull 0.0.0
  notesw webfull
  relw webfull prepare "$rel_web_next"
  accepts "web: prepare, with install, typecheck, tests and build all running"
fi

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
