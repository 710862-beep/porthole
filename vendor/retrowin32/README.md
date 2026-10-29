# retrowin32 backend (vendored)

Upstream: <https://github.com/evmar/retrowin32>  
License: Apache-2.0; see `LICENSE` in this directory.

This directory contains only the user-mode x86/Win32 Wasm engine, its generated
JavaScript binding, and two small upstream test programs. It does **not** contain
a Windows image, BIOS, Windows kernel, Preact, or the upstream debugger UI.

## Pinned sources

- Wasm and generated binding: `pages` branch, commit
  `eea2a62dad509d0e4bbde871abe88e483fbf4764`.
- Test executables and Zig sources: `main`, commit
  `7c9243072755da54054bcaa9e1351371af638ded`.
- Wasm SHA-256:
  `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`.
- `hello.exe` SHA-256:
  `aedd81ffb8358801ad2ee2202b24b4fcde1cb9f0e40c4c3059b72c8fc76b6ce3`.
- `callback.exe` SHA-256:
  `d1c0fe175759cf83be5bf764686693cdaecb8eb308a3f1d9f8f89c545dcdaf7f`.

`glue.mjs` was extracted from the generated `glue/pkg/glue.js` section of the
upstream `pages/bundle.js`. Porthole adds an explicit optional headless-clock import adapter and
three named exports at the end (`initRetrowin32`,
`createRetrowin32Emulator`, and `Retrowin32Status`). The clock adapter supplies performance.now to the pinned Rust ticks contract in Node, without creating a global Window or DOM. All other generated binding behavior is preserved. Porthole supplies
its own Vanilla JS host in `js/retrowin32-backend.js`.

## Scope

The engine executes PE32 x86 instructions in user mode and supplies its own
high-level Win32 modules. Porthole adapts files, stdout, timers, events, and
Canvas surfaces. The Porthole JavaScript SHIMs are a separate path used by the
integrated D3D9 workload and PE import report; they are not credited for calls
handled inside retrowin32.

`callback.exe` intentionally imports the test-only `retrowin32_test.dll`. Its
upstream test SHIM invokes the x86 callback and returns `1`; it does not return
the callback's `0x4567` value. Successful execution of these fixtures is not a
claim that DOOM95, .kkrieger, arbitrary PE64 files, or every Win32 program works.
