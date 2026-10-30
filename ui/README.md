# ui/ — Porthole shell (for the UI agent)

You own everything the user sees. The emulator core is done being your problem:
it lives in `rust/porthole-x64-wasm` and is driven through one boring, stable protocol.

## The 60-second mental model

* **Runtime today**: `../x64.html` + `../js/x64-app.js` — mounts storage (FSA → OPFS),
  instantiates the Wasm core (`BrowserX64Emulator`), runs a tick loop that pumps
  `drain_evicted_pages`/`supply_page`, paints `guest_frame_rgba()` to a canvas, shows
  telemetry. This shell (`ui/index.html`) wraps it in an iframe inside a desktop window.
  **Do not fork that logic into ui/.** When you're ready, lift it into
  `ui/runtime/` behind `EmulatorRuntime` (contracts.ts) and delete the iframe.
* **Frames**: the ONLY pixels you may display as "the game" come from
  `guest_frame_rgba()` gated on `presented_frames()`. Host-composed pixels are how a
  previous build faked a frame for 2,703 presents; the post-mortem is in
  `../docs/x64-emulator-status.md` ("fake-frame incident"). Respect the scar tissue.
* **State**: shell state is tiny and explicit (`state` object in `app.js`, persisted to
  `localStorage["porthole.ui.v1"]`). Emulator state is NOT mirrored — read it from
  `telemetry_json()` / `presented_frames()` when you integrate directly.
* **Events**: no pub/sub framework. Shell → direct function calls; runtime → poll in the
  tick (that's how `js/x64-app.js` works). `onFrameReady` in the contracts is your seam
  to add a callback in the runtime wrapper; keep it allocation-free in the hot loop.

## Run it

```bash
npm run dev:ui        # static server for the repo root (python http.server)
# open http://localhost:8080/ui/
```

Needs no build step. `vendor/porthole-x64-wasm/` (the compiled core) is a CI artifact —
without it the shell still loads and the emulator window reports the missing artifact in
its log. To produce it: GitHub Actions `x64-emulator` workflow artifact, or locally with a
Rust toolchain: `npm run build:wasm`.

## Adding a component

1. Markup in `index.html` (hidden templates) or built in `app.js` — match existing style.
2. Styling: tokens in `styles.css` (`--bg/--panel/--line/--text/--muted/--accent`). These
   are shared with `x64.html`; change them in both places or extract a shared sheet.
3. Behaviour: plain functions in `app.js`, exposed for debugging under
   `window.PortholeUI` (DesktopMode/GameStoreMode/Dialogs/StorageSel) — keep those
   handles working; they're the contract test surface.
4. Dialogs: always `Dialogs.confirm(...)` (Promise<boolean>, Esc = No). Never
   `window.confirm`.

## Design language (current, minimal)

Dark navy panels on near-black, one teal accent (`#5eead4`), mono for metrics/hashes,
evidence strings visible on every game card (a product decision: this project's users
have been burned by fake progress — show receipts by default, polish later).

## Known shell limitations (honest)

* Emulator window is an iframe (input focus goes to the iframe; hotkeys don't reach the
  shell while it's focused). Direct integration removes this.
* "Install" = library registration only; bytes arrive via the emulator window's folder
  mount (or CI fetch scripts in dev).
* Input forwarding to the guest doesn't exist in the core (KI-04) — the biggest unlock
  for actual playability, and mostly a runtime task (`sdl_hle.rs` event queue), not CSS.
* No window resizing handles yet; windows drag + minimize + close only.
