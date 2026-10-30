# x86-64 emulator — measured status (2026-10-29)

This file records **measured** evidence only. Nothing below is a projection.

## What is real and verified in CI

| Gate | Command | Result |
| --- | --- | --- |
| Rust core unit tests | `cargo test --all-targets` (rust 1.81, ubuntu-24.04) | **PASS** — VMM sparse VA + LRU eviction/page-fault roundtrip, hybrid Wasm JIT emitter (`\0asm` module, epoch invalidation), emulator construction |
| Wasm build | `cargo build --release --target wasm32-unknown-unknown` + `wasm-bindgen --target web` | **PASS** — `porthole_x64_wasm.js` + `porthole_x64_wasm_bg.wasm` produced and uploaded |
| Wine 64-bit fixture build | `node scripts/build-wine64-tests.mjs` (zig 0.13.0, pinned Wine `0738d528`) | **PASS** — 4 unmodified upstream tests compiled to PE32+ (`0x8664`) |
| Wine 64-bit conformance inside the Wasm emulator | `node tests/wine64/run-wine64.mjs` | **PARTIAL — 5 of 7 subtest groups pass** (`uitools`, `wsprintf`, `atom`, `drive`, `power`); `environ` (35 failures) and `directory` (23 failures) still fail |
| **Real PE32+ startup fixtures inside the Wasm emulator** | `node scripts/build-game-fixtures.mjs && node tests/game/run-game.mjs` | **PASS — 3 of 3** executables run to `ExitProcess(0)`; the D3D12 one reaches `Present` and produces a 1280×720 RGBA frame |

The game fixtures are built from `tests/game/*.c` by `scripts/build-game-fixtures.mjs` (zig
`x86_64-windows-gnu`) and executed by `tests/game/run-game.mjs` against **the same Wasm module the
browser loads** — not the native tracer.

## Loading real Windows code (not Wine tests)

Three PE32+ x86-64 executables, compiled from C in this repository, mounted on the virtual
`C:\Game` volume and executed by the emulator's PE64 loader:

| Image | Bytes | sha256 (truncated) | What it does |
| --- | --- | --- | --- |
| `hello_world.exe` | 150 016 | `0654341b2b755350…` | ucrt startup, `main`, stdio, `ExitProcess(0)` |
| `game_startup.exe` | 152 576 | `d4656fe870b97724…` | `CreateFileW`/`WriteFile` on `C:\Game`, 2 GB `MEM_RESERVE`, 64 MB `MEM_COMMIT` write+readback on all 16 384 pages, `GetModuleHandleW`, `GetProcAddress`, indirect call through the resolved thunk, `D3D12CreateDevice`, `ExitProcess(0)` |
| `doom_d3d12_startup.exe` | 157 184 | `614d2cd61837a09f…` | 25-stage D3D12 boot: window → `CreateDXGIFactory2` → `EnumAdapters1` → `D3D12CreateDevice` → `CheckFeatureSupport` → queue → allocator → command list → fence → RTV heap → `D3D12SerializeRootSignature`+`CreateRootSignature` → PSO → `CreateSwapChainForHwnd` → `QueryInterface(IDXGISwapChain3)` → back buffers → RTVs → barriers → `ClearRenderTargetView` → `DrawInstanced` → `Close` → `ExecuteCommandLists` → `Present` |

Measured runs (`run 40991477773`, Wasm module `c34de2bd7896bec8…`):

```
hello_world.exe        exit=0  instructions=566    slices=1  page_faults=0  imports=54
game_startup.exe       exit=0  instructions=46382  slices=1  page_faults=0  imports=60
doom_d3d12_startup.exe exit=0  instructions=2216   slices=1  page_faults=0  imports=57
  frame: 1280x720 bytes=3686400 nonZero=1843200 sha256=5d9d754bb9731380… pixel0=[0,255,0,255]
  last stage: 25 IDXGISwapChain::Present(1,0)   →  DOOM_STARTUP_OK stages=25
```

`game_startup.exe`'s guest console, verbatim from the check-run summary:

