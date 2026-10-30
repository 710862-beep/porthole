# x86-64 emulator — measured status (2026-10-29)

This file records **measured** evidence only. Nothing below is a projection.

## What is real and verified in CI

| Gate | Command | Result |
| --- | --- | --- |
| Rust core unit tests | `cargo test --all-targets` (rust 1.81, ubuntu-24.04) | **PASS** — VMM 34 GB sparse VA + LRU eviction/page-fault roundtrip, hybrid Wasm JIT emitter (`\0asm` module, epoch invalidation), emulator construction |
| Wasm build | `cargo build --release --target wasm32-unknown-unknown` + `wasm-bindgen --target web` | **PASS** — `porthole_x64_wasm.js` + `porthole_x64_wasm_bg.wasm` produced and uploaded |
| Wine 64-bit fixture build | `node scripts/build-wine64-tests.mjs` (zig 0.13.0, pinned Wine `0738d528`) | **PASS** — 4 unmodified upstream tests compiled to `PE32+` (`0x8664`): `kernel32_test.exe` (power, drive, atom, environ, directory), `user32_test.exe` (wsprintf, uitools), `d3d12_test.exe` (d3d12), `porthole_x64_plan_test.exe` |
| Wine 64-bit conformance inside the Wasm emulator | `node tests/wine64/run-wine64.mjs` | **PARTIAL — 5 of 7 subtest groups pass** (`uitools`, `wsprintf`, `atom`, `drive`, `power`); `environ` and `directory` still fail |

Pre-existing JS/DOM/retrowin32 suite (`npm test`, `npm run check:syntax`) still passes locally
(77 scripts, 11 DOM checks, 15 retrowin32 checks).

## Resolved: the CRT-startup fault (was `access violation at 0x100c70...`)

Measured with `xtrace` (see below). **Two distinct defects, both now fixed.**

### Defect 1 - CRT initializer cursor advanced by function pointer (fixed, `6d0b1c8`)

`_initterm` stored `next_slot = fn_ptr + 8`. After calling the first constructor (`0x401000`) the
scan continued at `0x401008`, i.e. *inside `.text`*, and read the instruction bytes
`1c 70 02 00 c7 00 01 00` as a u64 = `0x100c70002701c` - exactly the address in the old fault
report. The trace that proves it:

```
U 0x7ff0000014f0 api-ms-win-crt-runtime-l1-1-0.dll!_initterm upcall -> 0x401000 rsp=0x21ffe68->0x21ffe60
W 0x21ffe60 <- 0x7ff00001fff0 len=8 at 0x7ff0000014f0 (guest)          # sentinel return address
... pre_c_init executes, `ret` lands on the sentinel ...
U sentinel->call 0x100c70002701c rsp=0x21ffe68->0x21ffe60
F access violation 0x100c700027000 at 0x100c70002701c rsp=0x21ffe60
```

