# Porthole UI — design system and desktop shell

A browser desktop environment with the surface language of CachyOS / KDE Plasma:
Catppuccin-Mocha darkness, frosted glass, cyan→violet accents, Inter for UI and
JetBrains Mono for anything machine-shaped.

The shell contains **no emulation logic**. Every pixel of guest output comes from
`runtime.getFramebuffer()`; every action goes through the interfaces in
[`runtime/types.ts`](runtime/types.ts). The runtime shipped today is the labelled
**mock**; the UI says so on the boot screen, the panel, the emulator chrome and the
System Monitor.

---

## 1. Run it

```bash
cd ui
npm install
npm run dev        # http://localhost:5173
npm run build      # check:no-any → check:boundaries → tsc --noEmit → vite build
npm run smoke      # headless jsdom walkthrough of the real App (83 assertions)
```

`npm run dev` binds `0.0.0.0:5173` with `allowedHosts: true`, so it also works behind
the Arena preview proxy and inside an iframe.

Browser notes: **External NVMe** needs `showDirectoryPicker` (Chromium, HTTPS or
localhost). Everywhere else the shell falls back to OPFS, and to volatile memory when
OPFS is missing — the modal probes both in the browser and says which one it used.

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
| Z-order | wallpaper `0`, windows `20`, hot corner `30`, overview `40`, taskbar `50`, launcher `60`, dialog `80`, toast `90`, lock `95`, boot `100` |
| Motion | `ease-kde cubic-bezier(.22,1,.36,1)`, `ease-snap`; keyframes fade-in / fade-up / scale-in / shimmer / pulse-dot / aurora-drift / float-slow / scan / caret-blink / spin-slow / boot-sweep / toast-in |

The accent channels live in `:root` and are re-written at runtime:

```css
:root {
  --accent-rgb: 0 229 255;      /* #00e5ff cyan   */
  --accent-2-rgb: 179 136 255;  /* #b388ff violet */
  --ease-kde: cubic-bezier(0.22, 1, 0.36, 1);
  --taskbar-height: 48px;
  --radius-window: 12px;
  --radius-control: 8px;
  color-scheme: dark;
}
```

---

## 3. Material — CSS Modules own the glass

Tailwind owns layout, spacing and type; CSS Modules own the multi-layer material
(tint + backdrop blur + gradient sheen + hairline + deep shadow) because none of that
survives as a single utility. Files: `src/styles/{glass,desktop,wallpaper,window,overview}.module.css`.

The brief is enforced literally: **panels are `#11111b` at 80 % with `blur(12px)`**.

```css
/* glass.module.css */
.base {
  position: relative;
  background-color: rgba(17, 17, 27, 0.8);
  backdrop-filter: blur(12px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.075);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 30px 80px -24px rgba(0, 0, 0, 0.9),
    0 4px 18px rgba(0, 0, 0, 0.35);
}

.window {
  background-image:
    linear-gradient(160deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0) 30%),
    linear-gradient(180deg, rgba(26, 26, 40, 0.86), rgba(17, 17, 27, 0.9));
  backdrop-filter: blur(12px) saturate(140%);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  transition: border-color 180ms var(--ease-kde), box-shadow 220ms var(--ease-kde);
}
```

| Recipe | Used by |
| --- | --- |
| `.base` | panels, popovers, dialogs (80 % tint, 12 px blur, hairline) |
| `.window` | window body; `[data-focused="true"]` adds the accent rim |
| `.launcher` | Kickoff-style launcher + overview cards (18 px radius) |
| `.popover` | tray flyouts, window menu, workload picker |
| `.dialog` | custom dialogs and the first-run storage modal |
| `.backdrop` | modal scrim (`rgba(8,8,14,.62)` + 10 px blur) |
| `.sheen` / `.hairline` / `.innerGlow` | white-gradient highlight, 1 px rims, inset accent light |

Global CSS (`src/styles/global.css`) also removes every browser default the shell
could inherit: slim KDE scrollbars, `::selection` in accent, `:focus-visible` rings,
non-selectable chrome, `overscroll-behavior: none`, dark `color-scheme`, and a
`[data-motion="reduced"]` switch that flattens every animation and transition.

---

## 4. Structure

```
ui/
├─ runtime/                    # emulation boundary (contracts, mock runtime, storage, catalog)
├─ public/wallpapers/          # cachy-aurora.png
├─ src/
│  ├─ App.tsx                  # boot → setup → starting → desktop machine
│  ├─ main.tsx
│  ├─ components/
│  │  ├─ boot/                 # BootScreen, SetupModal, BootExperience
│  │  ├─ desktop/              # Desktop, Wallpaper, HotCorner, Taskbar, TrayPopover,
│  │  │                        #   WelcomeWidget, RuntimeStatusWidget, LockScreen
│  │  ├─ windows/              # WindowLayer, WindowFrame, TitleBar, WindowControls,
│  │  │                        #   WindowMenu, WindowContent, WindowChromeContext
│  │  ├─ launcher/             # AppLauncher, OverviewMode, WindowThumbnail
│  │  ├─ store/                # GameStoreApp, GameGrid, GameDetails, InstallProgress, cover
│  │  ├─ apps/                 # EmulatorApp, TerminalApp, SystemMonitorApp, SettingsApp, WelcomeApp
│  │  └─ ui/                   # 16 primitives: Button, Modal, SegmentedControl, Switch,
│  │                           #   ProgressBar, Spinner, Badge, Skeleton, EmptyState, Kbd,
│  │                           #   PortholeMark, ToastHost, DialogHost, ErrorBoundary,
│  │                           #   AppIcon, LogConsole
│  ├─ hooks/                   # useWindowManager, useEmulator, useHotCorner, useRuntime,
│  │                           #   useWindowInteraction, useFramebuffer, useClock
│  ├─ store/                   # windowStore, emulatorStore, uiStore, dialogStore,
│  │                           #   libraryStore, apps
│  ├─ lib/                     # cn, format, clipboard, motion
│  └─ styles/                  # global.css + 5 CSS modules
└─ scripts/                    # build guards (no-any, UI boundaries) + jsdom smoke harness
```

