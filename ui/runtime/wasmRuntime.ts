/*
 * ABI-v3 BrowserX64Emulator adapter.
 *
 * This is the only UI-runtime module that knows about the wasm-bindgen ABI. It
 * reuses the repository's existing JIT host and NvmeVfs implementations through
 * Vite's platform bridge, and confines game bytes to a user-selected C:\\Game or
 * origin-private folder. Chocolatey content is never fetched here.
 */

import "@porthole/x64-jit-host";
import "@porthole/x64-nvme-vfs";
import type { WasmEmulatorBindings } from "./contracts";
import type {
  EmulatorState,
  ExtendedEmulatorRuntime,
  ProcessHandle,
  RuntimeLogEntry,
  RuntimeLogLevel,
  RuntimeMode,
  RuntimeTelemetry,
  StorageBackendId,
  PortholeStorageService,
} from "./types";

const MAX_RESIDENT_PAGES = 8192;
const MAX_GAME_TREE_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const PAGE_BYTES = 4096;
const PAGE_RECORD_BYTES = 8 + PAGE_BYTES;
const SLICE_INSTRUCTIONS = 50_000;
const TELEMETRY_INTERVAL_MS = 500;
const MAX_LOGS = 500;

interface WasmCore extends WasmEmulatorBindings {
  free?(): void;
}

interface GeneratedWasmModule {
  default?: (input?: string | URL) => Promise<unknown>;
  BrowserX64Emulator?: new (maxResidentPages: number) => WasmCore;
  memory?: unknown;
  __wasm?: { memory?: unknown };
}

interface CoreTelemetry {
  instructions?: number;
  residentPages?: number;
  residentLimit?: number;
  status?: string;
}

interface GuestFile {
  path: string;
  bytes: Uint8Array;
}

interface GuestVfs extends PortholeJitCache {
  listGameFiles(): Promise<string[]>;
  readGameTree(limitBytes: number): Promise<GuestFile[]>;
  importGameFiles(files: readonly File[]): Promise<string[]>;
  persistPages(records: Uint8Array): Promise<{ written?: number }>;
  fetchPage(pageBase: number): Promise<{ pageBase: number; bytes: Uint8Array; zeroFilled?: boolean }>;
}

class MemoryGuestVfs implements GuestVfs {
  private readonly files = new Map<string, Uint8Array>();
  private readonly pages = new Map<number, Uint8Array>();
  private readonly jit = new Map<string, PortholeJitCacheEntry[]>();

  async listGameFiles(): Promise<string[]> {
    return [...this.files.keys()].map((name) => `C:\\Game\\${name}`);
  }

  async readGameTree(limitBytes: number): Promise<GuestFile[]> {
    let total = 0;
    const result: GuestFile[] = [];
    for (const [name, bytes] of this.files) {
      if (bytes.byteLength > limitBytes || total + bytes.byteLength > limitBytes) continue;
      total += bytes.byteLength;
      result.push({ path: `C:\\Game\\${name}`, bytes: bytes.slice() });
    }
    return result;
  }

