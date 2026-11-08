# Porthole desktop, browser runtime, and catalog architecture

This note describes the React/Vite desktop in `ui/`, its ABI-v3 WebAssembly adapter, and the boundaries around game files and Chocolatey metadata. Wiring the UI does not prove Windows compatibility or Doom timedemo success.

## 1. Runtime path

```text
BootExperience / storage choice
  └─ Shell.beginSession(backend)
      └─ RuntimeRouter.initialize(backend)
          └─ WasmEmulatorRuntime.initialize()
              ├─ load the CI-produced wasm-bindgen ABI-v3 module
              ├─ mount OPFS, a user-selected File System Access directory, or memory VFS
              └─ connect the shared-memory X64JitHost and guest page/JIT-cache storage

Emulator launch
  └─ import user-selected files into the mounted C:\\Game directory
  └─ useEmulator.loadAndLaunch(path, arguments)
      └─ RuntimeRouter.loadExecutable() — refuses when initialization failed
          └─ WasmEmulatorRuntime.loadExecutable()
              ├─ load PE32+ and command line through BrowserX64Emulator
              ├─ compile AOT text and drain/flush ABI-v3 JIT artifacts
              └─ RAF scheduler → X64JitHost.runSlice → core.run_slice / JIT blocks
                   ├─ resolve guest page faults through the mounted VFS
                   ├─ collect SDL/D3D12 guest-presented buffers only
                   ├─ persist evicted guest pages and portable JIT cache entries
                   └─ report core HLE histogram, unimplemented imports, logs and telemetry
```

### Ownership and fallback policy

- `ui/runtime/contracts.ts` mirrors the wasm-bindgen boundary; `types.ts` adds shell-facing telemetry, logs, catalog and storage contracts.
- `runtimeRouter.ts` uses only `WasmEmulatorRuntime`. If the ABI-v3 artifact or required browser capability is unavailable, it records the failure and exposes `mode: "unavailable"`. It does not select a synthetic guest runtime. Guest import and launch remain disabled until the Wasm runtime initializes.
- `wasmRuntime.ts` is the only adapter that knows the ABI. It reuses `js/x64-jit-host.js` and `js/x64-nvme-vfs.js` through Vite platform bridges; it does not fork the JIT or VFS implementation.
- `useRuntime.tsx` owns the singleton runtime bundle and mirrors state into Zustand. `useEmulator.ts` and the window manager provide lifecycle and UI actions.
- `scripts/copy-wasm-artifacts.mjs` only copies a Wasm-bindgen artifact already produced by CI into ignored `ui/public/wasm/`. It neither compiles Rust nor downloads artifacts.

### Browser and host-process boundary

The desktop is a web application. It cannot create native host Windows processes or behave as a Windows installation. When the ABI-v3 artifact is available, the core can load user-imported PE32+ files as *guest* processes in WebAssembly; that is not the same as a native Windows process and does not imply general game compatibility. The desktop contains no mock browser, simulated shell, or synthetic production guest fallback.

### Storage and user imports

The runtime supports OPFS, a user-selected File System Access directory, and volatile memory. Guest binaries/data must already be present in the selected local `C:\\Game` folder or explicitly imported by the user. Imports are filename-sanitized and capped at 256 MiB per operation. An explicit App Store action saves a versioned Chocolatey `.nupkg` archive under `PortholePackages/` at the selected storage root, outside `C:\\Game`; this works independently of the Wasm guest runtime. The Store does not extract it or run package scripts/installers. A local IWAD `DEMO1` lump may be exposed as `C:\\Game\\demo1.lmp` for the existing `-timedemo demo1` argument; no Doom assets are fetched by this UI.

### Runtime limitations

- The adapter reports only buffers returned by the core after SDL/D3D12 presents. Empty guest buffers remain empty; the UI does not synthesize pixels.
- Keyboard delivery and mouse-button state are not implemented by the current core contract (KI-04). Mouse position has a separate injection path; the shell warns rather than claiming playable input.
- A guest modal request is logged and pauses execution until a desktop modal bridge exists.
- The ABI-v3 binary is a CI artifact. If it is absent, the runtime is unavailable; this UI does not build Rust or fetch the artifact locally.
- The unmodified Chocolate Doom timedemo remains under investigation. The historical interpreter-only pass is not evidence that the current hybrid-JIT path succeeds; see `docs/x64-emulator-status.md` and the Doom CI telemetry.

## 2. Chocolatey catalog and downloads

`runtime/catalog.ts` contains 24 curated entries. Chocolatey's public NuGet/OData `Packages()` feed supplies metadata for the known package IDs (version, title, summary/description, project link, tags, publish date and download count). The catalog is not a full live Chocolatey search index. `runtime/chocolateyMetadata.ts` filters the feed request by those IDs, caches metadata in local storage for 12 hours, times out after seven seconds, and can show cached metadata if the feed fails.

A user-triggered download fetches that version's `.nupkg` from Chocolatey's package endpoint, checks the size cap and ZIP signature, then writes the archive under `PortholePackages/` at the selected storage root. Downloads work independently of the Wasm guest runtime; the UI reports progress, supports cancellation, and rescans storage so saved packages remain visible after reload when storage is persistent. It never extracts packages or runs PowerShell scripts/installers. The archive is downloaded content, not an installed-app or compatibility claim. “Add to library” remains a separate browser-local bookmark; native executables and game assets are not fetched by this flow.

## 3. In-OS developer console

`DeveloperConsoleApp` consumes a bounded 600-row Zustand event ring. It shows:

- captured desktop control actions;
- runtime state transitions and adapter logs;
- aggregate SHIM/HLE counters and the core's unimplemented-import report;
- runtime telemetry when the Wasm core is available.

SHIM entries are aggregate counters from the core's `hle_histogram`, not a trace of each API call. Per-call SHIM trace fidelity is not verified. When the ABI-v3 runtime is unavailable, no simulated guest activity or telemetry is substituted.

## 4. Verification

From `ui/`:

```bash
npm run check:no-any
npm run check:boundaries
npm run typecheck
npm run smoke
npm run build
```

These checks cover UI contracts and shell flows; they do not replace Rust/JIT CI or the Doom timedemo. Report emulator results only from the CI job and its captured telemetry.
