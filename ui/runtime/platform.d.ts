interface PortholeGuestFile {
  path: string;
  bytes: Uint8Array;
}

interface PortholeNvmePage {
  pageBase: number;
  bytes: Uint8Array;
  zeroFilled?: boolean;
}

interface PortholeJitCacheEntry {
  meta: Record<string, unknown> | null;
  wasmBytes: Uint8Array;
}

interface PortholeJitCache {
  saveJitCache(exeSha256: string, entries: PortholeJitCacheEntry[]): Promise<unknown>;
  loadJitCache(exeSha256: string): Promise<PortholeJitCacheEntry[]>;
  saveJitModule(entryRip: bigint, wasmBytes: Uint8Array, meta?: Record<string, unknown>): Promise<unknown>;
  loadJitModules(limit?: number): Promise<PortholeJitCacheEntry[]>;
}

interface PortholeNvmeVfs extends PortholeJitCache {
  root: FileSystemDirectoryHandle | null;
  gameDir: FileSystemDirectoryHandle | null;
  guestDir: FileSystemDirectoryHandle | null;
  stats: { mounted: boolean; [name: string]: unknown };
  mount(handle: FileSystemDirectoryHandle, options?: { label?: string }): Promise<unknown>;
  listGameFiles(): Promise<string[]>;
  listGuestFiles(): Promise<string[]>;
  readGameTree(limitBytes?: number): Promise<PortholeGuestFile[]>;
  readGuestTree(limitBytes?: number): Promise<PortholeGuestFile[]>;
  persistGuestFiles(files: readonly PortholeGuestFile[], limitBytes?: number): Promise<{ written: number; bytes: number }>;
  persistPages(records: Uint8Array): Promise<{ written?: number }>;
  fetchPage(pageBase: number): Promise<PortholeNvmePage>;
}

interface PortholeX64JitHost {
  readonly stats: {
    compiled: number;
    executedBlocks: number;
    executedInstructions: number;
    traps: number;
    fallbackInstructions: number;
    cacheHits: number;
    cacheMisses: number;
    tailCalls: boolean;
  };
  exeSha256: string | null;
  cache: PortholeJitCache | null;
  initCache(): Promise<void>;
  runSlice(maxInstructions: number): Promise<string>;
  drainPending(): Promise<void>;
  flushCache(): Promise<void>;
}

interface PortholePlatformGlobal {
  X64JitHost: new (
    emulator: import("./contracts").WasmEmulatorBindings,
    binding: object,
    options: { enabled: boolean; memory: WebAssembly.Memory; cache?: PortholeJitCache },
  ) => PortholeX64JitHost;
  NvmeVfs: new (options?: { logger?: (message: string) => void }) => PortholeNvmeVfs;
}

interface Window {
  Porthole?: PortholePlatformGlobal;
}

declare module "@porthole/x64-jit-host";
declare module "@porthole/x64-nvme-vfs";
