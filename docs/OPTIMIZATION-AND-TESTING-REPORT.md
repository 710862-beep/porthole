# Porthole optimization and testing report

## Status: Phase 1 initial execution in progress

This report distinguishes **implemented harness**, **executed evidence**, and **blocked coverage**.
No Phase 2 pass rate, VM-leak fix, JIT speedup, or browser/WebGPU conformance claim is made yet.

### Baseline audit

- The historical ~6 MIPS measurements are interpreter measurements under Node/Wasm on CI,
  not Chrome or Chromebook measurements. See `x64-emulator-status.md` for the original runs.
- `src/jit.rs` currently emits and caches Wasm artifacts, but `lib.rs` still advances guest
  instructions with `cpu.step_one()`. Artifact counts are not executed-JIT evidence.
- The existing D3D12 path is HLE object/command emulation. A Vulkan CTS result from a native
  host driver, or a D3D12 fixture that clears a CPU buffer, is not DX12 Ultimate/DXR or
  Vulkan-1.3/WebGPU conformance.

### Phase 1 implementation

- Full upstream revisions and VKD3D-Proton submodule revisions: `tests/torture/pins.json`.
- Acquisition verifies the exact Git revision and refuses dirty source checkouts.
- Wine PE32+ matrix expanded to d3d9, d3d11, d3d12, dxgi, vulkan-1, comdlg32 and
  user32 msg/dialog/resource. Upstream `.c`/`.rc` files are not edited. A generated copy of
  Wine's test harness observes assertions and delegates accounting to `winetest_ok`.
- The API audit records all four Win64 register arguments, six stack slots, raw RAX,
  LastError, caller/thunk RIP, instruction number, and bounded before/after pointer snapshots.
  It is opt-in and does not alter HLE results. Overflow is reported, not hidden.
- Assertion-to-API links are explicitly a preceding-call window, not a proof of causality.
  Upstream messages do not always contain an expected HRESULT; missing values remain missing.
- al-khaser uses its unmodified upstream MSVC/MASM x64 Release project on Windows CI.
  pafish uses the unmodified C sources and x64 library set from its upstream Makefile64.
- VKD3D-Proton internal tests and Windows deqp-vk have pinned build/run scripts in the
  full/weekly CI lane. A Linux CTS build is a native reference only.

### Initial raw failures (executed)

Evidence was downloaded with `scripts/download-torture-blobs.py` and verified against the
GitHub run SHA, Git blob SHA and SHA-256. These are **failures**, not passes.

#### Wine d3d12 — run `41097853948`, source `602bdd9e5dacdfad16bc739e619aa371d81ada8c`

- Fixture: `d3d12_test.exe`, Wine `0738d528db522f52d9d75f2aec712688dd31d1d2`,
  SHA-256 `803ea207e8a7b93b767b10b79e7f0dce2da7552eaae4dc8d5f1c7e67b9bc989a`.
- Wasm SHA-256: `9554a6462767f2ae4bffb3f0c774888a6fad53b10ab1264f823a754574d4e3c1`.
- Result: `GUEST_FAULT` after 3,085 instructions; zero Wine assertions completed.
- Raw fault: `access violation at 0x0 ... rip=0x41bba1`.
- Preceding guest API window includes `D3D12CreateDevice(NULL, 0xb000, IID_ID3D12Device, &device) -> S_OK`,
  `CreateDXGIFactory2 -> S_OK`, `IDXGIFactory4::EnumAdapterByLuid -> S_OK`,
  `IDXGIAdapter1::GetDesc -> S_OK`. The crash occurred while formatting the adapter trace,
  before the first counted assertion summary. This is not a D3D12 conformance pass.

Raw console excerpt after stdout-on-fault was preserved (run `41099740757`):

```text
(null):0: Test failed: (null):0: Test failed: (null):0: Test failed:
```

#### al-khaser x64 — run `41099740757`, source `2c69de7116b1df031fb77fe661af5515b7350100`

- Upstream MSVC/MASM Release x64 build, source revision
  `f0e5559073fe02c4f50cc8c3ed8d5b302a6a0659`.
- Result: `GUEST_FAULT` after 40,261 instructions, but real BAD findings were emitted first:

```text
[!] Invalid delay value: 1. Using default 600 seconds.
[al-khaser version 0.82]
[*] All APIs present and accounted for.
[*] TLS process attach callback                                                                    [ BAD  ]
[*] TLS thread attach callback                                                                     [ BAD  ]
[*] Checking IsDebuggerPresent API                                                                 [ GOOD ]
[*] Checking PEB.BeingDebugged                                                                     [ GOOD ]
[*] Checking CheckRemoteDebuggerPresent API                                                        [ GOOD ]
[*] Checking PEB.NtGlobalFlag                                                                      [ GOOD ]
[*] Checking ProcessHeap.Flags
```

