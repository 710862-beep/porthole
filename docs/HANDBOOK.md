# Porthole Handbook

## Day 1: Getting Started

```bash
git clone https://github.com/710862-beep/porthole && cd porthole
npm ci                     # JS deps (jsdom/playwright for legacy suites)
npm run dev:ui             # serve repo root; open http://localhost:8080/ui/
```

Building the emulator core needs Rust + wasm-bindgen (`npm run build:wasm`), but the
normal path is CI: the `x64-emulator` workflow builds `porthole-x64-wasm` and uploads it
as an artifact; drop it in `vendor/porthole-x64-wasm/`. No local Rust? You can still do
all UI work — the shell degrades gracefully and says what's missing.

Tests you'll actually run:

| Command | What it proves | Time |
| --- | --- | --- |
| `npm run check:syntax` | JS syntax across the repo | seconds |
| `node scripts/check-boundaries.mjs` | ARCHITECTURE.md dependency rules (grep-level) | seconds |
| `node tests/third-party/run-7za.mjs` | Gate 1 Tier A (needs artifact + `node scripts/fetch-7za.mjs`) | ~10 s |
| `node tests/third-party/run-chocolate-doom.mjs` | Gate 1 Tier B + Gate 2 (~8–10 min — 3.6B instructions at ~6 MIPS) | long |
| `node tests/wine64/run-wine64.mjs` | Wine conformance groups | minutes |
| `npm test` | legacy JS suites (see KI-08: partially red, pre-existing) | minutes |

Every runner is **fail-closed**: it prints PASS only with guest-authored completion
evidence, and names blockers otherwise. If you ever "fix" a red by loosening a runner,
you've broken the project's core discipline — see the fake-frame post-mortem.

## Architecture Deep Dive

* **CPU** (`cpu.rs`, `cpu_simd.rs`): x86-64 interpreter (the JIT in `jit.rs` is
  scaffolding/emission experiments; the interpreter is the shipping path). SIMD coverage
  is demand-driven (PACKUSWB et al. landed when Doom hit them — decode faults name the
  opcode).
* **VMM** (`vmm.rs`): software MMU. Sparse `regions: BTreeMap`; `page_cache: HashMap`
  bounded by `max_resident_pages`; LRU by generation counter; dirty evictions queue to
  the host; `preflight_range` guarantees multi-page ops trap *before* partial commit.
  Guest VA ≠ Wasm linear memory — that's why wasm32 suffices (see gate3 plan).
* **PE loader** (`pe64.rs`): PE32+ sections/relocations/imports; builds PEB/TEB,
  `RTL_USER_PROCESS_PARAMETERS` (mind the CURDIR offsets — measured), import thunks in a
  dedicated VA window, data-import cells (a CRT startup once died on thunk-vs-data
  confusion), COM thunks in their own range `0x7FF1…` (an aliasing bug once dispatched
  COM calls into kernel32).
* **HLE** (`win32_hle.rs`): one giant dispatch keyed by `dll!symbol`. Import thunks
  trap into Rust with Win64 ABI args (RCX,RDX,R8,R9 + stack). Upcalls into guest code
  (e.g. `_initterm` entries) use a real frame at `rsp-0x30` — a sentinel at `rsp-8`
  once corrupted returns after 96k instructions. Unimplemented symbols return
  `ERROR_CALL_NOT_IMPLEMENTED` and are recorded by name.
* **SDL2 HLE** (`sdl_hle.rs`): guest-memory `SDL_Surface/PixelFormat/Palette` structs
  with real layouts; palette-converting blits; renderer **compositor** (window
  backbuffer in guest RAM; Clear fills, Copy does a true scaled blit, Present captures).
  Golden rule: read `pixels/pitch` from the *live guest struct* (`sdl_surface_live`) —
  guests legally rewrite them (Chocolate locks its texture into a surface).
* **Rendering pipeline to browser**: guest presents → core copies RGBA → JS pumps to
  canvas (`js/x64-app.js`). GPU tiers (WebGPU→WebGL2) exist in `js/graphics-*` for the
  D3D12-fixture path; the proven game path is software readback.
