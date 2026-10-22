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
# Today a release carries the notes and nothing else. The container image that
# is Fjord Web's real artifact joins it with ROADMAP 1a.12.

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
  local v=$1 tag first
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
}
