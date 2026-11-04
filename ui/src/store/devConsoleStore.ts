import { create } from "zustand";
import type { RuntimeLogLevel } from "@runtime/types";

export type DevConsoleChannel = "ui" | "shim" | "runtime";

export interface DevConsoleEntry {
  id: number;
  ts: number;
  channel: DevConsoleChannel;
  level: RuntimeLogLevel;
  source: string;
  message: string;
}

interface DevConsoleState {
  entries: DevConsoleEntry[];
  append: (entry: Omit<DevConsoleEntry, "id" | "ts"> & { ts?: number }) => void;
  clear: () => void;
}

const MAX_ENTRIES = 600;
let nextId = 1;

export const useDevConsoleStore = create<DevConsoleState>()((set) => ({
  entries: [],
  append: (entry) =>
    set((state) => ({
      entries: [
        ...state.entries,
        { ...entry, id: nextId++, ts: entry.ts ?? Date.now() },
      ].slice(-MAX_ENTRIES),
    })),
  clear: () => set({ entries: [] }),
}));

export function recordDevEvent(
  channel: DevConsoleChannel,
  level: RuntimeLogLevel,
  source: string,
  message: string,
): void {
  useDevConsoleStore.getState().append({ channel, level, source, message });
}
