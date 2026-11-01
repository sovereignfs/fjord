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
  c_check_patch_policy "$v"
}

# RELEASING.md § Fjord Web versions: a patch release (X.Y.Z to X.Y.Z+1) carries no
# migration, so going from one patch to the next never changes the database, and
# a bad patch can be rolled back without restoring a backup. Only checked when the
# previous release is there to compare with.
c_check_patch_policy() {
  local v=$1 minor patch prev_tag changed best=-1 candidate n
  minor=${v%.*}
  patch=${v##*.}
  [ "$patch" -gt 0 ] || return 0
  # The newest release of this minor before $v. This runs after the version was bumped, so
  # the current version cannot be used: the tags say what was released.
  for candidate in $(git tag --list "${C_TAG_PREFIX}${minor}.*"); do
    n=${candidate##*.}
    case $n in '' | *[!0-9]*) continue ;; esac
    if [ "$n" -lt "$patch" ] && [ "$n" -gt "$best" ]; then best=$n; fi
  done
  [ "$best" -ge 0 ] || return 0
  prev_tag="${C_TAG_PREFIX}${minor}.${best}"
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
  local v=$1 tag first image
  tag=$(tag_of "$v")
  need gh
  need jq
  [ -n "$WORK" ] || WORK=$(mktemp -d)

  step "Verify the published release $tag"
  verify_release_page "$tag" "$v"

  # The notes on the page are the changelog's section, which the workflow copied;
  # its first line is enough to tell it from a generic or empty page.
  first=$(section_body "$v" | sed '/./,$!d' | head -1)
  [ -n "$first" ] || die "$C_CHANGELOG has no notes for $v"
  jq -r .body "$WORK/release.json" | grep -qF -- "$first" ||
    die "the release page does not carry the changelog notes for $v"
  ok "the release page carries the changelog notes"

  # The image is the release's real artifact. It is a warning where it cannot be
  # looked at (no docker, or a package that is private and a login that cannot read it):
  # the workflow already pulled it and brought it up before publishing the page.
  image="ghcr.io/$(gh repo view --json owner --jq .owner.login | tr '[:upper:]' '[:lower:]')/fjord-web:$v"
  if command -v docker >/dev/null 2>&1 && docker buildx imagetools inspect "$image" >"$WORK/image.txt" 2>&1; then
    for platform in linux/amd64 linux/arm64; do
      grep -qF "$platform" "$WORK/image.txt" || die "the image $image has no $platform"
    done
    ok "the image $image is published for linux/amd64 and linux/arm64"
  else
    warn "could not look at $image: if it is private, make the package public (GitHub, Packages, fjord-web, Package settings); otherwise check the workflow run"
  fi
}
