# Porthole — Final Status Report (foundation phase)

Date: 2026-10-30 · Branch: `arena/0213f8bc-porthole` · Evidence rule: **measured only**.
Every number below names its binary SHA-256, its runner, and its device. Where something is
not measured, it says so. AUTHORING, EXECUTION, RENDERING and GAMEPLAY are separate claims.

## Gates — status at a glance

| Gate | Status | What was actually proven |
| --- | --- | --- |
| **1 Tier A** — independent binary (7-Zip) | ✅ **PASS** (EXECUTION) | Unmodified third-party exe ran a real create+extract archive round-trip, byte-identical |
| **1 Tier B** — Chocolate Doom execution | ✅ **PASS** (EXECUTION) | Unmodified exe completed demo1 timedemo; **2,664 gametics == real Wine 9.0** |
| **2** — real rendering | ✅ **PASS** (RENDERING) | 1,782 distinct guest-presented frame checksums; title frame **pixel-identical (64,000/64,000)** to an independently decoded reference. ⚠️ **Interactive gameplay NOT claimed** (demo playback, no input devices yet) |
| **3** — NVMe memory claim | ⏳ **DRAFTED, NOT RUN** | Test designed + coded (`tests/gate3/`); zero measurements exist. Any "unlimited RAM" sentence before this runs is unproven |
| **4** — locked Chromebook | ⏳ **PROBE READY, NOT RUN** | `gate4-probe.html` + runbook written; requires the physical device. **All numbers so far are Node on Azure CI, not Chrome** |
| **5** — Wine conformance 7/7 | ⚠️ **6/7** | `directory` closed (0 failures). `environ` open at **38 failures** (itemised lines not captured yet — no guessing) |

CI at HEAD `6acadd9`: Tier A ✅ · Tier B ✅ · Gate 2 Wine reference ✅ · Wasm build ✅ ·
Rust core tests ✅ · Guest trace ✅ · Wine64 conformance ❌ (environ) · legacy
`porthole-ci.yml` (pre-existing JS synthetic suite) ❌ — red since before this milestone,
disjoint from the x64 work, tracked in `docs/KNOWN-ISSUES.md` (KI-08).

## Performance benchmarks (measured)

| Metric | Measured value | Context |
| --- | --- | --- |
| Interpreter throughput | **5.95–7.99 MIPS** | Chocolate Doom timedemo, Node v22.23.4 on Azure CI (Xeon Platinum 8573C / EPYC 7763 / EPYC 9V74) |
| Timedemo size | 3,603,985,626 guest instructions | **Bit-identical instruction count on 3 different CI CPUs** (deterministic simulation) |
| Timedemo result | 2,664 gametics / 2,614 realtics | Wine 9.0 same binary: 2,664 gametics (693–1,167 realtics across runs — native is ~100× faster) |
| 7-Zip create / extract | 26.6M instr, 4.2 s, 6.30 MIPS / 7.4M instr, 1.1 s, 6.99 MIPS | Tier A, Node on CI |
| Guest presents | 2,704 for one demo; 1,782 distinct framebuffer checksums | 800×600 backbuffer, FNV-1a64, JS cross-checked |
| Title frame | 320×200, 178 colours, `fnv1a64:02d3105200077dee` | Pixel-identical to independent IWAD decode |
| Memory residency | Fixed LRU window (runs so far: 65,536 pages = 256 MiB cap; working sets fit) | **Small-window behaviour is Gate 3 — unmeasured** |
| Storage I/O latency | **Not measured** (NVMe/OPFS numbers do not exist yet) | Gate 3 (Node fs) then Gate 4 (device OPFS) |
| Frame time | Not measured as FPS in browser; ~35 fps *guest-reported* simulation rate in timedemo | Browser frame pacing via `x64.html` telemetry is Gate 4 territory |

Local-dev and Chromebook baselines: **do not exist yet**. Expected order of magnitude on a
low-end Chromebook is below the CI numbers; the Gate 4 probe's job is to replace this
sentence with data.

## Game / binary compatibility matrix

