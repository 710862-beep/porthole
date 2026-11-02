# Continuation report — branch `arena/633a2716-porthole`, PR #6

Written at HEAD `339e5ac`. Everything is pushed; the working tree is clean.
Purpose: let the next session start fixing instead of re-deriving.

## 0. Environment facts that shape every decision

- **No Rust toolchain in the sandbox.** `rust/porthole-x64-wasm` and `rust/retrowin32`
  cannot be compiled or `cargo test`ed locally. Every Rust change costs one CI round trip
  (~10 min for the x64 build, ~25–40 min for the torture matrix). Batch Rust edits, and
  prefer changes you can validate by reading the binary with Python (`pefile`, `capstone`
  are installed; `pip install` needs `--break-system-packages`).
- **Job logs and artifact zips are unreadable** (`gh run view --log` and `gh run download`
  both EOF on blob storage). Use either
  `python3 scripts/download-torture-blobs.py <run>` / `download-ci-blobs.py <run>` (Git
  blob API — works, but only for runs that produced their transfer manifest) or
  `gh api repos/710862-beep/porthole/check-runs/<jobDatabaseId>/annotations`
  (**capped at 50 annotations per check run** — that is why `scripts/ci-annotate-artifacts.mjs`
  exists and caps itself at 40).
- **Usable local x64 core**: `PORTHOLE_X64_WASM_DIR` pointing at a downloaded
  `artifacts/remote/<run>/core/artifacts/torture/candidate`. There is no
  `vendor/porthole-x64-wasm`, so `npm test` skips every x64-JIT test unless you set it.
- **`tests/synthetic/*.exe` and the Wine64 test binaries are built in CI** (zig 0.13.0),
  not committed. `al-khaser.exe` is built by MSVC on a Windows runner — it cannot be run
  locally at all; the only feedback is the CI report.

## 1. Status of the five workflows at `dd4c73a`

| workflow | result |
| --- | --- |
| `retrowin32 backend build` | **success** |
| `x86-64 emulator` — core unit tests, wasm build, Tier A 7-Zip, Gate 2 Wine reference | **success** |
| `x86-64 emulator` — **Tier B Chocolate Doom** | **success** (see §2) |
| `x86-64 emulator` — Wine64 conformance | **failure** |
| `Porthole torture conformance` — core, wine-d3d12, pafish | **success** |
| `Porthole torture conformance` — al-khaser, vkd3d-proton, expanded-wine, vulkan-cts, jit-benchmark | **failure** |
| `Rust Wasm candidate` | **failure** (asset acquisition) |
| `Porthole compatibility CI` | **failure** (synthetic lanes + acquisition) |

## 2. Tier B passes — and the caveat that must travel with it

Run `41376487935` (`53e1fad`), check `porthole-x64-tier-b-chocolate-doom`:

```
GATE 1 Tier B / GATE 2 (Chocolate Doom): PASS
timedemo_gametics=2664 realtics=2614 distinct_frame_checksums=1782 checksum_cross_check=true
presented_frames=2704 frame_size=800x600 framebuffer_checksum=fnv1a64:ceeff82acee82862
terminal=exit:4294967295 instructions=3,603,983,437 page_faults=0 wall_ms=968,067 mips=3.72
```

**That is an interpreter result, not a JIT result.** `tests/third-party/run-chocolate-doom.mjs`
enables the HLE trace ring unless `PORTHOLE_DOOM_TRACE` is exactly `0`, and
`BrowserX64Emulator::run_slice` only hands off to a native artifact when
`!self.trace_enabled && !self.hle_trace_only` (`rust/porthole-x64-wasm/src/lib.rs:605`).
The workflow sets neither variable, so the JIT compiled 25,274 blocks and never executed
one. Do **not** flip that default until the JIT beats the interpreter — it would move the
lane from 3.72 MIPS to ~1.1 MIPS and turn a green gate red. The coupling is recorded in
`docs/KNOWN-ISSUES.md`.

## 3. The JIT is slower than the interpreter, and why (measured)

Same pinned inputs, same end state (`rip=0x140020896`, `last_error=3`), 4,000,000
instructions, warm AOT cache, local sandbox:

