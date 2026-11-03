# Porthole UI — design system and desktop shell

Porthole is a browser desktop with a dark Linux-desktop visual language: Catppuccin-Mocha surfaces, restrained glass, cyan→violet accents, Inter for UI and JetBrains Mono for machine-shaped details. Its local Aurora wallpaper is unlettered—no OS name, logo or fabricated installation-review copy is overlaid. The desktop also includes a read-only browser/runtime status card and a full-width 48 px panel with left-aligned app icons and a right-side tray.

The React shell keeps emulation behind [`runtime/types.ts`](runtime/types.ts). `RuntimeRouter` uses the ABI-v3 Wasm adapter and reports `unavailable` if its CI artifact cannot initialize; production never substitutes a simulated guest. Guest pixels come only from core-reported frames, and the adapter reuses the repository JIT host and NVMe VFS. This is a browser desktop, not a native Windows process host. See [`../docs/ui-runtime-architecture.md`](../docs/ui-runtime-architecture.md) for ownership, flows and security boundaries.

---

## 1. Run it

```bash
cd ui
npm ci
npm run dev        # Vite on 0.0.0.0:5173
npm run build      # static checks → tsc → Vite build
npm run smoke      # headless jsdom walkthrough of the real App
```

`npm run dev` binds `0.0.0.0:5173` with `allowedHosts: true`, so it also works behind the Arena preview proxy and inside an iframe.

Browser notes: **External NVMe** needs `showDirectoryPicker` (Chromium, HTTPS or localhost). Everywhere else the shell offers OPFS, and volatile memory when OPFS is missing; the modal probes the browser and reports which backend it used.

---

## 2. Tokens — `tailwind.config.ts`

| Group | Tokens |
| --- | --- |
| Ramp | `crust #11111b`, `mantle #181825`, `base #1e1e2e`, `surface #313244 / high #45475a / higher #585b70`, `overlay #6c7086 / light #7f849c` |
| Ink | `ink #cdd6f4`, `ink-muted #a6adc8`, `ink-faint #7f849c`, `ink-ghost #585b70` |
| Accents | `cyan #00e5ff`, `violet #b388ff`, `pink #f5a9e0`, `mint #94e2d5`, `success #a6e3a1`, `warning #f9e2af`, `danger #f38ba8`, `info #89b4fa` |
| Live accent | `accent` → `rgb(var(--accent-rgb) / <alpha-value>)`, `accent-2` → `rgb(var(--accent-2-rgb) / <alpha-value>)`; Settings rewrites the two channels, no new classes needed |
| Radii | window `12px`, control `8px`, panel `0px`, card `10px`, menu `14px`, launcher `18px` |
| Shadows | `window 0 10px 30px rgba(0,0,0,.5)`, `window-focus` (+ accent rim/glow), `panel`, `launcher`, `dialog`, `glow`, `glow-sm`, `hairline`, `inset-top` |
| Type | `font-sans` = Inter Variable → Segoe UI → system-ui; `font-mono` = JetBrains Mono Variable → Cascadia → monospace; extra `2xs/3xs` steps |
| Space | `taskbar: 48px` (also `--taskbar-height`), plus 13/18/22 spacing steps |
| Z-order | wallpaper `0`, windows `20`, hot corner `30`, overview `40`, taskbar `50`, launcher `60`, dialogs `80`, toast `90`, lock `95`, boot `100` |
| Motion | `ease-kde cubic-bezier(.22,1,.36,1)`, `ease-snap`; keyframes fade-in / fade-up / scale-in / shimmer / pulse-dot / aurora-drift / float-slow / scan / caret-blink / spin-slow / boot-sweep / toast-in |

The accent channels live in `:root` and are re-written at runtime:

```css
:root {
  --accent-rgb: 0 229 255;
  --accent-2-rgb: 179 136 255;
  --ease-kde: cubic-bezier(0.22, 1, 0.36, 1);
  --taskbar-height: 48px;
  --radius-window: 12px;
  --radius-control: 8px;
  color-scheme: dark;
}
```

---

## 3. Material — CSS Modules own the glass

