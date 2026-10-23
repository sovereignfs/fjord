#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build fjord-wasm: the module, and the JavaScript that loads it, for Node and for a browser.
#
#   ./build.sh            -> pkg/node/   (CommonJS, for Node: what the tests load)
#                            pkg/web/    (an ES module, for a browser or a bundler)
#
# Needs the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`) and the
# `wasm-bindgen` command line tool at the version this crate's Cargo.lock names
# (`cargo install wasm-bindgen-cli --version '=<that version>' --locked`).
#
# Written for bash 3.2.

set -euo pipefail
cd "$(dirname "$0")"

want=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"$/\1/p')
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [ -z "$have" ]; then
  echo "wasm-bindgen is not installed: cargo install wasm-bindgen-cli --version '=$want' --locked" >&2
  exit 1
fi
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen $have is installed but Cargo.lock has $want: cargo install wasm-bindgen-cli --version '=$want' --locked" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown

module=target/wasm32-unknown-unknown/release/fjord_wasm.wasm
rm -rf pkg
wasm-bindgen --target nodejs --out-dir pkg/node "$module"
wasm-bindgen --target web --out-dir pkg/web "$module"

# What a page would download. (`wasm-opt` would shave a little more; it is not required.)
raw=$(wc -c <pkg/web/fjord_wasm_bg.wasm | tr -d ' ')
gzipped=$(gzip -9 -c pkg/web/fjord_wasm_bg.wasm | wc -c | tr -d ' ')
echo "fjord_wasm_bg.wasm: $raw bytes, $gzipped gzipped"
