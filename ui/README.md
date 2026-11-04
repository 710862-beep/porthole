# Porthole desktop UI

The `ui/` project is a React 19 + Vite browser desktop with a dark Linux-desktop visual language. It includes a launcher, taskbar, workspaces, resizable windows, settings, a curated metadata-only App Store, a browser-based x86-64 emulator surface, System Monitor, and an in-OS Developer Console. It is Porthole, not a CachyOS distribution or installation image, and it does not ship a mock browser or simulated production guest runtime.

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

The App Store contains 24 curated entries, not a full live Chocolatey search index. Chocolatey Community Repository integration requests public OData package metadata only (version, summary/description, tags, project link and related fields), with a 12-hour local cache. No `.nupkg`, installer, native executable, package scripts or package contents are downloaded or executed. “Add to library” saves a browser-local bookmark; it is not an installation. User-imported files are separate from the Chocolatey feed.

## Diagnostics

System Monitor probes browser capabilities and displays runtime telemetry when the Wasm core is available. The Developer Console captures UI events, runtime state/logs, aggregate core HLE/SHIM counters and unimplemented-import diagnostics. SHIM histogram entries are aggregate counters, not per-call traces; per-call trace fidelity is not verified.

For runtime and security boundaries, see [`../docs/ui-runtime-architecture.md`](../docs/ui-runtime-architecture.md). For the visual system and desktop scaffold, see [`DESIGN.md`](DESIGN.md).
