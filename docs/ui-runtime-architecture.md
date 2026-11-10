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
- `ui/scripts/copy-wasm-artifacts.mjs` only copies a Wasm-bindgen artifact already produced by CI (or supplied locally) into `ui/public/wasm/`. It neither compiles Rust nor downloads artifacts.

### Browser and host-process boundary

The desktop is a web application. It cannot create native host Windows processes or behave as a Windows installation. When the ABI-v3 artifact is available, the core can load user-imported PE32+ files as *guest* processes in WebAssembly; that is not the same as a native Windows process and does not imply general game compatibility. The desktop contains no mock browser, simulated shell, or synthetic production guest fallback.

### Storage and user imports

The runtime supports OPFS, a user-selected File System Access directory, and volatile memory. User-imported files are filename-sanitized, can preserve relative subdirectories beneath `C:\\Game`, and are capped at 256 MiB per operation. Guest writes are snapshotted into the selected storage on process exit/stop: `C:\\Game` remains user-visible under `Game/`, while other C: paths are stored under `.porthole_guest_fs/`; the total persisted/read guest tree is bounded at 256 MiB. An explicit App Store action saves a versioned Chocolatey `.nupkg` under `PortholePackages/`, separate from the guest drive. After bounded ZIP inspection and explicit confirmation, a directly embedded PE32+ x64 EXE and same-folder non-script payload may be copied to guest storage and launched only inside the Wasm runtime. The Store never runs Chocolatey PowerShell/batch scripts, MSI installers, or package-provided URLs. This guest-run path is enabled only when the loaded CI ABI exposes the new file-snapshot exports. It does not prove that installation succeeded or that an app is compatible; guest registry/services and keyboard/mouse-button delivery remain incomplete. A local IWAD `DEMO1` lump may be exposed as `C:\\Game\\demo1.lmp` for `-timedemo demo1`; no Doom assets are fetched by this UI.

### Runtime limitations

- The adapter reports only buffers returned by the core after SDL/D3D12 presents. Empty guest buffers remain empty; the UI does not synthesize pixels.
- Keyboard delivery and mouse-button state are not implemented by the current core contract (KI-04). Mouse position has a separate injection path; the shell warns rather than claiming playable input.
- A guest modal request is logged and pauses execution until a desktop modal bridge exists.
- The ABI-v3 binary is a CI artifact. If it is absent, the runtime is unavailable; this UI does not build Rust or fetch the artifact locally.
- The unmodified Chocolate Doom timedemo remains under investigation. The historical interpreter-only pass is not evidence that the current hybrid-JIT path succeeds; see `docs/x64-emulator-status.md` and the Doom CI telemetry.

## 2. Chocolatey catalog and downloads

`runtime/catalog.ts` contains 24 curated entries. Curated Chocolatey metadata is refreshed from the public NuGet/OData feed; `runtime/chocolateyMetadata.ts` also supports live package search, bounded results and validated pagination. Metadata may fail because browser CORS or the public feed is unavailable; the Store reports errors and cached metadata rather than claiming a successful refresh.

A user-triggered download fetches a versioned `.nupkg`, checks its size cap and ZIP signature, then writes it under `PortholePackages/` at the selected storage root. Downloads work independently of the Wasm guest runtime; the UI reports progress, supports cancellation, and rescans storage so saved packages remain visible after reload when storage is persistent. “Inspect package” performs bounded ZIP-directory/path validation and exposes only directly embedded PE32+ x64 executables. After a separate confirmation, the selected executable and same-folder non-script payloads can run only inside Porthole’s Wasm guest. PowerShell/batch scripts, MSI files, and package URLs are never executed or followed. Guest C: file writes are persisted on exit when the loaded ABI has the required exports, but install success is not inferred; interactive installers, Windows services/registry behavior, external downloads, and universal app compatibility are unsupported. “Save listing” remains a separate browser-local bookmark.

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
