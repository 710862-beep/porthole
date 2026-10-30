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

/** Authored minimal PE64: no third-party bytes, one RX .text section, entry at base+0x1000. */
function pe64(code) {
  const b = Buffer.alloc(0x400);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80);
  const coff = 0x84;
  b.writeUInt16LE(0x8664, coff); b.writeUInt16LE(1, coff + 2); b.writeUInt16LE(240, coff + 16); b.writeUInt16LE(0x22, coff + 18);
  const opt = 0x98;
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 4); b.writeUInt32LE(0x1000, opt + 16); b.writeUInt32LE(0x1000, opt + 20);
  b.writeBigUInt64LE(0x140000000n, opt + 24); b.writeUInt32LE(0x1000, opt + 32); b.writeUInt32LE(0x200, opt + 36);
  b.writeUInt32LE(0x3000, opt + 56); b.writeUInt32LE(0x200, opt + 60); b.writeUInt16LE(3, opt + 68); b.writeUInt32LE(16, opt + 108);
  const sh = 0x188;
  b.write('.text', sh); b.writeUInt32LE(0x200, sh + 8); b.writeUInt32LE(0x1000, sh + 12); b.writeUInt32LE(0x200, sh + 16); b.writeUInt32LE(0x200, sh + 20); b.writeUInt32LE(0x60000020, sh + 36);
  code.copy(b, 0x200);
  return b;
}
async function runToEnd(emu, host) {
  for (let i = 0; i < 20000; i++) {
    const status = host ? await host.runSlice(512) : emu.run_slice(512);
    if (status === 'stopped') return status;
    if (!['next', 'hostcall', 'upcall', 'jit', 'fallback'].includes(status)) return status;
  }
  return 'budget';
}
function regs(emu) {
  const r = JSON.parse(emu.registers_json());
  return { rax: BigInt(r.rax), rcx: BigInt(r.rcx), rdx: BigInt(r.rdx), rflags: BigInt(r.rflags) };
}

test('JIT and interpreter agree on RFLAGS across a hot sub/nop block followed by interpreted jnz', async t => {
  const first = await newCore();
  if (!first || typeof first.emu.jit_context_slots !== 'function' || first.emu.jit_context_slots() !== 21) {
    t.skip('core predates the 21-slot JIT flag ABI; rebuild rust/porthole-x64-wasm');
    return;
  }
  // mov rcx,1000; mov rdx,1; L: sub rcx,rdx; nop; jnz L; ret
  const code = Buffer.from([
    0x48, 0xc7, 0xc1, 0xe8, 0x03, 0, 0,
    0x48, 0xc7, 0xc2, 0x01, 0, 0, 0,
    0x48, 0x29, 0xd1,
    0x90,
    0x75, 0xfa,
    0xc3,
  ]);
  const interp = first.emu;
  interp.load_pe(pe64(code));
  interp.set_jit_enabled(false);
  assert.equal(await runToEnd(interp), 'stopped');
  const expected = regs(interp);
  assert.equal(expected.rcx, 0n);
  assert.equal((expected.rflags >> 6n) & 1n, 1n, 'final sub must set ZF');

  const second = await newCore();
  const jit = second.emu;
  jit.load_pe(pe64(code));
  const host = new X64JitHost(jit, {}, { memory: second.memory });
  jit.set_jit_enabled(true);
  assert.equal(await runToEnd(jit, host), 'stopped');
  await host.drainPending();
  const actual = regs(jit);
  assert.deepEqual(actual, expected, 'JIT must materialize flags consumed by the interpreter after the block');
  assert.ok(host.stats.executedBlocks > 0, `expected JIT execution, got ${JSON.stringify(host.stats)}`);
});
