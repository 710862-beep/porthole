import {
  Activity,
  Code2,
  Cpu,
  LayoutGrid,
  Settings2,
  Store,
  type LucideIcon,
} from "lucide-react";
import type { LauncherCategory } from "@runtime/types";

/** Every surface the desktop shell can host. */
export type AppId =
  | "welcome"
  | "store"
  | "emulator"
  | "system"
  | "settings"
  | "devtools";

export interface AppSize {
  width: number;
  height: number;
}

export interface AppDefinition {
  id: AppId;
  title: string;
  /** Launcher grouping. */
  category: "games" | "emulators" | "utilities" | "settings" | "system";
  icon: LucideIcon;
  /** Hex used for icon tiles / gradients. */
  tint: string;
  description: string;
  keywords: string[];
  pinned: boolean;
  singleton: boolean;
  defaultSize: AppSize;
  minSize: AppSize;
}

export const APPS: Record<AppId, AppDefinition> = {
  store: {
    id: "store",
    title: "App Store",
    category: "games",
    icon: Store,
    tint: "#00e5ff",
    description: "Browse Chocolatey metadata and download versioned package archives into selected Porthole storage.",
    keywords: ["store", "games", "library", "catalog", "shop"],
    pinned: true,
    singleton: true,
    defaultSize: { width: 1140, height: 740 },
    minSize: { width: 900, height: 560 },
  },
  emulator: {
    id: "emulator",
    title: "Porthole Emulator",
    category: "emulators",
    icon: Cpu,
    tint: "#b388ff",
    description: "ABI-v3 Wasm guest execution, AOT/JIT telemetry; guest launch is unavailable without the CI artifact.",
    keywords: ["emulator", "runtime", "wasm", "guest", "vmm"],
    pinned: true,
    singleton: true,
    defaultSize: { width: 960, height: 640 },
    minSize: { width: 560, height: 400 },
  },
  system: {
    id: "system",
    title: "System Monitor",
    category: "system",
    icon: Activity,
    tint: "#89b4fa",
    description: "Live runtime telemetry, storage backend and capability probes.",
    keywords: ["system", "monitor", "telemetry", "performance", "storage"],
    pinned: true,
    singleton: true,
    defaultSize: { width: 880, height: 640 },
    minSize: { width: 680, height: 480 },
  },
  settings: {
    id: "settings",
    title: "Settings",
    category: "settings",
    icon: Settings2,
    tint: "#f9e2af",
    description: "Appearance, motion, storage backend and shell reset.",
    keywords: ["settings", "preferences", "appearance", "wallpaper", "storage"],
    pinned: false,
    singleton: true,
    defaultSize: { width: 900, height: 660 },
    minSize: { width: 700, height: 500 },
  },
  welcome: {
    id: "welcome",
    title: "Welcome to Porthole",
    category: "system",
    icon: LayoutGrid,
    tint: "#f5a9e0",
    description: "What this desktop is, what it is not, and where the evidence lives.",
    keywords: ["welcome", "about", "help", "intro", "docs"],
    pinned: false,
    singleton: true,
    defaultSize: { width: 760, height: 560 },
    minSize: { width: 560, height: 420 },
  },
  devtools: {
    id: "devtools",
    title: "Developer Console",
    category: "utilities",
    icon: Code2,
    tint: "#a6e3a1",
    description: "Inspect shell events, runtime telemetry and documented SHIM call reports.",
    keywords: ["developer", "console", "events", "shim", "runtime", "debug"],
    pinned: false,
    singleton: true,
    defaultSize: { width: 900, height: 620 },
    minSize: { width: 640, height: 440 },
  },
};

export const APP_LIST: AppDefinition[] = Object.values(APPS);

export const PINNED_APPS: AppId[] = APP_LIST.filter((app) => app.pinned).map((app) => app.id);

export const LAUNCHER_CATEGORIES: LauncherCategory[] = [
  { id: "games", label: "Games" },
  { id: "emulators", label: "Emulators" },
  { id: "utilities", label: "Utilities" },
  { id: "system", label: "System" },
  { id: "settings", label: "Settings" },
];
