# Known Issues (tracked, severity-ordered)

Each entry: severity · impact · evidence · estimated effort · workaround. Nothing here is
hidden behind a TODO sweep: the x64 core (`rust/porthole-x64-wasm/src`) currently contains
~0 TODO/FIXME markers; the repo-wide count (~131) is almost entirely in the vendored
`rust/retrowin32/` tree, inventoried at the bottom instead of deleted.

---

### KI-01 — Guest thread bodies are not scheduled
- **Severity:** High
- **Impact:** Any binary that does real work on `CreateThread` threads misbehaves or must
  be forced single-threaded (Tier A ran 7-Zip with `-mmt1` for exactly this reason).
- **Evidence:** `docs/x64-emulator-status.md` (named limitation); thread APIs accept and
  record but bodies never execute.
- **Effort:** Large (scheduler + wait/signal semantics + deterministic interleaving).
- **Workaround:** single-threaded flags where the application offers them.

### KI-02 — HLE bulk copies ignore page faults (silent data loss under memory pressure)
- **Severity:** High for Gate 3; latent today
- **Impact:** HLE arms call `vmm.write_bytes` and ignore `Err(PageFault)`; an HLE copy
  (e.g. intercepted `memcpy`, file reads into buffers) spanning a swapped-out page
  silently drops bytes when the resident window is small.
- **Evidence:** code inspection (`let _ = vmm.write_bytes(...)` throughout
  `win32_hle.rs`/`sdl_hle.rs`); current gates ran with a 256 MiB window so it rarely bites.
- **Effort:** Medium-Large (make HLE dispatch fallible; re-dispatch the faulting call
  after `supply_page`; requires HLE calls to be restartable/idempotent).
- **Workaround:** Gate 3 fixture uses plain CPU stores (those trap-and-resume correctly).

### KI-03 — Wine `environ` conformance: 38 failures (Gate 5 remainder)
- **Severity:** Medium
- **Impact:** `GetEnvironmentVariable` buffer-size/`ERROR_MORE_DATA` family semantics;
  blocks the "7/7" Gate 5 claim. `directory` is closed (0 failures).
- **Evidence:** last read on `5b0bd45`: 432 tests, 38 failures, 14 todo, 2 skipped.
  Itemised failure lines are not captured by the harness summary — first fix is
  instrumentation, not semantics. `SetEnvironmentStringsW` confirmed unimplemented.
- **Effort:** Medium (capture itemisation → fix against pinned Wine source
  `dlls/kernel32/tests/environ.c`).
- **Workaround:** none; do not guess fixes without the failing test lines.

### KI-04 — No interactive input devices
- **Severity:** High for any GAMEPLAY claim; irrelevant to proven EXECUTION/RENDERING
- **Impact:** SDL events report "no devices"; keyboard/mouse have no path into the guest.
  Doom evidence is demo playback only.
- **Evidence:** `sdl_hle.rs` PollEvent family returns empty; Gate 2 record says so.
- **Effort:** Medium (event queue + browser key/mouse capture + SDL scancode mapping +
  Win32 message queue equivalents).
- **Workaround:** none. This is the UI agent's most valuable runtime addition.

### KI-05 — D3D12 HLE is fixture-grade (deferred by decision)
- **Severity:** High if claimed; **not claimed**
- **Impact:** `CreateGraphicsPipelineState` does not parse DXBC; descriptors, placed
  resources, command replay to WebGPU are absent/stub. DXBC ≠ DXIL; SM6 needs
  `dxil-spirv` (separate future work item).
- **Evidence:** coverage table + deferred list in `docs/x64-emulator-status.md`.
- **Effort:** Very large. **Workaround:** SDL2 software path (proven) is the renderer.

### KI-06 — Guest `atexit`/`_crt_atexit` handlers recorded, not executed
- **Severity:** Low–Medium
- **Impact:** Static destructors/cleanup that writes files on exit may not run.
- **Effort:** Small–Medium (upcall machinery exists; needs exit-path draining + tests).
- **Workaround:** none today.

### KI-07 — `GetComputerNameA/W` buffer-size off-by-one
- **Severity:** Low
- **Impact:** Edge-case size reporting vs Wine expectations.
- **Effort:** Small (fix with the relevant Wine test as oracle).

### KI-08 — Pre-existing red legacy workflows (not caused by x64 work)
- **Severity:** Medium (credibility/CI hygiene)
- **Impact:** `porthole-ci.yml` ("Syntax, runtime, stress and Wine adapter") fails since
  before this milestone on the legacy JS synthetic suite; `wine64-conformance` fails due
  to KI-03. "CI is green" cannot be claimed repo-wide until triaged.
- **Effort:** Medium (triage legacy suite; either fix, quarantine with rationale, or
  retire). Gate jobs themselves are green and fail-closed.

### KI-09 — No audio output path
- **Severity:** Medium for games
- **Impact:** SDL_mixer/winmm report no-device semantics; guests run silent
  (all current evidence used `-nosound`).
- **Effort:** Medium (WebAudio sink + SDL audio device model).

### KI-10 — Eviction victim search is O(window) per fault
- **Severity:** Low at 1k pages; Medium at 65k pages
- **Impact:** p99 fault latency under big windows (Gate 3/4 will measure).
- **Effort:** Small–Medium (clock/second-chance hand).

## TODO/FIXME/HACK inventory (not deleted — classified)

* `rust/porthole-x64-wasm/src` (the product core): ~0 markers. Deferred work lives in
  this file and in `docs/x64-emulator-status.md`'s deferred D3D12 list instead.
* `rust/retrowin32/` (vendored/other track): ~131 markers, concentrated in
  `winapi/user32/*`, `winapi/ddraw/*`, `x86/src/ops/*`. Disposition: **deferred by
  decision** — that tree is not on the shipping path for the x64 milestone; do not mass-
  edit. If it is ever promoted, triage per-file first.

## Rust `unwrap()` policy

~130 `unwrap()` calls exist in the core (mostly page-cache lookups immediately after
insertion, and PE parsing after bounds checks). They are **not** all commented. Rule going
forward (see HANDBOOK): new code must avoid `unwrap()` on guest-influenced data or justify
it in a comment; a panic in Wasm is a trap that JS sees as a crash, so treat each site as
a potential guest-triggered DoS until audited. A dedicated audit pass is the fix; it has
not been done — this entry is the tracking record.
