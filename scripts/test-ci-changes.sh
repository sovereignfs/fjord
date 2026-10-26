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

NONE="rust=false scripts=false web=false"
RUST="rust=true scripts=false web=false"
RUST_WEB="rust=true scripts=false web=true"
SCRIPTS="rust=false scripts=true web=false"
WEB="rust=false scripts=false web=true"
BOTH="rust=true scripts=true web=false"
ALL="rust=true scripts=true web=true"

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
expect "Fjord Web's documents" "$NONE" clients/web/README.md clients/web/CHANGELOG.md clients/web/CLAUDE.md clients/web/DESIGN.md clients/web/ROADMAP.md clients/web/LICENSE
expect "the other clients' plans, which have no code yet" "$NONE" clients/mobile/DESIGN.md clients/mobile/ROADMAP.md clients/mcp/DESIGN.md clients/mcp/ROADMAP.md

printf '\nchanges that need the Rust jobs\n'
expect "a source file" "$RUST" crates/fjord-cli/src/cmd/sync.rs
expect "the core library, which the web client builds into itself as WebAssembly" "$RUST_WEB" crates/fjord-core/src/path.rs
expect "the WebAssembly crate" "$RUST_WEB" crates/fjord-wasm/src/api.rs crates/fjord-wasm/build.sh
expect "the CLI alone does not touch the web client" "$RUST" crates/fjord-cli/src/cmd/ls.rs
expect "the shared action that builds the module" "$RUST_WEB" .github/actions/build-wasm/action.yml
expect "a test" "$RUST" crates/fjord-cli/tests/guard.rs
# These are Markdown, and the build or the tests read them.
expect "an init template, which is compiled into the binary" "$RUST_WEB" crates/fjord-core/templates/README.md
expect "a Markdown template" "$RUST_WEB" crates/fjord-core/templates/welcome.md
expect "a conformance fixture, which is a .md Doc, and which the web tests read" "$RUST_WEB" tests/fixtures/conforming/Public/welcome.md
expect "the verify schema" "$RUST" schema/verify.schema.json
expect "Cargo.toml, which the format module is built from" "$RUST_WEB" Cargo.toml
expect "Cargo.lock, which the format module is built from" "$RUST_WEB" Cargo.lock
expect "a crate's Cargo.toml" "$RUST" crates/fjord-cli/Cargo.toml
expect "the CI workflow itself" "$RUST" .github/workflows/ci.yml
expect "a document and a source file together" "$RUST" ROADMAP.md crates/fjord-cli/src/main.rs

printf '\nchanges that need only the Fjord Web jobs\n'
expect "a page" "$WEB" clients/web/app/page.tsx
expect "a source file" "$WEB" clients/web/src/site.ts
expect "the lockfile" "$WEB" clients/web/pnpm-lock.yaml
expect "package.json" "$WEB" clients/web/package.json
expect "the app's configuration" "$WEB" clients/web/next.config.ts clients/web/tsconfig.json
# A document in the sense of this classifier is only a named one.
expect "a Markdown file that is not one of its documents" "$WEB" clients/web/content/terms.md
expect "its own workflow" "$WEB" .github/workflows/web-ci.yml
expect "a document and a source file together" "$WEB" clients/web/README.md clients/web/src/site.ts
expect "a Rust change leaves the web jobs alone, when it is the CLI's" "$RUST" crates/fjord-cli/src/cmd/sync.rs
expect "a web change leaves the Rust jobs alone" "$WEB" clients/web/app/layout.tsx

printf '\nchanges that need only the script checks\n'
expect "a release script" "$SCRIPTS" scripts/release.sh
expect "the release library" "$SCRIPTS" scripts/lib/release.sh
expect "a component's release file" "$SCRIPTS" scripts/release/cli.sh scripts/release/web.sh
expect "the release tests" "$SCRIPTS" scripts/test-release.sh

printf '\nthe classifier itself\n'
expect "changing the classifier runs everything" "$ALL" scripts/ci-changes.sh
expect "changing its tests runs everything" "$ALL" scripts/test-ci-changes.sh

printf '\nboth kinds at once\n'
expect "a source file and a script" "$BOTH" crates/fjord-cli/src/main.rs scripts/release.sh
expect "a page and a source file" "$ALL" clients/web/app/page.tsx crates/fjord-core/src/lib.rs scripts/release.sh

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
