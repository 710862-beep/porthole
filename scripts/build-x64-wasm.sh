#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.81.0}"
for tool in cargo wasm-bindgen; do
  command -v "$tool" >/dev/null || { echo "BUILD_BLOCKED: missing tool $tool" >&2; exit 1; }
done
wasm_bindgen_version="$(wasm-bindgen --version)"
if [[ "$wasm_bindgen_version" != "wasm-bindgen 0.2.92" ]]; then
  echo "BUILD_BLOCKED: expected wasm-bindgen 0.2.92, found $wasm_bindgen_version" >&2
  exit 1
fi

out="$PWD/artifacts/porthole-x64-wasm"
rm -rf "$out"
mkdir -p "$out"
cargo build --manifest-path rust/porthole-x64-wasm/Cargo.toml --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir "$out" \
  rust/porthole-x64-wasm/target/wasm32-unknown-unknown/release/porthole_x64_wasm.wasm
sha256sum "$out"/porthole_x64_wasm.js "$out"/porthole_x64_wasm_bg.wasm > "$out/SHA256SUMS"
echo "BUILD_COMPLETE: ABI-v3 x64 Wasm core in $out"
