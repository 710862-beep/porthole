# x86-64 emulator — measured status (2026-10-29)

This file records **measured** evidence only. Nothing below is a projection.

## What is real and verified in CI

| Gate | Command | Result |
| --- | --- | --- |
| Rust core unit tests | `cargo test --all-targets` (rust 1.81, ubuntu-24.04) | **PASS** — VMM 34 GB sparse VA + LRU eviction/page-fault roundtrip, hybrid Wasm JIT emitter (`\0asm` module, epoch invalidation), emulator construction |
| Wasm build | `cargo build --release --target wasm32-unknown-unknown` + `wasm-bindgen --target web` | **PASS** — `porthole_x64_wasm.js` + `porthole_x64_wasm_bg.wasm` produced and uploaded |
| Wine 64-bit fixture build | `node scripts/build-wine64-tests.mjs` (zig 0.13.0, pinned Wine `0738d528`) | **PASS** — 4 unmodified upstream tests compiled to `PE32+` (`0x8664`): `kernel32_test.exe` (power, drive, atom, environ, directory), `user32_test.exe` (wsprintf, uitools), `d3d12_test.exe` (d3d12), `porthole_x64_plan_test.exe` |
| Wine 64-bit conformance inside the Wasm emulator | `node tests/wine64/run-wine64.mjs` | **FAIL — 0/4 passed** |

Pre-existing JS/DOM/retrowin32 suite (`npm test`, `npm run check:syntax`) still passes locally
(77 scripts, 11 DOM checks, 15 retrowin32 checks).

## Current failure (exact, reproducible)

All four Wine binaries execute the same CRT startup path and fault after **85 instructions**:

```
history: 0x4010b8 0x4010bf 0x4010c1 0x427120 0x4010c6 0x4010c8 0x424cf0 0x424cf2
fault:   access violation at 0x100c700027000 (rax=0x0 rcx=0x1 rdx=0x20b rsp=0x21ffe70 gs=0x7ffe00020000)
```

`0x424cf0` is a two-instruction stub in every binary:

```
424cf0: 31 c0    xor eax,eax
424cf2: c3       ret
```

The caller (`0x4010c8: call 0x424cf0`, pushed return address `0x4010cd`) reaches the stub, and the
`ret` leaves the CPU jumping to `0x100c700027000` instead of `0x4010cd`. So the fault is a
**CALL/RET stack-symmetry or stack-page bookkeeping defect**, not a decoder gap: the ~85
instructions before it (REX-prefixed MOV/MOVZX/CMP/SETcc, `call rel32` to two HLE/JIT targets,
`sub rsp, imm8`) all executed correctly, including a previous `call`/`ret` pair to `0x427120`.

The high bits differ per binary (`0x100c700027000`, `0x100c70002d000`, `0x100c700024000`,
`0x100c70004a000`) and track each image's layout, which suggests the popped value is derived from
image data (a relocated pointer or a slot the loader never initialised) rather than from stack
corruption.

## Next debugging steps (in order)

1. Dump the 64 bytes below `RSP` plus the containing page at the moment of the fault (extend
   `render_rip_history` into a `fault_snapshot()` that formats `[rsp-32, rsp+32)`), and check
   whether `0x4010cd` is present at `[rsp]` at all.
2. Verify `CALL rel32`/`RET`/`PUSH`/`POP` push-pop symmetry against a hand-checked trace
   (`call 0x427120` → `ret` works, `call 0x424cf0` → `ret` does not, so compare the two stack
   frames; the second call is the first one reached *after* an HLE thunk returns).
3. Audit the HLE return path in `lib.rs::run_slice`: the thunk branch pops the return address and
   advances `RSP` by 8, and `HleAction::Upcall` stages `UPCALL_RETURN_THUNK` at `rsp-8`. If a call
   is dispatched with a stale `RSP` (e.g. after `_initterm` upcall bookkeeping), every later
   `ret` in that frame returns into the previous frame's data.
4. Once the CRT reaches `main`, iterate on the `kernel32`/`user32`/`d3d12` subtest semantics
   (atoms, environment expansion, drive/directory errors, DXGI swapchain refcounts) against the
   guest's own `Test failed` lines, which the harness already captures verbatim.

## Reproducing locally

```bash
npm ci
python3 -m pip install --target .cache/tools ziglang==0.13.0
PORTHOLE_ZIG=$PWD/.cache/tools/ziglang/zig node scripts/build-wine64-tests.mjs
# requires a built wasm artifact in vendor/porthole-x64-wasm/ (produced by .github/workflows/x64-emulator.yml)
PORTHOLE_X64_WASM_DIR=vendor/porthole-x64-wasm node tests/wine64/run-wine64.mjs --report artifacts/wine64-report.json
```

`tests/wine64/run-wine64.mjs` reports `NOT_RUN` (exit 2) when the Wasm artifact is absent instead of
claiming success.
