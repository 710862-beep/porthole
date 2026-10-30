# Architecture & dependency rules

## Data flow: how a guest instruction becomes a pixel

```
Browser (x64.html / ui shell)
 └─ JS platform layer (js/x64-app.js): storage mount, frame pump, telemetry
     └─ wasm-bindgen boundary: BrowserX64Emulator (rust/porthole-x64-wasm/src/lib.rs)
         ├─ CPU interpreter (cpu.rs, cpu_simd.rs) ── traps ──┐
         ├─ VMM / software MMU (vmm.rs): sparse VA, LRU     │ page-fault:<base>
         │    resident window, eviction queue               │ (suspend/resume)
         ├─ PE32+ loader (pe64.rs): sections, imports, PEB  │
         ├─ Win32 HLE (win32_hle.rs, win32_fmt.rs)          │
         ├─ SDL2 HLE (sdl_hle.rs): surfaces, compositor ────┤ presented frames
         └─ D3D12 HLE (d3d12_hle.rs): fixture-grade (KI-05) ┘ (guest bytes only)
Host storage: File System Access directory → OPFS fallback (js/x64-nvme-vfs.js, js/vfs-*)
Host display: canvas 2D today (js/x64-d3d12-renderer.js owns the D3D12-fixture path)
```

## Current layout (reality, 2026-10-30) → target layout (plan, not yet executed)

| Today | Role | Target (per handoff spec) |
| --- | --- | --- |
| `rust/porthole-x64-wasm/src/{cpu,cpu_simd}.rs` | x86-64 interpreter + SIMD | `core/cpu/` |
| `rust/porthole-x64-wasm/src/vmm.rs` | VMM/paging | `core/vmm/` |
| `rust/porthole-x64-wasm/src/pe64.rs` | PE32+ loader | `core/pe/` |
| `rust/porthole-x64-wasm/src/win32_hle.rs`, `win32_fmt.rs` | Win32/CRT HLE | `core/hle/{kernel32,user32,win32_types}` |
| `rust/porthole-x64-wasm/src/d3d12_hle.rs` | D3D12/DXGI HLE | `core/hle/d3d12/` |
| `rust/porthole-x64-wasm/src/sdl_hle.rs` | SDL2 HLE | `core/hle/sdl2/` |
| `rust/porthole-x64-wasm/src/lib.rs` (+ `bin/xtrace.rs`) | Wasm exports, run loop, native tracer | `core/` root + `platform/ci/` |
| `js/x64-app.js`, `js/x64-nvme-vfs.js`, `js/x64-d3d12-renderer.js`, `js/vfs*.js` | browser storage/graphics/runtime glue | `platform/browser/{wasm-bindings,storage,graphics,input}` |
| `x64.html` | existing single-page runtime | stays until `ui/` supersedes it |
| `ui/` (new in this handoff) | Game Store + Desktop modes, contracts | `ui/` (already target-shaped) |
| `tests/{third-party,wine64,gate3,game,…}` | test suites | `tests/{e2e,wine64,gate3,negative,fixtures}` (rename map in HANDBOOK) |

**Why the move is a plan and not done:** every CI workflow hard-codes
`rust/porthole-x64-wasm` paths, and this environment has no local Rust toolchain to
verify a moved crate before pushing. Moving = guaranteed multi-cycle CI breakage for
zero behavioural gain today. Execute the move as its own PR with CI time budgeted,
crate-by-crate (`git mv` + `Cargo.toml` path updates + workflow edits + full gate rerun).

## Dependency rules (effective now, enforced by review + CI grep guard below)

1. **core → nothing.** `rust/` must not reference `ui/`, DOM, or browser APIs beyond the
   wasm-bindgen export surface in `lib.rs`.
2. **platform → core only.** `js/` platform code may instantiate `BrowserX64Emulator`
   and pump its protocol (drain/supply/frames/telemetry). It must contain **no emulation
   logic** (no opcode knowledge, no Win32 semantics).
3. **ui → platform + contracts.** `ui/` consumes the runtime through
   `ui/runtime/contracts.ts` shapes only. It must never reach into `rust/` or parse PE
   files itself.
4. **tests → core/platform public surfaces.** Tests must not import UI components.
5. **Single frame authority.** Anything called a "frame" in UI code must originate from
   `guest_frame_rgba()/presented_frames()` (SDL path) — never from host-composed pixels.
   (Historical fake-frame incident, `docs/x64-emulator-status.md`.)
6. **Fail-closed evidence.** Any new test that can pass while doing nothing is a bug.
   Runners print named blockers; PASS requires guest-authored completion markers.

Lightweight guard (no ESLint exists in this repo today; adding one is UI-agent task P3):
`scripts/check-boundaries.mjs` — run in review; fails if rule 1/3/4 greps trip.

## Storage architecture (hybrid, as built)

* Guest RAM overflow + VFS persistence go through one host protocol:
  `drain_evicted_pages()` → host writes shards; `page-fault:<base>` → host reads →
  `supply_page()`. Browser backends: FSA picked directory first
  (`js/vfs-fs-access.js`, `js/x64-nvme-vfs.js`), OPFS/memory fallbacks
  (`js/vfs-fallback.js`). Gate 4 decides which backend the locked Chromebook allows;
  Gate 3 proves the protocol under a 4 MiB resident window (Node-fs stand-in first).
* Negative paths (quota exceeded, write failure) must **pause the guest**, never drop
  pages silently — see KI-02 for the one place that can still happen (HLE bulk copies).

## Graphics tiers

WebGPU → WebGL2 → canvas-2D/software, in that preference order
(`js/graphics-device.js`, `js/graphics-fallback.js`, `js/x64-d3d12-renderer.js`).
The proven Doom path is SDL-software → RGBA readback → canvas; GPU tiers matter when
D3D12 grows beyond fixture-grade (KI-05) — not before.
