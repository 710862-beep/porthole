# Continuation brief (any agent, any model)

You are continuing **Porthole**: an x86-64 Windows PE32+ emulator in Rust→WebAssembly
that runs *unmodified* binaries in the browser, with guest RAM paged to on-device
storage. This file is the shortest honest on-ramp; depth lives in the docs it points to.

## Where things stand (2026-10-30, do not re-litigate)

* ✅ 7-Zip 21.07 x64 runs a real archive round-trip (Gate 1A).
* ✅ Chocolate Doom 3.1.1 + Freedoom runs demo1 to completion: **2,664 gametics,
  identical to Wine 9.0**, 3,603,985,626 instructions at ~6 MIPS (Gate 1B).
* ✅ Its frames are real: 1,782 distinct guest framebuffer checksums; title frame
  pixel-identical to an independently decoded IWAD reference (Gate 2 rendering).
* ⏳ Gate 3 (4 MiB resident vs 512 MiB/1 GiB working set): code in `tests/gate3/`, unrun.
* ⏳ Gate 4 (locked Chromebook): probe `gate4-probe.html` ready, device run pending.
* ⚠️ Gate 5: Wine `directory` 0 failures; `environ` 38 (needs itemised capture first).
* ❌ Not done and not claimed: interactive input, audio, guest threads, real D3D12.

## Coding standards (established, evidenced in the tree)

* **Comments explain provenance and danger**: upstream file/function for semantics,
  struct offsets inline, and *why* for anything that once broke (search "fake" /
  "incident" / "measured" to see the style). Match it.
* Rust: no `unwrap()` on guest-influenced data without a safety comment (KI: audit
  pending). HLE returns documented failure codes, never fake success. One concept per
  commit; commit messages carry before/after measured numbers.
* JS: plain, dependency-free modules; fail-closed runners (`process.exit(1)` on any
  unmet check, named blockers printed); every downloaded test binary hash-pinned and
  verified before use (`scripts/fetch-*.mjs` pattern).
* Edits to the same file: serial, then grep-verify (parallel edits have raced).

## Testing requirements

* New guest-facing behaviour ships with a fail-closed check that would have caught its
  absence (guest-authored marker, checksum, or Wine test). "It didn't crash" is not a test.
* Frames: distinct-checksum evolution ≥100 + reference comparison, or it isn't rendering.
* Run the boundary guard + syntax checks before pushing:
  `node scripts/check-boundaries.mjs && npm run check:syntax`.
* Core changes: expect CI-only verification (no local cargo in the sandbox) — publish
  reports via the Checks API pattern (`scripts/ci-publish-trace.py`) and read THOSE.

## Architecture decisions (and why)

1. **Software MMU over Wasm linear memory mapping** — guest VA is sparse regions +
   a bounded HashMap page cache; disk bounds VA, the cap bounds RAM. ⇒ no memory64.
2. **Trap-and-resume paging** — `run_slice` returns `page-fault:<base>`; the Wasm call
   fully exits while the host does async I/O; the instruction re-executes after
   `supply_page`. No blocking on Promises inside Wasm, ever.
3. **HLE over DLL loading** — third-party *executables* run unmodified; their DLLs are
   host-implemented. (Wine cross-checks use the real DLLs under Wine instead.)
4. **SDL software renderer is the graphics path** — it's what the target binary uses;
   D3D12 stays fixture-grade until a real binary + `dxil-spirv` justify otherwise.
5. **Evidence lives in CI artifacts + `docs/x64-emulator-status.md`** with binary hash,
   runner, device on every PASS. If it isn't written there with numbers, it didn't happen.

Start at `docs/HANDOFF-PACKAGE.md`. Good luck; be as suspicious of green checkmarks as
this project taught its last agent to be.