Tailwind owns layout, spacing and type; CSS Modules own the multi-layer material (tint + backdrop blur + gradient sheen + hairline + deep shadow). Files: `src/styles/{glass,desktop,wallpaper,window,overview}.module.css`.

The brief is enforced literally: **panels are `#11111b` at 80 % with `blur(12px)`**.

| Recipe | Used by |
| --- | --- |
| `.base` | panels, popovers, dialogs (80 % tint, 12 px blur, hairline) |
| `.window` | window body; `[data-focused="true"]` adds the accent rim |
| `.launcher` | Kickoff-style launcher + overview cards (18 px radius) |
| `.popover` | tray flyouts, window menu, launch-profile picker |
| `.dialog` | custom dialogs and the first-run storage modal |
| `.backdrop` | modal scrim (`rgba(8,8,14,.62)` + 10 px blur) |
| `.sheen` / `.hairline` / `.innerGlow` | white-gradient highlight, 1 px rims, inset accent light |

Global CSS (`src/styles/global.css`) also removes browser defaults the shell could inherit: slim scrollbars, `::selection` in accent, `:focus-visible` rings, non-selectable chrome, `overscroll-behavior: none`, dark `color-scheme`, and a `[data-motion="reduced"]` switch that flattens every animation and transition.

---

## 4. Structure

```text
ui/
├─ runtime/                    # contracts, no-fallback router, ABI-v3 Wasm adapter, storage, metadata catalog
├─ public/wallpapers/          # supporting boot/lock artwork
├─ src/
│  ├─ App.tsx                  # boot → setup → starting → desktop machine
│  ├─ components/
│  │  ├─ boot/                 # BootScreen, SetupModal, BootExperience
│  │  ├─ desktop/              # Desktop, Wallpaper, HotCorner, Taskbar, TrayPopover,
│  │  │                        #   RuntimeStatusWidget, LockScreen
│  │  ├─ windows/              # WindowLayer, WindowFrame, TitleBar, WindowControls,
│  │  │                        #   WindowMenu, WindowContent, WindowChromeContext
│  │  ├─ launcher/             # AppLauncher, OverviewMode, WindowThumbnail
│  │  ├─ store/                # App Store, curated catalog, Chocolatey metadata, local bookmarks
│  │  ├─ apps/                 # Emulator, Developer Console, System Monitor, Settings, Welcome
│  │  └─ ui/                   # Button, Modal, SegmentedControl, Switch, ProgressBar, Badge,
│  │                           #   Skeleton, EmptyState, Kbd, PortholeMark, ToastHost, DialogHost,
│  │                           #   ErrorBoundary, AppIcon, LogConsole
│  ├─ hooks/                   # useWindowManager, useEmulator, useHotCorner, useRuntime,
│  │                           #   useWindowInteraction, useFramebuffer, useClock
│  ├─ store/                   # windowStore, emulatorStore, uiStore, dialogStore,
│  │                           #   libraryStore, apps, developer-console events
│  ├─ lib/                     # cn, format, clipboard, motion
│  └─ styles/                  # global.css + CSS modules
└─ scripts/                    # build guards and jsdom smoke harness
```

---

## 5. Window manager

- Geometry lives in Zustand (`windowStore`, persisted to `porthole.ui.windows.v2`), but a drag never writes to it: `useWindowInteraction` writes bounds straight to the frame element inside a single `requestAnimationFrame`, then commits once on pointer-up. Pointer moves therefore cost zero React renders.
- Eight resize handles (`n/s/e/w/ne/nw/se/sw`), per-app `minSize`, viewport clamping at commit, Escape cancels a drag and restores the start bounds.
- Close runs a 180 ms exit (`beginClose` → `closeWindow`), so the window is removed from state only after the animation; the closing frame is pointer-transparent.
- Focus is z-ordered; minimize hands focus to the top-most visible window; switching workspaces refocuses the top-most window there.
- Minimized / other-workspace / closing windows stay mounted but hidden, so app state and guest sessions survive a workspace switch. The emulator detaches its frame listener while hidden.
- Right-click anywhere on a window opens the custom window menu (minimize, maximize, move to workspace 1–4, close).

---

## 6. Surfaces

