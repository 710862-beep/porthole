# x86-64 emulator — measured status (2026-10-30)

This file records **measured** evidence only. New acceptance claims separate AUTHORING, EXECUTION,
RENDERING, and GAMEPLAY. A synthetic guest, a host-authored pixel, or a successful `Present` call is
not a real-game render or gameplay result. Historical fixture results below are explicitly not
qualifying evidence for the current milestone.

## GATE 1 — independent binary, Tier A: **PASS** (EXECUTION; Node/Wasm on CI, not Chrome/Chromebook)

### Pinned third-party executable

| Field | Measured value |
| --- | --- |
| Product | 7-Zip Standalone Console `7za.exe`, x64, version **21.07** (embedded `FileVersion` and `ProductVersion`; copyright 2021-12-26) |
| Package URL | `https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz` |
| Package SHA-256 | `04f9738ee00be8be53f5d06254a9e6e4b5117b17f8b74058477d870e62764a7d` |
| Executable path in package | `package/win/x64/7za.exe` |
| Executable size / SHA-256 | 1,231,360 bytes / `b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95` |
| PE identity | PE32+ / AMD64 `0x8664`; Windows console subsystem |
| Acquisition | `node scripts/fetch-7za.mjs`; archive and executable hashes checked before writing ignored `tests/assets/third-party/7za.exe` |
| Acquisition runner/device | Node v22.22.3 / Linux 6.1.158+ x64; Intel Xeon Processor @ 2.60GHz; 4,131,278,848 bytes RAM (Arena sandbox, not Chrome or the target Chromebook) |

The byte-identical executable was independently identified by `objdump -p` and embedded version
strings. Its **complete import table** is:

```text
OLEAUT32.dll: ordinals #7, #9, #10, #2, #6, #4
USER32.dll:   CharUpperW, CharPrevExA
ADVAPI32.dll: OpenProcessToken, SystemFunction036, GetFileSecurityW, SetFileSecurityW,
              RegOpenKeyExW, RegQueryValueExW, AdjustTokenPrivileges, LookupPrivilegeValueW,
              RegCloseKey
msvcrt.dll:   _c_exit, _XcptFilter, _onexit, __dllonexit, ??1type_info@@UEAA@XZ,
              ?terminate@@YAXXZ, __C_specific_handler, _beginthreadex, exit, _isatty,
              realloc, memset, strlen, wcsstr, wcscmp, _exit, memmove, fflush, fputc,
              fputs, _iob, fgetc, fclose, free, _CxxThrowException, malloc, memcmp,
              _purecall, __CxxFrameHandler, memcpy, _cexit, __getmainargs, __initenv,
              _initterm, __setusermatherr, _commode, _fmode, __set_app_type, strcmp
KERNEL32.dll: SetThreadAffinityMask, CreateEventW, SetEvent, ResetEvent, CreateSemaphoreW,
              ReleaseSemaphore, InitializeCriticalSection, GetVersionExW, SetFileTime,
              ResumeThread, WaitForSingleObject, VirtualFree, VirtualAlloc, GetOEMCP,
              LocalFileTimeToFileTime, GetConsoleMode, SetConsoleMode, SetFileApisToOEM,
              GetCommandLineW, GetConsoleScreenBufferInfo, SetConsoleCtrlHandler,
              GetProcessTimes, QueryPerformanceFrequency, QueryPerformanceCounter,
              DeleteCriticalSection, SetProcessAffinityMask, OpenEventW, UnmapViewOfFile,
              MapViewOfFile, OpenFileMappingW, WaitForMultipleObjects, LeaveCriticalSection,
              EnterCriticalSection, GetStdHandle, GetSystemTimeAsFileTime, FileTimeToDosDateTime,
              DosDateTimeToFileTime, IsProcessorFeaturePresent, GlobalMemoryStatusEx,
              GetSystemInfo, GetProcessAffinityMask, FileTimeToLocalFileTime,
              FileTimeToSystemTime, CompareFileTime, GetCurrentProcess, GetDiskFreeSpaceW,
              SetEndOfFile, WriteFile, ReadFile, GetLastError, MultiByteToWideChar,
              WideCharToMultiByte, FreeLibrary, LoadLibraryW, GetModuleFileNameW, LocalFree,
              FormatMessageW, CloseHandle, CreateFileW, SetFileAttributesW, RemoveDirectoryW,
              MoveFileW, GetProcAddress, GetModuleHandleW, CreateDirectoryW, DeleteFileW,
              SetCurrentDirectoryW, GetCurrentDirectoryW, GetTempPathW, SetLastError,
              GetCurrentProcessId, GetTickCount, GetCurrentThreadId, GetFileInformationByHandle,
              FindClose, FindFirstFileW, FindNextFileW, GetModuleHandleA, GetFileAttributesW,
              GetLogicalDriveStringsW, DeviceIoControl, GetFileSize, SetFilePointer
```

