#!/usr/bin/env sh
# Rebuild the pinned FM-1 emulator core into src/renderer/public/fm1/fm1_web.wasm.
# Needs git, rustc 1.100.1 with the wasm32-unknown-unknown target (rustup target add ...).
# The sha256 must stay equal to FM1_WASM_SHA256 in src/renderer/js/fm1/wasm-pin.js
# (tests/fm1-wasm-pin.test.js checks it); a different toolchain gives different bytes.
#   scripts/build-fm1-wasm.sh [work-dir]
set -eu

COMMIT=69cb1ef46d86a2776112cc9279773ded3ffa293b
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/fm1-emu}"

if [ ! -d "$WORK/.git" ]; then
  git clone https://github.com/joakimeriksson/fm1-emu "$WORK"
fi
cd "$WORK"
git fetch origin
git checkout --detach "$COMMIT"

# same flags as fm1-emu web/build.sh: one codegen unit, inline threshold 2000, and the function
# table exported and growable (the JIT installs compiled blocks in it)
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export RUSTFLAGS="-Cllvm-args=-inline-threshold=2000 -Clink-arg=--export-table -Clink-arg=--growable-table"
cargo build --release -p fm1-web --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/fm1_web.wasm "$ROOT/src/renderer/public/fm1/fm1_web.wasm"
sha256sum "$ROOT/src/renderer/public/fm1/fm1_web.wasm"
echo "expected 77bd2e2acb83d2a32bc92f7e44627db8b554d9abc340914bbed4941b77fd7f59"
