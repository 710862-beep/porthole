# Pure-Browser x86-64 Windows Emulator Plan (NVMe-Backed Virtual Memory + WebGPU + Wine Conformance Suite)

> **Session Date:** 2026-10-29
> **Active Branch:** `arena/e737e676-porthole`
> **Target Environment:** Locked Chromebook / Pure Browser (Chrome + File System Access API + WebAssembly + WebGPU/WebGL2/Software Rasterizer + Web Audio API)

---

## 1. Architectural Scope & Mandatory Technical Pillars

This blueprint specifies and governs the real implementation of a **pure-browser 64-bit Windows (`PE32+` / `x86-64`) execution environment** inside Porthole capable of running on a locked Chromebook with zero Linux containers, zero native daemons, and zero Ring 0 drivers:

1. **Pillar A — x86-64 Interpreter in Rust → WebAssembly (`rust/porthole-x64-wasm/`)**:
   - Full 64-bit register file: `RAX`–`R15` (with 64/32/16/8-bit subregister aliasing and Win64 32-bit zero-extension), `RIP`, `RFLAGS`, `GS`/`FS` segment bases (`NT_TIB`/`TEB` at `GS:[0x30]`, `PEB` at `GS:[0x60]`), and 256-bit `YMM0`–`YMM15` (`XMM0`–`XMM15` lower-128 aliasing + `MXCSR`).
   - Full instruction decoder & executor for x86-64 general-purpose, string/atomic (`LOCK XADD`, `CMPXCHG`, `REP MOVS/STOS`), SSE/SSE2/SSE4 (`MOVUPS`, `MOVAPS`, `MOVDQA`, `MOVDQU`, `ADDPS`, `ADDPD`, `SUBPS`, `MULPS`, `XORPS`, `PXOR`, `PCMPEQB`, `PMOVMSKB`, `UCOMISS/SD`, `CVT*`), and VEX-encoded AVX/AVX2 (`VMOVUPS`, `VMOVDQU`, `VADDPS`, `VPADDD`, `VPXOR`, `VPCMPEQB`, `VPMOVMSKB`, `VZEROUPPER`).
   - Basic-block instruction cache (`icache`) indexed by `(rip, page_write_epoch)` to avoid re-decoding instructions while invalidating automatically on self-modifying code.

2. **Pillar B — NVMe-Backed Virtual Memory Manager (`rust/porthole-x64-wasm/src/vmm.rs` + `js/nvme-vmm-bridge.js`)**:
   - Supports **16 GB–64 GB sparse 64-bit guest virtual address space** (`VirtualAlloc`, `VirtualFree`, `VirtualProtect`, `VirtualQuery`).
   - 4 KB page granularity (`read_page(addr: u64) -> [u8; 4096]`, `write_page(addr: u64, data: [u8; 4096])`).
   - Resident `HashMap<u64, Vec<u8>>` page cache in browser RAM with O(1) amortized generation-stamped LRU eviction.
   - Sharded 64 MB backing swap files (`.porthole_vmem/shard_XXXXX.bin`) persisted via Chrome's File System Access API (`window.showDirectoryPicker()` / `FileSystemDirectoryHandle`), with trap-and-resume page-fault resolution and batched asynchronous dirty-page writeback.

3. **Pillar C — Hybrid AOT / JIT WebAssembly Compiler (`rust/porthole-x64-wasm/src/jit.rs` + `js/nvme-vmm-bridge.js`)**:
   - **AOT Phase**: Pre-scans `.text` basic blocks at PE32+ load time, emits valid standalone WebAssembly modules (`\0asm\x01\0\0\0`) operating directly on the CPU state buffer, validates/instantiates them with `WebAssembly.Module`, and caches `.wasm` blobs to `.porthole_jit_cache/` on the NVMe drive.
   - **JIT Phase**: Compiles hot dynamic / self-modifying `PAGE_EXECUTE_READWRITE` basic blocks at runtime (`exec_count >= threshold`), invalidates compiled artifacts when `page_write_epoch` advances, and persists compiled Wasm blobs across sessions.

