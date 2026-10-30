/* tslint:disable */
/* eslint-disable */
/**
* Phase 5 driver: owns the Wasm x86-64 core, VMM, HLE kernel and JIT cache, and exposes a
* slice-based execution API that a browser (or a Node conformance harness) pumps from JS.
*/
export class BrowserX64Emulator {
  free(): void;
/**
* @param {number} max_resident_pages
*/
  constructor(max_resident_pages: number);
/**
* @param {string} path
* @param {Uint8Array} bytes
*/
  vfs_insert(path: string, bytes: Uint8Array): void;
/**
* @param {string} path
*/
  vfs_mkdir(path: string): void;
/**
* @param {string} path
* @returns {Uint8Array | undefined}
*/
  vfs_read(path: string): Uint8Array | undefined;
/**
* Sets the guest command line (`GetCommandLineA/W`, `argc`/`argv`), e.g.
* `"kernel32_test.exe atom"` so a winetest binary runs a single subtest.
* @param {string} line
*/
  set_command_line(line: string): void;
/**
* Records the guest-visible path of the loaded image for `GetModuleFileNameW(NULL, ...)`.
* @param {string} path
*/
  set_exe_path(path: string): void;
/**
* @param {string} name
* @param {string} value
* @returns {boolean}
*/
  set_environment_variable(name: string, value: string): boolean;
/**
* Maps a PE32+ (`0x8664`) image, resolves imports against the HLE thunk space, initializes
* PEB/TEB/stack, and runs the AOT block compiler over `.text`.
* @param {Uint8Array} bytes
* @returns {string}
*/
  load_pe(bytes: Uint8Array): string;
/**
* Executes up to `max_instructions` guest instructions. Returns a compact status string:
* `next` (budget exhausted), `exit:<code>`, `fault:<message>`, `page-fault:<addr>` or `halt`.
* @param {number} max_instructions
* @returns {string}
*/
  run_slice(max_instructions: number): string;
/**
* Records up to `max_entries` execution events (instructions, HLE dispatches, upcall
* transitions, page faults and stores inside the optional write watch).
* Enables the torture runner's structured API audit. This is diagnostics, not an
* execution mode: it never changes an HLE result or substitutes a test assertion.
* @param {number} max_entries
*/
  enable_api_audit(max_entries: number): void;
/**
* Drains JSONL. `dropped` makes ring overflow visible instead of silently losing calls.
* @returns {string}
*/
  take_api_audit(): string;
/**
* @param {number} max_entries
*/
  enable_trace(max_entries: number): void;
/**
* @returns {string}
*/
  take_trace(): string;
/**
* Keeps only trace lines containing one of `patterns`.
*
* The ring buffer is 260-1000 lines, but a winetest subtest issues tens of thousands of API
* calls; filtering by symbol name (e.g. `MultiByteToWideChar`) keeps the *whole* run.
* @param {(string)[]} patterns
*/
  set_trace_filter(patterns: (string)[]): void;
/**
* Full register + stack + page report for the current (or last) fault. Deliberately verbose:
* it is the only state that survives a `run_slice` returning `fault:`.
* @returns {string}
*/
  fault_snapshot(): string;
/**
* `Interface::Method=count` histogram of the COM calls the guest made.
* @param {number} top
* @returns {string}
*/
  com_histogram(top: number): string;
/**
* COM methods that reached the default arm and answered `E_NOTIMPL`.
* @returns {string}
*/
  unimplemented_methods(): string;
/**
* `symbol=count` histogram of the APIs the guest actually called.
* @param {number} top
* @returns {string}
*/
  hle_histogram(top: number): string;
/**
* Symbols the guest called that fell through to the "not implemented" default arm.
* @returns {string}
*/
  unimplemented_symbols(): string;
/**
* Keep only HLE (`H`/`U`/`R`/`E`) events in the trace ring buffer.
*
* A 22 000-instruction run overflows a 260-line buffer long before the interesting API call,
* so the diagnostics lane can filter down to Win32 traffic and still see the whole run.
* @param {boolean} on
*/
  set_hle_trace_only(on: boolean): void;
/**
* @param {bigint} lo
* @param {bigint} hi
* @param {number} capacity
*/
  set_write_watch(lo: bigint, hi: bigint, capacity: number): void;
/**
* Adds an extra watched window (globals, heap head, ...) to the data breakpoint set.
* @param {bigint} lo
* @param {bigint} hi
*/
  add_write_watch(lo: bigint, hi: bigint): void;
/**
*/
  clear_write_watch(): void;
/**
* Dumps `count` little-endian qwords starting at `addr`, used by the native tracer.
* @param {bigint} addr
* @param {number} count
* @returns {string}
*/
  peek_qwords(addr: bigint, count: number): string;
/**
* Pretty-prints one guest VA: mapping region, protection, residency, swap state and epoch.
* @param {bigint} addr
* @returns {string}
*/
  describe_address(addr: bigint): string;
/**
* @returns {bigint}
*/
  stack_pointer(): bigint;
/**
* @returns {string}
*/
  register_json(): string;
/**
* @returns {bigint}
*/
  instructions_executed(): bigint;
/**
* @returns {bigint}
*/
  rip(): bigint;
/**
* @returns {string}
*/
  status_text(): string;
/**
* @returns {string}
*/
  take_console(): string;
/**
* @returns {bigint}
*/
  frames_presented(): bigint;
/**
* Total frames the GUEST presented through the SDL path (Gate 2 accounting). This counter
* advances only inside `SDL_RenderPresent`/`SDL_UpdateWindowSurface` on guest-issued draws;
* there is no host-side increment and no host-authored pixels behind it.
* @returns {bigint}
*/
  presented_frames(): bigint;
/**
* Checksum of the last guest-presented SDL frame: FNV-1a/64 over `w|h|RGBA8` bytes,
* formatted `fnv1a64:<16 hex>`. Empty until the guest presents a frame. The algorithm is
* deliberately trivial so a reference renderer (same binary on real Wine/Windows) can
* reproduce it byte-for-byte for the Gate 2 comparison.
* @returns {string}
*/
  frame_checksum(): string;
/**
* Last guest-presented SDL frame (tight RGBA8) without consuming it.
* @returns {Uint8Array}
*/
  guest_frame_rgba(): Uint8Array;
/**
* @returns {number}
*/
  guest_frame_width(): number;
/**
* @returns {number}
*/
  guest_frame_height(): number;
/**
* Measurement tap: the guest's native-resolution SDL frame (tight RGBA8) as written into
* its streaming texture, before any host scaling. Exists so the Gate 2 Wine reference can
* compare byte-for-byte against the same binary's own screenshots (320x200 for Doom).
* Not a presented frame; see presented_frames()/guest_frame_rgba() for that claim.
* @returns {Uint8Array}
*/
  guest_native_frame_rgba(): Uint8Array;
/**
* @returns {number}
*/
  guest_native_frame_width(): number;
/**
* @returns {number}
*/
  guest_native_frame_height(): number;
/**
* @returns {bigint}
*/
  guest_native_frames(): bigint;
/**
* FNV-1a/64 over `w|h|RGBA8` of the native-frame tap (same algorithm as frame_checksum).
* @returns {string}
*/
  native_frame_checksum(): string;
/**
* Returns the last presented swapchain frame as tightly packed RGBA8 (width/height are
* retrievable through the accessors below).
* @returns {Uint8Array | undefined}
*/
  take_frame(): Uint8Array | undefined;
/**
* @returns {number}
*/
  frame_width(): number;
/**
* @returns {number}
*/
  frame_height(): number;
/**
* @returns {number}
*/
  resident_pages(): number;
/**
* @returns {number}
*/
  swapped_pages(): number;
/**
* @returns {bigint}
*/
  pages_evicted(): bigint;
/**
* @returns {number}
*/
  jit_artifacts(): number;
/**
* @returns {bigint}
*/
  jit_modules_emitted(): bigint;
/**
* @returns {number}
*/
  last_error(): number;
/**
* Drains pages evicted from RAM that must be persisted to the NVMe swap shards.
* Layout: repeated `[u64 page_base][4096 bytes]` records.
* @returns {Uint8Array}
*/
  drain_evicted_pages(): Uint8Array;
/**
* Supplies a page previously persisted on NVMe after a `page-fault:<addr>` status.
* @param {bigint} page_base
* @param {Uint8Array} bytes
*/
  supply_page(page_base: bigint, bytes: Uint8Array): void;
/**
* Changes the resident page budget (RAM LRU window).
* @param {number} pages
*/
  set_max_resident_pages(pages: number): void;
/**
* Returns the pending host modal request JSON, or "" when none.
* @returns {string}
*/
  modal_request(): string;
/**
* Host answers a modal; resumes the guest with the chosen button result.
* @param {number} result
* @returns {boolean}
*/
  modal_respond(result: number): boolean;
/**
* Host-driven virtual mouse input (browser pointer events).
* @param {number} x
* @param {number} y
*/
  inject_mouse_move(x: number, y: number): void;
/**
* @param {boolean} on
*/
  set_jit_enabled(on: boolean): void;
/**
* @returns {number}
*/
  jit_pending_count(): number;
/**
* @param {number} index
* @returns {string}
*/
  jit_pending_meta(index: number): string;
/**
* @param {number} index
* @returns {Uint8Array}
*/
  jit_pending_wasm(index: number): Uint8Array;
/**
*/
  jit_clear_pending(): void;
/**
* @returns {Uint8Array}
*/
  jit_active_wasm(): Uint8Array;
/**
* @returns {number}
*/
  jit_context_ptr(): number;
/**
* Copies GPRs into the shared context and arms the artifact at current RIP.
* @returns {string}
*/
  jit_enter_block(): string;
/**
* Atomically commits a completed host-executed Wasm block. On any epoch/entry mismatch the
* block is discarded and the interpreter resumes at the unchanged RIP (safe SMC fallback).
* @returns {string}
*/
  jit_commit_block(): string;
/**
* Drops a trapped active block without applying its register writes; the interpreter will
* re-execute from the original RIP and reproduce the precise fault/page-fault.
*/
  jit_abort_block(): void;
/**
* Imports a persisted artifact only after re-hashing the live guest bytes and epoch.
* @param {bigint} entry_rip
* @param {number} page_epoch
* @param {number} byte_len
* @param {number} insn_count
* @param {boolean} ends_with_ret
* @param {bigint} code_hash
* @param {Uint8Array} wasm
* @returns {boolean}
*/
  jit_import_cached(entry_rip: bigint, page_epoch: number, byte_len: number, insn_count: number, ends_with_ret: boolean, code_hash: bigint, wasm: Uint8Array): boolean;
/**
* Instantaneous counters consumed by the browser telemetry panel.
* @returns {string}
*/
  telemetry_json(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_browserx64emulator_free: (a: number) => void;
  readonly browserx64emulator_new: (a: number) => number;
  readonly browserx64emulator_vfs_insert: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly browserx64emulator_vfs_mkdir: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_vfs_read: (a: number, b: number, c: number, d: number) => void;
  readonly browserx64emulator_set_command_line: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_set_exe_path: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_set_environment_variable: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly browserx64emulator_load_pe: (a: number, b: number, c: number, d: number) => void;
  readonly browserx64emulator_run_slice: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_enable_api_audit: (a: number, b: number) => void;
  readonly browserx64emulator_take_api_audit: (a: number, b: number) => void;
  readonly browserx64emulator_enable_trace: (a: number, b: number) => void;
  readonly browserx64emulator_take_trace: (a: number, b: number) => void;
  readonly browserx64emulator_set_trace_filter: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_fault_snapshot: (a: number, b: number) => void;
  readonly browserx64emulator_com_histogram: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_unimplemented_methods: (a: number, b: number) => void;
  readonly browserx64emulator_hle_histogram: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_unimplemented_symbols: (a: number, b: number) => void;
  readonly browserx64emulator_set_hle_trace_only: (a: number, b: number) => void;
  readonly browserx64emulator_set_write_watch: (a: number, b: number, c: number, d: number) => void;
  readonly browserx64emulator_add_write_watch: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_clear_write_watch: (a: number) => void;
  readonly browserx64emulator_peek_qwords: (a: number, b: number, c: number, d: number) => void;
  readonly browserx64emulator_describe_address: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_stack_pointer: (a: number) => number;
  readonly browserx64emulator_register_json: (a: number, b: number) => void;
  readonly browserx64emulator_instructions_executed: (a: number) => number;
  readonly browserx64emulator_rip: (a: number) => number;
  readonly browserx64emulator_status_text: (a: number, b: number) => void;
  readonly browserx64emulator_take_console: (a: number, b: number) => void;
  readonly browserx64emulator_frames_presented: (a: number) => number;
  readonly browserx64emulator_presented_frames: (a: number) => number;
  readonly browserx64emulator_frame_checksum: (a: number, b: number) => void;
  readonly browserx64emulator_guest_frame_rgba: (a: number, b: number) => void;
  readonly browserx64emulator_guest_frame_width: (a: number) => number;
  readonly browserx64emulator_guest_frame_height: (a: number) => number;
  readonly browserx64emulator_guest_native_frame_rgba: (a: number, b: number) => void;
  readonly browserx64emulator_guest_native_frame_width: (a: number) => number;
  readonly browserx64emulator_guest_native_frame_height: (a: number) => number;
  readonly browserx64emulator_guest_native_frames: (a: number) => number;
  readonly browserx64emulator_native_frame_checksum: (a: number, b: number) => void;
  readonly browserx64emulator_take_frame: (a: number, b: number) => void;
  readonly browserx64emulator_frame_width: (a: number) => number;
  readonly browserx64emulator_frame_height: (a: number) => number;
  readonly browserx64emulator_resident_pages: (a: number) => number;
  readonly browserx64emulator_swapped_pages: (a: number) => number;
  readonly browserx64emulator_pages_evicted: (a: number) => number;
  readonly browserx64emulator_jit_artifacts: (a: number) => number;
  readonly browserx64emulator_jit_modules_emitted: (a: number) => number;
  readonly browserx64emulator_last_error: (a: number) => number;
  readonly browserx64emulator_drain_evicted_pages: (a: number, b: number) => void;
  readonly browserx64emulator_supply_page: (a: number, b: number, c: number, d: number) => void;
  readonly browserx64emulator_set_max_resident_pages: (a: number, b: number) => void;
  readonly browserx64emulator_modal_request: (a: number, b: number) => void;
  readonly browserx64emulator_modal_respond: (a: number, b: number) => number;
  readonly browserx64emulator_inject_mouse_move: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_set_jit_enabled: (a: number, b: number) => void;
  readonly browserx64emulator_jit_pending_count: (a: number) => number;
  readonly browserx64emulator_jit_pending_meta: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_jit_pending_wasm: (a: number, b: number, c: number) => void;
  readonly browserx64emulator_jit_clear_pending: (a: number) => void;
  readonly browserx64emulator_jit_active_wasm: (a: number, b: number) => void;
  readonly browserx64emulator_jit_context_ptr: (a: number) => number;
  readonly browserx64emulator_jit_enter_block: (a: number, b: number) => void;
  readonly browserx64emulator_jit_commit_block: (a: number, b: number) => void;
  readonly browserx64emulator_jit_abort_block: (a: number) => void;
  readonly browserx64emulator_jit_import_cached: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly browserx64emulator_telemetry_json: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
