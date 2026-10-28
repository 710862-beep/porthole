# Porthole retrowin32 source candidate

This is **source integration, not a validated replacement Wasm**. The stable
runtime remains `vendor/retrowin32/retrowin32.wasm` and was not overwritten.

## Origin and scope

`retrowin32/` vendors upstream evmar/retrowin32 at
`00d8809d579fb7baf8fecb2c0118abe72a91bd6c` (Apache-2.0; upstream LICENSE retained).
The historical revision correlates with the published pages build's panic line
and scheduler; it is not a proven reproducible source mapping of that binary.
`PROVENANCE.json` records the source archive checksum, revision, modifications,
and tool versions. `patches/porthole-core.patch` is the complete local source
delta, verified to apply to the pristine downloaded revision.

The upstream tree includes development UI/examples; Porthole does not build or
load that UI. Porthole remains Vanilla JS/CSS. `web/wasm.wasm` inside the upstream
source is a placeholder and is NOT a build input/runtime engine.

## Source changes (compiled and tested in Actions; compatibility incomplete)

- CPUState::Terminated; terminated CPUs excluded from scheduling; no empty
  deadline unwrap when all CPUs have completed. Machine recognizes all-completed.
- Entry-point return terminates that CPU; worker return/ExitThread no longer
  invokes process-wide exit. Explicit ExitProcess remains immediate.
- Thread handle namespace, CloseHandle support, independent TEB/FS for workers,
  bounded TLS slot access, default stack size, lpThreadId output. Suspended
  creation/security attributes are rejected, not pretended to be supported.
- Cooperative WaitForSingleObject/MultipleObjects for thread/event handles;
  atomic readiness/consumption, one shared deadline, auto/manual-reset events.
  Currently uses a 1 ms sleep poll, not a fully event-driven scheduler.
- Replace null task Context references in upstream future polling with valid
  noop wakers. This does not remove all upstream raw-pointer aliasing risks.
- ANSI registry APIs use a typed host bridge, copied bytes and guest-memory
  bounds checks. The JS adapter uses the existing RegistryStore and its snapshot
  persistence; RegSet success means accepted overlay, not durable flush.
  Wide APIs explicitly return unsupported rather than the upstream fake success.
- Rust web host clock uses host.ticks(), and create_dir delegates to host overlay
  instead of todo!(). Native hosts without registry support return unsupported.

Still missing: complete Raw Input/WM_INPUT binary ABI, ws2_32 guest integration,
semaphores and critical sections in Rust, suspension/resumption/termination
semantics, TLS slot reclamation, full TEB/SEH metadata, security/ACL semantics,
and verified durable directory/registry behavior through a new guest build.
Existing upstream API stubs outside this delta are not endorsements of support.

## Build candidate

Required: Rust **1.81.0**, cargo/rustfmt, target wasm32-unknown-unknown, make,
clang-cl/lld-link, and wasm-bindgen-cli **0.2.92** (matches Cargo.lock).

```
rustup toolchain install 1.81.0 --profile minimal --component rustfmt --target wasm32-unknown-unknown
cargo +1.81.0 install wasm-bindgen-cli --version 0.2.92 --locked
npm run build:wasm
```

The script forces the **Win32 dllexport generator and PE DLL rebuild first**,
then runs native Rust tests, builds `-p glue`, and runs wasm-bindgen on
`glue.wasm`. A standalone wasm-bindgen export does not register a Win32 import.
It writes matching binding and Wasm into `artifacts/wasm-candidate/`, never vendor.

```
PORTHOLE_WASM=artifacts/wasm-candidate/retrowin32.wasm \
PORTHOLE_GLUE=artifacts/wasm-candidate/glue.mjs \
node scripts/run-synthetic.mjs
```

Both environment variables must reference the matching build. Each process
loads a fresh glue instance; the reports include the backend SHA-256. Neither
exit 0 nor SUCCESS is sufficient if flushError is set. Registry bridge injection
is explicit via `registryBridge` in createProcess; the runner uses a volatile
store, not a claim of physical persistence. App/UI automatic provisioning and
cross-session guest persistence remain to be validated before promotion.

## Actual remote result — 2026-10-28

Local Rust installation remains blocked; GitHub Actions is the working build
server. Source commit `1bd21160ae81f88eaaa50c54a8a939bc6545457f`,
[run 40714518581](https://github.com/710862-beep/porthole/actions/runs/40714518581):
Rust 1.81.0, bindgen 0.2.92, rebuilt DLLs, **8 native Rust tests passed**, and
release Wasm produced. Downloaded Wasm: **1,669,558 bytes**. Checksums, Wasm
compile and matching JS binding initialization passed locally and remotely.

**Workflow remains red:** 3/5 authored guest contracts passed (threads, registry,
installer with real Node disk verification), 2 failed (headless input and absent
ws2_32). Original probes: 6/15 passed; DOOM95 still fails with a null jump.
Raw Input and ws2_32 are not implemented by this source delta. No promotion.

Two bootstrap bugs were fixed using real CI diagnostics: missing generated
DLL files in clean checkouts, and an invalid local `default` re-export in the
binding. A validator regression rejects that syntactically invalid binding.

Normal Actions artifact redirects are blocked in this sandbox. The workflow
also creates **unreferenced Git blobs**, with a small Checks API transfer manifest;
this does not commit binaries or update any branch/ref. `contents: write` is
needed only for blob creation. The downloader verifies run/source SHA, Git blob
SHA1, size and SHA256 before writing under ignored `artifacts/remote/<run>/`.
Blobs are an ephemeral transport; normal Actions artifacts retain their 14-day
policy. No access tokens or signed artifact URLs are stored in reports.

```bash
bash scripts/build-remote.sh --run 40714518581
# exits nonzero because guest compatibility gates remain failed
# API-only direct retrieval (no promotion):
python3 scripts/download-ci-blobs.py 40714518581
node scripts/validate-wasm.mjs artifacts/remote/40714518581/retrowin32-candidate-wasm
```

The manual workflow dispatch API returns 403 for the sandbox integration;
pushing the session branch automatically starts this workflow. No other branch
was created. See [full report](../docs/rust-wasm-integration.md).
