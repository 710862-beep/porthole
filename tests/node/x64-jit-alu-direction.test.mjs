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
function movImm32(reg, imm) { return Buffer.from([0x40 | (reg >> 3), 0xb8 | (reg & 7), imm & 255, (imm >>> 8) & 255, (imm >>> 16) & 255, (imm >>> 24) & 255]); }
async function run(code, jit) {
  const c = await newCore(); if (!c) return null;
  c.emu.load_pe(pe64(code)); c.emu.set_jit_enabled(jit); if (jit) c.emu.set_jit_validate(false);
  const host = jit ? new X64JitHost(c.emu, {}, { memory: c.memory }) : null;
  let status; let n = 0;
  do { status = host ? await host.runSlice(10000) : c.emu.run_slice(10000); n += 1; } while (status === 'next' && n < 100);
  return { status, regs: JSON.parse(c.emu.register_json()), stats: host?.stats };
}

test('JIT preserves ModRM direction for r/m,reg and reg,r/m ALU opcodes', async t => {
  const probe = await newCore();
  if (!probe || typeof probe.emu.jit_context_slots !== 'function' || probe.emu.jit_context_slots() !== 32) { t.skip('core predates the 32-slot JIT ABI'); return; }
  const cases = [
    // sub eax,ebx (29 /r MR): EAX must be the destination, not EBX.
    { op: [0x40, 0x29, 0xd8], a: 0x50113436, b: 0x9078dd65 },
    // sub ebx,eax (2B /r RM): EBX must be the destination.
    { op: [0x40, 0x2b, 0xd8], a: 0x50113436, b: 0x9078dd65 },
    // add eax,ebx (01 /r MR)
    { op: [0x40, 0x01, 0xd8], a: 0x9c2d1701, b: 0xd1c10d85 },
    // xor eax,ebx (31 /r MR)
    { op: [0x40, 0x31, 0xd8], a: 0x5a3bbe2e, b: 0x24a8f56a },
  ];
  for (const { op, a, b } of cases) {
    const body = Buffer.from(op);
    const loop = Buffer.concat([body, Buffer.from([0x48, 0x83, 0xe9, 0x01])]);
    const code = Buffer.concat([
      Buffer.from([0x48, 0xb9, 0xc8, 0, 0, 0, 0, 0, 0, 0]), // mov rcx,200
      movImm32(0, a), movImm32(3, b), loop,
      Buffer.from([0x75, 256 - (loop.length + 2), 0xc3]),
    ]);
    const interp = await run(code, false);
    const jit = await run(code, true);
    assert.equal(jit.status, interp.status, code.toString('hex'));
    assert.equal(jit.regs.rax, interp.regs.rax, `RAX direction ${code.toString('hex')}`);
    assert.equal(jit.regs.rbx, interp.regs.rbx, `RBX direction ${code.toString('hex')}`);
    assert.equal(jit.regs.rflags, interp.regs.rflags, `RFLAGS ${code.toString('hex')}`);
    assert.ok(jit.stats.executedInstructions > 100, `expected hot JIT loop, got ${JSON.stringify(jit.stats)}`);
  }
});
