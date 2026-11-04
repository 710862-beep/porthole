/*
 * Runtime bundle factory. All React components consume one stable contract;
 * RuntimeRouter selects the ABI-v3 Wasm adapter and reports unavailable when its
 * artifact cannot initialize; production never substitutes synthetic execution.
 */

import { RuntimeRouter } from "./runtimeRouter";
import { LocalCatalogStore } from "./localCatalogStore";
import { BrowserStorageService } from "./storage";
import type { ExtendedEmulatorRuntime, GameStoreService, PortholeStorageService } from "./types";

export interface RuntimeBundle {
  runtime: ExtendedEmulatorRuntime;
  store: GameStoreService;
  storage: PortholeStorageService;
}

export function createRuntimeBundle(): RuntimeBundle {
  const storage = new BrowserStorageService();
  return {
    runtime: new RuntimeRouter(storage),
    store: new LocalCatalogStore(),
    storage,
  };
}
