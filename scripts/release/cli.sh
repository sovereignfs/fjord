# shellcheck shell=bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# The CLI: package `fjord-cli`, binary `fjord`. Built and published by `dist`
# when a `fjord-cli-vX.Y.Z` tag is pushed. Sourced by scripts/release.sh.
#
# `fjord-core` is released with it: the two crates share one workspace
# version, and the CLI is the only thing that ships.

# The C_* variables are read by scripts/lib/release.sh, which shellcheck cannot
# see from here.
# shellcheck disable=SC2034
C_NAME=cli
C_PACKAGE=fjord-cli
C_TAG_PREFIX=fjord-cli-v
# Releases up to 0.2.0 were tagged before there was more than one component.
C_LEGACY_TAG_PREFIX=v
C_CHANGELOG=crates/fjord-cli/CHANGELOG.md
C_TOUCHED="crates/fjord-cli/CHANGELOG.md Cargo.toml Cargo.lock crates/fjord-cli/Cargo.toml"
C_RELEASE_WORKFLOW=fjord-cli-release.yml
# The README and the installers say `releases/latest`, and mean this.
C_LATEST=yes
C_REQUIRED_WORKFLOWS="CI"
C_OPTIONAL_WORKFLOWS="Audit"

c_current_version() {
  awk '/^\[workspace\.package\]/ { f = 1; next } /^\[/ { f = 0 }
       f && /^version = / { gsub(/"/, "", $3); print $3; exit }' Cargo.toml
}

c_core_dependency_version() {
  sed -nE 's/^fjord-core = .*version = "([^"]+)".*/\1/p' crates/fjord-cli/Cargo.toml
}

c_check_versions() {
  local cur core
  cur=$(c_current_version)
  core=$(c_core_dependency_version)
  [ -n "$cur" ] || die "could not read the workspace version from Cargo.toml"
  [ "$cur" = "$core" ] ||
    die "Cargo.toml says $cur but the fjord-core dependency in crates/fjord-cli/Cargo.toml says $core; fix that first"
  ok "both version declarations agree on $cur"
}

c_bump() {
  local cur=$1 v=$2
  [ "$(grep -c "^version = \"$cur\"\$" Cargo.toml)" = 1 ] ||
    die "expected exactly one 'version = \"$cur\"' line in Cargo.toml"
  sed "s/^version = \"$cur\"\$/version = \"$v\"/" Cargo.toml >"$WORK/cargo.new"
  cat "$WORK/cargo.new" >Cargo.toml

  [ "$(grep -c "path = \"../fjord-core\", version = \"$cur\"" crates/fjord-cli/Cargo.toml)" = 1 ] ||
    die "expected exactly one fjord-core dependency at version $cur in crates/fjord-cli/Cargo.toml"
  sed "s|path = \"../fjord-core\", version = \"$cur\"|path = \"../fjord-core\", version = \"$v\"|" \
    crates/fjord-cli/Cargo.toml >"$WORK/fjord.new"
  cat "$WORK/fjord.new" >crates/fjord-cli/Cargo.toml
  ok "both declarations now say $v"

  cargo build --workspace --quiet
  ok "built, so Cargo.lock followed"
}

c_check_plan() {
  local v=$1 tag out
  tag=$(tag_of "$v")
  out=$(dist plan --tag="$tag" 2>&1) ||
    die "dist plan --tag=$tag failed:"$'\n'"$out"
  grep -q "announcing v$v" <<<"$out" ||
    die "dist plan did not announce v$v — is the crate version $v?:"$'\n'"$out"
  ok "dist plan announces $tag"

  dist plan --tag="$tag" --output-format=json 2>/dev/null |
    jq -e '.announcement_changelog' >/dev/null ||
    die "dist found no release notes for $tag in $C_CHANGELOG"
  ok "dist found the release notes"
}

# The Homebrew tap this release publishes to, if it does: "owner/repo", from
# dist's config. Empty when the release publishes no formula.
c_tap() {
  if grep -qE '^publish-jobs *=.*"homebrew"' dist-workspace.toml; then
    sed -nE 's/^tap *= *"([^"]+)".*/\1/p' dist-workspace.toml
  fi
}

# The formula's name: dist's `formula` override, else the package name.
c_formula() {
  local name
  name=$(sed -nE 's/^formula *= *"([^"]+)".*/\1/p' crates/fjord-cli/Cargo.toml | head -1)
  echo "${name:-fjord-cli}"
}

# What the steps that talk to GitHub must have in place before anything is
# published. A release that publishes a Homebrew formula pushes it with the
# repository secret HOMEBREW_TAP_TOKEN; without it the release is published and
# the tap is not, which is a failure that is found only afterwards, so look first.
c_check_publish() {
  local tap
  tap=$(c_tap)
  [ -n "$tap" ] || return 0
  gh repo view "$tap" >/dev/null 2>&1 ||
    die "the Homebrew tap $tap does not exist (RELEASING.md § Homebrew)"
  ok "the Homebrew tap $tap exists"
  gh secret list --repo "$GH_REPO" 2>/dev/null | awk '{ print $1 }' | grep -qx HOMEBREW_TAP_TOKEN ||
    die "this release publishes a Homebrew formula, but the repository secret HOMEBREW_TAP_TOKEN is not set. Without it the release would publish and the tap would not. Set it: gh secret set HOMEBREW_TAP_TOKEN --repo $GH_REPO (RELEASING.md § Homebrew)"
  ok "HOMEBREW_TAP_TOKEN is set"
}

# Check what the tap now holds. Only required when the release itself carries
# the formula (it is a release asset when dist publishes one), so verifying an
# older release, from before the tap, is not a failure.
c_verify_formula() {
  local v=$1 manifest=$2 tap formula raw body shas
  tap=$(c_tap)
  formula=$(c_formula)
  if ! jq -e --arg f "$formula.rb" '.artifacts | has($f)' "$manifest" >/dev/null 2>&1; then
    say "this release carries no Homebrew formula, so the tap was not checked"
    return 0
  fi
  # Not piped into base64: a pipeline's status is its last command's, and a
  # missing file would go unnoticed here and be misreported below.
  raw=$(gh api "repos/$tap/contents/Formula/$formula.rb" --jq .content 2>/dev/null) ||
    die "the release carries $formula.rb but $tap has no Formula/$formula.rb. The publish job did not run or failed: gh run list --workflow $C_RELEASE_WORKFLOW"
  body=$(base64 -d <<<"$raw")
  grep -q "^  version \"$v\"" <<<"$body" ||
    die "$tap has a Formula/$formula.rb that is not version $v. The publish job did not update it"
  ok "$tap has Formula/$formula.rb at $v"
  # One checksum per platform archive. A formula without them installs
  # unverified, which `dist` does when it did not know the checksums.
  shas=$(grep -c '^ *sha256 "' <<<"$body" || true)
  [ "$shas" -ge 4 ] ||
    die "Formula/$formula.rb has $shas sha256 lines, not one per platform (4). It would install unverified"
  ok "the formula carries a sha256 for each of its $shas archives"
  say "install it with: brew install ${tap/homebrew-/}/$formula"
}

c_gates() {
  gate rustfmt cargo fmt --check
  gate clippy cargo clippy --workspace --all-targets --locked -- -D warnings
  gate tests cargo test --workspace --locked
  if cargo deny --version >/dev/null 2>&1; then
    gate "cargo deny" cargo deny check
  else
    warn "cargo-deny is not installed, so it was not run here; the Audit workflow will run it"
  fi
}

# What a platform's archive is called, or nothing if this machine is not one
# we publish for.
c_host_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    Linux-x86_64) echo x86_64-unknown-linux-musl ;;
    Linux-aarch64 | Linux-arm64) echo aarch64-unknown-linux-musl ;;
    *) echo "" ;;
  esac
}

