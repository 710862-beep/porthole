# Phase 4 — Native JIT Stores / CALL / SSE2: measured status

Date: 2026-11-01 (update: commit `7817b65`)
Branch: `arena/633a2716-porthole`
Candidate CI: `41242706190` (`e3a5409`) — **Porthole torture conformance**

## Verdict

**FAIL as a JIT result; the Doom timedemo itself now PASSES on the interpreter.**

Read the update at the bottom first: commit `7817b65` records that Gate 1 Tier B reports
`timed 2664 gametics in 2614 realtics` at 3.72 MIPS — but that run had the JIT
**disabled** by a trace/JIT coupling in the runner, so it is an interpreter number and
must not be claimed as a JIT result. The JIT is measured at 0.76 MIPS against the
interpreter's 1.43 MIPS on identical local runs, so Phase 4's throughput criterion is
still unmet.

### Superseded verdict (kept for provenance)

**FAIL — Doom timedemo has not produced gametics.**

Phase 4 native paths are implemented and exercised by CI, but the full Chocolate
Doom timedemo still does not complete:

- Interpreter baseline: `timeout-still-running`, **0.05 MIPS**, **0 gametics**.
- Hybrid JIT: `exit:11` (guest fault), **0.10 MIPS**, **0 gametics**.
- The authored hot-loop microbench reaches **513 MIPS** in fast mode, so the
  remaining Doom gap is memory/HLE/block-dispatch overhead, not the ALU loop
  ceiling.

## What landed

- ABI v3 JIT context: 64 slots, XMM0–15 as `v128` locals.
- Native integer stores (`i64/i32/store16/store8`) through a software TLB backed
  by `env.resolve`; Wasm linear-memory traps are caught by the host and rolled
  back through an undo log before interpreter retry.
- Native CALL/RET stack traffic: CALL pushes the return RIP with a native store;
  RET pops with a native load; static JMP/CALL edges can link via Wasm
  `call` / `return_call` after an acyclic second AOT pass.
- Basic SSE2/SSE4.1 subset: `movdqa/movdqu/paddd/pxor/pmulld/movd/movq` lowered
  to Wasm SIMD. Complex AVX still exits.
- Correctness fixes found by real Doom/Wine execution:
  - fast-path `jit_commit_block` now clears `jit_active`;
  - ctx undo/touched offsets encoded as u32 LEB;
  - RIP-relative EA no longer double-added (iced already folds RIP);
  - 32-bit address-size overrides fall back precisely;
  - REX low-byte GPRs map to architectural ModRM indexes;
  - linked CALL no longer double-counts caller instructions;
  - cross-page guard branches to `$abort`, not `$commit`;
  - undo rollback skips the invalid-host sentinel.
- Benchmark harness now extracts the pinned IWAD `DEMO1` lump into
  `C:\Game\demo1.lmp`; previous runs logged `couldn't open demo1.lmp`.

## Exact Doom telemetry (CI `41242706190`)

### Hybrid JIT (`doom-jit-report.json`)

```json
{
  "terminal": "exit:11",
  "instructions": 16754100,
  "wallMs": 162045,
  "mips": 0.1,
  "gametics": 0,
  "realtics": 0,
  "presentedFrames": 1,
  "distinctFrameChecksums": 1,
  "jit": {
    "compiled": 25922,
    "executedBlocks": 2022920,
    "executedInstructions": 8377318,
    "traps": 10,
    "cacheHits": 2508522,
    "cacheMisses": 633,
    "saved": 25922,
    "loaded": 0,
    "fallbackInstructions": 7538957,
    "discarded": 1,
    "compileErrors": 0,
    "cacheErrors": 0,
    "commitPageFaults": 0,
    "tailCalls": true,
    "lastTrap": "fault:jit-validation:0x14003a070"
  }
}
```

### Interpreter baseline (`doom-baseline-report.json`)

```json
{
  "terminal": "timeout-still-running",
  "instructions": 46000000,
  "wallMs": 946505,
  "mips": 0.05,
  "gametics": 0,
  "realtics": 0,
  "presentedFrames": 58,
  "distinctFrameChecksums": 11
}
```

### JIT microbench (`jit-microbench.json`, local re-run on the same candidate)

```json
[
  { "mode": "interpreter", "instructions": 40000002, "ms": 3116, "mips": 12.838 },
  { "mode": "jit-validate", "instructions": 40000002, "ms": 169, "mips": 236.505 },
  { "mode": "jit-fast", "instructions": 40000002, "ms": 78, "mips": 513.347 }
]
```

## Remaining blockers

1. **Doom guest fault under JIT.** The JIT lane terminates with `exit:11` after
   ST_Init, around 16.7M instructions. Local diagnostics show residual
   validation mismatches in function epilogues (POP/register state) and one
   `memory access out of bounds` trap before the fault.
2. **Throughput.** Even when it does not fault, Doom runs at ~0.1 MIPS because
   each memory op pays software-TLB + undo-log cost and the host still dispatches
   millions of small blocks. `fallbackInstructions` is 7.5M, not near zero.
3. **Baseline is also too slow.** The interpreter lane does not finish the demo
   in 900 s, so gametics remain 0 even without JIT.

## Next concrete steps

- Reproduce the epilogue POP mismatch with a pinned Doom block and fix the
  remaining stack/register divergence before trusting fast-path stores.
- Replace per-store undo records with per-page copy-on-write snapshots for
  memset/blit loops, keeping precise trap rollback.
- Reduce host round-trips: native indirect-JMP/thunk handling and a fast
  `jit_enter_block` path that avoids re-entering the interpreter between
  already-compiled blocks.