| configuration | wall | MIPS |
| --- | --- | --- |
| interpreter (`PORTHOLE_JIT=0`, trace off) | 2,797 ms | **1.43** |
| JIT, validate mode 1 | 5,613 ms | 0.71 |
| JIT, validate mode 0 | 5,284 ms | 0.76 |
| JIT after the `7817b65` host changes | 5,284 ms | **0.76** |

Root cause, quantified from the runner's own telemetry: a 2,000,000-instruction slice
reports **492,228 executed blocks for 1,889,926 instructions — 3.8 instructions per native
block** — with 76,388 interpreter handoffs. `pe64::aot_scan_text` finds **25,274
basic-block leaders in 99,023 scanned instructions** (one every 3.9): every conditional
branch, every unconditional branch *and* every instruction after a `call` becomes a leader.
The host round trip (Rust `run_slice` → `jit_enter_block` JSON → module lookup →
`run_block` → `jit_commit_block`) costs several microseconds to run four guest
instructions. Block length, not codegen quality, is the bottleneck.

What `7817b65` already removed: the `run_slice` + 2× `instructions_executed()` round trip
between chained artifacts, a `DataView` allocation per block, a `String(entryRip)` map
write per block, and a **quadratic** `saveJitCache` (it rewrote the entire ~20 MB archive
from every `drainPending`; now rate-limited to one flush per minute, with the runner's
explicit start/end flushes unchanged).

**The remaining lever is longer blocks.** The concrete options, in order of expected value:

1. Continue a block across a direct `call`. `jit.rs` already links
   `BlockExit::Jump | BlockExit::Call { indirect: false }` into native `call`/`return_call`
   edges, but `aot_scan_text` cuts the block at the instruction after every call.
2. Emit several blocks (e.g. one guest page, or one strongly-connected trace) into a single
   Wasm module so successors can `return_call` inside Wasm. Chaining across separate
   `WebAssembly.Instance`s is impossible from JS.
3. `jit_commit_block` enforces `executed == art.insn_count` (unless `self_loop` or
   `dynamic_count`), so a multi-block commit is rejected outright. All 64 context slots are
   allocated (0–15 GPR, 16 status, 17 rip, 18 executed, 19 rflags, 20 budget, 21 entry rip,
   22/23 fs/gs, 24 mem fault, 25 TLB ptr, 26 TLB gen, 27 undo ptr, 28 native_stores,
   29 undo cap, 30 touched ptr, 31 touched count, 32–63 XMM), so chaining needs a context
   ABI change (v4) plus the matching host check on `jit_context_slots()`.

Target to make `jit-benchmark` pass: ~2.4 MIPS (3.6 billion instructions in the 1500 s
budget). The budget was raised from 900 s to 1500 s in `7817b65` because the interpreter
alone needs 968 s.

## 4. Fixed this session, with the evidence that proved it

- **`339e5ac` — `.pdata` was parsed at the RVA instead of the file offset.**
  `pe64.rs` read the exception directory with `off = exc_rva as usize`. Verified on the
  pinned Chocolate Doom: directory RVA `0xbe000`, `.pdata` mapped at VA `0xbe000` with raw
  offset `0xbc600`; the old code read inside `.rdata` and produced 1,554 garbage entries,
  the corrected read produces real ones (`begin=0x1000 end=0x1001 unwind=0xc3000`, …).
  For al-khaser the first "entry" was `(0,0,0)`, so the table came out **empty** — proven by
  the diagnostic added in `d53587e`:
  `seh-walk:fault_rip=0x440010000 fault_rsp=0x21fe868 frames=5 pdata=0 image_base=0x140000000 frame[…]:no-pdata-entry …`.
  **This is the single most likely unblock for al-khaser — verify it first next session.**
- **`9f07a98` — retrowin32 winmm.** `midiOutGetNumDevs`/`midiOutSetVolume` are implemented
  in `winapi/winmm/midi.rs` (traced to Wine `winmm.c`, SHA `0738d528`) and `host.rs`
  already answers 0 devices / `MMSYSERR_INVALHANDLE` (5), but neither was in
  `winmm.dll`'s shim table, so `GetProcAddress` returned NULL. Note the ordering trap:
  `run-synthetic.mjs` loads `vendor/retrowin32/retrowin32.wasm` — the **vendored** Wasm —
  so backend fixes only reach the compatibility lane after the candidate workflow promotes.
- **`7817b65` — compatibility CI's five synthetic lanes were never executing.** The workflow
  ran `run-synthetic.mjs` without building `tests/synthetic/*.exe`; all five died with
  `ENOENT`. `npm run build:synthetic` is now a step. They now fail on real PE32 gaps.
