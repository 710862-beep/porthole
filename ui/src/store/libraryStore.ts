import { create } from "zustand";
import type { GameStoreService, StoreGame } from "@runtime/types";

/* React subscription mirror for the persistent local catalog membership service. */
interface LibraryStore {
  games: StoreGame[];
  hydrate: (service: GameStoreService) => void;
}

let unsubscribe: (() => void) | null = null;

export const useLibraryStore = create<LibraryStore>()((set) => ({
  games: [],
  hydrate: (service) => {
    const sync = (): void => set({ games: service.listGames() });
    sync();
    unsubscribe?.();
    unsubscribe = service.onChange(sync);
  },
}));

/** Selector helper: browser-library entries, not installed binaries. */
export function inLibraryGames(games: StoreGame[]): StoreGame[] {
  return games.filter((game) => game.status === "in-library");
}
