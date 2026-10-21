#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Decide which CI jobs a change needs.
#
#   git diff --name-only BASE HEAD | scripts/ci-changes.sh
#
# Reads changed paths on stdin and prints `name=true|false` lines, ready to be
# appended to $GITHUB_OUTPUT:
#
#   rust     the Rust build, tests and checks can be affected
#   scripts  the shell scripts can be affected (shellcheck)
#
# A change to documentation alone sets neither, so the expensive jobs do not
# run for it. The rules err towards running: a path under crates/ is Rust unless
# it is one of the documents named below, and the Markdown that is *not* a
# document in that sense (the init templates that are compiled into the binary,
# the conformance fixtures) stays Rust.
#
# Not here on purpose: deny.toml and the dependency files' audit belong to the
# Audit workflow, and dist-workspace.toml to the generated release workflow's
# own `plan` job.
#
# Written for bash 3.2.

set -euo pipefail

rust=false
scripts=false

# A crate's own README and CHANGELOG: documents nothing compiles and no test
# reads. A regex and not a glob, because in a `case` pattern `*` matches `/`, and
# `crates/*/README.md` would swallow crates/fjord-core/templates/README.md,
# which is compiled into the binary.
crate_document='^crates/[^/]+/(README|CHANGELOG)\.md$'

while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [[ $path =~ $crate_document ]]; then
    continue
  fi
  case "$path" in
    # Changing the classifier changes what runs, so run everything.
    scripts/ci-changes.sh | scripts/test-ci-changes.sh)
      rust=true
      scripts=true
      ;;
    crates/* | schema/* | tests/* | .cargo/* | Cargo.toml | Cargo.lock | rust-toolchain | rust-toolchain.toml | .github/workflows/ci.yml)
      rust=true
      ;;
    scripts/*) scripts=true ;;
  esac
done

printf 'rust=%s\n' "$rust"
printf 'scripts=%s\n' "$scripts"
