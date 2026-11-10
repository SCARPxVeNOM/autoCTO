#!/usr/bin/env bash
# Builds every artifact into res/: the three contracts and the brain.
# The launchpad embeds res/autocto_coin.wasm, so the coin is built first.
set -euo pipefail
cd "$(dirname "$0")/.."

build_contract() {
  (cd "contracts/$1" && cargo near build non-reproducible-wasm --no-abi >/dev/null)
  cp "target/near/$2/$2.wasm" res/
}

build_contract coin autocto_coin
build_contract launchpad autocto_launchpad
build_contract mock-outlayer mock_outlayer

cargo build -q -p autocto-brain --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/autocto-brain.wasm res/

echo "sha256 of every artifact:"
shasum -a 256 res/*.wasm