  async importGameFiles(files: readonly File[]): Promise<string[]> {
    const names: string[] = [];
    let total = [...this.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    for (const file of files) {
      const name = safeGuestFileName(file.name);
      if (!name) continue;
      if (file.size > MAX_IMPORT_BYTES || total + file.size > MAX_IMPORT_BYTES) {
        throw new Error(`Import exceeds the ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB in-memory limit.`);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.files.set(name.toLowerCase(), bytes);
      total += bytes.byteLength;
      names.push(`C:\\Game\\${name}`);
    }
    return names;
  }

  async persistPages(records: Uint8Array): Promise<{ written: number }> {
    const view = records;
    if (view.byteLength % PAGE_RECORD_BYTES !== 0) {
      throw new Error(`Invalid evicted-page record size: ${view.byteLength} bytes.`);
    }
    let written = 0;
    for (let offset = 0; offset < view.byteLength; offset += PAGE_RECORD_BYTES) {
      const base = Number(new DataView(view.buffer, view.byteOffset + offset, 8).getBigUint64(0, true));
      this.pages.set(base, view.slice(offset + 8, offset + PAGE_RECORD_BYTES));
      written += 1;
    }
    return { written };
  }

  async fetchPage(pageBase: number): Promise<{ pageBase: number; bytes: Uint8Array; zeroFilled: boolean }> {
    return {
      pageBase,
      bytes: this.pages.get(pageBase)?.slice() ?? new Uint8Array(PAGE_BYTES),
      zeroFilled: !this.pages.has(pageBase),
    };
  }

  async saveJitCache(exeSha256: string, entries: PortholeJitCacheEntry[]): Promise<void> {
    this.jit.set(exeSha256, cloneCacheEntries(entries));
  }

  async loadJitCache(exeSha256: string): Promise<PortholeJitCacheEntry[]> {
    return cloneCacheEntries(this.jit.get(exeSha256) ?? []);
  }

  async saveJitModule(entryRip: bigint, wasmBytes: Uint8Array, meta?: Record<string, unknown>): Promise<void> {
    const key = `module:${entryRip.toString(16)}`;
    this.jit.set(key, [{ meta: meta ?? {}, wasmBytes: wasmBytes.slice() }]);
  }

  async loadJitModules(limit = 4096): Promise<PortholeJitCacheEntry[]> {
    return [...this.jit.entries()]
      .filter(([key]) => key.startsWith("module:"))
      .flatMap(([, entries]) => cloneCacheEntries(entries))
      .slice(0, limit);
  }
}

class DirectoryGuestVfs implements GuestVfs {
  constructor(private readonly disk: PortholeNvmeVfs) {}

  listGameFiles(): Promise<string[]> {
    return this.disk.listGameFiles();
  }

  readGameTree(limitBytes: number): Promise<GuestFile[]> {
    return this.disk.readGameTree(limitBytes);
  }

  async importGameFiles(files: readonly File[]): Promise<string[]> {
    const gameDir = this.disk.gameDir;
    if (!gameDir) throw new Error("The mounted storage has no writable Game directory.");
    const names: string[] = [];
    let total = 0;
    for (const file of files) {
      const name = safeGuestFileName(file.name);
      if (!name) continue;
      if (file.size > MAX_IMPORT_BYTES || total + file.size > MAX_IMPORT_BYTES) {
        throw new Error(`Import exceeds the ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB per-session limit.`);
      }
      const handle = await gameDir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(await file.arrayBuffer()));
      await writable.close();
      total += file.size;
      names.push(`C:\\Game\\${name}`);
    }
    return names;
  }

  persistPages(records: Uint8Array): Promise<{ written?: number }> {
    return this.disk.persistPages(records);
  }

  fetchPage(pageBase: number): Promise<{ pageBase: number; bytes: Uint8Array; zeroFilled?: boolean }> {
    return this.disk.fetchPage(pageBase);
  }

  saveJitCache(exeSha256: string, entries: PortholeJitCacheEntry[]): Promise<unknown> {
    return this.disk.saveJitCache(exeSha256, entries);
  }

  loadJitCache(exeSha256: string): Promise<PortholeJitCacheEntry[]> {
    return this.disk.loadJitCache(exeSha256);
  }

  saveJitModule(entryRip: bigint, wasmBytes: Uint8Array, meta?: Record<string, unknown>): Promise<unknown> {
    return this.disk.saveJitModule(entryRip, wasmBytes, meta);
  }

  loadJitModules(limit?: number): Promise<PortholeJitCacheEntry[]> {
    return this.disk.loadJitModules(limit);
  }
}

function safeGuestFileName(value: string): string {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 180);
}

function cloneCacheEntries(entries: readonly PortholeJitCacheEntry[]): PortholeJitCacheEntry[] {
  return entries.map(({ meta, wasmBytes }) => ({
    meta: meta ? { ...meta } : null,
    wasmBytes: wasmBytes.slice(),
  }));
}

function memoryFrom(value: unknown): WebAssembly.Memory | null {
  if (!value || typeof value !== "object" || !("memory" in value)) return null;
  const memory = (value as { memory?: unknown }).memory;
  return memory instanceof WebAssembly.Memory ? memory : null;
}