c_sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

c_verify() {
  local v=$1 tag base json missing target archive want got
  tag=$(tag_of "$v")
  need gh
  need curl
  need jq
  need tar
  [ -n "$WORK" ] || WORK=$(mktemp -d)
  base="https://github.com/$GH_REPO/releases/download/$tag"

  step "Verify the published release $tag"

  verify_release_page "$tag" "$v"

  # The expected assets come from the release's own manifest, plus the
  # manifest itself, which it does not list: no number to keep in sync.
  json="$WORK/dist-manifest.json"
  curl -fsSL "$base/dist-manifest.json" -o "$json" ||
    die "could not download dist-manifest.json from the release"
  {
    jq -r '.artifacts | keys[]' "$json"
    echo dist-manifest.json
  } | sort >"$WORK/expected"
  jq -r '.assets[].name' "$WORK/release.json" | sort >"$WORK/actual"
  missing=$(comm -23 "$WORK/expected" "$WORK/actual")
  [ -z "$missing" ] || die "assets missing from the release: $(echo "$missing" | tr '\n' ' ')"
  ok "all $(wc -l <"$WORK/expected" | tr -d ' ') expected assets are present"

  jq -r .body "$WORK/release.json" | grep -q '^## Release Notes' ||
    die "the release page has generic notes: dist found no section for $v in $C_CHANGELOG"
  ok "the release page carries the changelog notes"

  c_verify_formula "$v" "$json"

  target=$(c_host_target)
  if [ -z "$target" ]; then
    warn "no published binary for $(uname -sm); skipped the download and run checks"
    return 0
  fi

  archive="fjord-cli-$target.tar.xz"
  curl -fsSL "$base/$archive" -o "$WORK/$archive" || die "could not download $archive"
  curl -fsSL "$base/$archive.sha256" -o "$WORK/$archive.sha256" ||
    die "could not download $archive.sha256"
  want=$(cut -d' ' -f1 "$WORK/$archive.sha256")
  got=$(c_sha256_of "$WORK/$archive")
  [ "$want" = "$got" ] || die "checksum mismatch for $archive: published $want, downloaded $got"
  ok "$archive matches its published checksum"

  # The real installer, in its mode meant for CI, with HOME pointed at
  # scratch: it installs where it is told and edits no shell profile.
  curl -fsSL "$base/fjord-cli-installer.sh" -o "$WORK/installer.sh" ||
    die "could not download the installer"
  mkdir -p "$WORK/home" "$WORK/bin"
  HOME="$WORK/home" FJORD_CLI_UNMANAGED_INSTALL="$WORK/bin" sh "$WORK/installer.sh" >"$WORK/installer.log" 2>&1 ||
    die "the installer failed:"$'\n'"$(cat "$WORK/installer.log")"
  got=$("$WORK/bin/fjord" --version)
  [ "$got" = "fjord $v" ] || die "the installed binary reports '$got', not 'fjord $v'"
  ok "the installer works, and the binary reports '$got'"

  # And the binary does what it should: it records the version that ran.
  (
    export GIT_AUTHOR_NAME=release GIT_AUTHOR_EMAIL=release@example.invalid
    export GIT_COMMITTER_NAME=release GIT_COMMITTER_EMAIL=release@example.invalid
    "$WORK/bin/fjord" init "$WORK/repo" >/dev/null
  )
  got=$(jq -r .generator "$WORK/repo/fjord.json")
  [ "$got" = "fjord $v" ] || die "init recorded generator '$got', not 'fjord $v'"
  ok "init records \"generator\": \"fjord $v\""

  printf '\nhttps://github.com/%s/releases/tag/%s\n' "$GH_REPO" "$tag"
}
