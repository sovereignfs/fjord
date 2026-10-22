#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Cut a release of one component of this repository.
#
#   scripts/release.sh COMPONENT check   X.Y.Z               read-only preflight
#   scripts/release.sh COMPONENT prepare X.Y.Z [--skip-gates]
#                                                            branch, bump, plan, gate, commit
#   scripts/release.sh COMPONENT propose X.Y.Z [--dry-run]   push the branch, open a draft PR
#   scripts/release.sh COMPONENT tag     X.Y.Z [--dry-run]   after the PR merges: tag, watch, verify
#   scripts/release.sh COMPONENT verify  X.Y.Z               check a published release
#
# COMPONENT is a file in scripts/release/: `cli` and `web` today. A client or a
# plugin adds its own beside them (RELEASING.md says what one must provide).
#
# `main` takes changes only through pull requests, so a release is one too:
# `prepare`, read what it committed, `propose` (which opens a draft PR and
# stops), a person reviews and merges it, then `tag`. `prepare` never pushes
# and puts everything back, branch included, if anything fails. `tag` is the
# step the world can see: it waits for CI to be green on the merged commit, and
# only then creates the tag, which is what fires the release.
#
# Notes for a release come from the component's CHANGELOG.md. Write them under
# `## [Unreleased]` as you go; `prepare` turns that into the version's
# section (heading, date and compare links), because the release tooling reads
# the section at the tagged commit and fails *silently* without one.
#
# What is shared lives in scripts/lib/release.sh. Why each check exists is in
# RELEASING.md and ROADMAP.md.
#
# Needs: git, cargo, dist, jq. `publish` and `verify` also need gh (logged
# in), curl and tar. Written for bash 3.2, which is what macOS ships.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=scripts/lib/release.sh
source "$HERE/lib/release.sh"

usage() {
  cat >&2 <<'USAGE'
Usage:
  scripts/release.sh COMPONENT check   X.Y.Z                  read-only preflight
  scripts/release.sh COMPONENT prepare X.Y.Z [--skip-gates]   branch, bump, plan, gate, commit
  scripts/release.sh COMPONENT propose X.Y.Z [--dry-run]      push the branch, open a draft PR
  scripts/release.sh COMPONENT tag     X.Y.Z [--dry-run]      after the PR merges: tag, watch, verify
  scripts/release.sh COMPONENT verify  X.Y.Z                  check a published release

Components: cli, web

The usual run is prepare, propose, a review and a merge, then tag. The header
of this file says what each one does and why.
USAGE
  exit 2
}

# Load a component's definition. Names are checked against what is on disk,
# so `../x` or a typo cannot source something unintended.
load_component() {
  local name=$1 file
  file="$HERE/release/$name.sh"
  case $name in
    '' | *[!a-z0-9-]*) die "'$name' is not a component name" ;;
  esac
  [ -f "$file" ] || die "there is no component '$name' (no $file)"
  # shellcheck disable=SC1090
  source "$file"
}

main() {
  [ $# -ge 3 ] || usage
  local component=$1 command=$2 version=$3 dry_run=no skip_gates=no
  shift 3
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run) dry_run=yes ;;
      --skip-gates) skip_gates=yes ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done

  load_component "$component"

  case $command in
    check) cmd_check "$version" ;;
    prepare) cmd_prepare "$version" "$skip_gates" ;;
    propose) cmd_propose "$version" "$dry_run" ;;
    tag) cmd_tag "$version" "$dry_run" ;;
    publish) cmd_publish "$version" ;;
    verify)
      valid_version "$version" || die "'$version' is not a version of the form X.Y.Z"
      c_verify "$version"
      ;;
    *) usage ;;
  esac
}

# Run only when executed, so the tests can source the library and a component
# and call single functions without `main` firing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
