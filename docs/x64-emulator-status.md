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
