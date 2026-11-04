# shellcheck shell=bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Fjord Web: package `fjord-web` in clients/web. A `web-vX.Y.Z` tag starts
# .github/workflows/web-release.yml, which checks the app and publishes a GitHub
# release with the changelog's notes. Sourced by scripts/release.sh.
#
# Its releases are never marked Latest: "Latest" is one slot for the whole
# repository, and the CLI's install URLs depend on it being the CLI's.
#
# A release is the notes and the container image: the workflow builds it for
# linux/amd64 and linux/arm64, publishes it to ghcr.io/<owner>/fjord-web, attests
# where it came from, and only then publishes the release page (RELEASING.md).

# The C_* variables are read by scripts/lib/release.sh, which shellcheck cannot
# see from here.
# shellcheck disable=SC2034
C_NAME=web
C_PACKAGE=fjord-web
C_TAG_PREFIX=web-v
C_CHANGELOG=clients/web/CHANGELOG.md
# The lockfile does not record the project's own version, so a bump leaves it alone.
C_TOUCHED="clients/web/CHANGELOG.md clients/web/package.json"
C_RELEASE_WORKFLOW=web-release.yml
C_NEEDS="node pnpm"
C_LATEST=no
# By file name, not title: this list is split on spaces, and "Web CI" would be two.
C_REQUIRED_WORKFLOWS="web-ci.yml"
C_OPTIONAL_WORKFLOWS=""

C_PACKAGE_JSON=clients/web/package.json

c_current_version() {
  jq -r '.version // empty' "$C_PACKAGE_JSON"
}

# The version is written in one place. The check is that it is there and well
# formed, so that a bump has something to replace.
c_check_versions() {
  local cur
  cur=$(c_current_version)
  [ -n "$cur" ] || die "could not read the version from $C_PACKAGE_JSON"
  valid_version "$cur" || die "$C_PACKAGE_JSON says '$cur', which is not of the form X.Y.Z"
  ok "$C_PACKAGE_JSON says $cur"
}

c_bump() {
  local cur=$1 v=$2
  [ "$(grep -c "^  \"version\": \"$cur\",\$" "$C_PACKAGE_JSON")" = 1 ] ||
    die "expected exactly one '  \"version\": \"$cur\",' line in $C_PACKAGE_JSON"
  sed "s/^  \"version\": \"$cur\",\$/  \"version\": \"$v\",/" "$C_PACKAGE_JSON" >"$WORK/package.new"
  cat "$WORK/package.new" >"$C_PACKAGE_JSON"
  ok "$C_PACKAGE_JSON now says $v"
}

# What the tag will start has to be in place and has to be able to find its notes:
# the workflow reads the version's section of the changelog, and a release with
# none would go out with an empty page.
c_check_plan() {
  local v=$1 workflow=".github/workflows/$C_RELEASE_WORKFLOW"
  [ -f "$workflow" ] || die "there is no $workflow, so tagging $(tag_of "$v") would start nothing"
  grep -qF "web-v" "$workflow" ||
    die "$workflow does not trigger on web-v tags"
  ok "$workflow is there and triggers on web-v tags"
  section_body "$v" | has_content ||
    die "$C_CHANGELOG has no notes for $v, so the release page would be empty"
  ok "$C_CHANGELOG has notes for $v"
  c_check_migrations_kept "$v"
  c_check_patch_policy "$v"
}

# A migration that has been released is never edited or removed (RELEASING.md § Fjord Web
# versions): a database that applied it would no longer match the file that says what it did.
# Adding one is what a change to the schema is. Compared with the newest release before $v.
c_check_migrations_kept() {
  local v=$1 prev_tag changed
  prev_tag=$(c_previous_release "$v") || return 0
  changed=$(git diff --name-status --no-renames "$prev_tag" HEAD -- clients/web/migrations | awk '$1 != "A" { print $2 }')
  # Each dialect's `meta/_journal.json` lists the migrations in order, so it gains an entry for every new migration: that is adding one, and is not an edit of the
  # released ones. It is an edit if an entry the release had is gone or changed (the entries it had are the start of the entries it has).
  local file kept="" TMPDIR_RELEASE_JOURNAL
  TMPDIR_RELEASE_JOURNAL=$(mktemp)
  for file in $changed; do
    case $file in
      */meta/_journal.json)
        git show "$prev_tag:$file" >"$TMPDIR_RELEASE_JOURNAL.old" 2>/dev/null || { kept="$kept $file"; continue; }
        node -e '
          const fs = require("fs");
          const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries;
          const now = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).entries;
          process.exit(now.length >= before.length && before.every((entry, i) => JSON.stringify(entry) === JSON.stringify(now[i])) ? 0 : 1);
        ' "$TMPDIR_RELEASE_JOURNAL.old" "$file" 2>/dev/null || kept="$kept $file"
        rm -f "$TMPDIR_RELEASE_JOURNAL.old"
        ;;
      *) kept="$kept $file" ;;
    esac
  done
  rm -f "$TMPDIR_RELEASE_JOURNAL"
  changed=$(printf '%s\n' $kept)
  if [ -n "$changed" ]; then
    printf '%s\n' "$changed" | sed 's/^/        /' >&2
    die "migrations that were released in $prev_tag were edited or removed (above). A released migration is never changed: put the fix in a new one"
  fi
  ok "no migration released in $prev_tag was edited or removed"
}