---

## 5. Window manager

- **Geometry lives in Zustand** (`windowStore`, persisted to `porthole.ui.windows.v2`),
  but a drag never writes to it: `useWindowInteraction` writes `left/top/width/height`
  straight to the frame element inside a single `requestAnimationFrame`, then commits
  **once** on pointer-up. Pointer moves therefore cost zero React renders.
- 8 resize handles (`n/s/e/w/ne/nw/se/sw`), per-app `minSize`, viewport clamping at
  commit, Escape cancels a drag and restores the start bounds.
- Close runs a 180 ms exit (`beginClose` → `closeWindow`), so the window is removed
  from state only after the animation; the closing frame is pointer-transparent.
- Focus is z-ordered (`focusWindow` bumps `zCounter`); minimize hands focus to the
  top-most visible window; switching workspaces refocuses the top-most window there.
- Minimized / other-workspace / closing windows stay mounted but hidden, so terminal
  history and emulator sessions survive a workspace switch. The emulator detaches its
  runtime frame listener while hidden.
- Right-click anywhere on a window opens the custom window menu (minimize, maximize,
  move to workspace 1–4, close).

---

## 6. Surfaces

| Surface | Behaviour |
| --- | --- |
| **Boot** | aurora backdrop, staged progress with real step names, honesty footer (`mock runtime`) |
| **First run** | storage modal: External NVMe (`showDirectoryPicker` + write probe), OPFS, volatile memory; unavailable backends are disabled with the browser's own explanation; failures fall back through a custom Yes/No dialog |
| **Desktop** | gradient/aurora wallpaper, greeting + clock while empty, floating runtime plasmoid, 12 px top scrim, 48 px bottom panel |
| **Panel** | CachyOS-mark launcher · centered pinned apps with glowing running dots (click = focus/minimize/restore) · overview button · tray: volume flyout, network flyout, `HH:MM` clock + session menu |
| **Launcher** | Kickoff layout, categories with counts, live search, workspace/session actions, keyboard navigation |
| **Overview** | hot corner or Super, desktop scales to 94 %, window cards, workspace rail with mini-map and add-workspace, window/app search, click window = focus+close, empty space = close |
| **Game Store** | cover grid from gradients, details panel with Install/Launch/Uninstall, phase checklist, collapsible mono console, honest "no bytes downloaded" copy |
| **Emulator** | canvas at native 240×135 (`image-rendering: pixelated`), workload picker, Launch/Pause/Resume/Stop, click-to-arm input capture with KI-04 warning, synthetic-scanout badge, runtime console |
| **Terminal** | shell commands over shell state only (`help`, `uname`, `telemetry`, `storage`, `logs`, `clear`, …), history, no fake guest console |
| **System Monitor** | telemetry cards, resident-window bar, storage probes, host capability probes, copyable JSON report |
| **Settings** | Appearance / Desktop / Storage / Runtime / About; wallpaper grid, accent swatches, switches, workspace count, layout reset, factory reset (custom confirm, then reload) |
| **Dialogs** | Yes/No modal (accent Yes, grey No) and error modal with **Copy to clipboard**; focus trap, Escape, backdrop; no `alert/confirm/prompt` anywhere |
| **Lock screen** | blurred aurora, 64 px mono clock, click or Enter/Space/Esc to unlock (the shell is explicit that there is no authentication) |

---

## 7. Honesty contract

- The mock runtime is labelled on the boot screen, the panel plasmoid, the emulator
  badge and the System Monitor banner. Synthetic frames are never called guest output.
- Compatibility claims point at repository evidence; the UI invents none.
- Installing a store entry registers a library entry — no bytes are downloaded, and
  every install surface says so.
- Storage downgrades (NVMe → OPFS → memory) are reported, not hidden.
- Input capture warns that keystrokes are counted but not yet delivered to the core (KI-04).

---

## 8. Verification

| Gate | Command | Result |
| --- | --- | --- |
| Strict types | `npx tsc --noEmit` | clean |
| No `any` | `npm run check:no-any` | PASS — 74 files, zero explicit `any` |
| UI boundary | `npm run check:boundaries` | PASS — no emulation imports, no native dialogs |
| Production build | `npx vite build` | 579 kB JS (178 kB gzip), 71 kB CSS (16 kB gzip) |
| Tailwind emission | custom audit | all 440 utility tokens found in the built CSS |
| Behaviour | `npm run smoke` | PASS — 83 assertions |

`scripts/smoke.mjs` mounts the real `App` in jsdom through Vite's module graph and
drives boot → storage → desktop → windows (drag, resize, minimize, maximize, close)
→ launcher search → overview (hot corner, Super, cards) → store install → terminal
commands → settings (accent, switches, storage) → dialogs/toasts → lock → emulator
launch → workspaces, then fails on unexpected console output. Canvas rasterisation is
stubbed because jsdom has no 2D context; every other DOM path is real.

Known limits: the real Wasm core is not wired yet (mock only); folder permission is
session-scoped by design; visual QA inside this sandbox is limited to structural and
behavioural checks because no browser binary is installable here.