- The `Invalid delay value` line was traced to unimplemented CRT `strtol` returning 0 for
  `strtol("1", &end, 10)`. The subsequent fault occurred in the ProcessHeap.Flags check:
  `VerifyVersionInfoW` was unimplemented and PEB.ProcessHeap did not expose a heap header.

#### pafish64 — run `41097853948`

- Fixture SHA-256 `e9eed44f64df41d101a5088b44572d77ec27eb56b0c7b272f64118ab5c64fdf6`.
- Result: `GUEST_FAULT`, `Unimplemented 0F 0xb9` (UD2) after 57,889 instructions.
- Guest log BAD/traced findings included missing mouse device/movement/click/double-click,
  missing dialog confirmation, disk size <= 60 GB, patched Sleep/GetTickCount, fewer than two
  processors via PEB and GetSystemInfo, low uptime, and:

```text
[pafish] Wine traced using GetProcAddress(wine_get_unix_file_name) from kernel32.dll
```

- The final API window shows `CoCreateInstance(...) -> S_OK` followed by `SysAllocString`,
  then a null-interface WMI call. Returning S_OK without a valid COM interface was incorrect.

### First closed-loop fixes (retest in progress)

The following Rust/HLE changes were made in response to the raw failures above and are being
retested by the same upstream suites; they are not claimed as verified passes until the rerun
reports exact assertion results:

1. `HeapAlloc(heap, flags, size)` now passes the byte size, not the flags, to the allocator;
   a native regression test checks non-overlap of a 0xc00-byte allocation.
2. Guest stdout is drained on fault paths so raw check output is not lost.
3. PEB.ProcessHeap points to a mapped heap header with non-debug Flags/ForceFlags;
   `VerSetConditionMask` and `VerifyVersionInfoW` implement Windows 10.0.19045 comparisons.
4. CRT `strtol`/`strtoul` family parses CLI arguments and writes `endptr`.
5. `CoCreateInstance` returns `REGDB_E_CLASSNOTREG` and nulls the output pointer instead of
   fake S_OK; `GetProcAddress` no longer fabricates `wine_*` export pointers.
6. The generated Wine debug-string buffer and assertion location observer were hardened;
   upstream Wine `.c` test sources remain unmodified.

### First retest evidence — run `41103475282`, source `37e1a681b1df64989b43b3615f49d3bc5b06f48f`

The same upstream fixtures were rebuilt and rerun after the HLE fixes. Results are still
**FAIL/GUEST_FAULT**, but the harness now reaches real assertions and check results.

#### Wine d3d12 exact assertion failures

`d3d12_test.exe` SHA-256 `bc1da9b25e2ef23efd2864666e99332a61f4c3ca77ffd5b8486311d7ae31e04e`;
20,898 instructions executed before a later null-call fault. Two observer records:

```json
{"expression":"pfn_101 == pfn_D3D12CreateDevice","expected":true,"actual":false,
 "message":"Got 00007FF000010010, expected 00007FF000010000.\n","file":"d3d12.c","line":796}
{"expression":"hr == ((HRESULT)0x00000000)","expected":true,"actual":false,
 "message":"Got unexpected hr 0x80004001.\n","file":"d3d12.c","line":912}
```

- `GetProcAddress(d3d12, 101)` returned a distinct export thunk instead of the named
  `D3D12CreateDevice` thunk. A canonicalization fix is committed for the next rerun.
- `d3d12.c:912` received `E_NOTIMPL (0x80004001)` where `S_OK` was expected. This remains an
  open D3D12 HLE failure, not a pass.

#### al-khaser retest

The guest executed 74,708 instructions and emitted 22 check records, 11 findings. The earlier
ProcessHeap crash is gone; raw console now includes:

```text
[*] Checking ProcessHeap.Flags                                                                     [ GOOD ]
[*] Checking ProcessHeap.ForceFlags                                                                [ GOOD ]
[*] Checking Low Fragmentation Heap                                                                [ GOOD ]
[*] Checking NtQueryInformationProcess with ProcessDebugFlags                                      [ BAD  ]
[*] Checking NtQueryInformationProcess with ProcessDebugObject                                     [ BAD  ]
[*] Checking NtSetInformationThread with ThreadHideFromDebugger                                    [ BAD  ]
[*] Checking NtSystemDebugControl
```