# The newest web release before $1, from the tags (the plan is checked after the bump, so the
# version in package.json is already the new one). Fails if there is none.
c_previous_release() {
  local v=$1 candidate cand_v best=""
  for candidate in $(git tag --list "${C_TAG_PREFIX}[0-9]*.[0-9]*.[0-9]*"); do
    cand_v=${candidate#"$C_TAG_PREFIX"}
    valid_version "$cand_v" || continue
    version_gt "$v" "$cand_v" || continue
    if [ -z "$best" ] || version_gt "$cand_v" "$best"; then best=$cand_v; fi
  done
  [ -n "$best" ] || return 1
  echo "${C_TAG_PREFIX}$best"
}

# RELEASING.md § Fjord Web versions: a patch release (X.Y.Z to X.Y.Z+1) carries no
# migration, so going from one patch to the next never changes the database, and
# a bad patch can be rolled back without restoring a backup. Only checked when the
# previous release is there to compare with.
c_check_patch_policy() {
  local v=$1 prev_tag prev_v changed
  prev_tag=$(c_previous_release "$v") || return 0
  prev_v=${prev_tag#"$C_TAG_PREFIX"}
  # Only a patch release of the same minor: 0.1.0 to 0.2.0 may carry migrations.
  [ "${prev_v%.*}" = "${v%.*}" ] || return 0
  changed=$(git diff --name-only "$prev_tag" HEAD -- clients/web/migrations)
  if [ -n "$changed" ]; then
    printf '%s\n' "$changed" | sed 's/^/        /' >&2
    die "$v is a patch release, and the migrations changed since $prev_tag (above). A patch release carries none: make this a minor release (RELEASING.md § Fjord Web versions)"
  fi
  ok "no migration changed since $prev_tag, as a patch release requires"
}

# Run in clients/web, so a gate's failure names the gate and not a directory.
c_in_web() {
  (cd clients/web && "$@")
}

c_gates() {
  gate "pnpm install --frozen-lockfile" c_in_web pnpm install --frozen-lockfile
  gate typecheck c_in_web pnpm typecheck
  gate tests c_in_web pnpm test
  gate build c_in_web pnpm build
}

c_verify() {
  local v=$1 tag first image page owner token index platforms
  tag=$(tag_of "$v")
  need gh
  need jq
  [ -n "$WORK" ] || WORK=$(mktemp -d)

  step "Verify the published release $tag"
  verify_release_page "$tag" "$v"

  # The notes on the page are the changelog's section, which the workflow copied;
  # its first line is enough to tell it from a generic or empty page.
  # Neither pipe is cut short (`head -1`, `grep -q`): the writer would die of SIGPIPE, and `pipefail`
  # would call that a failure of a long page.
  first=$(section_body "$v" | sed '/./,$!d' | sed -n 1p)
  [ -n "$first" ] || die "$C_CHANGELOG has no notes for $v"
  page=$(jq -r .body "$WORK/release.json")
  grep -qF -- "$first" <<<"$page" ||
    die "the release page does not carry the changelog notes for $v"
  ok "the release page carries the changelog notes"

  # The image is the release's real artifact. Asked of the registry directly, anonymously and with a time
  # limit (a `docker` call can wait on a credential helper for ever): a public package answers, and a
  # private one does not, which is a warning and not a failure, because the workflow itself pulled the
  # image by digest and brought it up before it published the page.
  owner=$(gh repo view --json owner --jq .owner.login | tr '[:upper:]' '[:lower:]')
  image="ghcr.io/$owner/fjord-web:$v"
  platforms=""
  if token=$(curl -fsS --max-time 20 "https://ghcr.io/token?scope=repository:$owner/fjord-web:pull" 2>/dev/null | jq -r '.token // empty') && [ -n "$token" ] &&
    index=$(curl -fsS --max-time 20 -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json" "https://ghcr.io/v2/$owner/fjord-web/manifests/$v" 2>/dev/null); then
    platforms=$(jq -r '[.manifests[]?.platform | select(.architecture != "unknown") | "\(.os)/\(.architecture)"] | sort | join(",")' <<<"$index")
  fi
  if [ "$platforms" = "linux/amd64,linux/arm64" ]; then
    ok "the image $image is published for linux/amd64 and linux/arm64"
  elif [ -n "$platforms" ]; then
    die "the image $image is published for $platforms, and must be for linux/amd64 and linux/arm64"
  else
    warn "could not look at $image: if the package is private, make it public (GitHub, Packages, fjord-web, Package settings); otherwise check the workflow run"
  fi
}