- **`c2fe3b3` — CI observability.** `scripts/ci-annotate-artifacts.mjs` turns
  `artifacts/*.json` into check annotations (wired into the compatibility and candidate
  workflows with `if: always()`). This is how everything below was diagnosed.
- **`7817b65` — SEH walk.** Establisher-frame counter desynchronised whenever a scanned
  stack slot was not a return address; return addresses were matched against `__try` scope
  records without the `-1` control-PC adjustment ntdll applies. Every rejection is now
  recorded in `Win32Kernel::seh_diag` and appended to the unhandled-exception fault.
- **`dd4c73a` / `79ad104` — docs.** `docs/PHASE4-NATIVE-JIT-STATUS.md` carries the measured
  A/B and an explicit "do not read this as a JIT result" header; `docs/KNOWN-ISSUES.md`
  carries the per-lane blocking assertions, the acquisition 404s, and the trace/JIT coupling.

## 5. Open failures, with everything known about each

### al-khaser (torture) — `GUEST_FAULT`, instruction 67,052

`STATUS_GUARD_PAGE_VIOLATION` (0x80000001) unhandled at `rip=0x440010000`. The guard-page
trap is newly firing and is **correct** (real Windows raises it on a guard-page fetch);
the SEH dispatch never reached the guest `__except`, so the process dies instead of
reporting one BAD check. Preceding context from the trace log:

```
kernel32.dll!GetSystemInfo   rsp=0x21fe868 -> rax=0x0        ret=0x14000928a
kernel32.dll!VirtualAlloc    rsp=0x21fe868 -> rax=0x440010000 ret=0x1400092a2
kernel32.dll!VirtualProtect  rsp=0x21fe868 -> rax=0x1        ret=0x1400092ca   (0x140 = EXECUTE_READWRITE|GUARD)
X exception handler=0x140018a7c pointers=0x300002050
```

Before this fault, 25 checks had already reported GOOD (TLS attach, WMI CPU fan, RDTSC
Locky, …). Re-run and read `pdata=` in the new diagnostic: if it is non-zero the walk has a
chance; if any frame now shows a per-frame rejection reason, fix that.

### Wine64 conformance — `d3d9`

- `d3d9_test.exe stateblock FAIL exit=0 insn=1100 failures=0` — Wine `skip()`s before its
  first `ok()` when `Direct3DCreate9` returns NULL (`stateblock.c:2059`), and the
  fail-closed runner treats zero assertions as a failure. There is no D3D9 rasterizer here,
  so `stateblock`/`visual` **cannot** pass honestly; the only honest options are to stop
  running those subtests (`scripts/build-wine64-tests.mjs`, `d3d9_test.exe`
  `subtests: ['d3d9ex', 'device', 'stateblock', 'visual']`) or to accept the red.
- `d3d9_test.exe d3d9ex TIMEOUT 600000 ms insn=440,000,019`. `START_TEST(d3d9ex)` loads
  `d3d9.dll`, resolves `Direct3DCreate9Ex`, then runs ~30 test functions
  (`test_qi_base_to_ex`, `test_qi_ex_to_base`, `test_reset_resources` at line 1843,
  `test_wndproc` at 2611, …). Most begin with `create_device()` → `pDirect3DCreate9Ex`
  → FAILED → `skip`, so a 440 M-instruction burn means one of them is looping; it has not
  been identified. The Wine64 job builds its binaries with zig in CI, so it cannot be
  reproduced locally — consider adding a per-subtest instruction counter or a
  `--only d3d9ex` run with `PORTHOLE_WINE64_TRACE=1` to find it.

### Rust Wasm candidate + Porthole compatibility CI — asset acquisition

`artifacts/asset-acquisition.json`: `ACQUISITION_PARTIAL`,
`missing = ["wine/winetest.exe", "windows/Minesweeper.exe"]`.
`winetest.exe`: `ArtifexSoftware/wine` release asset 404,
`test.winehq.org/builds/winetest-latest.exe` 404, `web.archive.org/...` 404.
`check-promotion.mjs` refuses to promote while anything is missing, so the candidate lane
fails at "Acquire real upstream and game probes" and the compatibility lane fails its
promotion step with `COMPATIBILITY_GATES_FAILED`. `winetest` is acquisition-only
(`tests: []` in `tests/wine/manifest.json` — never executed), so requiring it for promotion
is arguable; that decision has not been made. **Do not** substitute a different binary and
call it Minesweeper — a Wine `winemine.exe` from a Kron4ek build would be an honest
acquisition only under its own name.

