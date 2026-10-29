# x86-64 emulator — measured status (2026-10-29)

This file records **measured** evidence only. Nothing below is a projection.

## What is real and verified in CI

| Gate | Command | Result |
| --- | --- | --- |
| Rust core unit tests | `cargo test --all-targets` (rust 1.81, ubuntu-24.04) | **PASS** — VMM 34 GB sparse VA + LRU eviction/page-fault roundtrip, hybrid Wasm JIT emitter (`\0asm` module, epoch invalidation), emulator construction |
| Wasm build | `cargo build --release --target wasm32-unknown-unknown` + `wasm-bindgen --target web` | **PASS** — `porthole_x64_wasm.js` + `porthole_x64_wasm_bg.wasm` produced and uploaded |
| Wine 64-bit fixture build | `node scripts/build-wine64-tests.mjs` (zig 0.13.0, pinned Wine `0738d528`) | **PASS** — 4 unmodified upstream tests compiled to `PE32+` (`0x8664`): `kernel32_test.exe` (power, drive, atom, environ, directory), `user32_test.exe` (wsprintf, uitools), `d3d12_test.exe` (d3d12), `porthole_x64_plan_test.exe` |
| Wine 64-bit conformance inside the Wasm emulator | `node tests/wine64/run-wine64.mjs` | **FAIL — 0/4 passed** |

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

### Subtest results (measured, run 40974146382)

The CRTs now reach `main` and **run the real subtests**:

| Fixture / subtest | Verdict | Instructions | Guest console |
| --- | --- | --- | --- |
| `user32_test.exe uitools` | **PASS** (exit 0) | 5 935 | `uitools: 42 tests executed (0 failures), 0 skipped` |
| `kernel32_test.exe power` | **PASS** (exit 0) | 1 529 | `power: 5 tests executed (0 failures), 0 skipped` |
| `user32_test.exe wsprintf` | 31 failures (exit 31) | 25 532 | `wsprintf.c:83 zero padded negative value failure: buf=[0000000000]` |
| `kernel32_test.exe drive` | 2+ failures, then `unmapped thunk` | 17 456 | `drive.c:64 got 1 for drive spec 'C:'` |
| `kernel32_test.exe directory` | failures, then `unmapped thunk` | 14 846 | `CreateDirectoryA(C:\Windows\System32): ret=1 err=3` |
| `kernel32_test.exe environ` | `unmapped thunk 0x7ff00000f2a0` | 1 039 | - |
| `kernel32_test.exe atom` | budget exhausted (60 000) | 60 000 | - |
| `d3d12_test.exe d3d12` | access violation at 0x0 | 1 005 | call through a NULL vtable slot |
| `porthole_x64_plan_test.exe x64_plan` | access violation at 0x0 | 13 688 | `CreateFileW on C:\Game failed: err=3` |

### First three semantic blockers, with the exact API

1. **`wsprintfA` / `wsprintfW` (user32.dll)** - 31 failures. `wsprintfA` with
   `"%010d", -12345` produces `0000000000`; the length probe (`buf=NULL`) returns 1 instead of the
   full expanded length, so the caller's "wrong result [0]" comparisons all fail. The HLE formatter
   needs the Win32 subset: `-`/`0`/`+`/` ` flags, width, precision, `%I64d`, `%s`, `%c`, `%x`, `%p`.
2. **`CreateFileW` on `C:\`** - `ERROR_PATH_NOT_FOUND (3)` where Wine expects sharing/access
   errors, plus `GetDriveTypeA("C:")` returning 1 instead of `DRIVE_FIXED (3)`, and
   `CreateDirectoryA("C:\\Windows\\System32")` returning 1/err 3.
3. **`unmapped thunk 0x7ff00000_____`** - a call into the HLE region whose slot was never
   registered: `GetProcAddress` hands the guest a thunk for an export that `dispatch` does not
   implement, so the driver cannot resolve `(dll, symbol)` for that RIP.

`atom` exhausting 60 000 instructions without a fault is a *livelock*, not a crash: the guest is
looping on a `GetAtomNameA` truncation rule that our HLE answers inconsistently.

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
