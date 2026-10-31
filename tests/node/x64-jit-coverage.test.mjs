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
  return { emu: new mod.BrowserX64Emulator(8192), memory: core.memory };
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
async function run(code, jit) {
  const c = await newCore(); if (!c) return null;
  c.emu.load_pe(pe64(code)); c.emu.set_jit_enabled(jit); if (jit) c.emu.set_jit_validate(false);
  const host = jit ? new X64JitHost(c.emu, {}, { memory: c.memory }) : null;
  let status; let n = 0;
  do { status = host ? await host.runSlice(10000) : c.emu.run_slice(10000); n += 1; } while (status === 'next' && n < 200);
  return { status, regs: JSON.parse(c.emu.register_json()), stats: host?.stats };
}
function movImm32(reg, imm) { return Buffer.from([0x40 | (reg >> 3), 0xb8 | (reg & 7), imm & 255, (imm >>> 8) & 255, (imm >>> 16) & 255, (imm >>> 24) & 255]); }
function movImm64(reg, imm) {
  const b = Buffer.alloc(10); b[0] = 0x48 | (reg >> 3); b[1] = 0xb8 | (reg & 7); b.writeBigUInt64LE(imm, 2); return b;
}

test('JIT covers memory loads, LEA, MOVZX/SX, SETcc and partial-register ALU', async t => {
  const probe = await newCore();
  if (!probe || typeof probe.emu.jit_context_slots !== 'function' || probe.emu.jit_context_slots() !== 32) { t.skip('core predates the 32-slot JIT ABI'); return; }
  // Data qword lives at .text+0x100 (VA 0x140001100); RSI points at it. This exercises
  // base+displacement and SIB loads without needing a separate .data section.
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(0x1122334455667788n, 0);
  data.writeUInt8(0x9a, 8);
  data.writeInt16LE(-1234, 10);
  const cases = [
    // mov rax,[rsi]; add rax,rbx
    Buffer.from([0x48, 0x8b, 0x06, 0x48, 0x01, 0xd8]),
    // movzx eax,byte [rsi+8]; movsx edx,word [rsi+10]
    Buffer.from([0x0f, 0xb6, 0x46, 0x08, 0x0f, 0xbf, 0x56, 0x0a]),
    // lea rax,[rsi+8]; cmp eax,ebx; sete cl
    Buffer.from([0x48, 0x8d, 0x46, 0x08, 0x39, 0xd8, 0x0f, 0x94, 0xc1]),
    // mov rax,[rsi+rbx*1]; xor r8d,r9d  (SIB index)
    Buffer.from([0x48, 0x8b, 0x04, 0x1e, 0x45, 0x31, 0xc8]),
    // add al,bl; and ax,bx
    Buffer.from([0x00, 0xd8, 0x66, 0x21, 0xd8]),
  ];
  for (const body of cases) {
    const loop = Buffer.concat([body, Buffer.from([0x48, 0x83, 0xe9, 0x01])]);
    const jnzDisp = 256 - (loop.length + 2);
    const code = Buffer.concat([
      Buffer.from([0x48, 0xb9, 0xc8, 0, 0, 0, 0, 0, 0, 0]), // mov rcx,200
      movImm64(6, 0x140001100n),                              // mov rsi,data
      movImm32(0, 0x12345678), movImm32(3, 0),                // eax, ebx=0 (SIB index)
      loop, Buffer.from([0x75, jnzDisp, 0xc3]),
    ]);
    data.copy(code, 0x100);
    const interp = await run(code, false);
    const jit = await run(code, true);
    assert.equal(jit.status, interp.status, body.toString('hex'));
    for (const r of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'r8', 'rflags']) {
      assert.equal(jit.regs[r], interp.regs[r], `${r} mismatch for ${body.toString('hex')}`);
    }
    assert.ok(jit.stats.executedInstructions > 100, `expected hot JIT loop, got ${JSON.stringify(jit.stats)}`);
    assert.equal(jit.stats.compileErrors, 0);
  }
});
