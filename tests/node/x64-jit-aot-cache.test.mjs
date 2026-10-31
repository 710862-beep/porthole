import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { X64JitHost } = require('../../js/x64-jit-host.js');
const wasmDir = process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm';
async function newCore() {
  const gluePath = path.resolve(wasmDir, 'porthole_x64_wasm.js');
  const wasmPath = path.resolve(wasmDir, 'porthole_x64_wasm_bg.wasm');
  if (!fs.existsSync(gluePath) || !fs.existsSync(wasmPath)) return null;
  const mod = await import(pathToFileURL(gluePath).href);
  const core = await mod.default(fs.readFileSync(wasmPath));
  return { emu: new mod.BrowserX64Emulator(8192), memory: core.memory, mod };
}
function pe64(code) {
  const b = Buffer.alloc(0x400);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80);
  const c = 0x84; b.writeUInt16LE(0x8664, c); b.writeUInt16LE(1, c + 2); b.writeUInt16LE(240, c + 16); b.writeUInt16LE(0x22, c + 18);
  const o = 0x98; b.writeUInt16LE(0x20b, o); b.writeUInt32LE(0x200, o + 4); b.writeUInt32LE(0x1000, o + 16); b.writeUInt32LE(0x1000, o + 20);
  b.writeBigUInt64LE(0x140000000n, o + 24); b.writeUInt32LE(0x1000, o + 32); b.writeUInt32LE(0x200, o + 36);
  b.writeUInt32LE(0x3000, o + 56); b.writeUInt32LE(0x200, o + 60); b.writeUInt16LE(3, o + 68); b.writeUInt32LE(16, o + 108);
  const s = 0x188; b.write('.text', s); b.writeUInt32LE(0x200, s + 8); b.writeUInt32LE(0x1000, s + 12); b.writeUInt32LE(0x200, s + 16); b.writeUInt32LE(0x200, s + 20); b.writeUInt32LE(0x60000020, s + 36);
  code.copy(b, 0x200); return b;
}

test('AOT .text scan populates a SHA-256 keyed cache that a fresh core reloads', async t => {
  const first = await newCore();
  if (!first || typeof first.emu.aot_compile_text !== 'function') { t.skip('core predates AOT .text scanning'); return; }
  // A few real blocks: entry loop, a branch target, and a ret.
  const code = Buffer.from([
    0x48, 0x83, 0xe9, 0x01, 0x75, 0xfa, 0xc3,
    0x90, 0x90, 0x48, 0x01, 0xd8, 0xc3,
  ]);
  const image = pe64(code);
  const sha = 'a'.repeat(64); // identity is supplied by the loader; archive keying is what we test
  const store = new Map();
  const cache = {
    async loadJitCache(key) { return store.get(key) || []; },
    async saveJitCache(key, entries) { store.set(key, entries.map(({ meta, wasmBytes }) => ({ meta, wasmBytes: new Uint8Array(wasmBytes) }))); },
  };
  first.emu.load_pe(image);
  const jit1 = new X64JitHost(first.emu, first.mod, { memory: first.memory, cache, exeSha256: sha });
  const blocks = first.emu.aot_compile_text();
  assert.ok(blocks > 0, `expected AOT blocks, got ${blocks}`);
  await jit1.drainPending();
  await jit1.flushCache();
  const stats = JSON.parse(first.emu.aot_stats_json());
  assert.ok(stats.wasmBytes > 0);
  assert.ok(store.has(sha), 'cache archive must be keyed by exe SHA-256');
  assert.ok(store.get(sha).length > 0);

  const second = await newCore();
  second.emu.load_pe(image);
  const jit2 = new X64JitHost(second.emu, second.mod, { memory: second.memory, cache, exeSha256: sha });
  await jit2.initCache();
  assert.ok(jit2.cacheTelemetry.hits > 0, `expected persistent cache hits, got ${JSON.stringify(jit2.cacheTelemetry)}`);
  assert.equal(jit2.stats.compileErrors, 0);
  // A cached RIP must not be recompiled by a second AOT pass.
  const again = second.emu.aot_compile_text();
  assert.equal(again, 0, 'AOT must skip RIPs already served from cache');
});