```
GAME_STARTUP_BEGIN
  ok   CreateFileW (0x0)              ok   WriteFile (0x15)      ok   WriteFile byte count (0x15)
  ok   VirtualAlloc reserve 2GB       info reserve=0000000440000000
  ok   VirtualAlloc commit 64MB       info touched=16384 pages bad=0
  ok   commit write/readback (0x0)
  ok   GetModuleHandleW(kernel32) (0x10000000)
  ok   GetProcAddress(Sleep) (0x10000)      ok   GetProcAddress(VirtualAlloc) (0x10010)
  ok   indirect call through thunk (0x0)    ok   indirect VirtualAlloc (0xc4000000)
  info D3D12CreateDevice hr=0x00000000 device=00007FF400000990
GAME_STARTUP_RESULT failures=0
```

The instruction counts are low because the CRT's formatting (`__stdio_common_vfprintf`, `puts`,
`malloc`, `fflush`) is HLE, not interpreted: 566 instructions is the *guest's* code only, and
`game_startup.exe`'s 46 382 are dominated by the 16 384-page commit loop.

The COM histogram for the D3D12 fixture is the evidence that each call reached the right method:

```
ID3D12DescriptorHeap::GetCPUDescriptorHandleForHeapStart=3  ID3D12Device::CreateRenderTargetView=2
ID3D12GraphicsCommandList::ResourceBarrier=2  IDXGISwapChain3::GetBuffer=2  IDXGIFactory4::EnumAdapters1=1
IDXGIAdapter1::GetDesc1=1  ID3D12Device::CreateCommandQueue=1  ID3D12Device::CreateCommandAllocator=1
ID3D12Device::CreateCommandList=1  ID3D12Device::CheckFeatureSupport=1  ID3D12Device::CreateFence=1
ID3D12Device::CreateDescriptorHeap=1  ID3D12Device::GetDescriptorHandleIncrementSize=1
ID3D12Device::CreateRootSignature=1  ID3D12Device::CreateGraphicsPipelineState=1
IDXGIFactory4::CreateSwapChainForHwnd=1  IDXGISwapChain3::QueryInterface=1  IDXGISwapChain3::Present=1
ID3D10Blob::GetBufferPointer=1  ID3D10Blob::GetBufferSize=1  ID3D10Blob::Release=1
ID3D12CommandQueue::ExecuteCommandLists=1  ID3D12GraphicsCommandList::SetGraphicsRootSignature=1
ID3D12GraphicsCommandList::SetPipelineState=1  ID3D12GraphicsCommandList::DrawInstanced=1
IDXGISwapChain3::GetCurrentBackBufferIndex=1
```

### The milestone, stated accurately

The target sentence for this round was *"the emulator loaded DOOM 2016's structure and crashed at
`D3D12CreateDevice` because `IDXGIFactory::CreateSwapChain` is not implemented."*

That is **not** what the measurements show, and the difference mattered:

* `IDXGIFactory::CreateSwapChain` (slot 10) and `CreateSwapChainForHwnd` (slot 15) were **already
  implemented**. The failure was not a missing D3D12 feature.
* What actually happened is recorded in the trace below: the guest's call to
  `factory->lpVtbl->EnumAdapters1` executed `kernel32!VirtualProtect` instead, returned `1`, left
  the adapter pointer `NULL`, and the program then took an `access violation at 0x0`. The COM call
  never reached the D3D12 HLE at all — the trace contained **no** `H d3d12` line for it.
* With that fixed, the same fixture runs the entire 25-stage boot sequence and presents a frame.

So the honest quotable result is:

> The emulator loads and executes (synthetic, DOOM-2016-shaped) PE32+ D3D12 code from the virtual
> `C:\Game` volume and reaches `IDXGISwapChain::Present` with a rendered 1280×720 RGBA frame —
> 2 216 guest instructions, 0 page faults, 31 distinct COM calls, exit code 0 — after fixing a
> COM-stub/Win32-import address-space alias that had been masquerading as a missing D3D12 feature.

(This is a *shape* match, not the real game: no DOOM 2016 binary or data is involved. See
"Blockers" for what a real title would hit next.)

## Resolved: the COM-vtable / import-thunk alias (2026-10-29)

`D3d12Subsystem::init_memory` allocated its vtable stubs from `THUNK_BASE + 0x1000`, which is
exactly `IMPORT_THUNK_BASE`. Both pools handed out the same addresses, so binding the guest's
imports overwrote the COM thunk→method map. Trace from `doom_d3d12_startup.exe` before the fix:

