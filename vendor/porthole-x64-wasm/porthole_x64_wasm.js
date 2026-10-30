let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8Memory0 = null;

function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

const heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

let heap_next = heap.length;

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function getObject(idx) { return heap[idx]; }

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8Memory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8Memory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8Memory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

let cachedInt32Memory0 = null;

function getInt32Memory0() {
    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory0;
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8Memory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedUint32Memory0 = null;

function getUint32Memory0() {
    if (cachedUint32Memory0 === null || cachedUint32Memory0.byteLength === 0) {
        cachedUint32Memory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32Memory0;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    const mem = getUint32Memory0();
    for (let i = 0; i < array.length; i++) {
        mem[ptr / 4 + i] = addHeapObject(array[i]);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

const BrowserX64EmulatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_browserx64emulator_free(ptr >>> 0));
/**
* Phase 5 driver: owns the Wasm x86-64 core, VMM, HLE kernel and JIT cache, and exposes a
* slice-based execution API that a browser (or a Node conformance harness) pumps from JS.
*/
export class BrowserX64Emulator {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BrowserX64EmulatorFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_browserx64emulator_free(ptr);
    }
    /**
    * @param {number} max_resident_pages
    */
    constructor(max_resident_pages) {
        const ret = wasm.browserx64emulator_new(max_resident_pages);
        this.__wbg_ptr = ret >>> 0;
        return this;
    }
    /**
    * @param {string} path
    * @param {Uint8Array} bytes
    */
    vfs_insert(path, bytes) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_vfs_insert(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
    * @param {string} path
    */
    vfs_mkdir(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_vfs_mkdir(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @param {string} path
    * @returns {Uint8Array | undefined}
    */
    vfs_read(path) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.browserx64emulator_vfs_read(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            let v2;
            if (r0 !== 0) {
                v2 = getArrayU8FromWasm0(r0, r1).slice();
                wasm.__wbindgen_free(r0, r1 * 1, 1);
            }
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Sets the guest command line (`GetCommandLineA/W`, `argc`/`argv`), e.g.
    * `"kernel32_test.exe atom"` so a winetest binary runs a single subtest.
    * @param {string} line
    */
    set_command_line(line) {
        const ptr0 = passStringToWasm0(line, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_set_command_line(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * Records the guest-visible path of the loaded image for `GetModuleFileNameW(NULL, ...)`.
    * @param {string} path
    */
    set_exe_path(path) {
        const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_set_exe_path(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * @param {string} name
    * @param {string} value
    * @returns {boolean}
    */
    set_environment_variable(name, value) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browserx64emulator_set_environment_variable(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret !== 0;
    }
    /**
    * Maps a PE32+ (`0x8664`) image, resolves imports against the HLE thunk space, initializes
    * PEB/TEB/stack, and runs the AOT block compiler over `.text`.
    * @param {Uint8Array} bytes
    * @returns {string}
    */
    load_pe(bytes) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            wasm.browserx64emulator_load_pe(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var r2 = getInt32Memory0()[retptr / 4 + 2];
            var r3 = getInt32Memory0()[retptr / 4 + 3];
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
    * Executes up to `max_instructions` guest instructions. Returns a compact status string:
    * `next` (budget exhausted), `exit:<code>`, `fault:<message>`, `page-fault:<addr>` or `halt`.
    * @param {number} max_instructions
    * @returns {string}
    */
    run_slice(max_instructions) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_run_slice(retptr, this.__wbg_ptr, max_instructions);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Records up to `max_entries` execution events (instructions, HLE dispatches, upcall
    * transitions, page faults and stores inside the optional write watch).
    * Enables the torture runner's structured API audit. This is diagnostics, not an
    * execution mode: it never changes an HLE result or substitutes a test assertion.
    * @param {number} max_entries
    */
    enable_api_audit(max_entries) {
        wasm.browserx64emulator_enable_api_audit(this.__wbg_ptr, max_entries);
    }
    /**
    * Drains JSONL. `dropped` makes ring overflow visible instead of silently losing calls.
    * @returns {string}
    */
    take_api_audit() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_take_api_audit(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {number} max_entries
    */
    enable_trace(max_entries) {
        wasm.browserx64emulator_enable_trace(this.__wbg_ptr, max_entries);
    }
    /**
    * @returns {string}
    */
    take_trace() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_take_trace(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Keeps only trace lines containing one of `patterns`.
    *
    * The ring buffer is 260-1000 lines, but a winetest subtest issues tens of thousands of API
    * calls; filtering by symbol name (e.g. `MultiByteToWideChar`) keeps the *whole* run.
    * @param {(string)[]} patterns
    */
    set_trace_filter(patterns) {
        const ptr0 = passArrayJsValueToWasm0(patterns, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_set_trace_filter(this.__wbg_ptr, ptr0, len0);
    }
    /**
    * Full register + stack + page report for the current (or last) fault. Deliberately verbose:
    * it is the only state that survives a `run_slice` returning `fault:`.
    * @returns {string}
    */
    fault_snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_fault_snapshot(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * `Interface::Method=count` histogram of the COM calls the guest made.
    * @param {number} top
    * @returns {string}
    */
    com_histogram(top) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_com_histogram(retptr, this.__wbg_ptr, top);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * COM methods that reached the default arm and answered `E_NOTIMPL`.
    * @returns {string}
    */
    unimplemented_methods() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_unimplemented_methods(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * `symbol=count` histogram of the APIs the guest actually called.
    * @param {number} top
    * @returns {string}
    */
    hle_histogram(top) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_hle_histogram(retptr, this.__wbg_ptr, top);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Symbols the guest called that fell through to the "not implemented" default arm.
    * @returns {string}
    */
    unimplemented_symbols() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_unimplemented_symbols(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Keep only HLE (`H`/`U`/`R`/`E`) events in the trace ring buffer.
    *
    * A 22 000-instruction run overflows a 260-line buffer long before the interesting API call,
    * so the diagnostics lane can filter down to Win32 traffic and still see the whole run.
    * @param {boolean} on
    */
    set_hle_trace_only(on) {
        wasm.browserx64emulator_set_hle_trace_only(this.__wbg_ptr, on);
    }
    /**
    * @param {bigint} lo
    * @param {bigint} hi
    * @param {number} capacity
    */
    set_write_watch(lo, hi, capacity) {
        wasm.browserx64emulator_set_write_watch(this.__wbg_ptr, lo, hi, capacity);
    }
    /**
    * Adds an extra watched window (globals, heap head, ...) to the data breakpoint set.
    * @param {bigint} lo
    * @param {bigint} hi
    */
    add_write_watch(lo, hi) {
        wasm.browserx64emulator_add_write_watch(this.__wbg_ptr, lo, hi);
    }
    /**
    */
    clear_write_watch() {
        wasm.browserx64emulator_clear_write_watch(this.__wbg_ptr);
    }
    /**
    * Dumps `count` little-endian qwords starting at `addr`, used by the native tracer.
    * @param {bigint} addr
    * @param {number} count
    * @returns {string}
    */
    peek_qwords(addr, count) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_peek_qwords(retptr, this.__wbg_ptr, addr, count);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Pretty-prints one guest VA: mapping region, protection, residency, swap state and epoch.
    * @param {bigint} addr
    * @returns {string}
    */
    describe_address(addr) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_describe_address(retptr, this.__wbg_ptr, addr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {bigint}
    */
    stack_pointer() {
        const ret = wasm.browserx64emulator_stack_pointer(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {string}
    */
    register_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_register_json(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {bigint}
    */
    instructions_executed() {
        const ret = wasm.browserx64emulator_instructions_executed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {bigint}
    */
    rip() {
        const ret = wasm.browserx64emulator_rip(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {string}
    */
    status_text() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_status_text(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {string}
    */
    take_console() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_take_console(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @returns {bigint}
    */
    frames_presented() {
        const ret = wasm.browserx64emulator_frames_presented(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * Total frames the GUEST presented through the SDL path (Gate 2 accounting). This counter
    * advances only inside `SDL_RenderPresent`/`SDL_UpdateWindowSurface` on guest-issued draws;
    * there is no host-side increment and no host-authored pixels behind it.
    * @returns {bigint}
    */
    presented_frames() {
        const ret = wasm.browserx64emulator_presented_frames(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * Checksum of the last guest-presented SDL frame: FNV-1a/64 over `w|h|RGBA8` bytes,
    * formatted `fnv1a64:<16 hex>`. Empty until the guest presents a frame. The algorithm is
    * deliberately trivial so a reference renderer (same binary on real Wine/Windows) can
    * reproduce it byte-for-byte for the Gate 2 comparison.
    * @returns {string}
    */
    frame_checksum() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_frame_checksum(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Last guest-presented SDL frame (tight RGBA8) without consuming it.
    * @returns {Uint8Array}
    */
    guest_frame_rgba() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_guest_frame_rgba(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    guest_frame_width() {
        const ret = wasm.browserx64emulator_guest_frame_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    guest_frame_height() {
        const ret = wasm.browserx64emulator_guest_frame_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * Measurement tap: the guest's native-resolution SDL frame (tight RGBA8) as written into
    * its streaming texture, before any host scaling. Exists so the Gate 2 Wine reference can
    * compare byte-for-byte against the same binary's own screenshots (320x200 for Doom).
    * Not a presented frame; see presented_frames()/guest_frame_rgba() for that claim.
    * @returns {Uint8Array}
    */
    guest_native_frame_rgba() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_guest_native_frame_rgba(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    guest_native_frame_width() {
        const ret = wasm.browserx64emulator_guest_native_frame_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    guest_native_frame_height() {
        const ret = wasm.browserx64emulator_guest_native_frame_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {bigint}
    */
    guest_native_frames() {
        const ret = wasm.browserx64emulator_guest_native_frames(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * FNV-1a/64 over `w|h|RGBA8` of the native-frame tap (same algorithm as frame_checksum).
    * @returns {string}
    */
    native_frame_checksum() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_native_frame_checksum(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Returns the last presented swapchain frame as tightly packed RGBA8 (width/height are
    * retrievable through the accessors below).
    * @returns {Uint8Array | undefined}
    */
    take_frame() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_take_frame(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            let v1;
            if (r0 !== 0) {
                v1 = getArrayU8FromWasm0(r0, r1).slice();
                wasm.__wbindgen_free(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    frame_width() {
        const ret = wasm.browserx64emulator_frame_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    frame_height() {
        const ret = wasm.browserx64emulator_frame_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    resident_pages() {
        const ret = wasm.browserx64emulator_resident_pages(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {number}
    */
    swapped_pages() {
        const ret = wasm.browserx64emulator_swapped_pages(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {bigint}
    */
    pages_evicted() {
        const ret = wasm.browserx64emulator_pages_evicted(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {number}
    */
    jit_artifacts() {
        const ret = wasm.browserx64emulator_jit_artifacts(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @returns {bigint}
    */
    jit_modules_emitted() {
        const ret = wasm.browserx64emulator_jit_modules_emitted(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
    * @returns {number}
    */
    last_error() {
        const ret = wasm.browserx64emulator_last_error(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * Drains pages evicted from RAM that must be persisted to the NVMe swap shards.
    * Layout: repeated `[u64 page_base][4096 bytes]` records.
    * @returns {Uint8Array}
    */
    drain_evicted_pages() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_drain_evicted_pages(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * Supplies a page previously persisted on NVMe after a `page-fault:<addr>` status.
    * @param {bigint} page_base
    * @param {Uint8Array} bytes
    */
    supply_page(page_base, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.browserx64emulator_supply_page(this.__wbg_ptr, page_base, ptr0, len0);
    }
    /**
    * Changes the resident page budget (RAM LRU window).
    * @param {number} pages
    */
    set_max_resident_pages(pages) {
        wasm.browserx64emulator_set_max_resident_pages(this.__wbg_ptr, pages);
    }
    /**
    * Returns the pending host modal request JSON, or "" when none.
    * @returns {string}
    */
    modal_request() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_modal_request(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Host answers a modal; resumes the guest with the chosen button result.
    * @param {number} result
    * @returns {boolean}
    */
    modal_respond(result) {
        const ret = wasm.browserx64emulator_modal_respond(this.__wbg_ptr, result);
        return ret !== 0;
    }
    /**
    * Host-driven virtual mouse input (browser pointer events).
    * @param {number} x
    * @param {number} y
    */
    inject_mouse_move(x, y) {
        wasm.browserx64emulator_inject_mouse_move(this.__wbg_ptr, x, y);
    }
    /**
    * @param {boolean} on
    */
    set_jit_enabled(on) {
        wasm.browserx64emulator_set_jit_enabled(this.__wbg_ptr, on);
    }
    /**
    * @returns {number}
    */
    jit_pending_count() {
        const ret = wasm.browserx64emulator_jit_pending_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * @param {number} index
    * @returns {string}
    */
    jit_pending_meta(index) {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_jit_pending_meta(retptr, this.__wbg_ptr, index);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * @param {number} index
    * @returns {Uint8Array}
    */
    jit_pending_wasm(index) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_jit_pending_wasm(retptr, this.__wbg_ptr, index);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    */
    jit_clear_pending() {
        wasm.browserx64emulator_jit_clear_pending(this.__wbg_ptr);
    }
    /**
    * @returns {Uint8Array}
    */
    jit_active_wasm() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_jit_active_wasm(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_free(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
    * @returns {number}
    */
    jit_context_ptr() {
        const ret = wasm.browserx64emulator_jit_context_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
    * Copies GPRs into the shared context and arms the artifact at current RIP.
    * @returns {string}
    */
    jit_enter_block() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_jit_enter_block(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Atomically commits a completed host-executed Wasm block. On any epoch/entry mismatch the
    * block is discarded and the interpreter resumes at the unchanged RIP (safe SMC fallback).
    * @returns {string}
    */
    jit_commit_block() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_jit_commit_block(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
    * Drops a trapped active block without applying its register writes; the interpreter will
    * re-execute from the original RIP and reproduce the precise fault/page-fault.
    */
    jit_abort_block() {
        wasm.browserx64emulator_jit_abort_block(this.__wbg_ptr);
    }
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
    jit_import_cached(entry_rip, page_epoch, byte_len, insn_count, ends_with_ret, code_hash, wasm) {
        const ptr0 = passArray8ToWasm0(wasm, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.browserx64emulator_jit_import_cached(this.__wbg_ptr, entry_rip, page_epoch, byte_len, insn_count, ends_with_ret, code_hash, ptr0, len0);
        return ret !== 0;
    }
    /**
    * Instantaneous counters consumed by the browser telemetry panel.
    * @returns {string}
    */
    telemetry_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.browserx64emulator_telemetry_json(retptr, this.__wbg_ptr);
            var r0 = getInt32Memory0()[retptr / 4 + 0];
            var r1 = getInt32Memory0()[retptr / 4 + 1];
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
        const obj = getObject(arg1);
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getInt32Memory0()[arg0 / 4 + 1] = len1;
        getInt32Memory0()[arg0 / 4 + 0] = ptr1;
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };

    return imports;
}

function __wbg_init_memory(imports, maybe_memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedInt32Memory0 = null;
    cachedUint32Memory0 = null;
    cachedUint8Memory0 = null;


    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(input) {
    if (wasm !== undefined) return wasm;

    if (typeof input === 'undefined') {
        input = new URL('porthole_x64_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof input === 'string' || (typeof Request === 'function' && input instanceof Request) || (typeof URL === 'function' && input instanceof URL)) {
        input = fetch(input);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await input, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync }
export default __wbg_init;
