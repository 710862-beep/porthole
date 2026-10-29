import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadScripts } from './helpers.mjs';

const require = createRequire(import.meta.url);
const P = loadScripts('porthole-linker', 'vfs', 'shim-kernel32', 'retrowin32-backend');
require('../../vfs-persist.js');
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ✓', name); };

console.log('\n[stress / memória]');
const kernel = new P.Kernel32Shim({ tracer: new P.ApiTracer() });
const allocations = [];
for (let i = 0; i < 96; i += 1) {
  const size = 4096 + (i % 7) * 137;
  const pointer = kernel.VirtualAlloc(0, size, 0x1000, 4);
  assert.ok(pointer > 0);
  const bytes = new Uint8Array(size);
  for (let j = 0; j < bytes.length; j += 1) bytes[j] = (i + j) & 0xff;
  kernel.writeMemory(pointer, bytes);
  allocations.push({ pointer, bytes });
}
for (const { pointer, bytes } of allocations) {
  const read = kernel.readMemory(pointer, bytes.byteLength);
  assert.equal(read[0], bytes[0]);
  assert.equal(read[read.length - 1], bytes[bytes.length - 1]);
  assert.equal(kernel.VirtualFree(pointer), true);
}
assert.equal(kernel.allocations.size, 0);
checks += 1; console.log('  ✓ 96 blocos variados preservam bytes e liberam todas as alocações');

console.log('\n[stress / VFS concorrente]');
class DelayedVFS {
  constructor() { this.isMapped = true; this.files = new Map(); this.active = 0; this.maxActive = 0; }
  getInfo() { return { persistent: true, mapped: true }; }
  key(path) { return P.VFSUtils.normalizePath(path).key; }
  async readFile(path) { const bytes = this.files.get(this.key(path)); if (!bytes) { const e = new Error('missing'); e.code = 'NOT_FOUND'; throw e; } return bytes.slice().buffer; }
  async writeFile(path, data) {
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    const bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength).slice();
    await new Promise((resolve) => setTimeout(resolve, bytes[0] % 3));
    this.files.set(this.key(path), bytes);
    this.active -= 1;
    return { persistent: true, bytes: bytes.byteLength };
  }
  async exists(path) { return this.files.has(this.key(path)); }
  async listDirectory() { return []; }
}
const host = new DelayedVFS();
const vfs = new P.VFSPersistence({ vfs: host });
const writes = [];
for (let i = 0; i < 64; i += 1) writes.push(vfs.writeFile(`C:\\Stress\\file-${i}.bin`, new Uint8Array([i, i + 1])));
for (let i = 0; i < 24; i += 1) writes.push(vfs.writeFile('C:\\Stress\\same.bin', new Uint8Array([i])));
await Promise.all(writes);
await vfs.flush();
assert.equal(host.files.size, 65);
assert.equal(new Uint8Array(await host.readFile('C:\\Stress\\same.bin'))[0], 23);
for (let i = 0; i < 64; i += 1) assert.deepEqual(Array.from(new Uint8Array(await host.readFile(`C:\\Stress\\file-${i}.bin`))), [i, i + 1]);
assert.equal(host.maxActive > 1, true);
assert.equal(vfs.getInfo().pendingWrites, 0);
checks += 1; console.log('  ✓ 88 escritas/65 arquivos convergem sem perda e com ordem por chave');

console.log('\n[stress / processos Wasm independentes; não threads Win32]');
const wasm = fs.readFileSync('vendor/retrowin32/retrowin32.wasm');
const hello = fs.readFileSync('vendor/retrowin32/fixtures/hello.exe');
const processes = [];
for (let i = 0; i < 4; i += 1) {
  const backend = new P.Retrowin32Backend({ wasmBytes: wasm });
  processes.push(await backend.createProcess({ path: `C:\\Stress\\hello-${i}.exe`, bytes: hello, preload: false }));
}
for (const process of processes) process.start();
const results = await Promise.all(processes.map((process) => process.done));
assert.ok(results.every((result) => result.status === 'exited' && result.exitCode === 0 && result.stdout === 'Hello, world!\n' && result.instructions === 57));
checks += 1; console.log('  ✓ quatro processos x86/Wasm concorrentes mantêm stdout/exit isolados');

console.log(`\nstress: ${checks} verificações concluídas.`);