| Surface | Behaviour |
| --- | --- |
| **Boot** | Porthole progress screen with active Wasm/unavailable runtime status |
| **First run** | storage modal: External NVMe (`showDirectoryPicker` + write probe), OPFS, volatile memory; failures are reported through a custom Yes/No dialog |
| **Desktop** | unlettered magenta/violet wallpaper, real browser/runtime status card and 48 px bottom panel with left-aligned app icons |
| **Panel** | icon-only Porthole launcher · left-aligned pinned apps with running indicators (click = focus/minimize/restore) · overview · tray flyouts, clock and session menu |
| **Launcher** | Kickoff layout, categories with counts, live search, workspace/session actions, keyboard navigation |
| **Overview** | hot corner or Super, window cards, workspace rail with mini-map and add-workspace, window/app search |
| **App Store** | 24 curated entries, public Chocolatey OData metadata refresh/cache, evidence details and browser-local library bookmarks; no package downloads |
| **Emulator** | user-local file import, launch profiles, ABI-v3 runtime, AOT/JIT hookup, core-reported guest frames, telemetry and runtime console; launch is disabled if Wasm is unavailable |
| **Developer Console** | bounded stream of captured UI events, runtime state/logs, aggregate core SHIM/HLE counters and unimplemented-import diagnostics |
| **System Monitor** | telemetry when the core is available, browser storage probes, browser capability probes and a copyable JSON report |
| **Settings** | Appearance / Desktop / Storage / Runtime / About; wallpaper grid, accent swatches, switches, workspace count, layout reset, factory reset |
| **Dialogs** | custom Yes/No and error modals with clipboard action; focus trap, Escape, backdrop; no native `alert/confirm/prompt` |
| **Lock screen** | blurred backdrop, mono clock and keyboard unlock (the shell explicitly has no authentication) |

---

## 7. Honesty contract

- The runtime mode is visible in the desktop and emulator UI. If the ABI-v3 artifact is missing, the production runtime reports unavailable and guest launch stays disabled; no synthetic process or frame fallback is shown.
- This browser app does not create native Windows processes. With the Wasm runtime available, user-imported PE32+ files execute only inside the guest; this is not a general Windows-compatibility claim.
- Compatibility claims point at repository evidence; the UI invents none. The Doom timedemo remains unresolved in the current hybrid-JIT path.
- Chocolatey refreshes package metadata only. “Add to library” stores a browser-local bookmark; no `.nupkg`, package scripts, installer or native executable is fetched or run by the store.
- Storage downgrades (File System Access → OPFS → memory) are reported, not hidden.
- Keyboard and mouse-button delivery remain core limitations (KI-04); pointer coordinates may be injected, but the UI does not claim gameplay input is complete.

---

## 8. Verification (2026-11-03)

| Gate | Command | Result |
| --- | --- | --- |
| Strict types | `npm run typecheck` / build `tsc --noEmit` | PASS |
| No `any` | `npm run check:no-any` | PASS — 76 files, zero explicit `any` |
| UI boundary | `npm run check:boundaries` | PASS — 76 files |
| Production build | `npm run build` | PASS — 621.11 kB JS (189.37 kB gzip), 73.41 kB CSS (16.97 kB gzip) |
| Behaviour | `npm run smoke` | PASS — desktop walkthrough, browser-local library bookmarks and unavailable-runtime checks |
| Wasm artifact | build copy step | Not present in this checkout; production runtime reports unavailable |

`scripts/smoke.mjs` mounts the real `App` in jsdom through Vite's module graph and walks boot → storage → desktop → windows → launcher → overview → catalog bookmarks → Developer Console → settings → dialogs/toasts → lock → emulator unavailable-mode checks → workspaces. Canvas rasterization is stubbed because jsdom has no 2D context; this is UI smoke coverage, not emulator or Doom evidence.

Known limits: the ABI-v3 adapter is build-wired but not runtime-validated in this checkout because the CI Wasm artifact is absent. Browser-side Chocolatey feed availability depends on the public endpoint's CORS response; cached/error status is shown in the Store. Keyboard and mouse-button delivery remain pending in the core (KI-04), and the guest modal bridge is not implemented. Folder permission is session-scoped by design.
