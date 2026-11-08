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
  load_pe(exe: Uint8Array): string;                    // JSON PE load report
  set_exe_path(path: string): void;
  set_command_line(cmd: string): void;
  set_environment_variable(name: string, value: string): boolean;
  vfs_mkdir(path: string): void;
  vfs_insert(path: string, bytes: Uint8Array): void;
  vfs_read(path: string): Uint8Array | undefined;
  // run loop: "next" | "exit:<code>" | "fault:<msg>" | "page-fault:<addr>" | "modal" | "halt"
  run_slice(budget: number): string;
  drain_evicted_pages(): Uint8Array;                   // [u64 base][4096 bytes]*
  supply_page(pageBase: bigint, bytes: Uint8Array): void;
  set_max_resident_pages(pages: number): void;
  resident_pages(): number;
  telemetry_json(): string;
  instructions_executed(): number;
  rip(): bigint;
  last_error(): number;
  status_text(): string;
  take_console(): string;
  unimplemented_symbols(): string;                     // fail-closed evidence channel
  hle_histogram(max: number): string;
  fault_snapshot(): string;
  aot_compile_text(): number;
  aot_stats_json(): string;
  set_jit_enabled(enabled: boolean): void;
  set_jit_validate_mode(mode: number): void;
  set_jit_tail_calls(enabled: boolean): void;
  jit_artifacts(): number;
  jit_pending_count(): number;
  jit_pending_meta(index: number): string;
  jit_pending_wasm(index: number): Uint8Array;
  jit_clear_pending(): void;
  jit_enter_block(): string;
  jit_active_wasm(): Uint8Array;
  jit_commit_block(): string;
  jit_abort_block(): void;
  jit_import_cached(
    entryRip: bigint,
    pageEpoch: number,
    byteLen: number,
    instructionCount: number,
    endsWithRet: boolean,
    hasStores: boolean,
    hasSimd: boolean,
    selfLoop: boolean,
    codeHash: bigint,
    wasmBytes: Uint8Array,
  ): boolean;
  jit_resolve_page(address: bigint, write: number): number;
  jit_clear_mem_fault(): void;
  jit_mem_fault(): number;
  // SDL-path frame evidence (Gate 2): this is authoritative for guest-presented SDL frames.
  presented_frames(): number;
  frame_checksum(): string;                            // fnv1a64:<16hex> or ""
  guest_frame_rgba(): Uint8Array;                      // tight RGBA8, guest-composed
  guest_frame_width(): number;
  guest_frame_height(): number;
  // Native-resolution measurement tap (Wine-reference comparison; not a presented frame).
  guest_native_frame_rgba(): Uint8Array;
  guest_native_frame_width(): number;
  guest_native_frame_height(): number;
  guest_native_frames(): number;
  native_frame_checksum(): string;
  // D3D12 HLE scanout path used by js/x64-app.js for native Windows workloads.
  frames_presented(): number;
  take_frame(): Uint8Array | undefined;
  frame_width(): number;
  frame_height(): number;
  inject_mouse_move(x: number, y: number): void;
  set_virtual_input_profile(enabled: boolean): void;
  modal_request(): string;
  modal_respond(result: number): boolean;
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
  loadExecutable(path: string, argumentsLine?: string): Promise<ProcessHandle>;
  /** Imports user-selected files into the mounted C:\\Game folder. */
  importFiles?(files: readonly File[]): Promise<string[]>;
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
export type StoreCategoryId =
  | AppCategoryId
  | "development"
  | "browsers"
  | "media"
  | "creativity"
  | "productivity"
  | "communications";
export interface AppCategory { id: AppCategoryId; label: string }
export interface GameMetadata {
  appId: string;
  title: string;
  kind: "game" | "utility" | "system";
  category: StoreCategoryId;
  exePath: string;                                     // guest path, e.g. C:\Game\...
  sha256?: string;                                     // pinned identity when known
  launchArguments?: string;
  status: "in-library" | "not-in-library";
  evidence?: string;                                   // e.g. "Gate 2 PASS — 2664 gametics"
}

export interface GameLibrary {
  listGames(): GameMetadata[];
  addToLibrary(appId: string): Promise<void>;
  removeFromLibrary(appId: string): Promise<void>;
  isInLibrary(appId: string): boolean;
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
