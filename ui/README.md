# Porthole desktop UI

The `ui/` project is a React 19 + Vite browser desktop with a dark Linux-desktop visual language. It includes a launcher, taskbar, workspaces, resizable windows, settings, a curated App Store with explicit Chocolatey package downloads into Porthole storage, a browser-based x86-64 emulator surface, System Monitor, and an in-OS Developer Console. It is Porthole, not a CachyOS distribution or installation image, and it does not ship a mock browser or simulated production guest runtime.

## Run and verify

```bash
cd ui
npm install
npm run dev          # Vite on 0.0.0.0:5173 (Arena preview compatible)
npm run typecheck
npm run check:no-any
npm run check:boundaries
npm run smoke
npm run build
```

The build copies an already-present Wasm artifact if available, typechecks, then builds the UI. It does not compile Rust or download an artifact. If the ABI-v3 module is absent or fails to initialize, the desktop remains usable for diagnostics but reports the runtime as unavailable and disables guest import/launch. No simulated runtime or mock browser is shipped.

## Runtime and artifact

`runtime/contracts.ts` mirrors the wasm-bindgen boundary. `RuntimeRouter` uses `WasmEmulatorRuntime`, which adapts ABI-v3 `BrowserX64Emulator`, `js/x64-jit-host.js`, and `js/x64-nvme-vfs.js`. The adapter connects AOT compilation, JIT slices/cache, guest page-fault resolution, and frame/telemetry channels.

Porthole runs in the browser; it cannot create native host Windows processes. When the CI-produced Wasm artifact is available, imported PE32+ files may be executed as guest processes inside that runtime. This does not imply general Windows or game compatibility. The Wasm-bindgen files belong in `vendor/porthole-x64-wasm/` (or `ui/public/wasm/`); `scripts/copy-wasm-artifacts.mjs` copies already-present files into ignored `ui/public/wasm/`. No generated Wasm is committed. User-selected storage can be OPFS, File System Access, or volatile memory. Guest executables and assets must be imported or already mounted locally.

**Frames and input:** only guest buffers returned after a core present are rendered as guest output. No placeholder pixels are synthesized. Keyboard delivery and mouse-button state remain pending in the core (KI-04); mouse position has a separate limited injection path.

## Catalog safety

The App Store starts with 24 curated entries and also provides paginated live search across the Chocolatey Community Repository's public OData search feed; it does not mirror the entire repository offline. Curated metadata uses a local cache; search results expose package ID, version, summary/description, tags, project link and download count when published. Get downloads a versioned `.nupkg` into `PortholePackages/` in the selected storage root, separate from guest files. Transfers are size-limited and show progress/cancellation. After bounded archive inspection and explicit confirmation, a directly embedded PE32+ x64 EXE plus same-folder non-script payloads can run only inside Porthole's Wasm guest. The Store never runs Chocolatey PowerShell/batch scripts, MSI installers, or package URLs. Guest file writes are persisted on process exit only when the updated CI ABI exposes the snapshot exports. This does not guarantee an installer succeeds; interactive input, Windows services/registry behavior, external downloads and universal Windows-app compatibility are unsupported. Browser CORS, package availability, storage quota and archive size can still prevent a download. “Save listing” remains a separate browser-local bookmark, and local game files are not fetched from Chocolatey.

## Diagnostics

System Monitor probes browser capabilities and displays runtime telemetry when the Wasm core is available. The Developer Console captures UI events, runtime state/logs, aggregate core HLE/SHIM counters and unimplemented-import diagnostics. SHIM histogram entries are aggregate counters, not per-call traces; per-call trace fidelity is not verified.

For runtime and security boundaries, see [`../docs/ui-runtime-architecture.md`](../docs/ui-runtime-architecture.md). For the visual system and desktop scaffold, see [`DESIGN.md`](DESIGN.md).
