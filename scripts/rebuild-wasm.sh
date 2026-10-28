#!/usr/bin/env bash
# Build candidate only. Never overwrite the pinned, working runtime on failure.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
exec > >(tee artifacts/rebuild-wasm.log) 2>&1
for tool in cargo rustc rustfmt clang-cl lld-link wasm-bindgen; do
  command -v "$tool" >/dev/null || { echo "BUILD_BLOCKED: missing tool $tool"; exit 1; }
done
export RUSTUP_TOOLCHAIN=1.81.0
rustc --version | grep -E '^rustc 1\.81\.0 '
cargo --version
wasm-bindgen --version | grep -Fx 'wasm-bindgen 0.2.92'
source=rust/retrowin32
# Force regeneration: changing asyncness/exports changes guest stdcall DLLs too.
make -B -C "$source/win32"
cargo test --manifest-path "$source/Cargo.toml" --locked -p x86
cargo test --manifest-path "$source/Cargo.toml" --locked -p win32 --features x86-emu
cargo build --manifest-path "$source/Cargo.toml" --locked -p glue --target wasm32-unknown-unknown --release
out="$PWD/artifacts/wasm-candidate"
mkdir -p "$out"
wasm-bindgen "$source/target/wasm32-unknown-unknown/release/glue.wasm" --out-dir "$out" --target web
mv "$out/glue.js" "$out/glue.mjs"
printf '\nexport { default as initRetrowin32, new_emulator as createRetrowin32Emulator, Status as Retrowin32Status };\n' >> "$out/glue.mjs"
cp "$out/glue_bg.wasm" "$out/retrowin32.wasm"
sha256sum "$out/retrowin32.wasm" "$out/glue.mjs" > "$out/SHA256SUMS"
echo "BUILD_COMPLETE: candidate artifacts only; guest validation still required."