async function loadWasmModule(): Promise<{ module: GeneratedWasmModule; memory: WebAssembly.Memory }> {
  if (import.meta.env.SSR || typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("The ABI-v3 WebAssembly runtime can only be initialized in a browser.");
  }
  const base = new URL(`${import.meta.env.BASE_URL}wasm/`, document.baseURI);
  const moduleUrl = new URL("porthole_x64_wasm.js", base).href;
  const wasmUrl = new URL("porthole_x64_wasm_bg.wasm", base).href;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as GeneratedWasmModule;
  const initialized = typeof module.default === "function" ? await module.default(wasmUrl) : null;
  if (typeof module.BrowserX64Emulator !== "function") {
    throw new Error("Wasm artifact has no BrowserX64Emulator binding (expected ABI v3).");
  }
  const memory = memoryFrom(initialized) ?? memoryFrom(module) ?? memoryFrom(module.__wasm);
  if (!memory) {
    throw new Error("Wasm artifact does not export memory; the shared-memory JIT host cannot start.");
  }
  if (!window.Porthole?.X64JitHost || !window.Porthole.NvmeVfs) {
    throw new Error("Porthole JIT/VFS platform bridge was not loaded by the desktop build.");
  }
  return { module, memory };
}

async function createGuestVfs(
  backend: StorageBackendId,
  storage: PortholeStorageService,
  log: (message: string) => void,
): Promise<GuestVfs> {
  if (backend === "memory") return new MemoryGuestVfs();
  if (backend === "file-system-access") {
    const root = storage.getDirectoryHandle();
    if (!root) throw new Error("External folder access was selected but no directory handle is mounted.");
    const disk = new window.Porthole!.NvmeVfs({ logger: log });
    await disk.mount(root, { label: "File System Access" });
    return new DirectoryGuestVfs(disk);
  }

  const manager = navigator.storage;
  if (!manager || typeof manager.getDirectory !== "function") {
    throw new Error("OPFS is unavailable in this browser context.");
  }
  const root = await manager.getDirectory();
  const disk = new window.Porthole!.NvmeVfs({ logger: log });
  await disk.mount(root, { label: "OPFS" });
  return new DirectoryGuestVfs(disk);
}

function parseCoreTelemetry(core: WasmCore | null): CoreTelemetry {
  if (!core) return {};
  try {
    const raw: unknown = JSON.parse(core.telemetry_json());
    if (!raw || typeof raw !== "object") return {};
    const value = raw as CoreTelemetry;
    return {
      instructions: Number(value.instructions) || 0,
      residentPages: Number(value.residentPages) || 0,
      residentLimit: Number(value.residentLimit) || MAX_RESIDENT_PAGES,
      status: typeof value.status === "string" ? value.status : "",
    };
  } catch {
    return {};
  }
}

function normalizeGuestPath(path: string): string {
  return path.replaceAll("/", "\\").replace(/\\+/g, "\\").toLowerCase();
}

function commandLine(path: string, argumentsLine: string): string {
  const quotedPath = `"${path.replaceAll('"', '\\"')}"`;
  return argumentsLine.trim() ? `${quotedPath} ${argumentsLine.trim()}` : quotedPath;
}

function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return Promise.resolve(null);
  const stableBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(stableBuffer).set(bytes);
  return crypto.subtle.digest("SHA-256", stableBuffer).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  ).catch(() => null);
}

function extractDoomDemo1(files: readonly GuestFile[]): GuestFile | null {
  const wad = files.find((file) => /\\doom2\.wad$/i.test(file.path));
  if (!wad || wad.bytes.byteLength < 12) return null;
  const view = new DataView(wad.bytes.buffer, wad.bytes.byteOffset, wad.bytes.byteLength);
  const magic = String.fromCharCode(...wad.bytes.subarray(0, 4));
  if (magic !== "IWAD" && magic !== "PWAD") return null;
  const lumpCount = view.getUint32(4, true);
  const directoryOffset = view.getUint32(8, true);
  if (lumpCount > 1_000_000 || directoryOffset + lumpCount * 16 > wad.bytes.byteLength) return null;
  for (let index = 0; index < lumpCount; index += 1) {
    const item = directoryOffset + index * 16;
    const start = view.getUint32(item, true);
    const size = view.getUint32(item + 4, true);
    const nameBytes = wad.bytes.subarray(item + 8, item + 16);
    const name = String.fromCharCode(...nameBytes).replace(/\0+$/, "").toUpperCase();
    if (name !== "DEMO1" || start + size > wad.bytes.byteLength) continue;
    return { path: "C:\\Game\\demo1.lmp", bytes: wad.bytes.slice(start, start + size) };
  }
  return null;
}

