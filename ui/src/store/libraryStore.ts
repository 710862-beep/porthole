import { create } from "zustand";
import type { GameStoreService, InstallProgress, StoreGame } from "@runtime/types";

/*
 * Mirror of the GameStoreService library. The service stays the source of truth;
 * this store only exists so React components can subscribe to install state.
 */

interface LibraryStore {
  games: StoreGame[];
  progress: Record<string, InstallProgress>;
  hydrate: (service: GameStoreService) => void;
  setProgress: (progress: InstallProgress) => void;
  clearProgress: (appId: string) => void;
}

let unsubscribe: (() => void) | null = null;

export const useLibraryStore = create<LibraryStore>()((set) => ({
  games: [],
  progress: {},

  hydrate: (service) => {
    const sync = (): void => {
      set({ games: service.listGames() });
    };
    sync();
    unsubscribe?.();
    unsubscribe = service.onChange(sync);
  },

  setProgress: (progress) =>
    set((state) => ({
      progress: { ...state.progress, [progress.appId]: progress },
    })),

  clearProgress: (appId) =>
    set((state) => {
      if (!(appId in state.progress)) return state;
      const next = { ...state.progress };
      delete next[appId];
      return { progress: next };
    }),
}));

/** Selector helper: installed entries only. */
export function installedGames(games: StoreGame[]): StoreGame[] {
  return games.filter((game) => game.status === "installed");
}