Findings: missing `psapi.dll!EnumProcessModulesEx` and three `WUDFPlatform.dll` exports; BAD TLS
process/thread attach callbacks; BAD ProcessDebugFlags, ProcessDebugObject,
ThreadHideFromDebugger, NtSystemDebugControl and UnhandledExcepFilterTest. The run then faulted
on unimplemented `INT 0xcd` at `0x1400176a7`. These are exact upstream check names and BAD/GOOD
results; they are not crash-only passes.

#### pafish64 retest (same run)

`pafish64.exe` now exits cleanly (`exit:0`) after 64,565 instructions, but the suite is still
**FAIL**: 58 parsed checks, 10 `traced!` findings. The previous Wine export fingerprint is gone
from the guest log. Remaining raw findings include:

```text
Checking mouse presence OK traced!
Checking mouse movement OK traced!
Checking mouse click activity OK traced!
Checking mouse double click activity OK traced!
Checking plausible dialog confirmation OK traced!
Checking if disk size <= 60GB via GetDiskFreeSpaceExA() OK traced!
Checking if Sleep() is patched using GetTickCount() OK traced!
Checking if NumberOfProcessors is < 2 via PEB access OK traced!
Checking if NumberOfProcessors is < 2 via GetSystemInfo() OK traced!
Checking operating system uptime using GetTickCount() OK traced!
```

This is a verified improvement from `GUEST_FAULT` to a completed upstream run, but it is not a
pass: the expected result for each check is `OK`, and the actual result is `traced!`.

A fault-free run with zero assertions remains a failure. Phase 2 top-20 fixing continues from
these recorded failures.

### Phase 2

Not started in this initial pass. No 300–500 MIPS claim is supported. A future executable
JIT must validate translated blocks against the interpreter, invalidate on code-page writes,
preserve precise guest fault state, and benchmark the same Chocolate Doom workload before
any speedup is reported.

---

## Phase 2 progress update (2026-10-30, branch `arena/633a2716-porthole`)

This section records the closed-loop work after the initial Phase 1 report. It is a living
record: entries marked **verified** have downloaded CI evidence; entries marked **pending
rerun** are implemented but not yet proven by a successful guest execution.

### Verified exception-dispatch and DXGI output-parent retests

- Torture run `41108877072` (commit `68cdabb`): native core **SUCCESS** (`5 passed; 0 failed`
  unit tests plus `3 passed; 0 failed` Wine64 startup integration tests). The earlier
  `vectored_exception_abi_and_unhandled_filter_chain` panic was a test-harness bug (empty heap
  table); fixed by initializing guest heaps in the regression test.
- Wine `d3d12_test.exe d3d12` progressed past the previous `IDXGISwapChain3::GetContainingOutput`
  failure at `d3d12.c:912`. New exact failure in the same run:
  - assertion `d3d12.c:680`, expression `hr == ((HRESULT)0x00000000)`, message
    `Got unexpected hr 0x80004001.`
  - causal audit entry: `ID3D12Resource::GetDevice`, args
    `this=0x7ff400000d90, riid=0x42b390, ppv=0x21ff800`, return `0x80004001 (E_NOTIMPL)`.
  - guest then faulted with unhandled `0xC0000005` after calling through the null device pointer.
  - fix committed: `ID3D12DeviceChild::GetDevice` (vtable slot 7) for resources, command lists,
    allocators, PSOs, root signatures, descriptor heaps and fences; swapchain buffers now inherit
    the creating device as parent. **Pending rerun.**
- al-khaser progressed to 98,506 instructions / 14 findings. INT 0x2D, INT 1, hardware/software
  breakpoint checks now report GOOD through real guest VEH dispatch. Remaining BAD findings
  include trap flag, PAGE_GUARD memory breakpoints, NtYieldExecution,
  NtQuerySystemInformation(SystemKernelDebuggerInformation), SharedUserData KdDebuggerEnabled.
  These are exact upstream check results, not crash-only passes.
- pafish still exits 0 with 10 findings at `68cdabb`; completion is not PASS.

### Environment-leak fixes committed (pending rerun)

- `GetSystemInfo` and PEB `NumberOfProcessors` now report 4 processors / mask `0xF`.
- `GetDiskFreeSpaceExA/W` model a 512 GiB volume (256 GiB free), replacing the previous ~3.5 MiB
  values that triggered the ≤60 GB sandbox heuristic.