```
H ... dxgi.dll!CreateDXGIFactory2 -> rax=0x0 ret=0x41d214
I 0x41d25e rax=0x7ff400000000                      # factory->lpVtbl
...
H 0x7ff0000010c0 kernel32.dll!VirtualProtect -> rax=0x1 ret=0x41d26d   # ← slot 12, not EnumAdapters1
...
STAGE 3: IDXGIFactory1::EnumAdapters1(0)
STAGE_FAIL n=3 api=IDXGIFactory1::EnumAdapters1 hr=0x00000000       # S_OK with adapter == NULL
```

Fix (`5fe1172`): one VA range per pool. `COM_THUNK_BASE = 0x7FF1_0000_0000`,
`COM_THUNK_REGION_SIZE = 0x1_0000`, mapped by `init_memory`; the run loop dispatches that range
**before** the import-thunk window, and an unregistered COM thunk is now a fault
(`unregistered COM thunk 0x…`) instead of a fallthrough.

Three related defects were fixed in the same pass:

1. **Every D3D12 slot name was off by one.** `ID3D12Object` has four methods (`GetPrivateData` is
   slot 3 — unlike DXGI's `IDXGIObject`, which starts with `SetPrivateData`), so `GetNodeCount` is
   7 and `CreateCommandQueue` is 8. Slot numbering in the dispatcher was already correct; only the
   names in logs and histograms were shifted, which is why earlier logs looked plausible but wrong.
   `d3d12_hle::method_name`/`interface_name` now carry the real layout.
2. **The default arm answered `S_OK`.** Every unimplemented slot silently succeeded, so a caller
   carried on with an uninitialised object and died somewhere unrelated. It now answers
   `E_NOTIMPL`, records the method in `unimplemented_methods()`, and traces
   `K COM Interface::Method this=… args=[…] -> 0x80004001`.
3. **`CheckFeatureSupport` zero-filled its answer**, which is a *negative* answer:
   `MaxSupportedFeatureLevel = 0` is "no feature level", `HighestShaderModel = 0` is not a valid
   enum, `MaxGPUVirtualAddressBits = 0` sizes resource heaps to zero. It now answers
   `FEATURE_LEVELS` (highest requested ≤ 12_0, measured `0xc000`), `ARCHITECTURE`,
   `GPU_VIRTUAL_ADDRESS_SUPPORT` (40/40) and `SHADER_MODEL` (echo ≤ 6.7).

Also added: `IDXGIAdapter1::GetDesc1` (slot 10, 312-byte `DXGI_ADAPTER_DESC1`, hardware-class so
engines do not skip the adapter), `ID3D12GraphicsCommandList::ResourceBarrier` (26) and
`Set{Compute,Graphics}RootSignature` (29/30) — void calls must not return `E_NOTIMPL`.

## How a failure is reported

`tests/game/doom_d3d12_startup.c` prints the stage name *before* every call, so a crash always
names the API that was executing, then prints one line with the four things needed to fix it:

```
STAGE 13: IDXGIFactory4::CreateSwapChainForHwnd
STAGE_FAIL n=13 api=IDXGIFactory4::CreateSwapChainForHwnd hr=0x887a0001 last_error=0
```

and exits with the stage number, so `exit:13` in a trace is the exact failure point. The runner
classifies an exit as:

| Status | Meaning |
| --- | --- |
| `PASS` | expected exit code **and** completion marker seen (`DOOM_STARTUP_OK`, `HELLO_WORLD_OK`, `GAME_STARTUP_RESULT failures=0`) |
| `STAGE_BLOCKED` | the guest reached a named stage, learned the API is unsupported, and exited deliberately — the current milestone state, not a regression |
| `GUEST_FAULT` | an access violation / decode fault inside the guest — always a defect |
| `FAIL` / `TIMEOUT` | wrong exit code, missing marker, or a slice/time budget exhausted |

Everything a run produces is published as a check run (`porthole-x64-game`) and as a JSON report
(`artifacts/game-report.json`): instruction count, exit code, page faults, Win32 histogram, COM
histogram, unimplemented Win32 symbols, unimplemented COM methods, the failing stage, and the
presented frame's size/non-zero bytes/sha256.

## COM slot coverage (hand-written arms per interface)

| Interface | Slots with a real arm | Interface size | Notable gaps |
| --- | --- | --- | --- |
| `ID3D12Device` | 25 | 44 | `CreateHeap` 28, `CreatePlacedResource` 29, `CreateReservedResource` 30, `CreateSharedHandle` 31–33, `MakeResident`/`Evict` 34–35 |
| `ID3D12GraphicsCommandList` | 21 | 60 | `SetDescriptorHeaps` 28, `SetGraphicsRootDescriptorTable` 32, `SetGraphicsRootConstantBufferView` 38, `ClearDepthStencilView` 47, `ExecuteIndirect` 59 |
| `IDXGISwapChain3` | 11 | 40 | `GetFrameLatencyWaitableObject` 33, `SetColorSpace1` 38 |
| `IDXGIFactory4` | 8 | 28 | `CreateSoftwareAdapter` 11, `CreateSwapChainForComposition` 24 |
| `ID3D12CommandQueue` | 6 | 19 | `UpdateTileMappings` 8, `BeginEvent`/`EndEvent` 12–13 |
| `ID3D12Resource` | 4 | 15 | `ReadFromSubresource` 12, `GetHeapProperties` 13 |
| `ID3D12DescriptorHeap` | 3 | 11 | none for a first frame |
| `ID3D12Fence` | 3 | 11 | none for a first frame |
| `IDXGIAdapter1` | 3 | 16 | `CheckInterfaceSupport` 9, `GetDesc2` 11 |

## Blockers — what the next real title will hit

Ordered by what stops the earliest frame. Each item is a measured hole, not a guess: the D3D12
fixture above is *just* enough to present a clear colour, and the list is what it does **not**
exercise.

1. **Shaders are fake.** `D3D12SerializeRootSignature` returns a 16-byte `DXBCRootSigV1` blob and
   `CreateGraphicsPipelineState` does not parse DXBC — the reported pixel0 `[0,255,0,255]` is a
   hard-coded green constant, not the output of a shader. A real title needs
   DXBC → DXIL/SPIR-V → WGSL lowering before WebGPU can draw anything.
2. **Descriptors are never written.** `CreateConstantBufferView`/`CreateShaderResourceView`/
   `CreateUnorderedAccessView`/`CopyDescriptors*` return `0` without touching descriptor memory,
   so any bindless or table-based binding resolves to garbage.
3. **Resources are bookkeeping only.** `CreateCommittedResource` (27) exists, but
   `CreateHeap`/`CreatePlacedResource` do not, and `Map`/`Unmap` do not expose a GPU-visible buffer
   to WebGPU yet.
4. **The command stream is recorded, not executed.** `ExecuteCommandLists` reads a command list
   whose recorded commands (barriers, RTVs, clear, draw) are not yet replayed into a
   `GPUCommandEncoder`.
5. **`Present` rasterises on the CPU.** The 1280×720 RGBA buffer is produced by the fallback
   rasteriser in `d3d12_hle`; nothing is uploaded to a canvas/WebGPU swap chain in the tested path.
6. **Feature queries beyond the four answered** (`D3D12_OPTIONS`, `FORMAT_SUPPORT`,
   `MULTISAMPLE_QUALITY_LEVELS`, `D3D12_OPTIONS1..5`) still answer zeros.
7. **Win32 side:** `environ` (35 failures) and `directory` (23 failures) remain, and a real title
   will additionally need `CreateFileMapping`/`MapViewOfFile`, `GetSystemInfo`, `CreateEventW`
   cross-thread waits, `timeGetTime`/`QueryPerformanceCounter` pacing, and `XAudio2`/DirectSound
   for audio.

### Prioritized D3D12/COM API list for the first real frame

Extending the HLE in this order gives the shortest path from "clear colour" to "a triangle from
real shaders":

1. `ID3D12Device::CreateCommittedResource` (27) — grow beyond bookkeeping: real `D3D12_RESOURCE_DESC`
   parsing, texture vs buffer, `D3D12_HEAP_TYPE_UPLOAD`/`READBACK`.
2. `ID3D12Resource::Map` (9) / `Unmap` (10) — CPU-visible pointer into the VMM so uploads work.
3. `ID3D12Device::CreateHeap` (28) + `CreatePlacedResource` (29) — used by every modern engine.
4. `ID3D12Device::CreateShaderResourceView` (18), `CreateConstantBufferView` (17),
   `CreateSampler` (22), `CopyDescriptors` (23), `CopyDescriptorsSimple` (24) — write real
   32-byte descriptors into heap memory.
5. `ID3D12GraphicsCommandList::SetDescriptorHeaps` (28), `SetGraphicsRootDescriptorTable` (32),
   `SetGraphicsRootConstantBufferView` (38) — table binding.
6. `D3D12SerializeRootSignature` / `CreateRootSignature` — parse the real DXBC root signature
   (`D3D12_ROOT_SIGNATURE_DESC`) instead of returning a stub blob.
7. `CreateGraphicsPipelineState` (10) — DXBC parse → shader translation → `GPURenderPipeline`.
8. `ID3D12CommandQueue::ExecuteCommandLists` (10) — replay recorded commands into a WebGPU
   `GPUCommandEncoder`.
9. `IDXGISwapChain::Present` (8) / `Present1` (22) — present the WebGPU texture to the canvas
   (CPU rasteriser stays as the WebGL2/CPU fallback).
10. `CheckFeatureSupport` (13) — `D3D12_OPTIONS`, `FORMAT_SUPPORT`, `MULTISAMPLE_QUALITY_LEVELS`.
11. `QueryInterface` for `ID3D12Device1..5` and `IDXGIFactory5/6` — engines probe these during
    device creation.

## Resolved earlier: the CRT-startup fault

Two defects, both fixed, both found with `xtrace`:

* **`_initterm` cursor advanced by function pointer.** `next_slot = fn_ptr + 8` made the scan
  continue inside `.text` and read instruction bytes as a pointer
  (`0x100c70002701c` = `1c 70 02 00 c7 00 01 00`). `find_next_initterm_fn` now returns
  `(slot_va, fn_va)` and the cursor uses the *slot*. The same path also overwrote `[rsp]` on
  upcall resume and treated "no more constructors" as process exit.
* **`__p___argv` returned the vector instead of the variable.** The guest does
  `call __p___argv; mov (%rax),%rax`, so the API must return a `char***`; `argv[0]` was the
  characters of the string. Fixed with a `var → arr → string` allocation (same double indirection
  for `__p__environ`/`__p___wargv`).

## How the trace is produced

`rust/porthole-x64-wasm/src/bin/xtrace.rs` (native, no wasm needed) plus
`.github/workflows/x64-trace.yml`:

* per-instruction trace (`I` lines: rip, rsp before/after, registers, instruction bytes),
* HLE dispatch log (`H` lines: thunk, `dll!symbol`, `[rsp]`, return address),
* COM dispatch log (`H d3d12 IDXGIFactory4::EnumAdapters1 this=… -> rax=… (0x…)`) and COM notes
  (`K COM …`),
* upcall transitions (`U`/`R`),
* **write watchpoints** (`W` lines: address, value, width, writing RIP),
* full `fault_snapshot()`: all 16 GPRs, RSP/RBP, 32 stack qwords, mapping/protection/residency of
  the faulting page, RIP ring,
* `--hle-only [--hle-match a,b,c]` so a 160-million-instruction run still fits in a 300-line
  trace, and `run_game` invocations for the three game fixtures in the same workflow.

Because log/artifact downloads are blocked in this sandbox, each run publishes its output as a
check-run `output.summary` (`porthole-x64-trace:*`, `porthole-x64-game`) and reads it back with
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs/<id> -q .output.summary`.

## Remaining work (in order)

1. `directory`: a wildcard in a *non-final* component must fail with `ERROR_PATH_NOT_FOUND` while a
   wildcard in the final component is `ERROR_INVALID_NAME` (directory.c:234-249).
2. `environ`: `GetEnvironmentVariableA/W` buffer-size reporting and `ExpandEnvironmentStrings`
   over-reporting rules (35 failures).
3. D3D12: work down the prioritized list above, starting with committed/placed resources and
   descriptor writes, so the "green triangle" becomes a shader-driven triangle.
4. Wire `Present` to a canvas in `js/x64-d3d12-renderer.js` and confirm the same 1280×720 frame
   appears in the browser path, not just in the Node harness.