* **Native tracer** (`src/bin/xtrace.rs` + `x64-trace.yml`): per-instruction trace,
  HLE/COM logs, write watchpoints, fault snapshots. This is how every hard bug above
  was actually found. Learn it before guessing.

## Adding a New API (the loop that built this)

1. **Get a named blocker**: run the target binary; the runner/trace ends with
   `unimplemented=<dll>!<name>` or a decode fault. Never add APIs speculatively.
2. **Find upstream semantics**: pinned Wine source (`vendor/wine-source`, commit in
   `docs/wine-commit.txt`) or the library's own headers (SDL: `SDL_pixels.h` etc.).
   Record provenance in a comment (file/function) like existing code does.
3. **Check the ABI by hand**: arg order has bitten us twice (`GetTempPath(length,buffer)`,
   `__p___argv` returning `char***`). Struct layouts must match the guest's headers
   byte-for-byte (offsets in comments, e.g. `SDL_Surface` pixels@+32).
4. **Implement in the dispatch match**, smallest correct semantics. If you must stub,
   return the *documented failure* for "device absent" cases (e.g. audio) — never a
   fake success that hands back garbage. Watch for `let _ = vmm.write_bytes(...)`
   (KI-02) if your API copies bulk data.
5. **Measure**: rerun the binary + the Wine group if relevant; commit with the before/
   after numbers in the message. One file at a time in `edit` batches, then grep-verify
   (parallel same-file edits have raced before).

Worked example (in git history): `PACKUSWB` — fault named `0F 67` → Intel manual
saturation bounds → `cpu_simd.rs` → WAD loading proceeded. Another: CURDIR offsets —
Wine `directory` 2→0 failures after fixing `RTL_USER_PROCESS_PARAMETERS` layout.

## Debugging Guide

| Symptom | First move |
| --- | --- |
| Guest exits 0 immediately, does nothing | Suspect silent early-out (our SDL2main argv bug did this). Trace HLE; check the first "error" API the guest calls (often a message box). Exit 0 is not success — demand guest-authored markers |
| Fault at RIP 0 / `ret` into nowhere after N×10⁴ instructions | Stack/ABI: upcall framing, home space, arg order, `__p___argv`-style indirection |
| Wrong results but no crash (archive diff, checksum drift) | Determinism tools: instruction count across runs, frame checksums, `xtrace` write watchpoints on the differing address |
| Frames presented but static | Checksum-evolution test (≥100 distinct or it's fake). Then compositor: is Copy moving pixels? Are surface structs read live? |
| CI says job green but test "passed" suspiciously | Read the published report, not the job colour — `continue-on-error` history and modal-dialog hangs both hid there once |
| Link/load failure of a new binary | Dump its import table (runners do), map blockers in order; data imports vs code thunks is the classic trap |

## Performance Tuning

* **CPU**: the interpreter is the ceiling (~6 MIPS CI). Profile hot opcodes from traces
  before optimising; HLE-accelerating hot libc (`memcpy` etc.) already happens via
  import interception — count with `hle_histogram`.
* **VMM**: eviction scan is O(window) (KI-10); resident window size is the main knob
  (`BrowserX64Emulator(pages)` / `set_max_resident_pages`).
* **Graphics**: SDL path cost is dominated by guest-side software rendering + our blits;
  the compositor reads/writes whole buffers per Copy — region-clip before micro-opting.
* **CI time**: Tier B dominates (~10 min). Don't parallel-push spam; batch fixes,
  verify locally what's verifiable (`node --check`, native `cargo test` in CI jobs).

## House rules (learned the expensive way)

1. Unmodified third-party binaries for compatibility claims; authored fixtures are
   harnesses, never evidence. Hash-pin everything (`scripts/fetch-*.mjs`).
2. Separate AUTHORING / EXECUTION / RENDERING / GAMEPLAY in every sentence you write.
3. Update `docs/x64-emulator-status.md` with measured numbers in the same commit series;
   name binary SHA-256 + runner + device for every PASS.
4. Never spend a cycle on D3D12 shader work (DXBC≠DXIL; `dxil-spirv` is a future item).
