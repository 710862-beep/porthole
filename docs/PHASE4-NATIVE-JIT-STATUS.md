# Phase 4 — Native JIT Stores / CALL / SSE2: measured status

Date: 2026-10-31
Branch: `arena/633a2716-porthole`
Candidate CI: `41242706190` (`e3a5409`) — **Porthole torture conformance**

## Verdict

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
