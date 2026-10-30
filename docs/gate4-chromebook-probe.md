# GATE 4 — locked Chromebook reality check (probe plan)

Status: **not yet run.** Nothing in this file is evidence until it comes back filled with
measurements from the actual device. Node/CI results cannot substitute.

## How to run (on the target Chromebook, managed account signed in)

1. Open `gate4-probe.html` in Chrome (single self-contained file at repo root — serve it
   from any static host the device may reach, or open via `file://` if policy allows;
   if both are blocked, paste the `<script>` body into DevTools console on any https
   page and record `R`).
2. Wait ~5 s for automatic checks. **Copy JSON** (button) to somewhere durable first.
3. Press **“1 · Try showDirectoryPicker()…”** — if a picker opens, pick any folder;
   if policy blocks it, the exact `DOMException` name/message is recorded verbatim.
4. Press **“2 · Probe max WebAssembly.Memory”** last (may kill the tab on low RAM).
5. Screenshot: this page, `chrome://policy` (search **FileSystem** — record values of
   `DefaultFileSystemReadGuardSetting`, `DefaultFileSystemWriteGuardSetting`, and any
   `*ForUrls` lists), `chrome://gpu` (first screen), `chrome://version`.
6. Open `x64.html`, load `7za.exe`, run the Tier A round-trip; record from the telemetry
   panel: instructions executed + wall time → sustained instructions/sec, plus a
   screenshot and (DevTools → Performance) a trace export for the run.

## Exact APIs probed (all in `gate4-probe.html`)

| Question Gate 4 must answer | API / source (exact) | Field in probe JSON |
| --- | --- | --- |
| What device/browser is this, really? | `navigator.userAgent`; `navigator.userAgentData.getHighEntropyValues(["model","platform","platformVersion","architecture","bitness","fullVersionList"])` | `userAgent`, `userAgentData` |
| File System Access allowed by enterprise policy? | presence: `typeof window.showDirectoryPicker`; **attempt**: `showDirectoryPicker({mode:"readwrite"})` behind a click; `chrome://policy` search | `fileSystem.showDirectoryPicker`, `fileSystem.pickerAttempt` (+ policy screenshot) |
| OPFS usable as the NVMe shard store? | `navigator.storage.getDirectory()`, `getFileHandle({create})`, `createWritable()` 4 MiB write/read/verify timing, `navigator.storage.estimate()`; `createSyncAccessHandle` presence (main thread; worker check is follow-up) | `fileSystem.opfsSmoke4MiB`, `fileSystem.estimate` |
| WebGPU tier | `navigator.gpu`, `requestAdapter()` → `adapter.info/features/limits`, `requestDevice()` | `webgpu` |
| WebGL2 tier | `canvas.getContext("webgl2")`, `WEBGL_debug_renderer_info` `UNMASKED_RENDERER_WEBGL` | `webgl2` |
| Wasm: memory64 / SIMD / threads / bulk-memory | `WebAssembly.validate(...)` against minimal feature modules; `window.crossOriginIsolated`; `typeof SharedArrayBuffer` | `wasm.simd`, `wasm.threadsSharedMemory`, `wasm.memory64`, `wasm.bulkMemory`, `wasm.signExtension` |
| Practical max `WebAssembly.Memory` | `new WebAssembly.Memory({initial:1, maximum:65536})` then `grow(4096)` ×N (256 MiB steps, 2 GiB safety cap, button-gated) | `wasm.memoryConstruct4GiBMax`, `wasm.memoryGrowProbe` |
| `devicePixelRatio` (measured) | `window.devicePixelRatio`; `screen.*` | `devicePixelRatio`, `screen` |
| Total JS heap | `performance.memory.jsHeapSizeLimit` (+ used/total) | `jsHeap` |
| Physical RAM | `navigator.deviceMemory` (GiB bucket) + `chrome://version`/device model cross-ref | `deviceMemoryGiB` |
| Sustained instructions/sec | probe: 50M-iteration wasm loop (CPU proxy only); **real number**: `x64.html` Tier A run → `instructions_executed`/wall-clock | `cpuProxy` + x64.html telemetry (manual) |
| Screen capture + trace | OS screenshot of probe + `x64.html`; DevTools Performance trace export | files, not JSON |

## How each answer gates the design (decisions to record when filled)

* `pickerAttempt.ok=false` with `AbortError` only when the user cancels; `NotAllowedError`/
  `SecurityError` or API absent ⇒ **the NVMe design must use OPFS** (no user-visible
  folder) — record which policy name from `chrome://policy` says so.
* `wasm.memory64=false` is **not** a blocker by design (see gate3 plan: VA is a software
  MMU, linear memory holds only the resident window). `wasm.simd=false` ⇒ expect the
  ~6 MIPS interpreter to be slower; record, don't panic.
* `sharedArrayBuffer=false` / `crossOriginIsolated=false` ⇒ no Wasm threads ⇒ guest
  thread bodies stay single-slice-scheduled; also blocks `createSyncAccessHandle`-in-worker
  designs that need COOP/COEP from the *serving origin* — record the serving origin used.
* `webgpu.deviceOk=false` but WebGL2 ok ⇒ renderer target stays WebGL2/canvas blit for
  the SDL path (current plan already assumes this floor).

## Results (fill on device day)

_Pending._ Paste probe JSON verdicts + `x64.html` Tier A sustained instructions/sec +
policy screenshots' key values here, then update `docs/x64-emulator-status.md`. Until
then every Porthole number is “Node on Azure CI (Ubuntu 24.04, Xeon/EPYC), not Chrome,
not the Chromebook.”
