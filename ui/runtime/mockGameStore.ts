/*
 * Game library service.
 *
 * Install is a SIMULATED library registration: no game bytes are downloaded by this
 * shell (the repository's CI scripts pin fixtures, and real bytes arrive through the
 * runtime's folder mount). Progress is therefore cosmetic but honest — every phase
 * message says what is actually happening.
 */

import { DEFAULT_INSTALLED_IDS, STORE_CATALOG } from "./catalog";
import type { GameStoreService, InstallPhase, InstallProgress, StoreGame } from "./types";

const LIBRARY_KEY = "porthole.ui.library.v2";
const SIMULATED_INSTALL_MS = 5200;

const PHASE_DETAIL: Record<Exclude<InstallPhase, "complete" | "failed">, string> = {
  queued: "Queued — waiting for the library writer.",
  preparing: "Reserving a slot in C:\\Games and checking the mounted backend.",
  transferring: "Streaming the pinned fixture into the virtual disk image…",
  verifying: "Hashing bytes against the pinned SHA-256 manifest…",
  writing: "Flushing shards to the selected storage backend…",
};

function phaseFor(percent: number): Exclude<InstallPhase, "complete" | "failed"> {
  if (percent >= 88) return "writing";
  if (percent >= 62) return "verifying";
  if (percent >= 10) return "transferring";
  return "preparing";
}

function readInstalled(): string[] | null {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return null;
  }
}

export class LocalGameStore implements GameStoreService {
  private installed = new Set<string>(DEFAULT_INSTALLED_IDS);
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor() {
    const saved = readInstalled();
    if (saved) {
      const known = new Set(STORE_CATALOG.map((game) => game.appId));
      this.installed = new Set(saved.filter((id) => known.has(id)));
    }
  }

  listGames(): StoreGame[] {
    return STORE_CATALOG.map((game) => this.withStatus(game));
  }

  getGame(appId: string): StoreGame | null {
    const game = STORE_CATALOG.find((candidate) => candidate.appId === appId);
    return game ? this.withStatus(game) : null;
  }

  isInstalled(appId: string): boolean {
    return this.installed.has(appId);
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async installGame(
    appId: string,
    onProgress?: (progress: InstallProgress) => void,
  ): Promise<void> {
    const game = this.getGame(appId);
    if (!game) throw new Error(`installGame: unknown app "${appId}"`);
    if (this.installed.has(appId)) throw new Error(`${game.title} is already installed`);
    if (this.timers.has(appId)) throw new Error(`${game.title} is already installing`);

    onProgress?.({ appId, phase: "queued", percent: 0, detail: PHASE_DETAIL.queued });
    const startedAt = performance.now();
    const completeDetail =
      "Library entry registered. No bytes were downloaded by this shell.";

    return new Promise<void>((resolve) => {
      let lastPercent = -1;
      let lastPhase: InstallPhase = "queued";

      const finish = (): void => {
        const timer = this.timers.get(appId);
        if (timer) clearInterval(timer);
        this.timers.delete(appId);
        this.installed.add(appId);
        this.persist();
        this.notify();
        onProgress?.({ appId, phase: "complete", percent: 100, detail: completeDetail });
        resolve();
      };

      const timer = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        const linear = Math.min(1, elapsed / SIMULATED_INSTALL_MS);
        // Ease-out so the bar feels like real I/O instead of a stopwatch.
        const percent = Math.round((1 - Math.pow(1 - linear, 2.4)) * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;

        const phase: InstallPhase = percent >= 100 ? "complete" : phaseFor(percent);
        const changedPhase = phase !== lastPhase;
        lastPhase = phase;
        // Emit on phase changes, then at ~4% granularity to keep React renders cheap.
        // Completion is emitted exactly once by finish(), never twice.
        if (changedPhase || percent % 4 === 0) {
          onProgress?.({
            appId,
            phase,
            percent,
            detail: phase === "complete" ? completeDetail : PHASE_DETAIL[phase],
          });
        }

        if (phase === "complete") finish();
      }, 100);

      this.timers.set(appId, timer);
    });
  }

  async uninstallGame(appId: string): Promise<void> {
    const timer = this.timers.get(appId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(appId);
    }
    if (!this.installed.has(appId)) return;
    this.installed.delete(appId);
    this.persist();
    this.notify();
    await Promise.resolve();
  }

  clear(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.installed = new Set(DEFAULT_INSTALLED_IDS);
    this.persist();
    this.notify();
  }

  private withStatus(game: StoreGame): StoreGame {
    return {
      ...game,
      status: this.installed.has(game.appId) ? "installed" : "not-installed",
    };
  }

  private persist(): void {
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify([...this.installed]));
    } catch {
      /* private mode / quota: library stays in memory */
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
