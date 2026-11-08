/*
 * Local App Store catalog service. Chocolatey contributes public feed metadata;
 * explicit archive downloads are handled by the UI and written through the selected
 * Porthole storage service. Library membership is a browser-local bookmark, not an installation claim.
 */

import { DEFAULT_IN_LIBRARY_IDS, STORE_CATALOG } from "./catalog";
import { fetchChocolateyMetadata } from "./chocolateyMetadata";
import type { ChocolateyRefreshResult, GameStoreService, StoreGame } from "./types";

const LIBRARY_KEY = "porthole.ui.library.v3";
const LEGACY_LIBRARY_KEY = "porthole.ui.library.v2";

function readLibraryIds(): string[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY) ?? localStorage.getItem(LEGACY_LIBRARY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return null;
  }
}

export class LocalCatalogStore implements GameStoreService {
  private inLibrary = new Set<string>(DEFAULT_IN_LIBRARY_IDS);
  private readonly listeners = new Set<() => void>();
  private readonly chocolatey = new Map<string, StoreGame["chocolatey"]>();

  constructor() {
    const saved = readLibraryIds();
    if (saved) {
      const known = new Set(STORE_CATALOG.map((game) => game.appId));
      this.inLibrary = new Set(saved.filter((id) => known.has(id)));
    }
  }

  listGames(): StoreGame[] {
    return STORE_CATALOG.map((game) => this.withMembership(game));
  }

  getGame(appId: string): StoreGame | null {
    const game = STORE_CATALOG.find((candidate) => candidate.appId === appId);
    return game ? this.withMembership(game) : null;
  }

  isInLibrary(appId: string): boolean {
    return this.inLibrary.has(appId);
  }

  async addToLibrary(appId: string): Promise<void> {
    if (!STORE_CATALOG.some((game) => game.appId === appId)) {
      throw new Error(`addToLibrary: unknown catalog entry "${appId}"`);
    }
    if (this.inLibrary.has(appId)) return;
    this.inLibrary.add(appId);
    this.persist();
    this.notify();
  }

  async removeFromLibrary(appId: string): Promise<void> {
    if (!this.inLibrary.delete(appId)) return;
    this.persist();
    this.notify();
  }

  async refreshChocolateyMetadata(): Promise<ChocolateyRefreshResult> {
    const entries = STORE_CATALOG.flatMap((game) =>
      game.chocolateyPackageId
        ? [{ appId: game.appId, packageId: game.chocolateyPackageId }]
        : [],
    );
    const batch = await fetchChocolateyMetadata(entries);
    let updated = 0;
    for (const entry of entries) {
      const metadata = batch.records.get(entry.packageId.toLowerCase());
      if (!metadata) continue;
      this.chocolatey.set(entry.appId, metadata);
      updated += 1;
    }
    if (updated > 0) this.notify();
    return {
      updated,
      missing: entries.length - updated,
      fetchedAt: batch.fetchedAt,
      fromCache: batch.fromCache,
      error: batch.error,
      source: "Chocolatey Community Repository",
    };
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  clear(): void {
    this.inLibrary = new Set(DEFAULT_IN_LIBRARY_IDS);
    this.persist();
    this.notify();
  }

  private withMembership(game: StoreGame): StoreGame {
    return {
      ...game,
      chocolatey: this.chocolatey.get(game.appId) ?? game.chocolatey,
      status: this.inLibrary.has(game.appId) ? "in-library" : "not-in-library",
    };
  }

  private persist(): void {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify([...this.inLibrary]));
    } catch {
      /* Quota/private-mode failures leave the current session usable in memory. */
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
