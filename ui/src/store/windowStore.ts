import { create } from "zustand";
import { persist } from "zustand/middleware";
import { APPS, type AppId } from "./apps";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type WindowStatus = "normal" | "minimized" | "maximized";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPayload {
  kind: "game" | "system-report" | "terminal" | "settings" | "welcome";
  /** Store game id for `kind: "game"`. */
  appId?: string;
  /** Initial terminal transcript lines. */
  lines?: string[];
  /** Settings section deep-link. */
  section?: string;
}

export interface WindowInstance {
  id: string;
  appId: AppId;
  title: string;
  bounds: Bounds;
  /** Geometry to return to when un-maximising. */
  restoreBounds: Bounds;
  status: WindowStatus;
  zIndex: number;
  workspace: number;
  payload: WindowPayload | null;
  createdAt: number;
}

interface WindowStore {
  windows: Record<string, WindowInstance>;
  order: string[];
  focusedId: string | null;
  /** Windows animating out; removed from `windows` when the transition ends. */
  closingIds: string[];
  zCounter: number;
  workspace: number;
  workspaceCount: number;
  sequence: number;

  openWindow: (appId: AppId, payload?: WindowPayload | null) => string;
  closeWindow: (id: string) => void;
  beginClose: (id: string) => void;
  closeAll: () => void;
  focusWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  toggleMinimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  commitBounds: (id: string, bounds: Bounds) => void;
  setTitle: (id: string, title: string) => void;
  moveToWorkspace: (id: string, workspace: number) => void;
  setWorkspace: (workspace: number) => void;
  setWorkspaceCount: (count: number) => void;
  resetLayout: () => void;
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

export const TASKBAR_HEIGHT = 48;
const EDGE_MARGIN = 10;

export function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function usableHeight(): number {
  return viewportSize().height - TASKBAR_HEIGHT;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Keeps a window reachable and inside the workspace area. */
export function clampBounds(bounds: Bounds): Bounds {
  const viewport = viewportSize();
  const width = clamp(Math.round(bounds.width), 320, Math.max(360, viewport.width - EDGE_MARGIN * 2));
  const height = clamp(
    Math.round(bounds.height),
    200,
    Math.max(240, usableHeight() - EDGE_MARGIN * 2),
  );
  const x = clamp(
    Math.round(bounds.x),
    -Math.round(width * 0.35),
    Math.max(EDGE_MARGIN, viewport.width - width - EDGE_MARGIN),
  );
  const y = clamp(
    Math.round(bounds.y),
    0,
    Math.max(EDGE_MARGIN, usableHeight() - height - EDGE_MARGIN),
  );
  return { x, y, width, height };
}

function cascadedBounds(appId: AppId, sequence: number): Bounds {
  const app = APPS[appId];
  const viewport = viewportSize();
  const width = Math.min(app.defaultSize.width, viewport.width - EDGE_MARGIN * 2);
  const height = Math.min(app.defaultSize.height, usableHeight() - EDGE_MARGIN * 2);
  const cascade = (sequence % 7) * 26;
  const centeredX = (viewport.width - width) / 2;
  const centeredY = (usableHeight() - height) / 2;
  return clampBounds({
    x: centeredX + cascade - 78,
    y: centeredY + cascade - 60,
    width,
    height,
  });
}

function maximizedBounds(): Bounds {
  const viewport = viewportSize();
  return { x: 0, y: 0, width: viewport.width, height: usableHeight() };
}

function topmostVisible(
  windows: Record<string, WindowInstance>,
  workspace: number,
  excludeId?: string,
): string | null {
  let best: WindowInstance | null = null;
  for (const instance of Object.values(windows)) {
    if (instance.id === excludeId) continue;
    if (instance.workspace !== workspace) continue;
    if (instance.status === "minimized") continue;
    if (!best || instance.zIndex > best.zIndex) best = instance;
  }
  return best ? best.id : null;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

const initialWorkspaceCount = 4;

export const useWindowStore = create<WindowStore>()(
  persist(
    (set, get) => ({
      windows: {},
      order: [],
      focusedId: null,
      closingIds: [],
      zCounter: 10,
      workspace: 0,
      workspaceCount: initialWorkspaceCount,
      sequence: 1,

      openWindow: (appId, payload = null) => {
        const state = get();
        const app = APPS[appId];

        // Singleton apps focus their existing window instead of duplicating.
        if (app.singleton) {
          const existing = state.order
            .map((id) => state.windows[id])
            .find((instance) => instance?.appId === appId);
          if (existing) {
            const z = state.zCounter + 1;
            set({
              zCounter: z,
              focusedId: existing.id,
              workspace: existing.workspace,
              windows: {
                ...state.windows,
                [existing.id]: {
                  ...existing,
                  status: existing.status === "minimized" ? "normal" : existing.status,
                  zIndex: z,
                  payload: payload ?? existing.payload,
                },
              },
            });
            return existing.id;
          }
        }

        const id = `win-${state.sequence}-${Math.random().toString(36).slice(2, 7)}`;
        const bounds = cascadedBounds(appId, state.sequence);
        const instance: WindowInstance = {
          id,
          appId,
          title: app.title,
          bounds,
          restoreBounds: bounds,
          status: "normal",
          zIndex: state.zCounter + 1,
          workspace: state.workspace,
          payload,
          createdAt: Date.now(),
        };
        set({
          windows: { ...state.windows, [id]: instance },
          order: [...state.order, id],
          focusedId: id,
          zCounter: state.zCounter + 1,
          sequence: state.sequence + 1,
        });
        return id;
      },

      closeWindow: (id) => {
        const state = get();
        if (!state.windows[id]) return;
        const windows = { ...state.windows };
        delete windows[id];
        const focusedId =
          state.focusedId === id
            ? topmostVisible(windows, state.workspace)
            : state.focusedId;
        set({
          windows,
          order: state.order.filter((entry) => entry !== id),
          focusedId,
          closingIds: state.closingIds.filter((entry) => entry !== id),
        });
      },

      beginClose: (id) => {
        const state = get();
        if (!state.windows[id] || state.closingIds.includes(id)) return;
        set({
          closingIds: [...state.closingIds, id],
          focusedId:
            state.focusedId === id ? topmostVisible(state.windows, state.workspace, id) : state.focusedId,
        });
      },

      closeAll: () => set({ windows: {}, order: [], focusedId: null, closingIds: [] }),

      focusWindow: (id) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        if (state.focusedId === id && instance.status !== "minimized") return;
        const z = state.zCounter + 1;
        set({
          zCounter: z,
          focusedId: id,
          windows: {
            ...state.windows,
            [id]: {
              ...instance,
              zIndex: z,
              status: instance.status === "minimized" ? "normal" : instance.status,
            },
          },
        });
      },

      minimizeWindow: (id) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance || instance.status === "minimized") return;
        set({
          windows: {
            ...state.windows,
            [id]: { ...instance, status: "minimized" },
          },
          focusedId:
            state.focusedId === id ? topmostVisible(state.windows, state.workspace, id) : state.focusedId,
        });
      },

      restoreWindow: (id) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        const z = state.zCounter + 1;
        set({
          zCounter: z,
          focusedId: id,
          workspace: instance.workspace,
          windows: {
            ...state.windows,
            [id]: { ...instance, status: instance.status === "maximized" ? "maximized" : "normal", zIndex: z },
          },
        });
      },

      toggleMinimize: (id) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        if (instance.status === "minimized") get().restoreWindow(id);
        else get().minimizeWindow(id);
      },

      toggleMaximize: (id) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        const z = state.zCounter + 1;
        const next: WindowInstance =
          instance.status === "maximized"
            ? {
                ...instance,
                status: "normal",
                bounds: clampBounds(instance.restoreBounds),
                zIndex: z,
              }
            : {
                ...instance,
                status: "maximized",
                restoreBounds: instance.bounds,
                bounds: maximizedBounds(),
                zIndex: z,
              };
        set({
          zCounter: z,
          focusedId: id,
          windows: { ...state.windows, [id]: next },
        });
      },