### Measured execution (CI run 41031294277, commit `edbd6a7`)

`node tests/third-party/run-7za.mjs` inside the Wasm core (Node v22.23.4, linux
7.0.0-1017-azure x64, AMD EPYC 7763, 16,760,344,576 bytes RAM — CI runner, **not** Chrome and
**not** the target Chromebook; Gate 4 device evidence is still owed). The unmodified binary above
ran a real archive round-trip and the fail-closed runner verified byte identity:

| Phase | Command (guest argv) | Terminal state | Guest instructions | Wall time | Throughput |
| --- | --- | --- | --- | --- | --- |
| Create | `7za a -t7z -y -bd -mmt1 -mx=1 C:\Game\roundtrip.7z C:\Game\roundtrip-input.bin` | `exit:0` | 26,606,358 | 4,224 ms | 6.30 MIPS |
| Extract | `7za e -y -bd -mmt1 -oC:\Game\extract C:\Game\roundtrip.7z` | `exit:0` | 7,377,308 | 1,056 ms | 6.99 MIPS |

Workload, recorded in the report: deterministic 262,144-byte input
(`((i*131+(i>>8)*17)^(i>>3))&0xff`), single-threaded (`-mmt1`, because guest thread bodies are not
yet scheduled — named limitation, not hidden), fastest compression (`-mx=1`), resident-page cap
65,536 pages with a host evicted-page store (Gate 3 will re-run with a deliberately small cache).
Guest console, create phase (guest-authored output, verbatim excerpt):

```text
7-Zip (a) 21.07 (x64) : Copyright (c) 1999-2021 Igor Pavlov : 2021-12-26
Scanning the drive:
1 file, 262144 bytes (256 KiB)
Creating archive: C:\Game\roundtrip.7z
Add new data to archive: 1 file, 262144 bytes (256 KiB)
Files read from disk: 1
Archive size: 17021 bytes (17 KiB)
Everything is Ok
```

Extract also ended with `Everything is Ok`; extracted bytes compare identical to the input by
SHA-256 (runner fails closed otherwise). One imported-but-unused symbol remained unimplemented and
was tolerated by the guest: `SetDefaultDllDirectories` (called once, result ignored by 7za).
This is an **EXECUTION** claim only — no rendering or gameplay is implied.

### Failure history that led here (all measured, in order)

1. CI `41026934026`: fault at **29 instructions** — `access violation at 0x7ff000001000`,
   `unimplemented=__set_app_type`. Root cause: msvcrt **data** imports (`_fmode`, `_commode`,
   `_iob`, `__initenv`) were bound to code-thunk VAs, so CRT startup wrote `_fmode` through
   `0x7ff000001350`. Fixed by giving data imports real writable guest cells
   (`Win32Kernel::init_data_imports`) and binding them by cell VA in the loader.
