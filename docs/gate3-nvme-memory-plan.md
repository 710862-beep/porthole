# GATE 3 — NVMe memory proof (DRAFT, not yet wired into CI)

Status: **design + test code drafted, no measurement yet.** Everything below that describes
expected numbers is a prediction to be falsified by the first run, not a result.

## The claim under test

"Guest RAM can exceed the Chromebook's physical RAM because the VMM keeps only a small LRU
window of guest pages in Wasm memory and faults the rest to files on the device SSD (NVMe)."

What would prove it, and what this test measures (all recorded in
`artifacts/gate3-nvme-report.json` by `tests/gate3/run-nvme-stress.mjs`):

| Gate 3 requirement | How the draft answers it |
| --- | --- |
| Guest VA vs resident vs NVMe bytes | Guest commits 512 MiB (final run: 1024 MiB) of VA; resident cap forced to 1024 pages = **4 MiB**; shard store byte counters + final on-disk bytes reported |
| Fault count, NVMe read/write MiB | `pageFaults` (host-serviced), `evictionsDrained`, `storeMiBWwritten`/`storeMiBRead` from real file I/O |
| p50/p99 fault latency | Every fault timed around `readPage + supply_page` (Node `fs` on CI disk in this draft; the identical protocol runs against OPFS/`FileSystemFileHandle` in Chrome — those latency numbers only exist after Gate 4 device runs) |
| Trap-and-resume across async I/O | State machine below; correctness is the proof (zero wrong words after ≥2 full trips through the store) |
| 1 GB deterministic write/read byte-identical | Same test at `PORTHOLE_GATE3_MIB=1024`; guest self-verifies every word, host independently re-derives every word from the pattern and compares the shard files |
| `WebAssembly.Memory` feasibility | See "Why plain wasm32 memory suffices" — guest VA is *not* linear memory |

Fail-closed PASS criteria (all required): guest exit 0 with `NVME_STRESS_OK … bad=0`;
`pageFaults >= guestPages - residentPages` (faults were unavoidable, not incidental);
store bytes written ≥ 90% of the guest buffer; resident peak ≤ cap; host byte-identical
re-verification of all `guestPages` pages from the shards.

## The trap-and-resume state machine (as implemented, file:line)

```
                 run_slice(budget)
        ┌──────────────────────────────────┐
        │  CPU executing guest code        │
        │  load/store -> VMM ensure_page   │
        └───────┬───────────────┬──────────┘
       page resident      page in swapped_out_pages
        │                        │ Err(MemoryTrap::PageFault(base))
        ▼                        ▼  (raised by preflight/ensure BEFORE any
   (continues)               data byte is read/written; vmm.rs ensure_page_mut
                             + preflight_range: multi-page ops never
                             partially commit)
                                 │ propagates out of cpu.execute();
                                 │ RIP still AT the faulting instruction
                                 ▼
                      run_slice returns "page-fault:<base>"
                      (lib.rs Err(MemoryTrap::PageFault) arm)
                                 │
                    ═══ Wasm instance FULLY EXITED ═══
                    JS host: drain evictions -> persist shards;
                    read 4 KiB for <base> (await FileSystemFileHandle
                    read in the browser; fs.readSync in the Node draft)
                                 │
                                 ▼
                      emu.supply_page(base, bytes)
                      (vmm.supply_faulted_page: insert page, clear
                      swapped mark, pages_faulted_in++)
                                 │
                                 ▼
                      run_slice(budget) again -> the SAME instruction
                      re-executes and now completes
```

There is no "Promise cast to u32": the synchronous guest load/store never blocks on a JS
Promise. The Wasm call returns a status string; time passes; the host calls back in. The
guest-visible effect is identical to a real MMU page fault handled by an OS: the faulting
instruction restarts. Accesses that are *not* resumable (uncommitted VA, write to
read-only page) raise `AccessViolation` instead and terminate the run as a fault.

## Why plain wasm32 `WebAssembly.Memory` suffices (no memory64 needed)

Guest VA never maps 1:1 onto Wasm linear memory. The VMM is a software MMU:

* Address-space layout lives in `regions: BTreeMap<u64, VmaRegion>` — sparse, so a 512 MiB
  (or 512 GiB) guest mapping costs one region record until touched (`virtual_alloc` only
  inserts the region; pages materialise on first access).