4. **Pillar D — Win64 / NT High-Level Emulation & Cooperative Threading (`rust/porthole-x64-wasm/src/win32_hle.rs` + `js/x64-worker-pool.js`)**:
   - Microsoft x64 ABI (`RCX`, `RDX`, `R8`, `R9`, 32-byte shadow space, stack args, `RAX` return, `XMM0`–`XMM3` float args) + synthetic IAT & COM vtable thunk dispatch (`0x0000_7FFF_0000_0000`).
   - Subsystems implemented with real state and semantics:
     - `kernel32.dll` / `kernelbase.dll` / `ntdll.dll`: `VirtualAlloc/Free/Protect/Query`, `HeapCreate/Alloc/ReAlloc/Free/Size`, `Global/Local` atoms & memory, `CreateFileA/W`, `ReadFile`, `WriteFile`, `SetFilePointer[Ex]`, `GetFileSize[Ex]`, `CreateDirectoryA/W`, `RemoveDirectoryA/W`, `GetCurrentDirectoryA/W`, `SetCurrentDirectoryA/W`, `GetWindowsDirectoryA/W`, `GetSystemDirectoryA/W`, `GetLogicalDrives`, `GetDriveTypeA/W`, `GetDiskFreeSpace[Ex]A/W`, `GetSystemPowerStatus`, `GetEnvironmentVariableA/W`, `SetEnvironmentVariableA/W`, `GetEnvironmentStringsA/W`, `ExpandEnvironmentStringsA/W`, `LoadLibraryA/W`, `GetModuleHandleA/W`, `GetProcAddress`, `TlsAlloc/GetValue/SetValue/Free`, `CreateMutex/Event/Semaphore`, `WaitForSingleObject`, `WaitForMultipleObjects`, `CreateThread` (cooperative multi-thread scheduler + Web Worker offloader), `ExitProcess`, string/codepage helpers (`MultiByteToWideChar`, `WideCharToMultiByte`).
     - `msvcrt.dll` & UCRT (`ucrtbase.dll` / `api-ms-win-crt-*.dll`): full C runtime startup & stdio/heap/string/env/math/time support required by unmodified MinGW/Clang PE32+ Wine conformance binaries (`__main`, `_initterm`, `__acrt_iob_func`, `__stdio_common_vfprintf`, `__stdio_common_vsprintf`, `malloc/calloc/realloc/free`, `setvbuf`, `fflush`, etc.).
     - `user32.dll` & `gdi32.dll`: `wsprintfA/W`, `wvsprintfA/W`, `CharUpperA/W`, `CharLowerA/W`, `CharPrevA`, `CharPrevExA`, `SetRect`, `SetRectEmpty`, `CopyRect`, `IsRectEmpty`, `EqualRect`, `SubtractRect`, `InflateRect`, `IntersectRect`, `UnionRect`, `OffsetRect`, `PtInRect`, `CreateWindowExA/W`, `DestroyWindow`, `DefWindowProcA/W`, `PeekMessageA/W`, `GetDC`, `ReleaseDC`, `CreateCompatibleDC`, `DeleteDC`, `CreateBitmap`, `SelectObject`, `DeleteObject`, `GetStockObject`, `FillRect`, `GetPixel`, `SetPixel`.
     - `d3d12.dll` & `dxgi.dll`: COM object + refcounted vtable synthesis for `IDXGIFactory1/2/4`, `IDXGIAdapter1`, `IDXGISwapChain1/3`, `ID3D12Device`, `ID3D12CommandQueue`, `ID3D12CommandAllocator`, `ID3D12GraphicsCommandList`, `ID3D12DescriptorHeap`, `ID3D12RootSignature`, `ID3D12PipelineState`, `ID3D12Resource` (buffers, textures, upload/readback `Map`/`Unmap`, `CopyTextureRegion`), `ID3D12Fence`, `D3D12SerializeRootSignature`, DXBC shader inspection (`SV_Target0` constant & root-constant shaders), `ClearRenderTargetView`, `DrawInstanced`, and `Present`.

5. **Pillar E — Tiered Graphics Translation Pipeline (`js/x64-d3d12-renderer.js`) & Browser Launch UI (`x64.html` + `js/x64-app.js` + Web Audio synthesizer)**:
   - **Tier 1 — WebGPU**: `navigator.gpu` adapter/device, WGSL render pipelines, render-target clear/draw, readback staging, and swapchain presentation.
   - **Tier 2 — WebGL2**: `WebGL2RenderingContext` GLSL ES 3.00 shader translation, framebuffer attachments, `readPixels` readback, and presentation.
   - **Tier 3 — Software Rasterizer**: Deterministic RGBA8 framebuffer in memory with viewport/scissor clipping, `ClearRenderTargetView`, triangle rasterization (`DrawInstanced`), `CopyTextureRegion` readback parity, and `<canvas>` `putImageData` scanout.

---

## 2. Phase-by-Phase Topology

