/*
 * Runtime bundle factory.
 *
 * The desktop never imports implementations directly: App builds the bundle once and
 * hands it to React context. Swapping the mock for the real BrowserX64Emulator adapter
 * is a one-line change here — every component only knows the types in ./types.
 */

import { MockEmulatorRuntime } from "./mockRuntime";
import { LocalGameStore } from "./mockGameStore";
import { BrowserStorageService } from "./storage";
import type { ExtendedEmulatorRuntime, GameStoreService, PortholeStorageService } from "./types";

export interface RuntimeBundle {
  runtime: ExtendedEmulatorRuntime;
  store: GameStoreService;
  storage: PortholeStorageService;
}

export function createRuntimeBundle(): RuntimeBundle {
  return {
    runtime: new MockEmulatorRuntime(),
    store: new LocalGameStore(),
    storage: new BrowserStorageService(),
  };
}