2. CI `41030096921`: fault at **96,173 instructions**, `ret=0x0` out of `_initterm` after running
   7-Zip's C++ static constructors. Root cause: HLE upcalls staged the return sentinel at `rsp-8`,
   putting a constructor's legitimate 32-byte Win64 register-home space exactly over `_initterm`'s
   own return-address slot. Fixed by staging upcalls with a real frame at `rsp-0x30` (sentinel +
   home space + ABI alignment) and restoring the bias on resume.
3. CI `41031294277`: **PASS** as measured above. Supporting fixes in the same batch: CRC32/MOVBE
   decode (7-Zip's hardware-CRC path), freelist heap with real `realloc`/`HeapSize`, FindFirst/Next,
   file mappings, OLEAUT32 BSTR/VARIANT ordinals, semaphore counts, `_iob` stdio, and the swapped
   `GetTempPath`/`GetCurrentDirectory` argument order (length-first) that also caused most Wine
   `directory` failures.

### Gate order

Gate 1 **Tier A is closed** by the measurement above. Tier B / Gate 2 followed in order (next
section). D3D12 work remains explicitly deferred; the Chocolate Doom binary's actual SDL2
software-renderer path was the target. DXBC is not DXIL; SM6 shader support will require
`dxil-spirv` or an equivalent translator as a separate, later work item.

Wine conformance movement from the shared HLE fixes (measured on `5b0bd45`, pinned Wine
`0738d528`): `directory` 23 → 28 → 2 → **0 failures** (107 tests executed; final fix was the PEB
`CurrentDirectory` field offsets in `RTL_USER_PROCESS_PARAMETERS`, `pe64.rs`), `environ` **38
failures** (432 tests, 14 todo, 2 skipped — itemized failure lines still not captured by the
harness summary; `SetEnvironmentStringsW` confirmed unimplemented). Gate 5 therefore stands at
`directory` closed, `environ` open.

## GATE 1 Tier B + GATE 2 (rendering) — Chocolate Doom: **PASS** (EXECUTION + RENDERING; Node/Wasm on CI)

### Pinned third-party binaries (run UNMODIFIED)

| Field | Measured value |
| --- | --- |
| Product | Chocolate Doom **3.1.1**, official `win64` build, `chocolate-doom.exe` |
| Release zip SHA-256 | `58c34c61ae954493fce5ff01fd553898240a0de25658aa97b43ac9510c49581f` (9,798,661 bytes, GitHub release `chocolate-doom-3.1.1`) |
| Executable size / SHA-256 | 875,520 bytes / `15e81c194df270fbd71450222e71846247926fabfb889e72e7d855903454d752` |
| Game data | Freedoom **0.13.0** `freedoom2.wad`, 28,787,748 bytes / `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b` (verified against the release's official CHECKSUM) |
| Acquisition | `node scripts/fetch-chocolate-doom.mjs` — fails closed unless zip, exe and WAD hashes all match the pins; extracts to gitignored `tests/assets/third-party/` |
| Rendering path used by this binary | SDL2 software renderer (`SDL_RenderCopy` chain). The exe's import table (published in every Tier B report) contains **no** `SDL_GL_CreateContext`/OpenGL entry points, so the SDL2 renderer — not OpenGL/WGL, and not D3D12 — is the path it actually uses |
| Guest argv | `chocolate-doom.exe -iwad C:\Game\DOOM2.WAD -timedemo demo1 -nosound` (demo1 = recorded demo shipped in the Freedoom IWAD; input is guest demo data, not host input) |

### Measured execution + rendering (commit `c8332c3`, Tier B report check `124043422676`)

Runner: `node tests/third-party/run-chocolate-doom.mjs`, Node v22.23.4, linux 7.0.0-1017-azure x64,
AMD EPYC 9V74, 16,760,344,576 bytes RAM — CI runner, **not** Chrome, **not** the Chromebook
(Gate 4 still owed).

| Metric | Measured value |
| --- | --- |
| Terminal state | `exit:4294967295` (upstream `I_Error("timed %i gametics…")` exits −1 *after* completing the timedemo; the fail-closed runner accepts this only together with the parsed guest line below) |
| Guest console (guest-authored) | `timed 2664 gametics in 2614 realtics (35.669472 fps)` — gametics parsed from guest output by the runner (`timedemo_gametics=2664`) |
| Guest instructions | 3,603,985,626 — **bit-identical instruction count across three independent CI runs** (Xeon Platinum 8573C, EPYC 7763, EPYC 9V74): the simulation is deterministic |
| Wall time / throughput | ~450–605 s depending on runner CPU (5.95–7.99 MIPS) |
| Guest presents | 2,704 `SDL_RenderPresent` calls |
| **Distinct presented-frame checksums** | **1,782** (FNV-1a64 over width‖height‖tight-RGBA of the guest-composed 800×600 backbuffer; algorithm documented in `lib.rs`, independently re-implemented in BigInt JS by the runner — `checksum_cross_check=true`) |
| Sampled frames (PPM artifacts uploaded every run) | first `fnv1a64:2ed8cde68975e9a2` @present 1 (initial clear), mid `fnv1a64:985fbc6c1d3ff7a6` @1500, final `fnv1a64:ceeff82acee82862` @2704 — pairwise distinct |
| Named blockers | none (zero unimplemented symbols reached) |

Every presented byte originates from the guest: the guest's 8-bit software rendering into its
`screenbuffer`, palette-converted by guest-issued `SDL_LowerBlit`, copied by guest-issued
`SDL_RenderCopy` through the 320×200 streaming texture → 960×600 upscaled texture → 800×600
window backbuffer that `SDL_RenderPresent` captures. The harness fail-closes unless ≥100
distinct framebuffer checksums occur **and** first/mid/final samples are pairwise distinct —
a static, cleared or stale buffer cannot pass.

This is an **EXECUTION + RENDERING** claim. It is explicitly **not**:

* interactive gameplay (input is the IWAD's recorded demo; no keyboard/mouse device exists yet);
* Chrome/Chromebook evidence (Gate 4).

### Reference cross-checks (same binary, real Wine + independently decoded reference)

* **Execution vs real Wine 9.0** (`wine-9.0 (Ubuntu 9.0~repack-4build3)`, Xvfb, CI job
  `gate2-wine-reference`): the identical `chocolate-doom.exe` (SHA-256 `15e81c19…d752`) with
  the identical IWAD printed `timed 2664 gametics in 830 realtics` and, on a second run,
  `timed 2664 gametics in 693 realtics`. **Gametics match the emulator exactly (2,664)** —
  the deterministic simulation (3,603,985,626 guest instructions, ~6 MIPS in the Wasm core)
  is bit-faithful against a real Windows-API implementation, not merely self-consistent.
  (Realtics differ, as they must: native Wine runs the demo at >100 fps.)
* **Rendering vs independently decoded reference**: `scripts/decode-title-reference.mjs`
  derives the title frame straight from the pinned IWAD — TITLEPIC patch decoded with the
  guest's own `V_DrawPatch` semantics, PLAYPAL through the guest's `I_SetPalette` conversion
  (`gammatable[0]` from upstream `tables.c`: `v<128 ? v+1 : v`, then `& ~3`) — no emulator
  code, no guest code. The emulator's
  guest-produced 320×200 title frame (measurement tap on the streaming texture) must be
  **pixel-identical** to it and equal the known-good hash **`fnv1a64:02d3105200077dee`**
  (320×200, 178 distinct colours). This replaced the original plan of comparing against a
  guest PCX screenshot under Wine: synthetic key delivery in headless Xvfb proved unreliable
  across three attempts (window found, key sent, no `DOOM*.pcx` ever written). The PCX path
  remains in the script as a non-gating bonus if a screenshot ever materialises. What this
  proves: the guest, running in our core, parsed the WAD, executed its patch renderer and
  palette setup to a framebuffer that is bit-identical to an independent implementation of
  the same maths — at the native 320×200 stream (the comparable surface; the 800×600 window
  upscale differs by design, linear vs nearest, as noted below).

### The fake-frame incident (why the harness now demands ≥100 distinct checksums)

The immediately preceding build reported "PASS" with `distinct_frame_checksums=2`: the frame
was *not* the game's rendering. Two stacked SDL HLE defects, both found from the published
evidence itself and fixed:

1. `SDL_RenderCopy` recorded its source texture but moved **zero pixels**, and
   `SDL_RenderPresent` captured that untouched intermediate texture — 2,703 identical
   clear-colour checksums. Fixed with a real compositor (`0f76900`): window backbuffer in
   guest memory, `RenderClear` fills it, `RenderCopy` performs a true scaled blit, `Present`
   captures the backbuffer.
2. That still yielded 2 distinct checksums. Per-frame probes showed the palette blit writing
   to a surface with `pitch=0`. Root cause (upstream `i_video.c`, tag `chocolate-doom-3.1.1`):
   Chocolate creates its conversion surface with
   `SDL_CreateRGBSurfaceWithFormatFrom(NULL, w, h, 0, 0, …)` — "pixels and pitch will be
   filled with the texture's values" — then locks the streaming texture *directly into*
   `&argbbuffer->pixels`/`&argbbuffer->pitch` and blits into the texture through that surface.
   Our blit trusted creation-time host records instead of the live guest `SDL_Surface`.
   Fixed in `c8332c3` (`sdl_surface_live` reads pixels@+32/pitch@+24 at call time, as real SDL
   does) — distinct checksums went 2 → 1,782.

The simulation was bit-exact throughout (identical 3,603,985,626 instructions before and after
both fixes); only the presented bytes were wrong. Lesson recorded: **execution determinism is
not rendering evidence**, and any future PASS must show framebuffer evolution, not present
counts.

### Failure history that led here (all measured, in order)

1. First probe: access violation at `0x0` after 541 instructions — named blockers `rand_s`,
   `__p__acmdln` (the expected Gate-1 failure shape: named API, not exit 0).
2. `38e1f3f`: 1,023 instructions — SDL2main's argv UTF-16→UTF-8 conversion needed
   `SDL_wcslen`/`SDL_iconv_string`, then `SDL_ShowSimpleMessageBox`; exit 0 that was **not**
   success (no `SDL_Init` reached).
3. `2e8d21e`: 2,522,659 instructions — WAD loading reached unimplemented `0F 67`
   (`PACKUSWB`); implemented with `PACKSSWB`/`PACKSSDW` (Intel saturation bounds) in `0dee9cb`.
4. `0dee9cb`/`af7f0ee`: full timedemo executed; presented frames were the fake-frame incident
   above. Runner criteria and compositor fixed; PASS at `c8332c3` as measured above.

### Gate 2 — what remains open

* **Interactive gameplay**: needs real input devices (keyboard/mouse event injection) and a
  live session, not demo playback. Not claimed.
* The comparable reference surface is the pre-scaling 320×200 guest frame; the final 800×600
  upscale differs by design (real SDL applies the app-requested "linear" filter, our HLE
  blits nearest-neighbour), so a window-resolution bit-match is not the right target.

## Historical CI measurements (not current milestone acceptance)

These earlier checks were run under Node in CI; the old reports did not retain individual fixture
PE hashes or a host/device model. They remain useful regression history, but are not GATE 1–4 PASS
claims under the new identity, runner, and device reporting rules.

| Check | Command | Historical result |
| --- | --- | --- |
| Rust core unit tests | `cargo test --all-targets` (rust 1.81, ubuntu-24.04) | **PASS** — VMM sparse VA + LRU eviction/page-fault roundtrip, hybrid Wasm JIT emitter (`\0asm` module, epoch invalidation), emulator construction |
| Wasm build | `cargo build --release --target wasm32-unknown-unknown` + `wasm-bindgen --target web` | **PASS** — `porthole_x64_wasm.js` + `porthole_x64_wasm_bg.wasm` produced and uploaded |
| Wine 64-bit fixture build | `node scripts/build-wine64-tests.mjs` (zig 0.13.0, pinned Wine `0738d528`) | **PASS** — 4 unmodified upstream tests compiled to PE32+ (`0x8664`) |
| Wine 64-bit conformance inside the Wasm emulator | `node tests/wine64/run-wine64.mjs` | **PARTIAL — 5 of 7 subtest groups pass** (`uitools`, `wsprintf`, `atom`, `drive`, `power`); `environ` (35 failures) and `directory` (23 failures) still fail |
| Authored PE32+ startup fixtures (historical; not independent/game evidence) | `node scripts/build-game-fixtures.mjs && node tests/game/run-game.mjs` | Historical Node/Wasm fixture exits were recorded; they do not qualify as Gate 1, real rendering, or gameplay. The reported RGBA buffer was host-authored and is excluded as a frame. |

These are self-authored test fixtures built from `tests/game/*.c` by
`scripts/build-game-fixtures.mjs` (zig `x86_64-windows-gnu`) and executed by
`tests/game/run-game.mjs` under Node against the Wasm module. They are AUTHORING/EXECUTION evidence
only. They are neither an independent executable nor a game, and their host-generated buffer is
not RENDERING or GAMEPLAY evidence.

## Historical authored-fixture execution (not independent-binary evidence)

Four authored PE32+ x86-64 test executables, compiled from C in this repository, were mounted on
the virtual `C:\Game` volume and executed by the emulator's PE64 loader. They are rebuilt from
source on every run (zig embeds a build-id). The old fixture report did not retain per-binary
SHA-256s or a specific CI device, so its outcomes are not acceptance PASSes under the current
reporting policy. They establish only AUTHORING and fixture EXECUTION, not game compatibility.

| Image | Bytes | What it does |
| --- | --- | --- |
| `hello_world.exe` | 150 016 | ucrt startup, `main`, stdio, `ExitProcess(0)` |
| `game_startup.exe` | 152 576 | `CreateFileW`/`WriteFile` on `C:\Game`, 2 GB `MEM_RESERVE`, 64 MB `MEM_COMMIT` write+readback on all 16 384 pages, `GetModuleHandleW`, `GetProcAddress`, indirect call through the resolved thunk, `D3D12CreateDevice`, `ExitProcess(0)` |
| `doom_d3d12_blocked.exe` | 160 768 | the same image code, launched with `/blockstage:13`, so the *failure report* is measured as well |
| `doom_d3d12_startup.exe` | 160 768 | 25-stage D3D12 boot: window → `CreateDXGIFactory2` → `EnumAdapters1` → `D3D12CreateDevice` → `CheckFeatureSupport` → queue → allocator → command list → fence → RTV heap → `D3D12SerializeRootSignature`+`CreateRootSignature` → PSO → `CreateSwapChainForHwnd` → `QueryInterface(IDXGISwapChain3)` → back buffers → RTVs → barriers → `ClearRenderTargetView` → `DrawInstanced` → `Close` → `ExecuteCommandLists` → `Present` |

Historical execution data from check run `40994645347` (Node/Wasm; per-image hashes and exact
CI device were not retained, so these are recorded measurements, not current acceptance PASSes):

```
hello_world.exe          exit=0         instructions=566    slices=1  page_faults=0  imports=54
game_startup.exe         exit=0         instructions=46382  slices=1  page_faults=0  imports=60
doom_d3d12_startup.exe   exit=0         instructions=2523   slices=1  page_faults=0  imports=57
    host buffer: 1280x720 bytes=3686400 nonZero=1843200 sha256=5d9d754bb9731380… pixel0=[0,255,0,255]
    last fixture stage: 25 IDXGISwapChain::Present(1,0) → DOOM_STARTUP_OK stages=25
doom_d3d12_blocked.exe   named-fixture-stop exit=13 instructions=1928 slices=1 page_faults=0
```

The buffer above was filled by the host HLE with a constant green clear. It is explicitly **not a
rendered frame** and does not count toward GATE 2. The fixture name is historical and does not
identify or contain DOOM.

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

### Historical COM alias finding (synthetic fixture only)

The earlier fixture trace did expose a real implementation defect: a COM thunk VA aliased the
Win32 import-thunk VA, and binding an import overwrote a COM method mapping. The trace showed
`kernel32!VirtualProtect` where the fixture expected `IDXGIFactory1::EnumAdapters1`; the COM call
never reached its HLE. The address-space separation fix remains valid engineering work.

The authored fixture subsequently traversed its scripted 25 D3D12 stages, but its reported green
buffer came from host HLE code. That result proves neither DOOM loading nor D3D12 rendering, and
must not be described as a presented frame or game milestone. The D3D12 work is deferred by the
current request; the target rendering route is the independent Chocolate Doom SDL2/OpenGL path.

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
STAGE_FAIL n=13 api=... hr=... last_error=... expected="..." actual="..." fix="..."
```

and exits with the stage number, so `exit:13` in a trace is the exact failure point. The
`doom_d3d12_blocked.exe` fixture (`/blockstage:13`) produces exactly that line on every run, so the
report path is measured rather than assumed — verbatim from `run 40994645347`:

```
=== doom_d3d12_blocked.exe :: STAGE_BLOCKED (stage 13 IDXGIFactory4::CreateSwapChainForHwnd hr=0x887a0001)
    instructions=1928 exit=13 slices=1 page_faults=0
    FAILED STAGE 13: IDXGIFactory4::CreateSwapChainForHwnd hr=0x887a0001 last_error=0
      expected: S_OK (stage 13 completes)
      actual:   hr=0x887a0001 ptr=NULL
      fix:      simulated blocked stage (--blockstage) for failure-report validation

# guest console, same run:
STAGE_FAIL n=13 api=IDXGIFactory4::CreateSwapChainForHwnd hr=0x887a0001 last_error=0 \
  expected="S_OK (stage 13 completes)" actual="hr=0x887a0001 ptr=NULL" \
  fix="simulated blocked stage (--blockstage) for failure-report validation"
```

The runner classifies an exit as:

| Status | Meaning |
| --- | --- |
| `PASS` | expected exit code **and** completion marker seen (`DOOM_STARTUP_OK`, `HELLO_WORLD_OK`, `GAME_STARTUP_RESULT failures=0`) |
| `STAGE_BLOCKED` | the guest reached a named stage, learned the API is unsupported, and exited deliberately — the current milestone state, not a regression |
| `GUEST_FAULT` | an access violation / decode fault inside the guest — always a defect |
| `FAIL` / `TIMEOUT` | wrong exit code, missing marker, or a slice/time budget exhausted |

The historical runner published fixture output as a check run (`porthole-x64-game`) and JSON
report (`artifacts/game-report.json`): instruction count, exit code, page faults, Win32/COM
histograms, unimplemented APIs, stage, and a host-produced buffer's byte count/hash. That buffer is
not presented/rendered evidence and is excluded from GATE 2.

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

## Deferred D3D12 notes — not this milestone

These are historical implementation gaps and are deliberately not being worked in this cycle. The next renderer gate targets Chocolate Doom's actual SDL2/OpenGL/WGL calls, not a synthetic D3D12 path.

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
   for audio. Measured the hard way: the first version of the blocked-stage fixture used
   `strstr`/`atoi` from msvcrt, both of which are **not implemented** — the call returned with
   `last_error=120` (`ERROR_CALL_NOT_IMPLEMENTED`) and the fixture silently never blocked. The
   fixture now parses its own command line, and `msvcrt strstr/atoi` belong on the Win32 gap list.

### Deferred D3D12/COM work list (not to be started before requested SDL2/OpenGL gates)

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

## Remaining gates (strict order)

1. **GATE 1 / Tier A:** ✅ PASS (above). **GATE 1 / Tier B execution:** ✅ PASS (above).
2. **GATE 2:** guest-originated evolving frames ✅; execution cross-validated against real
   Wine 9.0 (identical 2,664 gametics) ✅; title frame pixel-identical to an independently
   decoded IWAD reference (`fnv1a64:02d3105200077dee`) ✅. Still open: interactive gameplay
   with real input devices. No D3D12 work in this gate.
3. **GATE 3:** force evictions with an LRU smaller than the guest working set; instrument guest VA,
   resident/NVMe bytes, faults, read/write MiB, and p50/p99 latency; demonstrate trap/suspend/resume
   across asynchronous File System Access I/O and a byte-identical 1 GiB deterministic round-trip.
   Not yet run — current Tier A/B runs use a 65,536-page resident cap that the working sets fit
   inside, so the NVMe claim is presently **unproven**.
4. **GATE 4:** gather actual locked-Chromebook Chrome evidence (enterprise picker policy, WebGPU or
   WebGL2 tier, Wasm features, DPR, JS heap, physical RAM, sustained instructions/sec, screen capture,
   and trace). Node or a simulated browser is not acceptable. Not yet run — all evidence so far
   is Node on CI runners.
5. **GATE 5:** `directory` ✅ 0 failures (measured). `environ` still 38 failures
   (`GetEnvironmentVariable` buffer-size/`ERROR_MORE_DATA` semantics; needs itemized failure
   capture first — do not guess fixes without the failing test lines).

D3D12, DXBC/DXIL translation, and any other graphics backend are later work. DXBC is not DXIL;
Shader Model 6 requires `dxil-spirv` or an equivalent translator before WebGPU can execute those
shaders.

## Phase 2 basic-block JIT — measured microbench gate

The one-instruction JIT handoff was replaced by a real basic-block compiler in
`rust/porthole-x64-wasm/src/jit.rs` (ABI v2, 32 i64 context slots):

- Decodes multi-instruction GPR blocks until JMP/Jcc/RET/CALL, an unsupported
  instruction, or a page boundary. GPRs and RFLAGS are Wasm locals for the whole
  block; the CPU context is read once and written back on exit.
- Hot self-back-edges are lowered to a native Wasm `loop`/`br_if` with a
  whole-block instruction budget, so a hot loop does not cross JS per iteration.
- Static forward JMP edges can be linked with `return_call` when the host's
  `WebAssembly.validate` probe accepts tail calls; otherwise the dispatcher
  resumes the successor. The core build stays baseline because wasm-bindgen
  0.2.92 cannot parse a `+tail-call` core module.
- Unsupported/memory-writing instructions terminate the block before their side
  effect; the interpreter resumes at the exact RIP. SMC/page epochs invalidate
  artifacts and linked predecessors. Correctness lanes shadow-validate the first
  execution of each artifact/epoch, then commit atomically.

Measured authored hot-loop A/B (`tests/bench/jit-microbench.mjs`, N=20,000,000,
Node v22.22.3, candidate from CI run `41158464780`):

| mode | instructions | ms | MIPS |
|---|---:|---:|---:|
| interpreter | 40,000,002 | 2731 | 14.648 |
| jit-validate | 40,000,002 | 130 | 307.527 |
| jit-fast | 40,000,002 | 64 | 629.648 |

The JIT now exceeds the interpreter's ~10–15 MIPS on the microbench by >40x.
`x64-jit-differential` and the new `x64-jit-alu-direction` regression pass against
the candidate core. Chocolate Doom remains a separate compatibility gate: the
guest still stalls in `NET_Init` before timedemo gametics, so Doom throughput is
reported as a failure rather than a JIT PASS.

### Final Phase 2 CI Doom A/B (`41160535076`)

Core SUCCESS and Node unit/differential SUCCESS. Doom 900 s A/B remains FAIL:
interpreter 0.04 MIPS (timeout, 0 gametics), JIT 0.05 MIPS (guest exit -1, 0
gametics), 0 Wasm compile errors after the SAR opcode fix. The authored JIT
microbench gate is cleared (hundreds of MIPS); Doom compatibility is not.
