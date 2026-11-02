#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build the site each engine's scaffold makes with that engine's own tools (ROADMAP web 3c.1, Research 0001): `fjord init --kind ssg`,
# then `astro build` and `jekyll build`, and check that the built site holds the posts and neither of Fjord's manifests.
#
#   scripts/check-site-scaffolds.sh [path/to/fjord] [astro|jekyll]
#
# Needs Node (npm) for Astro and Ruby 3 with Bundler for Jekyll. Without an engine's tools that engine is skipped, and said so; a
# check that built nothing exits 1. Written for bash 3.2.

set -euo pipefail
cd "$(dirname "$0")/.."

fjord=${1:-target/debug/fjord}
only=${2:-}
[ -x "$fjord" ] || { echo "$fjord is not there: cargo build -p fjord-cli" >&2; exit 2; }
fjord=$(cd "$(dirname "$fjord")" && pwd)/$(basename "$fjord")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
built=0
failed=0

fail() { echo "FAIL: $*" >&2; failed=1; }

# The built site must hold the welcome post, and nothing of Fjord's.
check_output() {
  local engine=$1 dir=$2 post=$3
  [ -f "$dir/$post" ] || fail "$engine: the post is not at $post"
  if grep -rIl --exclude-dir=node_modules 'fjord' "$dir" >/dev/null 2>&1; then
    echo "$engine: a file of the built site mentions fjord:" >&2
    grep -rIl 'fjord' "$dir" >&2
    failed=1
  fi
  for manifest in fjord.json fjord.vault.json; do
    if find "$dir" -name "$manifest" | grep -q .; then fail "$engine: $manifest is in the built site"; fi
  done
}

astro() {
  command -v npm >/dev/null || { echo "astro: skipped, npm is not installed"; return; }
  local site=$work/astro
  "$fjord" --no-input init "$site" --kind ssg --engine astro --no-git >/dev/null
  # Posts as Fjord writes them (`fjord new`): an id Astro does not know, a date with the writer's offset, and a draft that must not be built.
  "$fjord" -C "$site" --no-input new --no-edit --title "Offset date" --date 2026-11-02T00:30:00+05:30 >/dev/null
  "$fjord" -C "$site" --no-input new --no-edit --title "A draft" --draft >/dev/null
  [ -f "$site/content/posts/offset-date.md" ] || fail "astro: fjord new did not put the post at content/posts/offset-date.md"
  (cd "$site" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null) || { fail "astro: the build failed"; return; }
  check_output astro "$site/dist" posts/welcome/index.html
  [ -f "$site/dist/posts/offset-date/index.html" ] || fail "astro: the offset post was not built"
  [ ! -e "$site/dist/posts/a-draft/index.html" ] || fail "astro: the draft was built"
  "$fjord" -C "$site" verify --strict >/dev/null || fail "astro: the scaffold does not pass fjord verify --strict"
  built=$((built + 1))
  echo "astro: built, $(cd "$site" && node -e 'console.log(require("./node_modules/astro/package.json").version)')"
}

jekyll() {
  command -v bundle >/dev/null || { echo "jekyll: skipped, bundler is not installed"; return; }
  ruby -e 'exit(RUBY_VERSION >= "3.0" ? 0 : 1)' || { echo "jekyll: skipped, Ruby $(ruby -e 'print RUBY_VERSION') is older than 3.0"; return; }
  local site=$work/jekyll
  "$fjord" --no-input init "$site" --kind ssg --engine jekyll --no-git >/dev/null
  "$fjord" -C "$site" --no-input new --no-edit --title "Offset date" --date 2026-11-02T00:30:00+05:30 >/dev/null
  "$fjord" -C "$site" --no-input new --no-edit --title "A draft" --draft >/dev/null
  # A Jekyll post's name is a rule: the writer's day, then the slug.
  [ -f "$site/content/_posts/2026-11-02-offset-date.md" ] || fail "jekyll: fjord new did not name the post by its date"
  [ -f "$site/content/_drafts/a-draft.md" ] || fail "jekyll: fjord new did not put the draft in _drafts"
  (cd "$site" && bundle config set --local path vendor/bundle >/dev/null && bundle install >/dev/null 2>&1 && bundle exec jekyll build >/dev/null) || { fail "jekyll: the build failed"; return; }
  # The post's address uses the build machine's day, so find it by name, not by date.
  local welcome
  welcome=$(cd "$site/_site" && find . -name 'welcome.html' | head -1)
  [ -n "$welcome" ] || { fail "jekyll: the welcome post was not built"; return; }
  check_output jekyll "$site/_site" "${welcome#./}"
  grep -q '<html' "$site/_site/$welcome" || fail "jekyll: a post has no layout"
  [ -n "$(find "$site/_site" -name 'offset-date.html')" ] || fail "jekyll: the offset post was not built"
  [ -z "$(find "$site/_site" -name 'a-draft.html')" ] || fail "jekyll: the draft was built"
  "$fjord" -C "$site" verify --strict >/dev/null || fail "jekyll: the scaffold does not pass fjord verify --strict"
  built=$((built + 1))
  echo "jekyll: built, $(cd "$site" && bundle exec jekyll --version)"
}

case "$only" in
  astro) astro ;;
  jekyll) jekyll ;;
  "") astro; jekyll ;;
  *) echo "unknown engine: $only" >&2; exit 2 ;;
esac

[ "$built" -gt 0 ] || { echo "nothing was built" >&2; exit 1; }
exit "$failed"
