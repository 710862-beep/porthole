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

### Initial results

Pending the first `Porthole torture conformance` CI run. Build failures, guest faults,
timeouts, zero-assertion runs and missing binaries are not passes. Raw evidence will be
recorded here with run ID, source SHA, binary hashes and exact excerpts.

### Phase 2

Not started in this initial pass. No 300–500 MIPS claim is supported. A future executable
JIT must validate translated blocks against the interpreter, invalidate on code-page writes,
preserve precise guest fault state, and benchmark the same Chocolate Doom workload before
any speedup is reported.