      commitBounds: (id, bounds) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        set({
          windows: {
            ...state.windows,
            [id]: { ...instance, bounds: clampBounds(bounds), status: instance.status === "maximized" ? "normal" : instance.status },
          },
        });
      },

      setTitle: (id, title) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        set({ windows: { ...state.windows, [id]: { ...instance, title } } });
      },

      moveToWorkspace: (id, workspace) => {
        const state = get();
        const instance = state.windows[id];
        if (!instance) return;
        const target = clamp(workspace, 0, state.workspaceCount - 1);
        set({
          windows: {
            ...state.windows,
            [id]: { ...instance, workspace: target },
          },
          focusedId: state.focusedId === id ? null : state.focusedId,
        });
      },

      setWorkspace: (workspace) => {
        const state = get();
        const target = clamp(Math.round(workspace), 0, state.workspaceCount - 1);
        if (target === state.workspace) return;
        const focusedId = topmostVisible(state.windows, target);
        set({ workspace: target, focusedId });
      },

      setWorkspaceCount: (count) => {
        const state = get();
        const next = clamp(Math.round(count), 1, 8);
        const windows: Record<string, WindowInstance> = {};
        for (const [id, instance] of Object.entries(state.windows)) {
          windows[id] =
            instance.workspace > next - 1 ? { ...instance, workspace: next - 1 } : instance;
        }
        set({
          workspaceCount: next,
          workspace: Math.min(state.workspace, next - 1),
          windows,
          focusedId: topmostVisible(windows, Math.min(state.workspace, next - 1)),
        });
      },

      resetLayout: () =>
        set({
          windows: {},
          order: [],
          focusedId: null,
          closingIds: [],
          zCounter: 10,
          workspace: 0,
          workspaceCount: initialWorkspaceCount,
          sequence: 1,
        }),
    }),
    {
      name: "porthole.ui.windows.v2",
      version: 1,
      partialize: (state) => ({
        windows: state.windows,
        order: state.order,
        focusedId: state.focusedId,
        zCounter: state.zCounter,
        workspace: state.workspace,
        workspaceCount: state.workspaceCount,
        sequence: state.sequence,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Drop windows whose app no longer exists and repair off-screen geometry.
        const windows: Record<string, WindowInstance> = {};
        for (const [id, instance] of Object.entries(state.windows)) {
          if (!(instance.appId in APPS)) continue;
          windows[id] = {
            ...instance,
            bounds:
              instance.status === "maximized" ? maximizedBounds() : clampBounds(instance.bounds),
            restoreBounds: clampBounds(instance.restoreBounds),
          };
        }
        state.windows = windows;
        state.order = state.order.filter((id) => id in windows);
        if (state.focusedId && !(state.focusedId in windows)) state.focusedId = null;
      },
    },
  ),
);
