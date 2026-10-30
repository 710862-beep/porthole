# Handoff Package — Porthole foundation → UI agent

## 1. Executive summary

Porthole is an x86-64 Windows emulator that runs **unmodified PE32+ binaries** inside a
WebAssembly core in the browser, with guest RAM overflow paged to on-device storage.
The foundation is proven, in CI, to this extent: a third-party console app (7-Zip 21.07)
does real file work byte-identically, and a real game (Chocolate Doom 3.1.1 + Freedoom)
executes a full demo **bit-identically to Wine 9.0** (2,664 gametics) while presenting
guest-rendered frames that are **pixel-identical to an independently decoded reference**
(64,000/64,000). Interactive play is not yet possible (no input devices); the small-cache
storage proof is coded but unrun; everything was measured under Node on CI — the
Chromebook itself is still unmeasured. Your job: build the product shell (Game Store +
desktop) on a runtime that already works, and help land input so "playable" becomes true.

## 2. Quick start

```bash
git clone https://github.com/710862-beep/porthole && cd porthole
npm ci
npm run dev:ui        # http://localhost:8080/ui/  (shell)   /x64.html (runtime)
```

For the compiled core: grab the `porthole-x64-wasm` artifact from the latest green
`x64-emulator` Actions run into `vendor/porthole-x64-wasm/`, or `npm run build:wasm`
with a local Rust toolchain. Smoke tests: `node scripts/check-boundaries.mjs`,
`npm run check:syntax`, `node tests/third-party/run-7za.mjs` (fast) — full gate matrix
in `docs/FINAL-STATUS-REPORT.md`.

## 3. Architecture overview

```
Chrome ── ui/ shell (Store/Desktop) ── x64.html runtime (js/x64-app.js)
        ── wasm-bindgen ── Rust core: CPU┐
                                      VMM┼─ page-fault ⇄ host shard files (FSA→OPFS)
                              PE loader ┤
                          Win32/SDL HLE ┘─ guest RGBA ── canvas (WebGPU/WebGL2 later)
```

Read first, in order:
1. `docs/FINAL-STATUS-REPORT.md` — what's proven, what's not (read the caveats twice).
2. `docs/HANDBOOK.md` — build/test/debug + the API-adding loop.
3. `ARCHITECTURE.md` — layers, dependency rules, the (planned) directory move.
4. `rust/porthole-x64-wasm/src/lib.rs` — the whole host protocol in one file.
5. `rust/porthole-x64-wasm/src/vmm.rs` — the memory claim's machinery.
6. `rust/porthole-x64-wasm/src/sdl_hle.rs` — how a real game's frames are composed.
7. `js/x64-app.js` — how the browser drives it today (your runtime to absorb).
8. `ui/runtime/contracts.ts` — your API surface; `docs/KNOWN-ISSUES.md` — your mines.

Data flow for one pixel: guest CPU stores to its 8-bit screen → guest calls
`SDL_LowerBlit` → HLE palette-converts into the texture the guest locked into a surface
→ guest `SDL_RenderCopy`×2 (HLE does real scaled blits into guest-RAM backbuffer) →
`SDL_RenderPresent` → core copies RGBA out → JS paints canvas. Every byte is the guest's.

## 4. Your first tasks (prioritised)

* **P0 — Game Store mode (real)**: wire `installGame` to an actual byte source
  (user-picked files into OPFS/FSA VFS + hash display); launch must pass the right
  exe/args into the runtime, not just open the window.
* **P0 — Absorb the runtime**: lift `js/x64-app.js` into `ui/runtime/` behind
  `EmulatorRuntime`; kill the iframe; own the canvas directly.
* **P1 — Input (KI-04, shared with core)**: browser keyboard/mouse → SDL event queue
  (`sdl_hle.rs`) + Win32 messages. This is the line between "demo" and "playable";
  coordinate with core before building capture UX.
* **P1 — Desktop mode depth**: window resizing, snap, workspace switcher in the
  taskbar, persisted window state; keep Yes/No dialogs as the only confirmation style.
* **P2 — Categorisation + settings**: app metadata schema v2 (publisher, icon from PE
  resources), real settings window (resident-window MiB, renderer tier, storage quota).
* **P3 — Polish**: ESLint adoption, animations, themes, i18n of `x64.html` strings
  (currently pt-BR), a11y pass on dialogs/windows.

## 5. Known blockers (details in docs/KNOWN-ISSUES.md)

KI-01 no guest thread scheduling · KI-02 HLE bulk-copy fault swallowing (Gate 3 will
surface it) · KI-04 no input · Gate 3 unrun (storage claim unproven at small windows) ·
Gate 4 unrun (Chromebook policy/perf unknown) · Gate 5 `environ` 38 failures ·
D3D12 fixture-grade by decision (KI-05). Workaround mindset: everything above has a
named next action; none of it blocks P0 UI work.

## 6. Resources

* Wine (pinned source + tests): `vendor/wine-source` @ `0738d528…`, winehq.org docs.
* SDL2 headers (the ground truth for layouts): libsdl-org/SDL `release-2.30.x`.
* Chocolate Doom: github.com/chocolate-doom/chocolate-doom (`src/i_video.c` is the
  single most instructive file in this project).
* WebGPU/WebGL2 specs via MDN; FSA/OPFS via web.dev storage articles.
* Intel SDM for opcode semantics; `docs/x64-emulator-status.md` for this project's own
  measured history (including every embarrassing incident — learn from them cheaply).

## Demo material (no video — honest substitute)

A screen recording could not be produced in the build environment. Instead, every CI
run publishes inspectable artifacts: Tier B reports with `frame_first/mid/final` PPM
screenshots of real guest frames (title → gameplay → intermission), the decoded
reference PPM, and full HLE histograms — see the `porthole-x64-tier-b-chocolate-doom`
and `porthole-x64-wine-reference` checks on any recent commit. Recording the 2–3 min
video (load → timedemo → frames → dialog → storage picker) is a 15-minute task on the
first machine with a real display; script it from §3's flow.
