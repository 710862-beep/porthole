/*
 * retrowin32 generated Wasm binding — Apache-2.0.
 * Source: evmar/retrowin32, pages @ eea2a62dad509d0e4bbde871abe88e483fbf4764.
 * Extracted from glue/pkg/glue.js; Porthole adds named exports and an explicit headless clock adapter.
 * See README.md and LICENSE in this directory. No upstream UI is included.
 */
// glue/pkg/glue.js
var wasm;
var cachedTextDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }) : { decode: () => {
  throw Error("TextDecoder not available");
} };
if (typeof TextDecoder !== "undefined") {
  cachedTextDecoder.decode();
}
var cachedUint8Memory0 = null;
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
function isLikeNone(x2) {
  return x2 === void 0 || x2 === null;
}
var cachedFloat64Memory0 = null;
function getFloat64Memory0() {
  if (cachedFloat64Memory0 === null || cachedFloat64Memory0.byteLength === 0) {
    cachedFloat64Memory0 = new Float64Array(wasm.memory.buffer);
  }
  return cachedFloat64Memory0;
}
var cachedInt32Memory0 = null;
function getInt32Memory0() {
  if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
    cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
  }
  return cachedInt32Memory0;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i2 = 1; i2 < length; i2++) {
      debug += ", " + debugString(val[i2]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_2) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder("utf-8") : { encode: () => {
  throw Error("TextEncoder not available");
} };
var encodeString = typeof cachedTextEncoder.encodeInto === "function" ? function(arg, view) {
  return cachedTextEncoder.encodeInto(arg, view);
} : function(arg, view) {
  const buf = cachedTextEncoder.encode(arg);
  view.set(buf);
  return {
    read: arg.length,
    written: buf.length
  };
};
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8Memory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8Memory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127)
      break;
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
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_export_2.set(idx, obj);
  return idx;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8Memory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_2.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