- Virtual monotonic clock: initial uptime 3,600,000 ms; `Sleep(ms)` advances `GetTickCount`,
  `GetTickCount64`, `QueryPerformanceCounter` and `GetSystemTimeAsFileTime` coherently.
- `GetSystemMetrics(SM_MOUSEPRESENT)=1`, `GetCursorPos`/`SetCursorPos` backed by a host-driven
  virtual cursor; browser pointer events feed `inject_mouse_move`. Headless pafish runs use a
  deterministic slow pointer-drift profile through the real API (documented in the report).

### Host-integrated modal dialogs (pending rerun)

`MessageBoxA/W/ExA/ExW` no longer stub-return. They emit `HleAction::Modal`, the core yields
`run_slice() == "modal"`, and the host answers via `modal_respond(result)`. The browser launcher
renders a non-blocking DOM modal (OK/Cancel/Yes/No according to MB_* type) and resumes the guest
with the selected Win32 ID* value. Headless Wine/detection runners record the request and apply an
explicit `headless-auto-IDOK` policy. The final API audit records the actual returned button id.
Rust regression `messagebox_yields_host_modal_and_sleep_advances_tick_clock` covers the handoff
and Sleep/tick coherence. DialogBox/TaskDialog and comdlg32 file dialogs remain open.

### Hybrid AOT/JIT execution bridge (pending measured benchmark)

- Core exports `set_jit_enabled`, `jit_enter_block`, `jit_commit_block`, `jit_abort_block`,
  `jit_import_cached`, `jit_active_wasm`, pending-artifact drains and `jitEnabled` telemetry.
- `js/x64-jit-host.js` compiles/imports pure-GPR block artifacts, executes them against the core's
  exported `WebAssembly.Memory`, commits registers atomically, and falls back to precise
  interpreter replay on trap. OPFS/NVMe artifact cache is restored after PE load; cached bytes are
  re-validated by live guest-code hash + page epoch before acceptance.
- Hot-block compilation now retries every 64 page executions instead of once per page.
- Chocolate Doom runner supports `PORTHOLE_JIT=0/1` and `PORTHOLE_DOOM_MAX_INSTRUCTIONS`; CI has a
  dedicated 100M-instruction interpreter-vs-JIT A/B lane publishing raw reports.
- **No 300–500 MIPS result exists yet.** Historical interpreter baseline remains ~5.95–7.99 MIPS
  on the full timedemo. The A/B lane has not completed successfully because core compile fixes
  were still landing; the next successful run will provide the first measured JIT numbers.

### Build/acquisition fixes

- Expanded Wine build now generates `d3d9on12.h`, `dxva2api.h`, `dxvahd.h` with `widl`
  (`wine64-tools`) and aliases `debugstr_guid`, fixing the remote MinGW d3d11 build failure.
- VKD3D-Proton acquisition verifies recursive gitlink pins; Meson cross file injects the resolved
  `widl` path. Full VKD3D/CTS builds and lanes remain pending.
- Evidence downloader now merges all per-job transfer manifests instead of keeping only the last,
  so candidate Wasm and diagnostics from the same job are both recovered.

### Verified retest at `bf5fcd9` (torture run `41113063354`)

- Native core **SUCCESS**; candidate Wasm published and downloaded (SHA-256 verified).
- **pafish: findings reduced 10 → 5.** The multi-core PEB/GetSystemInfo, 512 GiB disk,
  Sleep/GetTickCount coherence, uptime and mouse-presence fixes are verified by the upstream
  guest now reporting OK for those checks. Remaining BAD findings are interactive/input-path
  checks: mouse movement, mouse speed, mouse click activity, mouse double click activity,
  plausible dialog confirmation. (A deterministic virtual pointer profile was added afterwards
  to exercise movement/speed through GetCursorPos; pending rerun.)
- **Wine d3d12:** `ID3D12Resource::GetDevice` no longer returns E_NOTIMPL; the guest progressed
  to `CopyTextureRegion`/`Close`. The lane then hit a **resident-page thrash timeout**:
  telemetry showed `residentLimit=1024` while the pinned working set (2 MiB stack + 2 MiB COM
  heap + image/PEB/thunks) exceeded 1024 pages, so every slice ended in a page fault. Root cause
  fixed by raising the Wine/Doom/browser resident budget to 8192 pages (32 MiB). Local retest with
  8192 pages advanced to **20,000,000 instructions with 0 page faults**, reaching
  `test_swapchain_refcount` (`d3d12.c:1157+`).
