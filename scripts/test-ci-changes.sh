#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Tests for scripts/ci-changes.sh. Fast and dependency-free, so CI runs them.
#
# The cases that matter are the ones where a wrong answer is costly in one
# direction or the other: a document must not start the Rust matrix, and
# Markdown that the build or the tests read must.

set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PASSED=0
FAILED=0

# expect "name" "rust=… scripts=…" path...
expect() {
  local name=$1 want=$2 got
  shift 2
  got=$(printf '%s\n' "$@" | "$HERE/ci-changes.sh" | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" = "$want" ]; then
    PASSED=$((PASSED + 1))
    printf '  pass  %s\n' "$name"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL  %s\n          wanted: %s\n          got:    %s\n' "$name" "$want" "$got"
  fi
}

NONE="rust=false scripts=false"
RUST="rust=true scripts=false"
SCRIPTS="rust=false scripts=true"
BOTH="rust=true scripts=true"

printf '\nchanges that need nothing\n'
expect "no changes at all" "$NONE"
expect "the CLI's changelog" "$NONE" crates/fjord-cli/CHANGELOG.md
expect "the CLI's README" "$NONE" crates/fjord-cli/README.md
expect "the root README and the roadmap" "$NONE" README.md ROADMAP.md CLAUDE.md RELEASING.md CONTRIBUTING.md
expect "the specification alone" "$NONE" spec/SPEC.md spec/LICENSE
expect "the PR template and other .github files" "$NONE" .github/PULL_REQUEST_TEMPLATE.md .github/dependabot.yml .github/workflows/audit.yml
expect "the licence" "$NONE" LICENSE
expect "deny.toml, which the Audit workflow owns" "$NONE" deny.toml
expect "dist's config, which its own plan job checks" "$NONE" dist-workspace.toml
expect "several documents together" "$NONE" ROADMAP.md crates/fjord-cli/CHANGELOG.md spec/SPEC.md

printf '\nchanges that need the Rust jobs\n'
expect "a source file" "$RUST" crates/fjord-cli/src/cmd/sync.rs
expect "the core library" "$RUST" crates/fjord-core/src/path.rs
expect "a test" "$RUST" crates/fjord-cli/tests/guard.rs
# These are Markdown, and the build or the tests read them.
expect "an init template, which is compiled into the binary" "$RUST" crates/fjord-core/templates/README.md
expect "a Markdown template" "$RUST" crates/fjord-core/templates/welcome.md
expect "a conformance fixture, which is a .md Doc" "$RUST" tests/fixtures/conforming/Public/welcome.md
expect "the verify schema" "$RUST" schema/verify.schema.json
expect "Cargo.toml" "$RUST" Cargo.toml
expect "Cargo.lock" "$RUST" Cargo.lock
expect "a crate's Cargo.toml" "$RUST" crates/fjord-cli/Cargo.toml
expect "the CI workflow itself" "$RUST" .github/workflows/ci.yml
expect "a document and a source file together" "$RUST" ROADMAP.md crates/fjord-cli/src/main.rs

printf '\nchanges that need only the script checks\n'
expect "a release script" "$SCRIPTS" scripts/release.sh
expect "the release library" "$SCRIPTS" scripts/lib/release.sh
expect "a component's release file" "$SCRIPTS" scripts/release/cli.sh
expect "the release tests" "$SCRIPTS" scripts/test-release.sh

printf '\nthe classifier itself\n'
expect "changing the classifier runs everything" "$BOTH" scripts/ci-changes.sh
expect "changing its tests runs everything" "$BOTH" scripts/test-ci-changes.sh

printf '\nboth kinds at once\n'
expect "a source file and a script" "$BOTH" crates/fjord-core/src/lib.rs scripts/release.sh

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
