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
#   web      Fjord Web (clients/web) can be affected: its own files, and what it builds into itself
#            (the format as WebAssembly, and the fixtures its tests read)
#   editor   the editors' package (packages/fjord-editor) can be affected. It depends on nothing of the repository's,
#            so only its own files start its jobs
#
# A change to documentation alone sets none, so the expensive jobs do not
# run for it. The rules err towards running: a path under crates/ is Rust unless
# it is one of the documents named below, and the Markdown that is *not* a
# document in that sense (the init templates that are compiled into the binary,
# the conformance fixtures) stays Rust.
#
# The Rust workflow (ci.yml), Fjord Web's (web-ci.yml) and the editors' (editor-ci.yml) all run
# this and each reads the outputs it cares about, so a change to one component never starts the
# others' jobs.
#
# Not here on purpose: deny.toml and the dependency files' audit belong to the
# Audit workflow, and dist-workspace.toml to the generated release workflow's
# own `plan` job.
#
# Written for bash 3.2.

set -euo pipefail

rust=false
scripts=false
web=false
editor=false

# A crate's own README and CHANGELOG: documents nothing compiles and no test
# reads. A regex and not a glob, because in a `case` pattern `*` matches `/`, and
# `crates/*/README.md` would swallow crates/fjord-core/templates/README.md,
# which is compiled into the binary.
crate_document='^crates/[^/]+/(README|CHANGELOG)\.md$'

# Fjord Web's own documents, likewise: nothing builds or tests from them. Anything
# else under clients/web (a Markdown file a page renders, say) counts as code.
web_document='^clients/web/(README|CHANGELOG|CLAUDE|DESIGN|ROADMAP)\.md$|^clients/web/LICENSE$'

# The editors' package's own documents, likewise.
editor_document='^packages/fjord-editor/(README|CHANGELOG|CLAUDE)\.md$|^packages/fjord-editor/LICENSE$'

while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [[ $path =~ $crate_document || $path =~ $web_document || $path =~ $editor_document ]]; then
    continue
  fi
  case "$path" in
    # Changing the classifier changes what runs, so run everything.
    scripts/ci-changes.sh | scripts/test-ci-changes.sh)
      rust=true
      scripts=true
      web=true
      editor=true
      ;;
    crates/* | schema/* | tests/* | .cargo/* | Cargo.toml | Cargo.lock | rust-toolchain | rust-toolchain.toml | .github/workflows/ci.yml | .github/actions/build-wasm/*)
      rust=true
      ;;
    scripts/*) scripts=true ;;
    clients/web/* | .github/workflows/web-ci.yml) web=true ;;
    packages/fjord-editor/* | .github/workflows/editor-ci.yml) editor=true ;;
  esac

  # Fjord Web runs the format as WebAssembly built from `fjord-core` (`crates/fjord-wasm`) and its tests read the
  # conformance fixtures, so a change to any of them is a change to what the web client runs, whatever else it
  # is. (The CLI alone, under crates/fjord-cli, is not.)
  case "$path" in
    crates/fjord-core/* | crates/fjord-wasm/* | tests/fixtures/* | Cargo.toml | Cargo.lock | .github/actions/build-wasm/*) web=true ;;
  esac
done

printf 'rust=%s\n' "$rust"
printf 'scripts=%s\n' "$scripts"
printf 'web=%s\n' "$web"
printf 'editor=%s\n' "$editor"
