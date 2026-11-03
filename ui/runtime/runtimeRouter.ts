/*
 * Production runtime selector. There is deliberately no synthetic guest fallback:
 * if the ABI-v3 Wasm artifact cannot initialize, the desktop remains available in
 * `unavailable` mode and guest launch is refused with the underlying reason in the
 * in-OS developer console.
 */

import type {
  EmulatorState,
  ExtendedEmulatorRuntime,
  ProcessHandle,
  RuntimeLogEntry,
  RuntimeMode,
  RuntimeTelemetry,
  StorageBackendId,
  PortholeStorageService,
} from "./types";
import { WasmEmulatorRuntime } from "./wasmRuntime";

export class RuntimeRouter implements ExtendedEmulatorRuntime {
  private readonly wasm: WasmEmulatorRuntime;
  private initializationFailure: string | null = "Runtime has not initialized yet.";

  constructor(storage: PortholeStorageService) {
    this.wasm = new WasmEmulatorRuntime(storage);
  }

  get mode(): RuntimeMode {
    return this.initializationFailure === null ? "wasm" : "unavailable";
  }

  async initialize(storage: StorageBackendId): Promise<void> {
    try {
      await this.wasm.initialize(storage);
      this.initializationFailure = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.initializationFailure = message;
      this.wasm.recordHostEvent(
        "error",
        "runtime",
        `ABI-v3 runtime unavailable; guest execution is disabled. ${message}`,
      );
      // Keep the desktop usable for diagnostics. Never swap to synthetic guest data.
    }
  }

  loadExecutable(path: string, argumentsLine = ""): Promise<ProcessHandle> {
    this.assertAvailable();
    return this.wasm.loadExecutable(path, argumentsLine);
  }

  async importFiles(files: readonly File[]): Promise<string[]> {
    this.assertAvailable();
    if (!this.wasm.importFiles) throw new Error("The active runtime does not support local file import.");
    return this.wasm.importFiles(files);
  }

  private assertAvailable(): void {
    if (this.initializationFailure !== null) {
      throw new Error(`ABI-v3 Wasm runtime is unavailable: ${this.initializationFailure}`);
    }
  }

  launch(handle: ProcessHandle): Promise<void> {
    return this.wasm.launch(handle);
  }

  pause(handle: ProcessHandle): Promise<void> {
    return this.wasm.pause(handle);
  }

  terminate(handle: ProcessHandle): Promise<void> {
    return this.wasm.terminate(handle);
  }

  onStateChange(callback: (state: EmulatorState) => void): void {
    this.wasm.onStateChange(callback);
  }

  offStateChange(callback: (state: EmulatorState) => void): void {
    this.wasm.offStateChange(callback);
  }

  getState(): EmulatorState {
    return this.wasm.getState();
  }

  sendKeyEvent(key: string, state: "down" | "up"): void {
    this.wasm.sendKeyEvent(key, state);
  }

  sendMouseEvent(button: 0 | 1 | 2, x: number, y: number): void {
    this.wasm.sendMouseEvent(button, x, y);
  }

  getFramebuffer(): ImageData | null {
    return this.wasm.getFramebuffer();
  }

  onFrameReady(callback: () => void): void {
    this.wasm.onFrameReady(callback);
  }

  offFrameReady(callback: () => void): void {
    this.wasm.offFrameReady(callback);
  }

  onTelemetry(callback: (telemetry: RuntimeTelemetry) => void): () => void {
    return this.wasm.onTelemetry(callback);
  }

  getTelemetry(): RuntimeTelemetry {
    return this.wasm.getTelemetry();
  }

  onLog(callback: (entry: RuntimeLogEntry) => void): () => void {
    return this.wasm.onLog(callback);
  }

  getLogs(): readonly RuntimeLogEntry[] {
    return this.wasm.getLogs();
  }

  clearLogs(): void {
    this.wasm.clearLogs();
  }

  dispose(): void {
    this.wasm.dispose();
  }
}
