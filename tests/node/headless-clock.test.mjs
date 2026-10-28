import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScripts } from './helpers.mjs';
const P = loadScripts('vfs', 'porthole-linker', 'retrowin32-backend');
const logs = [];
const backend = new P.Retrowin32Backend({ wasmBytes: fs.readFileSync('vendor/retrowin32/retrowin32.wasm'), tracer: { log(scope, msg) { logs.push(String(msg)); } } });
// The clock bridge must not mutate the Node global or claim a graphical DOM.
const previousWindow = globalThis.window;
const module = await backend._instantiate.call({ ...backend, wasmModule: await WebAssembly.compile(fs.readFileSync('vendor/retrowin32/retrowin32.wasm')), moduleURL: backend.moduleURL, instanceCount: 0 });
assert.equal(typeof module.createRetrowin32Emulator, 'function');
assert.equal(globalThis.window, previousWindow);
console.log('headless-clock: 2 verificações concluídas.');