Fix: `find_next_initterm_fn` returns `(slot_va, fn_va)`; the cursor uses the **slot**. Two
independent bugs were also fixed in the same path: the upcall resume used to overwrite `[rsp]`
(destroying the API's real return address) and treated "no more constructors" as process exit.

### Defect 2 - `__p___argv` returned the vector instead of the variable (fixed)

After defect 1, user32_test.exe ran 293 instructions and died on
`movzbl (%rdx),%ecx` with `rdx=0x6578652e74736574` ("test.exe" as ASCII). The guest does
`call __p___argv; mov (%rax),%rax` (0x425510): the API returns a `char***`, so `*result` must be
the vector. Returning the vector made `argv[0]` the *characters* of the string. Fix: allocate
`var -> arr -> string` (and the same double indirection for `__p__environ`/`__p___wargv`).

### Current state (measured, run 40973447170)

| Binary | Outcome | Instructions | Guest console |
| --- | --- | --- | --- |
| `user32_test.exe wsprintf` | `exit:0` | 603 | `Valid test names: wsprintf uitools` |
| `user32_test.exe uitools` | `exit:0` | 603 | idem |
| `d3d12_test.exe d3d12` | `exit:0` | 574 | `Valid test names: d3d12` |
| `kernel32_test.exe atom` | see per-fixture check run | | |

The MinGW/ucrt CRT now completes: `pre_c_init`, both `_initterm` passes with real upcalls,
`SetUnhandledExceptionFilter`, `_set_invalid_parameter_handler`, the argv duplication loop, and
`main`. Nothing faults and no page is needed from NVMe.

**Next blocker (open):** `main` still takes the "print the list of valid test names" path, so the
subtests themselves have not started. `__getmainargs` receives `argc == 2` (the guest loads
`[0x430044] = 2` and mallocs `8*(argc+1)` bytes), therefore either the test name is not reaching
`main`, or the comparison sees an empty `argv[1]`. Next step: dump `argv[0..2]` and the
`[0x430044]/[0x430048]` triple in `fault_snapshot()` and watch the printf path - `__stdio_common_vfprintf`
is already HLE'd, so the exact format string that reaches it identifies the branch.

### Subtest results (measured, run 40982219204)

The CRTs reach `main`, run the requested subtest, and four of the six wine fixtures now pass
inside the interpreter:

| Fixture / subtest | Verdict | Instructions | Guest console |
| --- | --- | --- | --- |
| `user32_test.exe uitools` | **PASS** | 5 935 | `42 tests executed, 0 failures` |
| `user32_test.exe wsprintf` | **PASS** | 20 222 | `86 tests executed, 0 failures, 2 skipped` |
| `kernel32_test.exe atom` | **PASS** | 164 049 683 | `1 049 715 tests executed, 0 failures` |
| `kernel32_test.exe drive` | **PASS** | 18 843 | `131 tests executed, 0 failures` |
| `kernel32_test.exe power` | **PASS** | 1 529 | `5 tests executed, 0 failures` |
| `kernel32_test.exe environ` | 35 failures | 71 853 | expansion/profile edge cases |
| `kernel32_test.exe directory` | 29 failures | 18 314 | `CreateDirectoryA(C:\\Windows\\System32): err=3` |
| `d3d12_test.exe d3d12` | access violation at 0x0 | 1 005 | call through a NULL vtable slot |
| `porthole_x64_plan_test.exe x64_plan` | access violation at 0x0 | 14 703 | `CreateFileW on C:\\Game failed` (now fixed) |

### The five defects this required (all measured, all fixed)

1. **CRT string helpers were unimplemented.** `strcmp` fell through to the default arm and
   returned 0 for every comparison, so winetest's `main` always took its "list valid test names"
   branch. `strlen/strcmp/strncmp/strcpy/strncpy/strcat/strchr/strrchr/_strdup/wcscmp/wcscpy` and
   the timezone globals are now implemented (`src/win32_hle.rs`).
2. **`wsprintfA/W` ignored the register varargs.** On x64 `buffer` is in RCX and `format` in RDX,
   so the first two varargs are R8/R9 and only the rest are stack slots at `[rsp+0x28]`. Reading
   only the stack formatted a zero for every single-argument conversion.
3. **`GetProcAddress` stubs were not callable.** `resolve_proc_address` hashed `(dll,symbol)` into
   the *import* thunk pool and never registered the result, so any call through a resolved pointer
   died with `unmapped thunk 0x7ff0...`. Export stubs now come from their own pool
   (`EXPORT_THUNK_BASE`..`EXPORT_THUNK_END`) and are registered in `import_thunks`.
4. **The virtual volume was case-sensitive.** Files were seeded with mixed-case keys while every
   lookup upper-cases, so `C:\\Game` was invisible and `CreateFileW` in the default working
   directory returned `ERROR_PATH_NOT_FOUND`.
5. **`MultiByteToWideChar`/`WideCharToMultiByte` read their arguments one slot early.** `dwFlags`
   is the second parameter; treating it as `lpMultiByteStr` made every conversion return 0, which
   is what made the wsprintf `%C` tests expect `\\x0000`.

Smaller fidelity fixes that each closed a measurable set of failures: `GlobalGetAtomNameA/W`
truncation rules (atom.c:196-273), `CharPrevA` saturating at the buffer start (wsprintf.c:318),
`GetDriveTypeA("C:")`, `GetDiskFreeSpaceA(NULL)`, `GetEnvironmentVariableA/W` leaving the buffer
untouched when the variable is missing, `OpenProcessToken`/`GetUserProfileDirectoryA/W`, and an
exact port of wine's `RtlExpandEnvironmentStrings` (literal runs copy character by character and
truncate without a terminator; a variable value is copied whole or not at all).

### Next blockers

1. `CreateDirectoryA("C:\\Windows\\System32")` returns `ERROR_PATH_NOT_FOUND` — the fixture runs
   as a normal user, so wine expects the call to fail with `ERROR_ACCESS_DENIED`; and
   `C:\\Please Remove Me*...` style names expect `ERROR_INVALID_NAME`.
2. `environ`'s last 35 failures are `GetEnvironmentVariableA/W` buffer-size reporting and
   `ExpandEnvironmentStrings` over-reporting rules.
3. `d3d12_test` and `porthole_x64_plan_test` die on a NULL vtable slot - the COM objects the D3D12
   HLE hands out need every slot filled, even the ones that only return `E_NOTIMPL`.

### Diagnostics built along the way

* `Win32Kernel::hle_notes` - HLE handlers can emit trace lines (`K ...`), drained by the driver.
* `hle_calls` histogram + `hle_unimplemented` list, printed at the end of every `xtrace` run, so a
  failing fixture immediately reports which APIs it used and which were missing.
* `xtrace --hle-only [--hle-match a,b,c]` - keep only HLE traffic (optionally filtered by symbol),
  which lets a 160-million-instruction run fit in a 300-line trace.

## How the trace is produced

`rust/porthole-x64-wasm/src/bin/xtrace.rs` (native, no wasm needed) plus
`.github/workflows/x64-trace.yml`:

* per-instruction trace (`I` lines: rip, rsp before/after, registers, instruction bytes),
* HLE dispatch log (`H` lines: thunk, `dll!symbol`, `[rsp]`, return address),
* upcall transitions (`U`/`R`),
* **write watchpoints** (`W` lines: address, value, width, writing RIP) over the stack top,
  `.data` and the heap head,
* full `fault_snapshot()`: all 16 GPRs, RSP/RBP, 32 stack qwords, mapping/protection/residency of
  the faulting page, RIP ring.

Because log/artifact downloads are blocked in this sandbox, the workflow publishes each trace as a
check-run `output.summary` and reads it back with
`gh api repos/<owner>/<repo>/commits/<sha>/check-runs/<id> -q .output.text`.

## Remaining work (in order)

1. Finish the `argv` handoff so `main` runs the requested subtest.
2. Iterate on per-API semantics (`atom`, `environ`, `drive`, `directory`, `power`, `wsprintf`,
   `uitools`, `d3d12`) from the guest's own `Test failed` lines, which the harness captures.
3. Split `kernel32_test.exe` per-subtest runs in the conformance report (already supported:
   `run-wine64.mjs` starts each binary as `<image> <subtest>`).