- Re-run the 900 s A/B timedemo and require `gametics > 0`, presented-frame
  diversity, and exact telemetry before claiming Phase 4 complete.

## Update — commit 7817b65 (measured, not projected)

**The Tier B gate is green.** Run 41376487935 on `53e1fad`:

```
GATE 1 Tier B / GATE 2 (Chocolate Doom): PASS
timedemo_gametics=2664 realtics=2614 distinct_frame_checksums=1782 checksum_cross_check=true
presented_frames=2704 frame_size=800x600
terminal=exit:4294967295 instructions=3,603,983,437 page_faults=0 wall_ms=968,067 mips=3.72
```

2664 gametics is the whole pinned `demo1.lmp`; 1782 distinct frame checksums out of
2704 presented frames with `checksum_cross_check=true`.

**What that run does not prove: the JIT was not executing.** `run-chocolate-doom.mjs`
enables the HLE trace ring unless `PORTHOLE_DOOM_TRACE` is exactly `0`, and
`run_slice` refuses to hand off to a native artifact while tracing is on
(`if self.jit_enabled && !self.trace_enabled && …`). The Tier B lane sets neither
variable, so the 3.72 MIPS above is the **interpreter**. The JIT still compiled 25,274
AOT blocks on every page touch, which is why the torture `jit-benchmark` JIT lane
measured 0.28 MIPS while its baseline measured 3.76.

### Measured A/B on the pinned inputs (local sandbox, warm AOT cache, 4,000,000 instructions)

| configuration | wall | MIPS |
| --- | --- | --- |
| interpreter (`PORTHOLE_JIT=0`, trace off) | 2,797 ms | 1.43 |
| hybrid JIT (`PORTHOLE_JIT=1`, trace off, validate mode 1) | 5,613 ms | 0.71 |
| hybrid JIT, validate mode 0 | 5,284 ms | 0.76 |
| hybrid JIT after the `7817b65` host changes | 5,284 ms | 0.76 |

Both lanes land on the same RIP (`0x140020896`) and the same `last_error`, so the
comparison is like-for-like execution, not two different code paths.

### Why the JIT loses, quantified

A 2,000,000-instruction slice reports **492,228 executed blocks for 1,889,926
instructions — 3.8 instructions per native block** — with 76,388 interpreter handoffs
and 76,387 `jit_enter_block` misses. The AOT `.text` scan finds 25,274 basic-block
leaders in 99,023 scanned instructions, i.e. one leader every 3.9 instructions, and every
unconditional/conditional branch *and* every instruction after a `call` becomes a leader.
The host round trip (Rust `run_slice` → `jit_enter_block` JSON → `WebAssembly.Module`
lookup → `run_block` → `jit_commit_block`) therefore costs several microseconds to
execute under four guest instructions. Block length, not instruction codegen, is the
bottleneck.

`7817b65` removes one leg of that round trip per block (no `run_slice` +
`instructions_executed()` between chained artifacts), caches the context `DataView`
against the Wasm memory buffer, drops a per-block `String(entryRip)` map write, and stops
`drainPending` from rewriting the entire ~20 MB JIT archive on every call. Those changes
took the JIT from 0.68 to 0.76 MIPS locally — real, but an order of magnitude short of
the interpreter, never mind the 300–500 MIPS target.

### Blockers, restated honestly

1. **JIT throughput (0.76 local / ~1.1 CI MIPS vs 1.43 / 3.72 interpreter).** Fixing it
   requires longer blocks: continuing a block across a direct `call` (the linker already
   has `Call{indirect:false}` edges) and/or emitting several blocks into one Wasm module
   so successors can `return_call` inside Wasm. Chaining across separate
   `WebAssembly.Instance`s is not possible from JS, and the exact-instruction-count check
   in `jit_commit_block` (`executed != art.insn_count`) rejects a multi-block commit
   without a context-ABI change — every one of the 64 context slots is already allocated.
2. **`jit-benchmark` needs both lanes to finish the demo in the same budget.** The
   interpreter needs 968 s, so the 900 s budget was the failure, not the emulator; the
   budget is now 1500 s. The JIT lane needs ~3.6 billion instructions and would need
   ~2.4 MIPS to fit in 1500 s.
3. **The trace/JIT coupling must be fixed before the JIT can be switched on in the
   production Tier B lane.** Turning `PORTHOLE_DOOM_TRACE` into an opt-in today would
   move Tier B from 3.72 MIPS (interpreter) to ~1.1 MIPS (JIT) and turn a green gate red.
4. **al-khaser regressed from "1 BAD" to `GUEST_FAULT`.** The PAGE_GUARD trap now fires
   (correct: real Windows raises `STATUS_GUARD_PAGE_VIOLATION` on a guard-page fetch), but
   the SEH dispatch did not reach the guest `__except`, so the process dies at instruction
   67,052 instead of reporting one BAD check. `7817b65` fixes the establisher-frame
   desynchronisation and the missing control-PC `-1` adjustment, and reports the rejected
   frames in the fault message.
5. **Wine64 `d3d9`.** `stateblock` still exits 0 with zero assertions (Wine `skip()`s
   before its first `ok()` when `Direct3DCreate9` returns NULL, which the fail-closed
   runner counts as a failure), and `d3d9ex` still times out after 440,000,019
   instructions. Neither is a rendering-equivalence question: there is no D3D9
   rasterizer here, so `visual`/`stateblock` cannot pass honestly, and `d3d9ex` hangs in
   a code path that has not yet been identified.
