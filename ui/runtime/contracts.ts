/*
 * UI <-> runtime contracts for the Porthole shell.
 *
 * PROVENANCE: `WasmEmulatorBindings` below mirrors the ACTUAL wasm-bindgen exports of
 * rust/porthole-x64-wasm/src/lib.rs (consumed today by js/x64-app.js). `EmulatorRuntime`
 * is the UI-facing abstraction the shell should depend on; `js/x64-app.js` is its current
 * de-facto implementation inside x64.html. When the runtime is lifted out of x64.html,
 * implement EmulatorRuntime over WasmEmulatorBindings + the storage layer and keep this
 * file as the single source of truth. Nothing in ui/ may import beyond these shapes
 * (ARCHITECTURE.md rule 3).
 *
 * Frame authority rule: the only pixels a UI may call "the frame" come from
 * guest_frame_rgba() after a guest SDL_RenderPresent (presented_frames() > 0).
 */

// ---------------------------------------------------------------------------
// Layer 0: raw wasm-bindgen surface (subset relevant to UI/runtime work)
// ---------------------------------------------------------------------------
export interface WasmEmulatorBindings {
  // construction: new BrowserX64Emulator(maxResidentPages)
  load_pe(exe: Uint8Array): string;                    // JSON load report
  set_exe_path(path: string): void;
  set_command_line(cmd: string): void;
  vfs_mkdir(path: string): void;
  vfs_insert(path: string, bytes: Uint8Array): void;
  // run loop: "next" | "exit:<code>" | "fault:<msg>" | "page-fault:<addr>" | "halt"
  run_slice(budget: number): string;
  drain_evicted_pages(): Uint8Array;                   // [u64 base][4096 bytes]*
  supply_page(pageBase: bigint, bytes: Uint8Array): void;
  set_max_resident_pages(pages: number): void;
  resident_pages(): number;
  telemetry_json(): string;
  instructions_executed(): number;
  rip(): bigint;
  last_error(): number;
  take_console(): string;
  unimplemented_symbols(): string;                     // fail-closed evidence channel
  hle_histogram(max: number): string;
  fault_snapshot(): string;
  // SDL-path frame evidence (Gate 2)
  presented_frames(): number;
  frame_checksum(): string;                            // fnv1a64:<16hex> or ""
  guest_frame_rgba(): Uint8Array;                      // tight RGBA8, guest-composed
  guest_frame_width(): number;
  guest_frame_height(): number;
  // native-resolution measurement tap (Wine-reference comparison; not a presented frame)
  guest_native_frame_rgba(): Uint8Array;
  guest_native_frame_width(): number;
  guest_native_frame_height(): number;
  guest_native_frames(): number;
  native_frame_checksum(): string;
}

// ---------------------------------------------------------------------------
// Layer 1: UI-facing runtime (what components code against)
// ---------------------------------------------------------------------------
export type ProcessHandle = string;                    // opaque id from the runtime
export type EmulatorState =
  | "idle" | "loading" | "running" | "paused"
  | "page-fault-wait"                                  // suspended on host storage I/O
  | "exited" | "faulted";
export type VirtualKey = string;                       // e.g. "KeyW", "ArrowUp", "Enter"
export type KeyState = "down" | "up";
export type MouseButton = 0 | 1 | 2;

export interface EmulatorRuntime {
  loadExecutable(path: string): Promise<ProcessHandle>;
  launch(handle: ProcessHandle): Promise<void>;
  pause(handle: ProcessHandle): Promise<void>;
  terminate(handle: ProcessHandle): Promise<void>;

  onStateChange(callback: (state: EmulatorState) => void): void;
  getState(): EmulatorState;

  // Input is NOT implemented in the core yet (KI-04): send* are accepted by the shell
  // and counted, and become real when the SDL/Win32 event queues land. UI must not
  // claim gameplay until then.
  sendKeyEvent(key: VirtualKey, state: KeyState): void;
  sendMouseEvent(button: MouseButton, x: number, y: number): void;

  // ImageData today (canvas 2D). GPUTexture once a GPU renderer owns scanout.
  getFramebuffer(): ImageData | null;
  onFrameReady(callback: () => void): void;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
export type AppCategoryId = "games" | "utilities" | "system";
export interface AppCategory { id: AppCategoryId; label: string }
export interface GameMetadata {
  appId: string;
  title: string;
  kind: "game" | "utility" | "system";
  category: AppCategoryId;                             // derived from kind today
  exePath: string;                                     // guest path, e.g. C:\Game\...
  sha256?: string;                                     // pinned identity when known
  status: "installed" | "not-installed";
  evidence?: string;                                   // e.g. "Gate 2 PASS — 2664 gametics"
}

export interface GameStoreMode {
  listGames(): GameMetadata[];
  installGame(source: string): Promise<void>;
  launchGame(appId: string): Promise<void>;           // switches shell to Desktop mode
  uninstallGame(appId: string): Promise<void>;        // behind a Yes/No dialog
}

export type WindowHandle = string;
export interface DesktopMode {
  createWindow(process: ProcessHandle): WindowHandle;
  focusWindow(handle: WindowHandle): void;
  minimizeWindow(handle: WindowHandle): void;
  closeWindow(handle: WindowHandle): void;
  showTaskView(): void;                               // top-left hot corner / button
  hideTaskView(): void;
  getCategories(): AppCategory[];
  getAppsInCategory(category: string): GameMetadata[];
}

// ---------------------------------------------------------------------------
// Storage backend selection (Gate 4 will fill the facts per-device)
// ---------------------------------------------------------------------------
export type StorageBackendId = "file-system-access" | "opfs" | "memory";
export interface StorageCapability {
  backend: StorageBackendId;
  available: boolean;
  detail: string;                                     // verbatim error when blocked
}
export interface StorageSelector {
  detect(): Promise<StorageCapability[]>;
  select(backend: StorageBackendId): Promise<void>;   // persisted (localStorage today)
  selected(): StorageBackendId;
}

// ---------------------------------------------------------------------------
// Dialogs (custom modal; never window.confirm in product code paths)
// ---------------------------------------------------------------------------
export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;                              // default "Yes"
  cancelLabel?: string;                               // default "No"
  danger?: boolean;
}
export interface DialogService {
  confirm(opts: ConfirmOptions): Promise<boolean>;    // Esc/backdrop => false
}