- **Wine todo semantics:** the refcount assertions at `d3d12.c:1157/1169/1174/1179/1185/1188`
  are `todo_wine` checks where Porthole returned the Windows-correct refcount (2/3). Wine counts
  a todo success as a failure; the observer/runner now distinguish `todo-success`
  (Windows-correct) from real compatibility failures, while still recording exact
  expression/expected/actual. This is not a relaxation of non-todo assertions.
- **Expanded Wine:** d3d11 compile advanced past DXVA headers; link failed on `NtQueryObject`.
  Fixed by linking `-lntdll`. Pending rerun.
- **al-khaser:** unchanged 14 findings / GUEST_FAULT at SharedUserData KdDebuggerEnabled;
  trap-flag, PAGE_GUARD, NtYieldExecution and SystemKernelDebuggerInformation remain open.

### Full-lane acquisition/build evidence (run `41118906889`, commit `3b07749`)

- **VKD3D-Proton internal tests: build SUCCESS.** The pinned upstream `tests/d3d12.exe`
  (62/62 ninja targets) now cross-compiles with MinGW + widl after supplying Win10
  `_WIN32_WINNT`/`PATHCCH_NONE` definitions. The runner executed 53 upstream subtests
  (root signatures, descriptor heaps, pipeline state, raytracing root signatures, mesh shaders,
  work graphs). All 53 currently report `GUEST_FAULT` during MSVCRT startup
  (`unhandled guest exception 0xc0000005`, ~590 instructions), with exact unimplemented imports
  `msvcrt.dll!__iob_func` and `msvcrt.dll!_lock`. This is real upstream execution evidence, not a
  synthetic pass; the CRT import fixes are committed for rerun.
- **Vulkan CTS:** acquisition of all external dependencies succeeded on the Windows runner;
  the CMake source-path bug was fixed. The full `deqp-vk` build is still in progress at the time
  of this entry; no CTS pass rate is claimed yet.
- **Expanded Wine:** `d3d11_test.exe` and `dxgi_test.exe` now build (ntdll link + generated
  `d3d10_1` import library). `vulkan_test.exe` link failed on missing `-lvulkan-1`; a generated
  import library from the upstream Wine `vulkan-1.spec` is committed for rerun.
- **Chocolate Doom A/B regression:** both interpreter and JIT lanes currently fail with
  `W_GetNumForName: PNAMES not found!` and `exit:-1`. The runner now verifies the asset itself:
  `freedoom2.wad` has 3610 lumps and `hasPNAMES=true`, so this is a guest file-mapping/read
  regression, not a missing asset. Historical baseline remains ~5.95–7.99 MIPS; current measured
  lanes are ~0.08 MIPS because the guest aborts early. No JIT speedup is claimed. JIT abort now
  invalidates the faulting artifact so fallback cannot loop on the same bad block.
- **Wine d3d12 local retest (8192 pages):** 667 upstream assertions executed, 9 `todo_wine`
  successes are Windows-correct refcount results, 1 remaining failure is the DXCore adapter path.
  DXCore factory/list/adapter COM objects and `DXCoreCreateAdapterFactory` are implemented;
  `LoadLibraryA("dxcore.dll")` now returns a stable module handle. Pending CI rerun.

### Verified local Wine d3d12 PASS (candidate `3d27d4a`, 8192 resident pages)