```text
[Browser Tab: x64.html + js/x64-app.js]
   │
   ├──► [Wasm x86-64 Core: vendor/porthole-x64-wasm/porthole_x64_wasm_bg.wasm]
   │       ├── CpuX64 (RAX..R15, RIP, RFLAGS, GS TEB/PEB, YMM0..15, BasicBlock ICache)
   │       ├── Hybrid Wasm AOT/JIT Compiler (\0asm emitter + WebAssembly.Module runner)
   │       ├── Win64 / NT HLE + COM Vtable Dispatcher (kernel32, user32, gdi32, d3d12, dxgi, ucrt)
   │       └── VirtualMemoryManager (64 GB VA space, 4 KB pages, LRU RAM cache + dirty tracking)
   │
   ├──► [NVMe Drive via File System Access API: js/nvme-vmm-bridge.js]
   │       ├── C:\Game\             (PE32+ executables, DLLs, game data via CreateFileW/ReadFile/WriteFile)
   │       ├── .porthole_vmem\      (64 MB sharded swap files: shard_00000.bin .. shard_N.bin)
   │       └── .porthole_jit_cache\ (Persisted AOT/JIT compiled WebAssembly blocks)
   │
   └──► [Tiered Graphics & Audio Output: js/x64-d3d12-renderer.js]
           ├── WebGPU -> WebGL2 -> Software RGBA8 Rasterizer (<canvas>)
           └── Web Audio API PCM output node
```

---

## 3. Real Wine Conformance Test Suite & Verification Gates

Every component in this plan must be validated against **real 64-bit Windows `PE32+` (`0x8664`) conformance binaries** compiled with `zig cc -target x86_64-windows-gnu` from pinned upstream Wine source (`vendor/wine-source`, commit `0738d528db522f52d9d75f2aec712688dd31d1d2`, LGPL-2.1-or-later) using Wine's unmodified `include/wine/test.h` test runner:

1. **`kernel32_test.exe`** (unmodified upstream `dlls/kernel32/tests/{power.c, drive.c, atom.c, environ.c, directory.c}`):
   - Subtests: `power`, `drive`, `atom`, `environ`, `directory` — **0 failures**, exit code `0`.
2. **`user32_test.exe`** (unmodified upstream `dlls/user32/tests/{wsprintf.c, uitools.c}`):
   - Subtests: `wsprintf`, `uitools` — **0 failures**, exit code `0`.
3. **`d3d12_test.exe`** (unmodified upstream `dlls/d3d12/tests/d3d12.c`):
   - Subtest: `d3d12` (`print_adapter_info`, `test_ordinals`, `test_interfaces`, `test_create_device`, `test_draw`, `test_swapchain_draw`, `test_swapchain_refcount`, `test_swapchain_size_mismatch`, `test_swapchain_backbuffer_index`, `test_desktop_window`, `test_invalid_command_queue_types`) — **0 failures**, exit code `0`, real pixels drawn, read back via `CopyTextureRegion` + `ID3D12Resource::Map`, and presented to the swapchain.
4. **`porthole_x64_plan_test.exe`** (64-bit `PE32+` Wine `test.h` conformance suite):
   - Explicitly validates **16 GB+ `VirtualAlloc` sparse address space + LRU RAM eviction & NVMe shard reload**, **SSE + 256-bit AVX/AVX2 `YMM` execution**, **AOT + dynamic `PAGE_EXECUTE_READWRITE` self-modifying JIT invalidation & Wasm bytecode cache persistence**, **`CreateFileW`/`WriteFile`/`ReadFile` on NVMe `C:\Game`**, and **cooperative multi-threading (`CreateThread` + `WaitForSingleObject` + `LOCK XADD`)** — **0 failures**, exit code `0`.
5. **Existing Porthole Regression Preservation**:
   - `npm run check:syntax`, `npm test` (all 32-bit `retrowin32` + JS/DOM/VFS/D3D tests), and `npm run test:wine` (extended to validate both architectures cleanly) must all pass 100% green.

---

## 4. Performance Expectations & Hard Technical Boundaries

- **Explicit Expectation**: *This will run at 0.1-1 FPS due to I/O bottlenecks and interpretation overhead. The goal is to boot and render, not to play.*
- **Viable Targets for Boot/Render Experimentation**: Compact 64-bit D3D12/Vulkan SDK samples, older DRM-free 64-bit Unity titles, and post-Denuvo DRM-free builds with straightforward Win64 imports.
- **Immediate Hard Exclusions**: Kernel-level anti-cheat (`vgk.sys`, `EasyAntiCheat_EOS.sys`, `BEDaisy.sys`, `randgrid.sys`), VM/anti-tamper DRM (Denuvo, VMProtect), and Ring 0 `.sys` kernel drivers will fail immediately by design and are never circumvented.