function new_emulator(host, cmdline) {
  const ptr0 = passStringToWasm0(cmdline, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.new_emulator(host, ptr0, len0);
  return Emulator.__wrap(ret);
}
function handleError(f2, args) {
  try {
    return f2.apply(this, args);
  } catch (e2) {
    const idx = addToExternrefTable0(e2);
    wasm.__wbindgen_exn_store(idx);
  }
}
var cachedUint8ClampedMemory0 = null;
function getUint8ClampedMemory0() {
  if (cachedUint8ClampedMemory0 === null || cachedUint8ClampedMemory0.byteLength === 0) {
    cachedUint8ClampedMemory0 = new Uint8ClampedArray(wasm.memory.buffer);
  }
  return cachedUint8ClampedMemory0;
}
function getClampedArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ClampedMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var Status = Object.freeze({ Running: 0, "0": "Running", Blocked: 1, "1": "Blocked", Error: 2, "2": "Error", DebugBreak: 3, "3": "DebugBreak", Exit: 4, "4": "Exit" });
var EmulatorFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_emulator_free(ptr >>> 0));
var Emulator = class {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(Emulator.prototype);
    obj.__wbg_ptr = ptr;
    EmulatorFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    EmulatorFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_emulator_free(ptr);
  }
  load_exe(name, buf, relocate) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
      const len0 = WASM_VECTOR_LEN;
      const ptr1 = passArray8ToWasm0(buf, wasm.__wbindgen_malloc);
      const len1 = WASM_VECTOR_LEN;
      wasm.emulator_load_exe(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, relocate);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      if (r1) {
        throw takeFromExternrefTable0(r0);
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  labels() {
    let deferred2_0;
    let deferred2_1;
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.emulator_labels(retptr, this.__wbg_ptr);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      var r3 = getInt32Memory0()[retptr / 4 + 3];
      var ptr1 = r0;
      var len1 = r1;
      if (r3) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(r2);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
  }
  memory() {
    const ret = wasm.emulator_memory(this.__wbg_ptr);
    return ret;
  }
  get esp() {
    const ret = wasm.emulator_esp(this.__wbg_ptr);
    return ret >>> 0;
  }
  get eip() {
    const ret = wasm.emulator_eip(this.__wbg_ptr);
    return ret >>> 0;
  }
  get exit_code() {
    const ret = wasm.emulator_exit_code(this.__wbg_ptr);
    return ret >>> 0;
  }
  regs() {
    const ret = wasm.emulator_regs(this.__wbg_ptr);
    return ret;
  }
  get instr_count() {
    const ret = wasm.emulator_instr_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  disassemble_json(addr, limit) {
    let deferred1_0;
    let deferred1_1;
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.emulator_disassemble_json(retptr, this.__wbg_ptr, addr, limit);
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
  unblock() {
    wasm.emulator_unblock(this.__wbg_ptr);
  }
  run(count) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.emulator_run(retptr, this.__wbg_ptr, count);
      var r0 = getInt32Memory0()[retptr / 4 + 0];
      var r1 = getInt32Memory0()[retptr / 4 + 1];
      var r2 = getInt32Memory0()[retptr / 4 + 2];
      if (r2) {
        throw takeFromExternrefTable0(r1);
      }
      return r0;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }
  breakpoint_add(addr) {
    wasm.emulator_breakpoint_add(this.__wbg_ptr, addr);
  }
  breakpoint_clear(addr) {
    wasm.emulator_breakpoint_clear(this.__wbg_ptr, addr);
  }
  mappings_json() {
    let deferred1_0;
    let deferred1_1;
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
      wasm.emulator_mappings_json(retptr, this.__wbg_ptr);
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
  poke(addr, value) {
    wasm.emulator_poke(this.__wbg_ptr, addr, value);
  }
  set_tracing_scheme(scheme) {
    const ptr0 = passStringToWasm0(scheme, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.emulator_set_tracing_scheme(this.__wbg_ptr, ptr0, len0);
  }
};
var FileOptionsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_fileoptions_free(ptr >>> 0));
var FileOptions = class {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(FileOptions.prototype);
    obj.__wbg_ptr = ptr;
    FileOptionsFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    FileOptionsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_fileoptions_free(ptr);
  }
  get read() {
    const ret = wasm.__wbg_get_fileoptions_read(this.__wbg_ptr);
    return ret !== 0;
  }
  set read(arg0) {
    wasm.__wbg_set_fileoptions_read(this.__wbg_ptr, arg0);
  }
  get write() {
    const ret = wasm.__wbg_get_fileoptions_write(this.__wbg_ptr);
    return ret !== 0;
  }
  set write(arg0) {
    wasm.__wbg_set_fileoptions_write(this.__wbg_ptr, arg0);
  }
  get truncate() {
    const ret = wasm.__wbg_get_fileoptions_truncate(this.__wbg_ptr);
    return ret !== 0;
  }
  set truncate(arg0) {
    wasm.__wbg_set_fileoptions_truncate(this.__wbg_ptr, arg0);
  }
  get create() {
    const ret = wasm.__wbg_get_fileoptions_create(this.__wbg_ptr);
    return ret !== 0;
  }
  set create(arg0) {
    wasm.__wbg_set_fileoptions_create(this.__wbg_ptr, arg0);
  }
  get create_new() {
    const ret = wasm.__wbg_get_fileoptions_create_new(this.__wbg_ptr);
    return ret !== 0;
  }
  set create_new(arg0) {
    wasm.__wbg_set_fileoptions_create_new(this.__wbg_ptr, arg0);
  }
};
var SurfaceOptionsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_surfaceoptions_free(ptr >>> 0));
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e2) {
        if (module.headers.get("Content-Type") != "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e2);
        } else {
          throw e2;
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
  imports.wbg.__wbg_read_ca96830ec9aacdcf = function(arg0, arg1, arg2) {
    const ret = arg0.read(getArrayU8FromWasm0(arg1, arg2));
    return ret;
  };
  imports.wbg.__wbg_seek_c5471dc2ba4d64bc = function(arg0, arg1) {
    const ret = arg0.seek(arg1 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_write_3b537d4aeda328c0 = function(arg0, arg1, arg2) {
    const ret = arg0.write(getArrayU8FromWasm0(arg1, arg2));
    return ret;
  };
  imports.wbg.__wbg_newwithu8clampedarray_ae824147b27925fc = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = new ImageData(getClampedArrayU8FromWasm0(arg0, arg1), arg2 >>> 0);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_putImageData_044c08ad889366e1 = function() {
    return handleError(function(arg0, arg1, arg2, arg3) {
      arg0.putImageData(arg1, arg2, arg3);
    }, arguments);
  };
  imports.wbg.__wbg_drawImage_26ad546f3bb64a22 = function() {
    return handleError(function(arg0, arg1, arg2, arg3) {
      arg0.drawImage(arg1, arg2, arg3);
    }, arguments);
  };
  imports.wbg.__wbg_drawImage_5a754349d9fbf4a6 = function() {
    return handleError(function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9) {
      arg0.drawImage(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }, arguments);
  };
  imports.wbg.__wbg_settitle_b48ee927b9814f5c = function(arg0, arg1, arg2) {
    arg0.title = getStringFromWasm0(arg1, arg2);
  };
  imports.wbg.__wbg_setsize_7bcb3132fd38238f = function(arg0, arg1, arg2) {
    arg0.set_size(arg1 >>> 0, arg2 >>> 0);
  };
  imports.wbg.__wbg_info_2551d10805917111 = function(arg0) {
    const ret = arg0.info();
    return ret;
  };
  imports.wbg.__wbg_instanceof_Window_f401953a2cf86220 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Window;
    } catch (_2) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_performance_3298a9628a5c8aa4 = function(arg0) {
    const ret = arg0.performance;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_now_4e659b3d15f470d9 = function(arg0) {
    const ret = arg0.now();
    return ret;
  };
  imports.wbg.__wbg_new0_7d84e5b2cd9fdc73 = function() {
    const ret = new Date();
    return ret;
  };
  imports.wbg.__wbg_getTime_2bc4375165f02d15 = function(arg0) {
    const ret = arg0.getTime();
    return ret;
  };
  imports.wbg.__wbindgen_number_new = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbg_new_cf3ec55744a78578 = function(arg0) {
    const ret = new Date(arg0);
    return ret;
  };
  imports.wbg.__wbg_getTimezoneOffset_38257122e236c190 = function(arg0) {
    const ret = arg0.getTimezoneOffset();
    return ret;
  };
  imports.wbg.__wbg_getevent_4f4de425a52104de = function(arg0) {
    const ret = arg0.get_event();
    return ret;
  };
  imports.wbg.__wbindgen_is_undefined = function(arg0) {
    const ret = arg0 === void 0;
    return ret;
  };
  imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbg_get_e3c254076557e348 = function() {
    return handleError(function(arg0, arg1) {
      const ret = Reflect.get(arg0, arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbindgen_number_get = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "number" ? obj : void 0;
    getFloat64Memory0()[arg0 / 8 + 1] = isLikeNone(ret) ? 0 : ret;
    getInt32Memory0()[arg0 / 4 + 0] = !isLikeNone(ret);
  };
  imports.wbg.__wbg_timeStamp_33be24162c74bf21 = function(arg0) {
    const ret = arg0.timeStamp;
    return ret;
  };
  imports.wbg.__wbg_type_c7f33162571befe7 = function(arg0, arg1) {
    const ret = arg1.type;
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
  };
  imports.wbg.__wbg_button_367cdc7303e3cf9b = function(arg0) {
    const ret = arg0.button;
    return ret;
  };
  imports.wbg.__wbg_offsetX_1a40c03298c0d8b6 = function(arg0) {
    const ret = arg0.offsetX;
    return ret;
  };
  imports.wbg.__wbg_offsetY_f75e8c25b9d9b679 = function(arg0) {
    const ret = arg0.offsetY;
    return ret;
  };
  imports.wbg.__wbg_ensuretimer_752ace6fb471cdd4 = function(arg0, arg1) {
    arg0.ensure_timer(arg1 >>> 0);
  };
  imports.wbg.__wbg_open_61490d64358619c7 = function(arg0, arg1, arg2, arg3) {
    const ret = arg0.open(getStringFromWasm0(arg1, arg2), FileOptions.__wrap(arg3));
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_stdout_e61c589931436d69 = function(arg0, arg1, arg2) {
    arg0.stdout(getArrayU8FromWasm0(arg1, arg2));
  };
  imports.wbg.__wbg_createwindow_79bbfe483866ee8c = function(arg0, arg1) {
    const ret = arg0.create_window(arg1 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_screen_0825c896804feac9 = function(arg0) {
    const ret = arg0.screen();
    return ret;
  };
  imports.wbg.__wbg_document_5100775d18896c16 = function(arg0) {
    const ret = arg0.document;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_createElement_8bae7856a4bb7411 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.createElement(getStringFromWasm0(arg1, arg2));
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_setwidth_080107476e633963 = function(arg0, arg1) {
    arg0.width = arg1 >>> 0;
  };
  imports.wbg.__wbg_setheight_dc240617639f1f51 = function(arg0, arg1) {
    arg0.height = arg1 >>> 0;
  };
  imports.wbg.__wbg_getContext_df50fa48a8876636 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.getContext(getStringFromWasm0(arg1, arg2));
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    }, arguments);
  };
  imports.wbg.__wbg_instanceof_CanvasRenderingContext2d_20bf99ccc051643b = function(arg0) {
    let result;
    try {
      result = arg0 instanceof CanvasRenderingContext2D;
    } catch (_2) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_setfillStyle_4de94b275f5761f2 = function(arg0, arg1) {
    arg0.fillStyle = arg1;
  };
  imports.wbg.__wbg_fillRect_b5c8166281bac9df = function(arg0, arg1, arg2, arg3, arg4) {
    arg0.fillRect(arg1, arg2, arg3, arg4);
  };
  imports.wbg.__wbg_fill_7f376d2e52c3054e = function(arg0) {
    arg0.fill();
  };
  imports.wbg.__wbindgen_error_new = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbindgen_memory = function() {
    const ret = wasm.memory;
    return ret;
  };
  imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {
    const ret = arg0.buffer;
    return ret;
  };
  imports.wbg.__wbg_byteLength_2e8dcbbe54bdad62 = function(arg0) {
    const ret = arg0.byteLength;
    return ret;
  };
  imports.wbg.__wbg_new_6308304d72aede55 = function(arg0, arg1, arg2) {
    const ret = new DataView(arg0, arg1 >>> 0, arg2 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_parse_66d1801634e099ac = function() {
    return handleError(function(arg0, arg1) {
      const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_log_21bd4d15c3d236fe = function(arg0, arg1, arg2, arg3) {
    let deferred0_0;
    let deferred0_1;
    try {
      deferred0_0 = arg2;
      deferred0_1 = arg3;
      arg0.log(arg1, getStringFromWasm0(arg2, arg3));
    } finally {
      wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
    }
  };
  imports.wbg.__wbg_self_ce0dbfc45cf2f5be = function() {
    return handleError(function() {
      const ret = self.self;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_window_c6fb939a7f436783 = function() {
    return handleError(function() {
      const ret = window.window;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_globalThis_d1e6af4856ba331b = function() {
    return handleError(function() {
      const ret = globalThis.globalThis;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_global_207b558942527489 = function() {
    return handleError(function() {
      const ret = global.global;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_newnoargs_e258087cd0daa0ea = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_call_27c0f87801dedf93 = function() {
    return handleError(function(arg0, arg1) {
      const ret = arg0.call(arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbindgen_debug_string = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getInt32Memory0()[arg0 / 4 + 1] = len1;
    getInt32Memory0()[arg0 / 4 + 0] = ptr1;
  };
  imports.wbg.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_2;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
  };
  return imports;
}
function __wbg_init_memory(imports, maybe_memory) {
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedFloat64Memory0 = null;
  cachedInt32Memory0 = null;
  cachedUint8Memory0 = null;
  cachedUint8ClampedMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_init(input, options = {}) {
  if (wasm !== void 0)
    return wasm;
  if (typeof input === "undefined") {
    input = new URL("glue_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  // The pinned Rust Host::ticks requires web_sys::Window just to read
  // performance.now(). In headless Node supply ONLY that clock contract.
  // No global Window/DOM spoof; graphical APIs still require a real DOM.
  if (options.headlessClock) {
    const clock = { performance: { now: options.headlessClock } };
    imports.wbg.__wbg_globalThis_d1e6af4856ba331b = () => clock;
    const isWindow = imports.wbg.__wbg_instanceof_Window_f401953a2cf86220;
    imports.wbg.__wbg_instanceof_Window_f401953a2cf86220 = value => value === clock || isWindow(value);
  }
  if (typeof input === "string" || typeof Request === "function" && input instanceof Request || typeof URL === "function" && input instanceof URL) {
    input = fetch(input);
  }
  __wbg_init_memory(imports);
  const { instance, module } = await __wbg_load(await input, imports);
  return __wbg_finalize_init(instance, module);
}
var glue_default = __wbg_init;

export { glue_default as initRetrowin32, new_emulator as createRetrowin32Emulator, Status as Retrowin32Status };
