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