### Compatibility CI — the five synthetic lanes (first blocking assertion each)

| lane | blocking assertion |
| --- | --- |
| `registry-test` | `REQUIRE(mm && midiCount && midiCount() == 0)` — fixed in `9f07a98`, but gated on promotion (see above) |
| `thread-validation` | `CreateMutexA` + `WaitForSingleObject(h,0)` + `ReleaseMutex` ownership, then `WaitForMultipleObjects(3, threads, TRUE, …)` |
| `network-test` | `WSAStartup` / `gethostbyname("localhost")` / `getaddrinfo` / `send`+`recv` over the guest loopback bridge |
| `installer-test` | `CreateDirectoryA` + `RegCreateKeyExA(HKEY_LOCAL_MACHINE, …)` |
| `input-test` | `GetErrorMode`/`SetErrorMode`, `GetAsyncKeyState`, `SystemParametersInfoA`, `SearchPathA`, `RegisterRawInputDevices` + `GetRawInputData` |

All five sources are in `tests/synthetic/*.c` and readable locally; the gap is in
`rust/retrowin32/win32/src/winapi/`, which cannot be compiled here.

### torture — vkd3d-proton, vulkan-cts, expanded-wine

- `vulkan-cts`: `info+api GUEST_FAULT` (`0xc0000005` at `rip=0x142e68814`, 48,000 insns).
- `vkd3d-proton`: per-test JSONs exist under
  `artifacts/remote/<run>/vkd3d-proton/artifacts/torture/vkd3d/` — start with
  `test_command_list_initial_pipeline_state.json`.
- `expanded-wine` at `51b6baa`: 16 declared / 3 passed (`d3d9 device`, `d3d11`, `vulkan`);
  d3d12 exit 9 with 671 tests and 9 failures; TIMEOUT `d3d9ex` (58 M) and `user32_dialog msg`
  (88 M, "no win event hook support"); GUEST_FAULT `dxgi` (`0xc0000005` write 0x0 at
  `0x14001c2a6`) and `printdlg` (`0x140017b9f`); partial dialog counts (filedlg 138/51,
  finddlg 43/24, fontdlg 8/5, itemdlg 1/1, dialog 173/129, resource 90/59).
  d3d12 alone is **PASS** in the dedicated `wine-d3d12` lane (671 tests, 9 raw failures,
  all inside `todo` blocks, so `effectiveFailures == 0`).

## 6. Suggested order for the next session

1. Confirm `339e5ac`: does al-khaser now report a non-zero `pdata=`? (`python3
   scripts/download-torture-blobs.py <run> al-khaser`, then read `terminal`.) If the walk
   still rejects every frame, the per-frame reason is in the same string — fix that, not
   the symptom.
2. Attack block length (§3, option 1 or 2) and re-measure locally with
   `PORTHOLE_X64_WASM_DIR=… PORTHOLE_JIT=1 PORTHOLE_DOOM_MAX_INSTRUCTIONS=4000000
   PORTHOLE_DOOM_TRACE=0 PORTHOLE_DOOM_DEBUG_WAD=0 node tests/third-party/run-chocolate-doom.mjs`
   against `PORTHOLE_JIT=0`. The gate is 2.4 MIPS before it is 300 MIPS.
3. Only after the JIT beats the interpreter, make `PORTHOLE_DOOM_TRACE` opt-in in
   `run-chocolate-doom.mjs` **and** flip it in the same commit, then re-check Tier B.
4. Then the retrowin32 lanes (§5), then the acquisition question, then d3d9.

## 7. Standing constraints from `agents.md` (unchanged)

Pinned unmodified binaries only. Separate authoring / execution / rendering / gameplay
claims. Gates 1→5 in order. Never weaken a fail-closed runner, never convert a gate to
expected-failure reporting, never report a PASS that is not an exact expected
HRESULT/boolean/result. §5 forbids anti-detection spoofing: the emulated environment must
stay honest, which is why al-khaser's PAGE_GUARD answer is a real guard-page trap and not a
spoofed "no debugger" flag.
