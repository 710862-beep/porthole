import { create } from "zustand";
import { persist } from "zustand/middleware";

/* -------------------------------------------------------------------------- */
/* Design-time preferences                                                    */
/* -------------------------------------------------------------------------- */

export type WallpaperId = "cachy-aurora" | "nebula" | "minimal";

export interface WallpaperOption {
  id: WallpaperId;
  label: string;
  blurb: string;
}

export const WALLPAPERS: WallpaperOption[] = [
  {
    id: "cachy-aurora",
    label: "Cachy Aurora",
    blurb: "Generated aurora plate — the default Porthole backdrop.",
  },
  { id: "nebula", label: "Nebula", blurb: "Procedural cyan/violet nebulae, no image download." },
  { id: "minimal", label: "Minimal Grid", blurb: "Quiet blueprint grid for long sessions." },
];

export type AccentId = "cyan" | "violet" | "mint" | "rose";

export interface AccentOption {
  id: AccentId;
  label: string;
  /** [r, g, b] channels of the primary accent. */
  accent: readonly [number, number, number];
  /** Companion accent for gradients. */
  accentAlt: readonly [number, number, number];
}

export const ACCENTS: Record<AccentId, AccentOption> = {
  cyan: {
    id: "cyan",
    label: "Cyan",
    accent: [0, 229, 255],
    accentAlt: [179, 136, 255],
  },
  violet: {
    id: "violet",
    label: "Violet",
    accent: [179, 136, 255],
    accentAlt: [0, 229, 255],
  },
  mint: {
    id: "mint",
    label: "Mint",
    accent: [148, 226, 213],
    accentAlt: [137, 180, 250],
  },
  rose: {
    id: "rose",
    label: "Rose",
    accent: [245, 169, 224],
    accentAlt: [179, 136, 255],
  },
};

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

export type BootPhase = "boot" | "setup" | "starting" | "desktop";

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface Toast {
  id: number;
  title: string;
  message?: string;
  tone: ToastTone;
  duration: number;
}

export interface ToastOptions {
  title: string;
  message?: string;
  tone?: ToastTone;
  duration?: number;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

interface UiStore {
  bootPhase: BootPhase;
  setupComplete: boolean;
  overviewOpen: boolean;
  launcherOpen: boolean;
  locked: boolean;
  wallpaper: WallpaperId;
  accent: AccentId;
  clock24h: boolean;
  showSeconds: boolean;
  reduceMotion: boolean;
  toasts: Toast[];

  setBootPhase: (phase: BootPhase) => void;
  markSetupComplete: () => void;
  openOverview: () => void;
  closeOverview: () => void;
  toggleOverview: () => void;
  openLauncher: () => void;
  closeLauncher: () => void;
  toggleLauncher: () => void;
  closeAllOverlays: () => void;
  setWallpaper: (wallpaper: WallpaperId) => void;
  setAccent: (accent: AccentId) => void;
  setClock24h: (value: boolean) => void;
  setShowSeconds: (value: boolean) => void;
  setReduceMotion: (value: boolean) => void;
  lock: () => void;
  unlock: () => void;
  pushToast: (options: ToastOptions) => number;
  dismissToast: (id: number) => void;
  resetShell: () => void;
}

let toastSequence = 1;

export const useUiStore = create<UiStore>()(
  persist(
    (set, get) => ({
      bootPhase: "boot",
      setupComplete: false,
      overviewOpen: false,
      launcherOpen: false,
      locked: false,
      wallpaper: "cachy-aurora",
      accent: "cyan",
      clock24h: true,
      showSeconds: false,
      reduceMotion: false,
      toasts: [],

      setBootPhase: (bootPhase) => set({ bootPhase }),

      markSetupComplete: () => set({ setupComplete: true }),

      openOverview: () =>
        set((state) => (state.overviewOpen ? state : { overviewOpen: true, launcherOpen: false })),

      closeOverview: () => set({ overviewOpen: false }),

      toggleOverview: () => {
        const { overviewOpen, bootPhase } = get();
        if (bootPhase !== "desktop") return;
        if (overviewOpen) set({ overviewOpen: false });
        else set({ overviewOpen: true, launcherOpen: false });
      },

      openLauncher: () =>
        set((state) => (state.launcherOpen ? state : { launcherOpen: true, overviewOpen: false })),

      closeLauncher: () => set({ launcherOpen: false }),

      toggleLauncher: () => {
        const { launcherOpen, bootPhase } = get();
        if (bootPhase !== "desktop") return;
        if (launcherOpen) set({ launcherOpen: false });
        else set({ launcherOpen: true, overviewOpen: false });
      },

      closeAllOverlays: () => set({ launcherOpen: false, overviewOpen: false }),

      setWallpaper: (wallpaper) => set({ wallpaper }),
      setAccent: (accent) => set({ accent }),
      setClock24h: (clock24h) => set({ clock24h }),
      setShowSeconds: (showSeconds) => set({ showSeconds }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),

      lock: () => set({ locked: true, launcherOpen: false, overviewOpen: false }),
      unlock: () => set({ locked: false }),

      pushToast: ({ title, message, tone = "info", duration = 4800 }) => {
        const id = toastSequence;
        toastSequence += 1;
        set((state) => ({
          toasts: [...state.toasts, { id, title, message, tone, duration }].slice(-4),
        }));
        if (duration > 0 && typeof window !== "undefined") {
          window.setTimeout(() => {
            get().dismissToast(id);
          }, duration);
        }
        return id;
      },

      dismissToast: (id) =>
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

      resetShell: () =>
        set({
          bootPhase: "boot",
          setupComplete: false,
          overviewOpen: false,
          launcherOpen: false,
          locked: false,
          toasts: [],
        }),
    }),
    {
      name: "porthole.ui.preferences.v2",
      version: 1,
      partialize: (state) => ({
        setupComplete: state.setupComplete,
        wallpaper: state.wallpaper,
        accent: state.accent,
        clock24h: state.clock24h,
        showSeconds: state.showSeconds,
        reduceMotion: state.reduceMotion,
      }),
    },
  ),
);

/** Imperative toast helper for non-React call sites (runtime hooks, services). */
export function toast(options: ToastOptions): number {
  return useUiStore.getState().pushToast(options);
}