function checksumRgba(width: number, height: number, bytes: Uint8Array): string {
  let hash = 0xcbf2_9ce4_8422_2325n;
  const mix = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100_0000_01b3n);
  };
  for (const value of [width, height]) {
    mix(value & 0xff);
    mix((value >>> 8) & 0xff);
    mix((value >>> 16) & 0xff);
    mix((value >>> 24) & 0xff);
  }
  for (const byte of bytes) mix(byte);
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function imageDataFrom(bytes: Uint8Array, width: number, height: number): ImageData | null {
  if (width <= 0 || height <= 0 || bytes.byteLength !== width * height * 4) return null;
  try {
    return new ImageData(new Uint8ClampedArray(bytes), width, height);
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Real ABI-v3 runtime; the router selects it only when the CI Wasm artifact is present. */
export class WasmEmulatorRuntime implements ExtendedEmulatorRuntime {
  readonly mode: RuntimeMode = "wasm";

  private module: GeneratedWasmModule | null = null;
  private memory: WebAssembly.Memory | null = null;
  private core: WasmCore | null = null;
  private jit: PortholeX64JitHost | null = null;
  private vfs: GuestVfs | null = null;
  private initialized = false;
  private disposed = false;
  private state: EmulatorState = "idle";
  private processId: ProcessHandle | null = null;
  private executable: string | null = null;
  private backend: StorageBackendId = "opfs";
  private frame: ImageData | null = null;
  private presentedFrames = 0;
  private sdlFramesSeen = 0;
  private d3dFramesSeen = 0;
  private frameChecksum = "";
  private fps = 0;
  private frameRateSampleAt = 0;
  private lastSampledFrames = 0;
  private inputEvents = 0;
  private runningSince: number | null = null;
  private accumulatedUptime = 0;
  private runGeneration = 0;
  private rafId: number | null = null;
  private lastTelemetryAt = 0;
  private cachedTelemetry: RuntimeTelemetry;
  private logSequence = 1;
  private logs: RuntimeLogEntry[] = [];
  private readonly stateListeners = new Set<(state: EmulatorState) => void>();
  private readonly frameListeners = new Set<() => void>();
  private readonly telemetryListeners = new Set<(telemetry: RuntimeTelemetry) => void>();
  private readonly logListeners = new Set<(entry: RuntimeLogEntry) => void>();
  private readonly hleCounts = new Map<string, number>();
  private missingSymbols = "";

  constructor(private readonly storage: PortholeStorageService) {
    this.cachedTelemetry = this.makeTelemetry({});
  }

  async initialize(storage: StorageBackendId): Promise<void> {
    if (this.disposed) throw new Error("Wasm runtime is disposed.");
    if (this.initialized) {
      if (storage !== this.backend) {
        throw new Error("Changing the mounted runtime backend requires a desktop restart.");
      }
      this.emitLog("info", "storage", `runtime storage remains mounted: ${storage}`);
      return;
    }

    this.backend = storage;
    const loaded = await loadWasmModule();
    const vfs = await createGuestVfs(storage, this.storage, (message) => {
      this.emitLog("info", "storage", message);
    });
    this.module = loaded.module;
    this.memory = loaded.memory;
    this.vfs = vfs;
    this.initialized = true;
    this.emitLog("info", "runtime", "ABI-v3 BrowserX64Emulator loaded from the Wasm artifact.");
    this.emitLog("info", "runtime", "Windows API SHIM routes through the core; the shared-memory Wasm JIT host is enabled.");
    this.emitLog("info", "storage", `guest page swap and JIT cache backend: ${storage}`);
    this.emitTelemetry();
  }

  async listGameFiles(): Promise<string[]> {
    if (!this.initialized || !this.vfs) throw new Error("Initialize the runtime before listing guest files.");
    return this.vfs.listGameFiles();
  }

  async importFiles(files: readonly File[]): Promise<string[]> {
    if (!this.initialized || !this.vfs) throw new Error("Initialize the runtime before importing guest files.");
    if (this.state === "running" || this.state === "page-fault-wait") {
      throw new Error("Pause the guest before importing files into C:\\Game.");
    }
    const paths = await this.vfs.importGameFiles(files);
    this.emitLog("info", "storage", `${paths.length} user-selected file(s) copied to the mounted C:\\Game directory.`);
    return paths;
  }

  async loadExecutable(path: string, argumentsLine = ""): Promise<ProcessHandle> {
    if (this.disposed) throw new Error("Wasm runtime is disposed.");
    if (!this.initialized || !this.module || !this.memory || !this.vfs) {
      throw new Error("Initialize the desktop runtime before loading a PE32+ executable.");
    }
    if (this.state === "running" || this.state === "paused" || this.state === "page-fault-wait") {
      this.stopExecution();
    }
    this.core?.free?.();
    this.core = null;
    this.jit = null;
    this.frame = null;
    this.presentedFrames = 0;
    this.sdlFramesSeen = 0;
    this.d3dFramesSeen = 0;
    this.frameChecksum = "";
    this.inputEvents = 0;
    this.hleCounts.clear();
    this.missingSymbols = "";
    this.accumulatedUptime = 0;
    this.runningSince = null;
    this.executable = path;
    this.processId = null;
    this.setState("loading");

    try {
      const files = await this.vfs.readGameTree(MAX_GAME_TREE_BYTES);
      const normalizedPath = normalizeGuestPath(path);
      const target = files.find((file) => normalizeGuestPath(file.path) === normalizedPath);
      if (!target) {
        throw new Error(`Executable not found in the mounted C:\\Game directory: ${path}. Import the PE32+ file (and its data files) first.`);
      }

      const CoreConstructor = this.module.BrowserX64Emulator;
      if (!CoreConstructor) throw new Error("BrowserX64Emulator binding disappeared after initialization.");
      const core = new CoreConstructor(MAX_RESIDENT_PAGES);
      this.core = core;
      core.set_max_resident_pages(MAX_RESIDENT_PAGES);
      core.set_jit_enabled(true);
      core.set_jit_validate_mode(1);
      core.set_virtual_input_profile(true);
      const platform = window.Porthole;
      if (!platform?.X64JitHost) throw new Error("The shared-memory Wasm JIT host is unavailable.");
      const jit = new platform.X64JitHost(core, this.module, {
        enabled: true,
        memory: this.memory,
        cache: this.vfs,
      });
      jit.cache = this.vfs;
      this.jit = jit;

      for (const directory of [
        "C:\\Windows",
        "C:\\Windows\\System32",
        "C:\\Users",
        "C:\\Users\\PORTHOLE",
        "C:\\Users\\PORTHOLE\\Temp",
        "C:\\Users\\PORTHOLE\\AppData",
        "C:\\Users\\PORTHOLE\\AppData\\Roaming",
        "C:\\Game",
      ]) {
        core.vfs_mkdir(directory);
      }
      for (const file of files) core.vfs_insert(file.path, file.bytes);
      if (/-timedemo\s+demo1\b/i.test(argumentsLine) && !files.some((file) => /\\demo1\.lmp$/i.test(file.path))) {
        const demo = extractDoomDemo1(files);
        if (demo) {
          core.vfs_insert(demo.path, demo.bytes);
          this.emitLog("info", "vfs", `Extracted the local IWAD DEMO1 lump into ${demo.path}.`);
        } else {
          this.emitLog("warn", "vfs", "Timedemo requested but no DEMO1 lump was found in the mounted IWAD.");
        }
      }

      let loadReport = "";
      try {
        loadReport = core.load_pe(target.bytes);
      } catch (error) {
        this.core = null;
        this.jit = null;
        core.free?.();
        this.setState("faulted");
        throw new Error(`PE32+ load failed: ${errorText(error)}`);
      }
      core.set_exe_path(path);
      core.set_command_line(commandLine(path, argumentsLine));
      const digest = await sha256Hex(target.bytes);
      if (digest) jit.exeSha256 = digest;
      await jit.initCache();
      const aotBlocks = core.aot_compile_text();
      await jit.drainPending();
      await jit.flushCache();

      this.processId = `wasm-${Date.now().toString(36)}-${this.logSequence.toString(36)}`;
      this.emitLog("info", "loader", `PE32+ mapped: ${path}${argumentsLine ? ` ${argumentsLine}` : ""} · AOT blocks=${aotBlocks} · cache=${digest ? "SHA-256 keyed" : "disabled (WebCrypto unavailable)"}.`);
      this.emitLog("debug", "loader", `load report: ${loadReport}`);
      this.refreshTelemetry(true);
      this.setState("idle");
      return this.processId;
    } catch (error) {
      const failedCore = this.core;
      this.core = null;
      this.jit = null;
      this.processId = null;
      failedCore?.free?.();
      this.emitLog("error", "loader", `load failed: ${errorText(error)}`);
      this.setState("faulted");
      throw error;
    }
  }

  async launch(handle: ProcessHandle): Promise<void> {
    if (!this.processId || handle !== this.processId || !this.core || !this.jit) {
      throw new Error(`launch: unknown or unloaded Wasm process (${handle}).`);
    }
    if (this.state === "running") return;
    this.runningSince = performance.now();
    this.frameRateSampleAt = performance.now();
    this.lastSampledFrames = this.presentedFrames;
    this.setState("running");
    this.emitLog("info", "runtime", `guest execution started · JIT enabled · slice=${SLICE_INSTRUCTIONS.toLocaleString()} instructions.`);
    this.runGeneration += 1;
    this.scheduleRunLoop(this.runGeneration);
  }

  async pause(handle: ProcessHandle): Promise<void> {
    this.validateHandle(handle, "pause");
    if (this.state !== "running" && this.state !== "page-fault-wait") return;
    this.stopExecution();
    this.accumulateUptime();
    this.setState("paused");
    this.emitLog("info", "runtime", "guest execution paused by the desktop.");
  }

  async terminate(handle: ProcessHandle): Promise<void> {
    if (this.processId && handle !== this.processId) {
      throw new Error(`terminate: unknown process handle (${handle}).`);
    }
    this.stopExecution();
    this.accumulateUptime();
    this.core?.free?.();
    this.core = null;
    this.jit = null;
    const finished = this.processId;
    this.processId = null;
    this.setState("exited");
    this.emitLog("info", "runtime", `Wasm guest ${finished ?? "(none)"} stopped; core instance released.`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopExecution();
    this.core?.free?.();
    this.core = null;
    this.jit = null;
    this.stateListeners.clear();
    this.frameListeners.clear();
    this.telemetryListeners.clear();
    this.logListeners.clear();
  }

  getState(): EmulatorState {
    return this.state;
  }

  onStateChange(callback: (state: EmulatorState) => void): void {
    this.stateListeners.add(callback);
  }

  offStateChange(callback: (state: EmulatorState) => void): void {
    this.stateListeners.delete(callback);
  }

  onFrameReady(callback: () => void): void {
    this.frameListeners.add(callback);
  }

  offFrameReady(callback: () => void): void {
    this.frameListeners.delete(callback);
  }

  onTelemetry(callback: (telemetry: RuntimeTelemetry) => void): () => void {
    this.telemetryListeners.add(callback);
    return () => this.telemetryListeners.delete(callback);
  }

  onLog(callback: (entry: RuntimeLogEntry) => void): () => void {
    this.logListeners.add(callback);
    return () => this.logListeners.delete(callback);
  }

  getLogs(): readonly RuntimeLogEntry[] {
    return this.logs;
  }

  /** Router diagnostic for an ABI/runtime initialization failure. */
  recordHostEvent(level: RuntimeLogLevel, source: string, message: string): void {
    this.emitLog(level, source, message);
  }

  clearLogs(): void {
    this.logs = [];
  }

  getTelemetry(): RuntimeTelemetry {
    const runningMs = this.accumulatedUptime +
      (this.runningSince === null ? 0 : performance.now() - this.runningSince);
    return { ...this.cachedTelemetry, uptimeMs: Math.round(runningMs), state: this.state };
  }

  sendKeyEvent(key: string, state: "down" | "up"): void {
    this.inputEvents += 1;
    if (this.inputEvents === 1 || this.inputEvents % 40 === 0) {
      this.emitLog("warn", "input", `key ${state} ${key} counted by the shell; Win32/SDL key delivery is not implemented (KI-04).`);
    }
    this.emitTelemetry();
  }

  sendMouseEvent(button: 0 | 1 | 2, x: number, y: number): void {
    this.inputEvents += 1;
    this.core?.inject_mouse_move(Math.round(x), Math.round(y));
    if (button !== 0 || this.inputEvents === 1 || this.inputEvents % 40 === 0) {
      this.emitLog("debug", "input", `mouse position forwarded to the core at ${Math.round(x)},${Math.round(y)}; button state is not implemented (KI-04).`);
    }
    this.emitTelemetry();
  }

  getFramebuffer(): ImageData | null {
    return this.frame;
  }

  private scheduleRunLoop(generation: number): void {
    if (this.disposed || this.state !== "running" || this.rafId !== null) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      void this.runSlice(generation);
    });
  }

  private async runSlice(generation: number): Promise<void> {
    const core = this.core;
    const jit = this.jit;
    const vfs = this.vfs;
    if (!core || !jit || !vfs || generation !== this.runGeneration || this.state !== "running") return;
    try {
      let status = await jit.runSlice(SLICE_INSTRUCTIONS);
      let pageFaults = 0;
      while (status.startsWith("page-fault:") && pageFaults < 64) {
        pageFaults += 1;
        const pageBase = Number(status.slice("page-fault:".length));
        this.setState("page-fault-wait");
        const page = await vfs.fetchPage(pageBase);
        core.supply_page(BigInt(page.pageBase), page.bytes);
        if (generation !== this.runGeneration) return;
        this.setState("running");
        status = await jit.runSlice(SLICE_INSTRUCTIONS);
      }

      if (status === "modal") {
        const request = core.modal_request();
        this.emitLog("warn", "shim", `guest modal requested; desktop modal UI is not wired yet. Request: ${request.slice(0, 240)}`);
        this.stopExecution();
        this.accumulateUptime();
        this.setState("paused");
        return;
      }
      if (status.startsWith("exit:") || status.startsWith("fault:") || status === "halt") {
        await this.finishGuest(status);
        return;
      }
      if (pageFaults >= 64) throw new Error("Page-fault retry limit exceeded in one scheduler slice.");

      this.syncFrame();
      const dirty = core.drain_evicted_pages();
      if (dirty.length > 0) {
        const result = await vfs.persistPages(dirty);
        if (result.written) this.emitLog("debug", "storage", `persisted ${result.written} evicted guest page(s).`);
      }
      const consoleOutput = core.take_console().trim();
      if (consoleOutput) {
        for (const line of consoleOutput.split(/\r?\n/).slice(-12)) {
          if (line.trim()) this.emitLog("info", "guest", line.slice(0, 500));
        }
      }
      const now = performance.now();
      if (now - this.lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
        this.refreshTelemetry();
        this.refreshShimTelemetry();
        this.lastTelemetryAt = now;
      }
      this.scheduleRunLoop(generation);
    } catch (error) {
      this.stopExecution();
      this.accumulateUptime();
      this.emitLog("error", "runtime", `guest scheduler stopped: ${errorText(error)}`);
      this.setState("faulted");
    }
  }

  private async finishGuest(status: string): Promise<void> {
    const core = this.core;
    if (core) {
      this.syncFrame();
      const dirty = core.drain_evicted_pages();
      if (dirty.length > 0 && this.vfs) {
        try {
          await this.vfs.persistPages(dirty);
        } catch (error) {
          this.emitLog("error", "storage", `final page flush failed: ${errorText(error)}`);
        }
      }
      const consoleOutput = core.take_console().trim();
      if (consoleOutput) this.emitLog("info", "guest", consoleOutput.slice(-4000));
    }
    this.refreshShimTelemetry();
    this.stopExecution();
    this.accumulateUptime();
    this.refreshTelemetry(true);
    if (status.startsWith("fault:")) {
      this.emitLog("error", "guest", status);
      this.setState("faulted");
    } else {
      this.emitLog("info", "guest", status === "halt" ? "guest halted." : status);
      this.setState("exited");
    }
  }

  private syncFrame(): void {
    const core = this.core;
    if (!core) return;
    const sdlFrames = Number(core.presented_frames());
    const d3dDelta = Number(core.frames_presented());
    const d3dFrames = this.d3dFramesSeen + d3dDelta;
    const total = Math.max(sdlFrames, d3dFrames);

    let nextFrame: ImageData | null = null;
    let checksum = "";
    if (sdlFrames > this.sdlFramesSeen) {
      const width = Number(core.guest_frame_width());
      const height = Number(core.guest_frame_height());
      const pixels = core.guest_frame_rgba();
      nextFrame = imageDataFrom(pixels, width, height);
      checksum = core.frame_checksum();
      this.sdlFramesSeen = sdlFrames;
    }
    if (!nextFrame && d3dDelta > 0) {
      const pixels = core.take_frame();
      if (pixels && pixels.length > 0) {
        const width = Number(core.frame_width());
        const height = Number(core.frame_height());
        nextFrame = imageDataFrom(pixels, width, height);
        if (nextFrame) checksum = checksumRgba(width, height, pixels);
      }
    }
    this.d3dFramesSeen = d3dFrames;
    this.presentedFrames = total;
    if (nextFrame) {
      this.frame = nextFrame;
      this.frameChecksum = checksum;
      for (const listener of this.frameListeners) listener();
    }
    const now = performance.now();
    const elapsed = now - this.frameRateSampleAt;
    if (elapsed >= 500) {
      this.fps = Math.round(((total - this.lastSampledFrames) * 1000) / elapsed);
      this.lastSampledFrames = total;
      this.frameRateSampleAt = now;
    }
  }

  private refreshShimTelemetry(): void {
    const core = this.core;
    if (!core) return;
    for (const token of core.hle_histogram(64).trim().split(/\s+/)) {
      if (!token) continue;
      const separator = token.lastIndexOf("=");
      if (separator <= 0) continue;
      const symbol = token.slice(0, separator);
      const count = Number(token.slice(separator + 1));
      if (!Number.isFinite(count)) continue;
      const delta = count - (this.hleCounts.get(symbol) ?? 0);
      this.hleCounts.set(symbol, count);
      if (delta > 0) this.emitLog("debug", "shim", `${symbol} +${delta} (total ${count})`);
    }
    const missing = core.unimplemented_symbols().trim();
    if (missing && missing !== this.missingSymbols) {
      this.missingSymbols = missing;
      this.emitLog("warn", "shim", `unimplemented guest imports observed: ${missing.slice(0, 800)}`);
    }
  }

  private refreshTelemetry(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastTelemetryAt < 120) return;
    const coreTelemetry = parseCoreTelemetry(this.core);
    this.cachedTelemetry = this.makeTelemetry(coreTelemetry);
    this.lastTelemetryAt = now;
    this.emitTelemetry();
  }

  private makeTelemetry(core: CoreTelemetry): RuntimeTelemetry {
    const uptimeMs = this.accumulatedUptime +
      (this.runningSince === null ? 0 : performance.now() - this.runningSince);
    return {
      state: this.state,
      processId: this.processId,
      executable: this.executable,
      instructionsExecuted: core.instructions ?? 0,
      presentedFrames: this.presentedFrames,
      residentPages: core.residentPages ?? 0,
      maxResidentPages: core.residentLimit ?? MAX_RESIDENT_PAGES,
      fps: this.state === "running" ? this.fps : 0,
      frameChecksum: this.frameChecksum,
      uptimeMs: Math.round(uptimeMs),
      storageBackend: this.backend,
      inputEvents: this.inputEvents,
    };
  }

  private emitTelemetry(): void {
    const snapshot = this.getTelemetry();
    this.cachedTelemetry = snapshot;
    for (const listener of this.telemetryListeners) listener(snapshot);
  }

  private emitLog(level: RuntimeLogLevel, source: string, message: string): void {
    const entry: RuntimeLogEntry = {
      id: this.logSequence++,
      ts: Date.now(),
      level,
      source,
      message,
    };
    this.logs = [...this.logs, entry].slice(-MAX_LOGS);
    for (const listener of this.logListeners) listener(entry);
  }

  private setState(next: EmulatorState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
    this.refreshTelemetry(true);
  }

  private validateHandle(handle: ProcessHandle, operation: string): void {
    if (!this.processId || this.processId !== handle) {
      throw new Error(`${operation}: unknown or unloaded Wasm process (${handle}).`);
    }
  }

  private stopExecution(): void {
    this.runGeneration += 1;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private accumulateUptime(): void {
    if (this.runningSince !== null) {
      this.accumulatedUptime += performance.now() - this.runningSince;
      this.runningSince = null;
    }
  }
}