| Binary (SHA-256) | Claim | Result | Evidence |
| --- | --- | --- | --- |
| 7-Zip Standalone Console 21.07 x64 `7za.exe` (`b0cfdeaf…05f95`) | EXECUTION | ✅ Archive round-trip byte-identical | `tests/third-party/run-7za.mjs`, Tier A CI job |
| Chocolate Doom 3.1.1 win64 `chocolate-doom.exe` (`15e81c19…d752`) + Freedoom 0.13.0 (`a8772e08…d4b`) | EXECUTION + RENDERING | ✅ 2,664 gametics == Wine 9.0; frames evolve; title pixel-identical | `tests/third-party/run-chocolate-doom.mjs`, `gate2-wine-reference` job, `scripts/decode-title-reference.mjs` |
| Wine 11 upstream test exes (pinned Wine `0738d528…`, zig-built from unmodified sources) | CONFORMANCE | ⚠️ 6/7 groups (`environ` 38 failures) | `tests/wine64/run-wine64.mjs` |
| Authored fixtures (`tests/game/*.c`, incl. the historical `doom_d3d12_startup.exe`) | AUTHORING only | Regression harnesses. **Not games, not compatibility evidence.** The D3D12 fixture's green pixel was host-authored and is explicitly excluded | `docs/x64-emulator-status.md` |

*Theoretical* compatibility (inference from API surface, **not tested — do not quote as
support**): console/Win32-file-IO utilities using the implemented kernel32/msvcrt subset;
SDL2 software-rendered 2D games using the implemented SDL subset (single window, one
renderer, streaming textures, surface blits). Explicitly **out of reach today**: anything
needing guest thread scheduling, real Direct3D (D3D12 HLE is fixture-grade: no DXBC/DXIL
parsing, no descriptor writes that matter, no GPU execution), XAudio2/DirectSound audio
output, networking beyond stubs, anti-cheat/DRM (out of scope by policy).

Path to broader Wine parity: close `environ` (needs itemised capture first) → schedule
guest thread bodies → HLE trap propagation for bulk copies under memory pressure → input
device model (keyboard/mouse events into SDL/Win32 queues) → more msvcrt/ucrt surface as
named by real binaries (the harness already fails closed with named blockers).

## API coverage (grounded counts)

* Rust core: ~17,700 lines in `rust/porthole-x64-wasm/src/` (CPU + SIMD, VMM, PE64, Win32
  HLE ≈ 6,000 lines, SDL2 HLE, D3D12 HLE, JIT scaffolding).
* Win32 dispatch: ~347 named entry arms in `win32_hle.rs` across kernel32/ntdll/msvcrt/
  ucrtbase/user32/gdi32/advapi32/shell32/ole32/oleaut32/winmm + SDL satellite DLLs.
  Critical honest gaps are tracked per-binary by the fail-closed runners
  (`unimplemented_symbols`), not by this count.
* SDL2: 82 entry points with real semantics (surfaces, palettes, renderer compositor,
  streaming/target textures, events-as-empty, timers). Audio device output: none
  (mixer reports no-device safely). No `SDL_GL_*` context implementation.
* D3D12/DXGI: interface/method coverage table in `docs/x64-emulator-status.md`
  (e.g. ID3D12Device 25/44 slots). It satisfies the authored fixture only; **shaders are
  not parsed** (DXBC ≠ DXIL; SM6 needs `dxil-spirv` or equivalent — separate future work).

## Known issues

Full list with severity/impact/effort/workaround: [`docs/KNOWN-ISSUES.md`](KNOWN-ISSUES.md).
Headlines: KI-01 no guest thread scheduling (High) · KI-02 HLE bulk copies ignore page
faults under memory pressure (High, Gate 3) · KI-03 `environ` 38 (Medium, Gate 5) ·
KI-04 no interactive input (High for gameplay) · KI-05 D3D12 is fixture-grade (by
decision) · KI-06 `atexit` handlers not executed (Low) · KI-07 `GetComputerName` off-by-one
(Low) · KI-08 pre-existing red legacy CI workflow (Medium, credibility).

## Incidents worth remembering (already fixed, why the harness is strict)

* The **fake frame**: an early Tier B "PASS" showed 2 distinct checksums across 2,704
  presents — `SDL_RenderCopy` moved zero pixels and Present captured a stale texture.
  Caught by the published evidence itself; fixed with a real compositor + the
  `sdl_surface_live` fix for Chocolate's LockTexture-into-surface idiom; the runner now
  demands ≥100 distinct checksums + pairwise-distinct sampled frames.
* `gammatable[0]` is not identity — the independent reference decoder found its own bug
  via `maxDelta=4` before matching 64,000/64,000.

## What "ready for UI agent" means today

The runtime is real but young: `x64.html` + `js/x64-app.js` already mount storage, load
the Wasm core, run guests and pump frames/telemetry. The new `ui/` shell (this handoff)
adds Game Store + Desktop modes *around* that runtime without forking it. Contracts are
in `ui/runtime/contracts.ts`; start from `docs/HANDOFF-PACKAGE.md`.