`node tests/wine64/run-wine64.mjs --only d3d12` completed **PASS** locally:
- 671 upstream Wine `d3d12` tests executed, 24,121,369 guest instructions, 152 s wall time.
- 9 Wine `todo_wine` successes (Windows-correct refcounts) are reported separately and do not count as failures.
- `effectiveFailures = 0`, guest exit code 9 (Wine's todo-success exit), runner exit 0.
- Fixes verified by this rerun: DXCore `LoadLibraryA` module handle + factory/list/adapter COM path,
  8192-page resident working set (no `MemoryRangeTooLarge`/swap-storm), todo-aware pass gate.
- Evidence: `artifacts/local-d3d12-dxcore2.json`, `artifacts/local-d3d12-dxcore2/`.

The corresponding CI lane executed the guest successfully but its evidence-publish step initially
exceeded the 64 MiB blob cap; caps were raised and the lane timeout increased to 300 s for rerun.

### Detection-suite progress

- al-khaser now reaches 47 checks / ~16.7 M instructions (previously faulted at `SharedUserData`
  after ~22 k). Remaining findings dropped to 10 after mapping `KUSER_SHARED_DATA`, implementing
  `NtQueryInformationProcess` debug flags/object/port, `NtSetInformationThread(HideFromDebugger)`,
  `NtSystemDebugControl`, `NtQuerySystemInformation(KernelDebuggerInformation)`, and returning 0
  for `NtYieldExecution`. `psapi.EnumProcessModulesEx` and `WUDFPlatform.WudfIs*DebuggerPresent`
  exports were added. The Windows runner hit a report-serialization size limit; audit output is now
  bounded in JSON (full JSONL retained) and the timeout raised to 600 s.
- pafish remains FAIL with exactly 3 interactive-input findings (mouse click, double click,
  plausible dialog confirmation); all environment/VM checks pass.

### CI-verified Wine d3d12 PASS (run `41124584297`, commit `33a4925`)

The `wine-d3d12` lane now completes **SUCCESS** on GitHub Actions: 671 upstream assertions,
`effectiveFailures = 0`, with the same 9 Windows-correct `todo_wine` refcount successes.
Raw report/audit/trace: `artifacts/remote/41124584297/wine-d3d12/artifacts/torture/`.

### Chocolate Doom status

The authoritative-HLE-write fix (`host_write_bytes` faults pages back in; `fread`/`ReadFile` use it)
resolved the earlier `PNAMES not found` abort. The guest now progresses further into `R_Init` and
fails on `F_END not found`; the benchmark still reports FAIL, 0 gametics, ~0.07 MIPS. A host-side
`hasF_END` probe is added to distinguish asset content from guest directory-read truncation.
No JIT speedup is claimed while the timedemo cannot start.

### JIT correctness and evidence-transport hardening (commits `424cf66`…`c2c702b`)

- **RFLAGS differential test PASS against the CI-built candidate.** The authored PE64 fixture
  `mov rcx,1000; mov rdx,1; L: sub rcx,rdx; nop; jnz L; ret` makes the hot-block handoff land on
  `sub+nop`, after which the *interpreter* executes `jnz`. The 21-slot JIT context now materializes
  the final flag writer's kind/width/lhs/rhs/result, and commit applies interpreter-identical
  RFLAGS. `tests/node/x64-jit-differential.test.mjs` passes against candidate
  `artifacts/remote/41134521742/core/artifacts/torture/candidate/` (full `npm run test:unit`: 25/25).
  The previous core ignored flags entirely, so this was a real miscompile class, not a benchmark artifact.
- **Fault-safe commit ordering.** `jit_commit_block` resolves the `ret` target before copying GPRs or
  adding the instruction count. A swapped stack page invalidates the artifact and replays in the
  interpreter without double execution. Native regression tests create real LRU pressure (the VMM
  enforces a 64-page minimum resident budget) for VMM partial writes, ReadFile replay, and JIT ret faults.
- **AOT scan narrowed to the entry block.** The old 256-byte-aligned `.text` scan decoded
  mid-instruction and cached semantically wrong Wasm; only RIPs actually executed are now compiled.
  OPFS artifacts are re-validated against live guest bytes before import.
- **JS JIT host binds the core's exported memory**, discards stale pending metadata instead of
  `JSON.parse("")`, separates cache-save errors from guest traps, and counts only committed blocks.
  The Doom A/B workflow no longer copies a stale baseline over a failed candidate report.
- **Evidence transport is gzip Git blobs** with original+blob SHA256 verification; a Node test exercises
  publish/download round-trip and rejects tampering. This replaces the raw-base64 transport that lost
  expanded-wine/VKD3D reports when pretty-printed audits exceeded the blob cap.
- **Vulkan CTS startup fault diagnosed:** run `41127156564` faulted at ~57 k instructions with missing
  `kernel32!InitializeSListHead` and `api-ms-win-crt-stdio!_set_fmode`. SLIST init/interlocked ops and
  `_set_fmode`/stable `__p__fmode` are implemented for rerun. CTS still has **no claimed pass rate**.
- **al-khaser leak fixes pending rerun:** ProcessDebugObjectHandle aliased ReturnLength,
  ThreadHideFromDebugger length/handle/alignment validation, TF single-step exception, and
  MEM_WRITE_WATCH/GetWriteWatch/ResetWriteWatch page tracking. Native regressions cover the exact
  upstream al-khaser expectations. TLS callbacks and PAGE_GUARD/SEH remain open.
- **Doom:** the host WAD probe now actually checks `F_END` (the earlier report's probe claim was
  incorrect), records marker indices and directory SHA256, and the runner/CI resident budget is restored
  to 65536 pages. The timedemo still FAILs at `F_END not found` in the last measured run; no JIT speedup
  is claimed. Pinned Doom inputs are staged for restricted-egress download via the verified blob transport.

### Suite rates from CI run `41135650180` (commit `c2c702b`)

| Lane | Result | Exact evidence |
|---|---|---|
| core | SUCCESS | native tests + `npm run test:unit` 25/25 against the candidate, including the JIT RFLAGS differential |
| Wine d3d12 | PASS | 671 upstream assertions, 9 Windows-correct `todo_wine` successes, effectiveFailures 0 |
| VKD3D-Proton | FAIL | 46 internal tests: 15 PASS, 28 FAIL (`exit:1`), 3 GUEST_FAULT; 2491 assertions, 690 failures. Dominant failure is readback value 0 (511), then descriptor-type/refcount/HR mismatches. Faults: `CreateQueryHeap`/`D3D12EnableExperimentalFeatures`, `D3D12CreateRootSignatureDeserializer`, `D3D12CreateVersionedRootSignatureDeserializer`. |
| Vulkan CTS | GUEST_FAULT | `info+api` faulted at 47,979 instructions at the upcall sentinel `0x7ff00001fff0` during CRT startup; no CTS pass rate is claimed. |
| al-khaser | FAIL (backend fault) | 47 checks, findings reduced 9 → 3 (TLS process/thread attach, PAGE_GUARD). Debug-object, thread-hide, trap-flag, and all four write-watch checks now GOOD. A later memory-walk fault at the same sentinel aborted the run. |
| pafish | FAIL | exactly 3 interactive reverse-Turing findings (mouse click, double click, plausible dialog confirmation); all environment/VM checks OK. Report serialization is fixed. |
| Chocolate Doom A/B | FAIL (timedemo incomplete) | resident 65536 + preflighted HLE writes resolved `F_END not found`; the guest reached `ST_Init` and presented 47 frames with 5 distinct checksums, but the 100M-instruction budget ended before timedemo completion. Reports were lost because the workflow skipped `cp` on nonzero exit; fixed to copy on failure and run the full timedemo. |

Follow-up fixes committed after this run (`025a528`, `f2a3f41`): JIT commit shadow-validation with
safe fallback, loader TLS callbacks, `VirtualQuery` failure on unmapped memory, `_invoke_watson`
termination, and `_initterm` tables skipping the HLE thunk region/sentinel. The sentinel fault was
the common blocker in CTS and al-khaser startup; rerun is required before claiming those lanes fixed.

### CI run `41139056569` (`ba769db`) and follow-up fixes

- Core gate SUCCESS (12/12 Rust tests); Wine d3d12 PASS (671 assertions). TLS process-attach
  callbacks did not regress Wine.
- al-khaser advanced to 65 checks; findings: TLS process/thread attach, PAGE_GUARD, mouse movement,
  lack of user input. The memory-walk spin is gone (`VirtualQuery` failure fix), but a later
  Winsock cloud probe still reached the sentinel; clean Winsock failure paths and
  `GetLastInputInfo` are committed for rerun. `load_pe` now reports `tlsCallbacks` for diagnosis.
- VKD3D-Proton remains 15 PASS / 28 FAIL / 3 GUEST_FAULT / 1 TIMEOUT; the root-signature
  deserializer exports now return E_NOTIMPL instead of faulting.
- Expanded Wine executed the full matrix but the aggregate JSON exceeded V8's string limit
  (`RangeError: Invalid string length`); the report now bounds per-test audits while preserving
  raw `.api.jsonl` sidecars. Observed failures include early d3d9/d3d11/dxgi/vulkan initialization
  and comdlg32/user32 faults/timeouts — not claimed as PASS.
- Chocolate Doom full timedemo: interpreter baseline reached `HU_Init`/`ST_Init` and presented
  52 frames (8 distinct checksums, cross-check true) but did not finish the timedemo within the
  wall budget; the JIT candidate hit a shadow-validation mismatch at `0x140007cfa`. The host now
  treats core validation faults as bad artifacts and replays the block in the interpreter.
  Startup TLS is limited to DLL_PROCESS_ATTACH until thread creation delivers DLL_THREAD_ATTACH.

### CI run `41144826025` (`19419ba`) — measured compatibility and the JIT throughput wall

Core gate SUCCESS; Wine d3d12 PASS (671 upstream assertions, 9 `todo_wine` successes).
Expanded Wine is **2/16 PASS** (`d3d11`, `vulkan`), 10 FAIL, 3 GUEST_FAULT, 1 TIMEOUT.
The new `msvcrt!printf`/`vprintf` paths produce real upstream summaries instead of empty
console logs; the remaining faults are exact: `comdlg32 filedlg/printdlg` follow
`FindResourceA("template_stc32", RT_DIALOG) -> 0`, `LoadResource(0) -> 0`,
`LockResource(0) -> 0`; `dxgi` reaches `signal(SIGSEGV)` after factory/output failures;
`user32 msg` times out waiting for hook/message delivery. VKD3D-Proton is **15 PASS /
30 FAIL / 1 GUEST_FAULT / 1 TIMEOUT** across 47 internal tests (aggregate rebuilt from
the verified per-test blobs). al-khaser reaches **133 checks** and reports 14 findings
(TLS attach, PAGE_GUARD, SCM, WMI fan, ACPI ×4, VBox shared folders, four timer APIs,
RDTSC Locky) before an anti-dump memory fault; `GetModuleHandleW(NULL)` now returns the
real `0x140000000` image base and `VirtualProtect(base,4096,RW)` succeeds. pafish is
58 checks with the same 3 interactive reverse-Turing findings.

Chocolate Doom A/B on this run: interpreter baseline 38,000,000 instructions /
937,565 ms = **0.04 MIPS**, 52 presented frames, 8 distinct checksums, timedemo
incomplete. The JIT candidate reached 10,000,000 instructions / 167,212 ms =
**0.06 MIPS** but terminated with the internal `jit` token because the JS host left
`status='jit'` after a successful commit when the slice budget was exhausted. That host
bug is fixed locally (`a7abea5`) with an exact-budget regression test.

**Reproducible JIT microbench added:** `tests/bench/jit-microbench.mjs` (authored
`mov rcx,N; sub rcx,1; jnz -6; ret`). Quick run at N=1,000,000 (2,000,002 instructions):
interpreter **10.024 MIPS**, JIT shadow-validation **0.371 MIPS**, JIT fast path
**0.476 MIPS**; compiled blocks = 1, executed blocks = 999,968, traps = 0. The earlier
40,000,002-instruction run measured 11.19–11.35 MIPS interpreter vs 0.40/0.46 MIPS JIT.
The decoder still stops at every branch, so hot loops become one-instruction artifacts
and pay a Wasm call/commit per iteration. **No 300–500 MIPS result is claimed.** The
next architectural step is branch-terminated multi-instruction blocks / block chaining
or trace compilation, not disabling shadow validation: `PORTHOLE_JIT_VALIDATE=0` on Doom
reproduced the original 5,671-instruction guest fault, so CI keeps validation enabled.

Fixes committed after this run and awaiting the next CI compile: PE resource directory
parsing + `FindResource/LoadResource/LockResource/SizeofResource/LoadStringA/W`
(`605d0c5`); empty SCM enumeration, checksummed generic ACPI DSDT/FACP/APIC tables,
`WNetGetProviderName` no-redirector failure, and virtual-time waitable timers
(`b2c32b1`). These target the exact al-khaser/comdlg32/user32 failures above; they are
not claimed as PASS until the real upstream suites rerun.

### Verified closed-loop fixes through CI run `41150031555` (`3391ea9`)

- **al-khaser now exits cleanly** (`exit:0`, 919,828 instructions, 133 checks) instead of
  faulting in anti-dump. The PEB loader list (`c01d702`) fixed `SizeOfImage()`; findings
  fell from 14 to **9**: TLS process/thread attach, PAGE_GUARD, WMI CPU fan, two ACPI
  checks, SetTimer, timeSetEvent, RDTSC Locky. SCM enumeration, VBox shared folders,
  CreateWaitableTimer and CreateTimerQueueTimer are no longer BAD.
- **PE resources are real:** `comdlg32 filedlg` advanced from GUEST_FAULT to FAIL with
  **138 upstream tests executed**; the exact audit now shows
  `FindResourceA(base,"template_stc32",RT_DIALOG) -> 0x7ff200000002`,
  `LoadResource -> 0x7ff200000002`, `LockResource -> 0x140097228`. The earlier NULL
  resource fault is gone. Expanded Wine overall is still **2/16 PASS** (d3d11, vulkan);
  dxgi/printdlg still fault and user32 msg still times out — not claimed as PASS.
- **Wine d3d12 remains PASS** (671 assertions). Core gate SUCCESS on every candidate.
- Diagnosed and fixed the remaining timer routing bug: `winmm.dll` was blanket-routed to
  the SDL fallback, so `timeSetEvent` returned 0 before the callback arm ran (`e779c22`).
  ACPI firmware now includes WSMT + fixed PNP device IDs, and `SetTimer` delivers a real
  WM_TIMER upcall (`8854705`); rerun pending.
