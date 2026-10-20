#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Tests for scripts/release.sh.
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
# "origin" and a clone of it, with the script under test copied in — so
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
# Share compiled dependencies: the clones are copies of this repository, so
# building them from scratch would take minutes for no benefit.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"

FULL=no
[ "${1:-}" = "--full" ] && FULL=yes

PASSED=0
FAILED=0
TODAY=$(date +%Y-%m-%d)

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
    mkdir -p scripts
    cp "$ROOT/scripts/release.sh" scripts/release.sh
    git add scripts/release.sh
    git commit -q -m "scratch: the release script under test"
    git push -q origin main
  )
}

# Run the script in a scratch repository, keeping its output and status.
OUT=""
RC=0
rel() {
  local name=$1
  shift
  OUT=$(cd "$T/$name" && /bin/bash scripts/release.sh "$@" 2>&1)
  RC=$?
}

# Add notes under [Unreleased].
notes() {
  (
    cd "$T/$1" || exit 1
    awk '{ print } /^## \[Unreleased\]/ && !d { print ""; print "### Added"; print ""; print "- A note for the release under test."; d = 1 }' \
      CHANGELOG.md >CHANGELOG.new
    mv CHANGELOG.new CHANGELOG.md
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
refuses "no notes anywhere in CHANGELOG.md" "no notes for $NEXT"

# An empty section heading is not notes.
(cd "$T/pre" && awk -v h="## [$NEXT] - $TODAY" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; d = 1 }' CHANGELOG.md >c.new && mv c.new CHANGELOG.md)
rel pre check "$NEXT"
refuses "a section heading with nothing under it" "is empty"
(cd "$T/pre" && git checkout -q CHANGELOG.md)

# A section with the wrong date: it would be dated for a different day.
(cd "$T/pre" && awk -v h="## [$NEXT] - 2000-01-01" '{ print } /^## \[Unreleased\]/ && !d { print ""; print h; print ""; print "- notes"; d = 1 }' CHANGELOG.md >c.new && mv c.new CHANGELOG.md)
rel pre check "$NEXT"
refuses "a section dated for another day" "dated 2000-01-01"
(cd "$T/pre" && git checkout -q CHANGELOG.md)

# Dirty tree: something other than CHANGELOG.md.
notes pre
(cd "$T/pre" && echo "stray" >>README.md)
rel pre check "$NEXT"
refuses "changes other than CHANGELOG.md" "changes other than CHANGELOG.md"
(cd "$T/pre" && git checkout -q README.md)

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
(cd "$T/pre" && git tag "v$NEXT" && git push -q origin "v$NEXT" && git tag -d "v$NEXT" >/dev/null)
notes pre
rel pre check "$NEXT"
refuses "a tag that already exists on origin" "already exists on origin"
(cd "$T/pre" && git push -q --delete origin "v$NEXT")

# The two version declarations disagree.
fresh skew
(cd "$T/skew" && sed -i.bak 's|path = "../fjord-core", version = "[^"]*"|path = "../fjord-core", version = "9.9.9"|' crates/fjord/Cargo.toml && rm crates/fjord/Cargo.toml.bak)
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

check_in ok "one commit, subject 'Release $NEXT'" \
  '[ "$(git log -1 --format=%s)" = "Release $NEXT" ]'
check_in ok "the working tree is clean afterwards" \
  '[ -z "$(git status --porcelain)" ]'
check_in ok "the commit message carries the release notes" \
  'git log -1 --format=%b | grep -qF "A note for the release under test."'
check_in ok "[Unreleased] is left empty above the new section" \
  'awk "/^## \\[Unreleased\\]/{f=1;next} /^## \\[/{exit} f&&NF{bad=1} END{exit bad}" CHANGELOG.md'
check_in ok "the new section is headed '## [$NEXT] - $TODAY'" \
  'grep -qxF "## [$NEXT] - $TODAY" CHANGELOG.md'
check_in ok "the notes moved under the new heading" \
  'awk -v h="## [$NEXT]" '"'"'index($0,h)==1{f=1;next} /^## \[/{f=0} f'"'"' CHANGELOG.md | grep -qF "A note for the release"'
check_in ok "[Unreleased] compares from the new version" \
  'grep -qF "[Unreleased]: https://github.com/sovereignfs/fjord-cli/compare/v$NEXT...HEAD" CHANGELOG.md'
check_in ok "a compare link was added for the new version" \
  'grep -qF "[$NEXT]: https://github.com/sovereignfs/fjord-cli/compare/v$CUR...v$NEXT" CHANGELOG.md'
check_in ok "the previous version's link is still there" \
  'grep -qF "[$CUR]: " CHANGELOG.md'
check_in ok "the workspace version is bumped" \
  'grep -qx "version = \"$NEXT\"" Cargo.toml'
check_in ok "the fjord-core dependency version is bumped" \
  'grep -q "fjord-core = .*version = \"$NEXT\"" crates/fjord/Cargo.toml'
check_in ok "Cargo.lock followed" \
  'grep -A1 "^name = \"fjord-cli\"" Cargo.lock | grep -q "version = \"$NEXT\""'
check_in ok "only the four expected files changed" \
  '[ -z "$(git diff --name-only HEAD~1 | grep -vE "^(CHANGELOG\\.md|Cargo\\.toml|Cargo\\.lock|crates/fjord/Cargo\\.toml)$")" ]'
check_in ok "nothing was pushed" \
  '[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]'
check_in ok "dist can find the notes in the result" \
  'dist plan --tag=v$NEXT --output-format=json 2>/dev/null | jq -e .announcement_changelog'

# Running prepare again must refuse: the version is no longer greater.
rel ok prepare "$NEXT" --skip-gates
refuses "preparing the same version twice" "already prepared"
if printf '%s' "$OUT" | grep -qF "scripts/release.sh publish $NEXT"; then
  pass "...and says to publish it"
else
  fail "...and says to publish it" "$OUT"
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
check_in roll "Cargo.toml is back at $CUR" 'grep -qx "version = \"$CUR\"" Cargo.toml'
check_in roll "the fjord-core dependency is back at $CUR" \
  'grep -q "fjord-core = .*version = \"$CUR\"" crates/fjord/Cargo.toml'
check_in roll "the uncommitted notes survived the rollback" \
  'grep -qF "A note for the release under test." CHANGELOG.md'
check_in roll "...and are still under [Unreleased], not promoted" \
  '! grep -q "^## \\[$NEXT\\]" CHANGELOG.md'
check_in roll "the only modified file is CHANGELOG.md" \
  '[ "$(git status --porcelain | awk "{print \$2}")" = "CHANGELOG.md" ]'

# --- publish: the preflight, which can be tested without publishing --------------------

printf '\npublish: preflight (never reaches GitHub beyond gh auth)\n'
if gh auth status >/dev/null 2>&1; then
  rel ok publish "$NEXT" --dry-run
  accepts "a dry run on a prepared release"
  if printf '%s' "$OUT" | grep -qF "Dry run, so nothing was changed"; then
    pass "...and says it changed nothing"
  else
    fail "...and says it changed nothing" "$OUT"
  fi
  check_in ok "...and really did not push" \
    '[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]'
  check_in ok "...or tag" '[ -z "$(git tag -l "v$NEXT")" ]'

  # Not prepared: HEAD is not the release commit.
  fresh unprep
  rel unprep publish "$NEXT" --dry-run
  refuses "publishing something that was never prepared" "run 'prepare $NEXT' first"

  # Prepared, then something else committed on top: HEAD is no longer it.
  (cd "$T/ok" && echo y >extra.txt && git add extra.txt && git commit -q -m "something else")
  rel ok publish "$NEXT" --dry-run
  refuses "a commit on top of the release commit" "HEAD is 'something else'"
else
  printf '  skip  gh is not logged in, so the publish preflight tests were not run\n'
fi

# --- Waiting on GitHub, against real completed runs ------------------------------------------
#
# These call the script's own functions. They read the real, finished runs for
# the v0.1.2 release, so they cannot publish anything.

printf '\nwaiting on GitHub: against the real v0.1.2 runs\n'
RELEASED_SHA=$(cd "$ROOT" && git rev-parse -q --verify "refs/tags/v0.1.2^{commit}" 2>/dev/null || true)
if gh auth status >/dev/null 2>&1 && [ -n "$RELEASED_SHA" ]; then
  # In a subshell: sourcing installs the script's EXIT trap and `set -e`.
  gh_call() {
    OUT=$(cd "$ROOT" && RELEASE_RUN_START_TIMEOUT=6 bash -c "source scripts/release.sh; $*" 2>&1)
    RC=$?
  }
  gh_call "wait_for_workflow CI $RELEASED_SHA yes"
  accepts "CI on the real v0.1.2 commit is found and green"
  gh_call "wait_for_workflow Audit $RELEASED_SHA no"
  accepts "Audit on the real v0.1.2 commit is found and green"
  gh_call "wait_for_release_run 0.1.2"
  accepts "the real v0.1.2 Release run is found and green"

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

# --- The full gates, once ---------------------------------------------------------------

if [ "$FULL" = yes ]; then
  printf '\nprepare: with the real gates (slow)\n'
  fresh full
  notes full
  rel full prepare "$NEXT"
  accepts "prepare, with fmt, clippy, tests and deny all running"
fi

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
