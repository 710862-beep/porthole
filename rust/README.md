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

## Source changes (not yet rustc-validated)

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

## Actual local result

`npm run build:wasm`: **BUILD_BLOCKED: missing tool cargo**.
A Rustup executable was acquired through PyPI (`rustup==1.29.0.1`), then a real
Rust 1.81.0 installation attempt failed while fetching
`https://static.rust-lang.org/dist/channel-rust-1.81.0.toml.sha256`
with `tls handshake eof` (host outside this sandbox's outbound allowlist).
No Rust compiler, target stdlib, native Rust test execution or rebuilt Wasm was
obtained. `artifacts/toolchain-acquisition.log` retains the failure.

Tree-sitter found no new grammar errors relative to upstream in 12 changed .rs
files; its pre-existing opaque wasm-bindgen extern-type errors are not rustc
errors. Grammar inspection is NOT a substitute for compilation/type checking.

CI's separate rust-wasm-candidate job installs the toolchain/linker, regenerates
DLLs, builds and validates the five PEs plus acquired originals. It has not been
run remotely in this session. Candidate tests are mandatory failures when
unsupported; publication is not promotion or proof of passing.
