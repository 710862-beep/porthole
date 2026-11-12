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
    if (status === 'stopped' || status.startsWith('exit:')) return status;
    if (!['next', 'hostcall', 'upcall', 'jit', 'fallback'].includes(status)) return status;
  }
  return 'budget';
}
function regs(emu) {
  const r = JSON.parse(emu.register_json());
  return { rax: BigInt(r.rax), rcx: BigInt(r.rcx), rdx: BigInt(r.rdx), rflags: BigInt(r.rflags) };
}

test('JIT and interpreter agree on a 32-bit store whose effective address is above 4 GiB', async t => {
  const first = await newCore();
  if (!first || typeof first.emu.jit_context_slots !== 'function' || first.emu.jit_context_slots() !== 64) {
    t.skip('core predates the 64-slot JIT basic-block ABI; rebuild rust/porthole-x64-wasm');
    return;
  }
  // The 32-bit ECX write must zero-extend, then participate in a 64-bit RAX+RCX EA.
  // Both the store/load width and the data register are 32-bit; the target is > 4 GiB.
  const code = Buffer.from([
    0x48, 0xb8, 0x00, 0x00, 0x00, 0x40, 0x01, 0x00, 0x00, 0x00,
    0xb9, 0x00, 0x20, 0x00, 0x00,
    0xbb, 0x88, 0x77, 0x66, 0x55,
    0x89, 0x1c, 0x08,
    0x8b, 0x14, 0x08,
    0xc3,
  ]);
  const address = 0x1_4000_2000n;
  const value = 0x55667788n;
  first.emu.load_pe(pe64(code));
  first.emu.set_jit_enabled(false);
  const interpStatus = await runToEnd(first.emu);
  assert.ok(interpStatus === 'stopped' || interpStatus === 'exit:0', interpStatus);
  const expected = regs(first.emu);
  assert.equal(expected.rdx, value, 'interpreter must store/load through the high 64-bit EA');
  assert.ok(first.emu.peek_qwords(address, 1).includes('0x0000000055667788'));

  const second = await newCore();
  const jit = second.emu;
  jit.load_pe(pe64(code));
  const host = new X64JitHost(jit, {}, { memory: second.memory });
  jit.set_jit_enabled(true);
  const jitStatus = await runToEnd(jit, host);
  assert.ok(jitStatus === 'stopped' || jitStatus === 'exit:0', jitStatus);
  await host.drainPending();
  assert.deepEqual(regs(jit), expected, 'JIT and interpreter must agree on the high-address store');
  assert.ok(jit.peek_qwords(address, 1).includes('0x0000000055667788'));
  assert.ok(host.stats.executedInstructions > 0, 'the high-address block must execute natively');
});

test('JIT RIP-relative loads in one block use each instruction end as the displacement base', async t => {
  const first = await newCore();
  if (!first || typeof first.emu.jit_context_slots !== 'function' || first.emu.jit_context_slots() !== 64) {
    t.skip('core predates the 64-slot JIT basic-block ABI; rebuild rust/porthole-x64-wasm');
    return;
  }
  // mov eax,[rip+10] at offset 0 -> data at 16; mov ecx,[rip+8] at offset 6 -> data at 20; ret.
  // If the second displacement is based on block-entry RIP, it reads instruction bytes at offset 8.
  const code = Buffer.alloc(24, 0x90);
  code.set([0x8b, 0x05], 0); code.writeInt32LE(10, 2);
  code.set([0x8b, 0x0d], 6); code.writeInt32LE(8, 8);
  code[12] = 0xc3;
  code.writeUInt32LE(0x11223344, 16);
  code.writeUInt32LE(0x55667788, 20);

  first.emu.load_pe(pe64(code));
  first.emu.set_jit_enabled(false);
  const interpStatus = await runToEnd(first.emu);
  assert.ok(interpStatus === 'stopped' || interpStatus === 'exit:0', interpStatus);
  const expected = regs(first.emu);
  assert.equal(expected.rax, 0x11223344n);
  assert.equal(expected.rcx, 0x55667788n);

  const second = await newCore();
  const jit = second.emu;
  jit.load_pe(pe64(code));
  const host = new X64JitHost(jit, {}, { memory: second.memory });
  jit.set_jit_enabled(true);
  const jitStatus = await runToEnd(jit, host);
  assert.ok(jitStatus === 'stopped' || jitStatus === 'exit:0', jitStatus);
  await host.drainPending();
  assert.deepEqual(regs(jit), expected, 'each RIP-relative operand must use its own next IP');
  assert.ok(host.stats.executedInstructions > 0, 'the RIP-relative block must execute natively');
});

test('JIT and interpreter agree on RFLAGS across a native self-loop sub/nop/jnz block', async t => {
  const first = await newCore();
  if (!first || typeof first.emu.jit_context_slots !== 'function' || first.emu.jit_context_slots() !== 64) {
    t.skip('core predates the 64-slot JIT basic-block ABI; rebuild rust/porthole-x64-wasm');
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
  const interpStatus = await runToEnd(interp);
  assert.ok(interpStatus === 'stopped' || interpStatus === 'exit:0', interpStatus);
  const expected = regs(interp);
  assert.equal(expected.rcx, 0n);
  assert.equal((expected.rflags >> 6n) & 1n, 1n, 'final sub must set ZF');

  const second = await newCore();
  const jit = second.emu;
  jit.load_pe(pe64(code));
  const host = new X64JitHost(jit, {}, { memory: second.memory });
  jit.set_jit_enabled(true);
  const jitStatus = await runToEnd(jit, host);
  assert.ok(jitStatus === 'stopped' || jitStatus === 'exit:0', jitStatus);
  await host.drainPending();
  const actual = regs(jit);
  assert.deepEqual(actual, expected, 'JIT must materialize flags consumed by the interpreter after the block');
  assert.ok(host.stats.executedInstructions > 1000, `expected native JIT loop execution, got ${JSON.stringify(host.stats)}`);
});