* Page contents live in `page_cache: HashMap<u64, PageEntry>` with
  `len <= max_resident_pages`. Wasm heap consumption from guest RAM is therefore
  ≈ `resident_pages x 4 KiB` + map overhead — 4 MiB at this test's cap — no matter how
  large the guest VA is. The wasm32 4 GiB ceiling bounds the *resident window*, and even a
  1 GiB window would fit.
* Everything non-resident exists only as: a `swapped_out_pages: HashSet<u64>` marker plus
  bytes in host shard files.

So "unlimited RAM" really means: *guest VA is bounded by disk, guest-resident RAM is a
fixed, configurable window*. The honest limits are (a) fault throughput — one host
round-trip per faulted page, so a thrashy access pattern runs at disk latency x fault
rate; (b) metadata — 8 bytes/shard-record + HashSet entry per swapped page (1 GiB of
guest RAM = 262,144 pages ≈ a few MiB of metadata); (c) the pinned-page set — PE image /
loader pages are pinned resident and count against the cap.

## Known hazards this draft deliberately exposes (follow-ups, not hidden)

1. **HLE bulk copies do not trap.** HLE arms use `vmm.write_bytes` and ignore the
   `Err(PageFault)` result, so e.g. a guest `memcpy` (HLE-interception) into a swapped-out
   destination silently drops the tail of the copy today. The Gate 3 guest fixture
   therefore uses only plain CPU stores for its buffer. Real guests (7za, Doom) ran with
   a 256 MiB window where this rarely bites; with a 4 MiB window it will. Fix direction:
   let HLE dispatch surface `PageFault`, have `run_slice` return it like a CPU fault and
   re-dispatch the same HLE call after supply — needs care to keep HLE calls idempotent.
   **Expect the first 4 MiB-window run of a real binary to find these; the authored
   fixture is the controlled first step, not the last.**
2. **Clean-page eviction relies on pinning.** Evicting a clean page just drops it and
   marks it swapped; on refault the host supplies shard bytes (or zeros if never
   persisted). That is only correct because file/image-backed clean pages are pinned in
   this design. If pinning is ever relaxed, clean victims must be persisted too (or be
   re-derivable from their backing file).
3. **Eviction victim search is a linear scan** (`evict_if_needed_locked` walks the whole
   cache per eviction). At 1024 resident pages irrelevant; at 65,536 pages it is
   O(window) per fault and will show up in p99. A clock/second-chance hand is the fix
   when measurements demand it.
4. **Node numbers are not Chromebook numbers.** This draft's latencies are Node `fs` on a
   CI NVMe. The browser path (OPFS sync access handles in a worker, or File System Access
   on the picked directory) has different latency and durability semantics; Gate 4 must
   re-measure on the locked Chromebook before any "works on the device" wording.

## Files (all draft)

* `tests/gate3/nvme_stress.c` — guest workload (build with the existing zig fixture
  pipeline when wiring CI: `x86_64-windows-gnu`, console subsystem).
* `tests/gate3/run-nvme-stress.mjs` — host driver, shard store, instrumentation,
  fail-closed verdict, `artifacts/gate3-nvme-report.{json,txt}`.
* CI job sketch (to add when green locally in CI): build fixture + `needs: wasm-build`,
  `PORTHOLE_GATE3_MIB=1024` for the gate run, 512 for PR-time. Estimated wall time at
  ~6 MIPS: the write+verify sweeps are ~0.7e9 guest instructions at 512 MiB (~2 min),
  ~1.4e9 at 1 GiB (~4 min), plus ~400k host fault round-trips (~tens of seconds).

## Predicted headline numbers for the first 512 MiB / 4 MiB run (to be falsified)

* guestPages = 131,072; pageFaults ≈ 131,072 (phase 2) + ~200,000 (phase 3 probes)
  ≈ 330k; evictions ≈ faults + 131k (phase 1 streaming) ≈ 460k
* store written ≈ 1.8 GiB cumulative (pages evicted more than once), store read ≈ 1.3 GiB
  cumulative; final on-disk footprint = 512 MiB
* resident peak = 1024 pages (4 MiB) + pinned image pages inside the same cap
