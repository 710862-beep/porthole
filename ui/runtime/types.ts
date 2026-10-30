/*
 * UI ↔ runtime types.
 *
 * PROVENANCE: contracts.ts mirrors the wasm-bindgen surface of
 * rust/porthole-x64-wasm/src/lib.rs and is owned by the runtime, not the shell.
 * This file extends those contracts with the *presentation* data the desktop needs
 * (telemetry snapshots, log records, storage probes, install jobs) without leaking
 * emulation internals or DOM types into the core boundary.
 *
 * Rule: nothing under src/ may import from rust/ or js/; everything crosses here.
 */

import type {
  AppCategoryId,
  EmulatorRuntime,
  EmulatorState,
  GameMetadata,
  ProcessHandle,
  StorageBackendId,
  StorageCapability,
  StorageSelector,
} from "./contracts";

export * from "./contracts";

/* ------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* ------------------------------------------------------------------------- */

/** "mock" ships in the desktop today. "wasm" = wired to BrowserX64Emulator. */
export type RuntimeMode = "mock" | "wasm";

export interface RuntimeTelemetry {
  state: EmulatorState;
  processId: ProcessHandle | null;
  executable: string | null;
  instructionsExecuted: number;
  presentedFrames: number;
  residentPages: number;
  maxResidentPages: number;
  /** Host-side present rate. Never interpreted as guest performance evidence. */
  fps: number;
  frameChecksum: string;
  uptimeMs: number;
  storageBackend: StorageBackendId;
  /** Accepted by the shell; not delivered to the guest yet (KI-04). */
  inputEvents: number;
}

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLogEntry {
  id: number;
  /** epoch milliseconds */
  ts: number;
  level: RuntimeLogLevel;
  source: string;
  message: string;
}

/**
 * The desktop-facing runtime. `EmulatorRuntime` is the minimum contract; the
 * additions are observation-only channels (telemetry/logs) plus initialization.
 *
 * Frame authority (contracts.ts): only `getFramebuffer()` after a present may be
 * drawn as "the frame". The mock runtime is always labelled as synthetic in UI.
 */
export interface ExtendedEmulatorRuntime extends EmulatorRuntime {
  readonly mode: RuntimeMode;
  initialize(storage: StorageBackendId): Promise<void>;
  onTelemetry(callback: (telemetry: RuntimeTelemetry) => void): () => void;
  getTelemetry(): RuntimeTelemetry;
  onLog(callback: (entry: RuntimeLogEntry) => void): () => void;
  getLogs(): readonly RuntimeLogEntry[];
  clearLogs(): void;
  /**
   * The base contract has no unsubscribe hooks. React needs them (StrictMode mounts
   * twice, windows unmount), so the desktop-facing surface adds explicit removals.
   */
  offFrameReady(callback: () => void): void;
  offStateChange(callback: (state: EmulatorState) => void): void;
  dispose(): void;
}

/* ------------------------------------------------------------------------- */
/* Storage                                                                    */
/* ------------------------------------------------------------------------- */

export interface StorageProbe extends StorageCapability {
  label: string;
  description: string;
  recommended: boolean;
}

export type NvmeSelection =
  | { ok: true; label: string; detail: string }
  | { ok: false; reason: string };

export interface StorageState {
  backend: StorageBackendId;
  label: string;
  detail: string;
}

/** Shell-side storage selection. Implemented in runtime/storage.ts. */
export interface PortholeStorageService extends StorageSelector {
  detectProbes(): Promise<StorageProbe[]>;
  requestNvme(): Promise<NvmeSelection>;
  describeSelected(): StorageState;
  setSelected(backend: StorageBackendId, detail?: string): StorageState;
  clearSelection(): void;
}

/* ------------------------------------------------------------------------- */
/* Game store                                                                 */
/* ------------------------------------------------------------------------- */

export type InstallPhase =
  | "queued"
  | "preparing"
  | "transferring"
  | "verifying"
  | "writing"
  | "complete"
  | "failed";

export interface InstallProgress {
  appId: string;
  phase: InstallPhase;
  percent: number;
  detail: string;
}

/** Library record: contract metadata + the extra facts the storefront renders. */
export interface StoreGame extends GameMetadata {
  summary: string;
  version: string;
  sizeMb: number;
  genre: string;
  /** Local, reviewable provenance note. Never a marketing claim. */
  provenance: string;
}

export interface GameStoreService {
  listGames(): StoreGame[];
  getGame(appId: string): StoreGame | null;
  installGame(appId: string, onProgress?: (progress: InstallProgress) => void): Promise<void>;
  uninstallGame(appId: string): Promise<void>;
  isInstalled(appId: string): boolean;
  onChange(callback: () => void): () => void;
  clear(): void;
}

/* ------------------------------------------------------------------------- */
/* App metadata shared with the shell                                         */
/* ------------------------------------------------------------------------- */

export type LauncherCategoryId = AppCategoryId | "emulators" | "settings";

export interface LauncherCategory {
  id: LauncherCategoryId;
  label: string;
}
