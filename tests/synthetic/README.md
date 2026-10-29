# Synthetic Win32 fixtures (Porthole-authored)

These C sources are independently authored API probes, not Wine tests, DOOM95,
Roblox, Adobe, NSIS or equivalent complete substitutes for those applications.
No runtime CRT is linked; they use explicit Win32 imports and WriteFile output.

## Build

```
python3 -m pip install --target .cache/tools ziglang==0.13.0
PORTHOLE_ZIG="$PWD/.cache/tools/ziglang/zig" node scripts/build-synthetic.mjs
node scripts/run-synthetic.mjs
```

Build requires curl/unzip only for separate asset acquisition, Python/pip for
compiler installation, and Zig 0.13.0 for these PEs. CI installs that exact version.
The default compiler path is the sandbox cache; set PORTHOLE_ZIG elsewhere.
Compiler flags select x86 Windows GNU / i386 without SSE (the pinned emulator
traps on xorps). The authored unsigned output's COFF timestamp is normalized to
zero; two consecutive local builds produced identical hashes. BUILD.json records
binary, source and shared-header SHA-256, compiler and arguments. This is local
reproducibility evidence, not a cross-machine reproducibility guarantee.

Generated .exe/BUILD.json are ignored by Git and rebuilt from sources. Each guest
runs in its own Node child with an external 15-second timeout. A loader failure,
missing import, panic, incomplete marker or timeout fails validation. No synthetic
fixture passed its guest test in this revision.

- thread-validation: 3 workers, 10 sleeps of 100 ms each, TLS checks, wait-all,
  three WORKER_DONE and SUCCESS required. Does not rewrite ExitProcess semantics.
- input-test: real window, mouse registration, ClipCursor, GetMessage/WM_INPUT.
  Requires real browser activation/input; automated headless success cannot
  certify mouse movement. It prints signed DX/DY values when RAWINPUT mouse deltas arrive.
- network-test: direct WinSock HTTP GET to github.com:80. A redirect response is
  connectivity evidence only, not TLS support. Current guest DLL is missing.
- registry-test: artificial deterministic 128-byte data and DWORD, same-process
  close/reopen; not cross-process persistence evidence by itself.
- installer-test: directory/file writes plus registry install location. Its empty
  uninstall.exe is deliberately a marker, NOT a working uninstaller nor complete
  uninstall registration. Persistence still needs a separate readback session.

The guest uses the pinned Rust DLL implementations, not the standalone JS shims.
