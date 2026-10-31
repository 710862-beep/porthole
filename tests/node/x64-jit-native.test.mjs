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
async function run(code, jit, validate = true) {
  const c = await newCore(); if (!c) return null;
  c.emu.load_pe(pe64(code)); c.emu.set_jit_enabled(jit);
  if (jit) c.emu.set_jit_validate_mode(validate ? 1 : 0);
  const host = jit ? new X64JitHost(c.emu, c.mod, { memory: c.memory }) : null;
  let status; let n = 0;
  do { status = host ? await host.runSlice(4096) : c.emu.run_slice(4096); n += 1; } while (status === 'next' && n < 200);
  const regs = JSON.parse(c.emu.register_json());
  const rsp = BigInt(regs.rsp);
  const scratch = c.emu.peek_qwords(rsp - 0x100n, 16);
  return { status, regs, scratch, stats: host?.stats };
}
function movImm64(reg, imm) { const b = Buffer.alloc(10); b[0] = 0x48 | (reg >> 3); b[1] = 0xb8 | (reg & 7); b.writeBigUInt64LE(imm, 2); return b; }

test('native JIT stores of all integer widths commit and reload exactly', async t => {
  const probe = await newCore();
  if (!probe || probe.emu.jit_context_slots() !== 64) { t.skip('core predates ABI v3'); return; }
  const seeded = Buffer.concat([
    Buffer.from([0x48, 0x89, 0xe6, 0x48, 0x81, 0xee, 0x00, 0x01, 0x00, 0x00]), // rsi=rsp-0x100
    Buffer.from([0xbb, 0x78, 0x56, 0x34, 0x12]), // mov ebx,0x12345678
    Buffer.from([0xb9, 0xef, 0xbe, 0x00, 0x00]), // mov ecx,0xbeef
    Buffer.from([0xb2, 0xa5]),                   // mov dl,0xa5
    movImm64(0, 0x1122334455667788n),           // mov rax,imm
    Buffer.from([0x48, 0x89, 0x06]),             // mov [rsi],rax
    Buffer.from([0x89, 0x5e, 0x08]),             // mov [rsi+8],ebx
    Buffer.from([0x66, 0x89, 0x4e, 0x10]),       // mov [rsi+16],cx
    Buffer.from([0x88, 0x56, 0x12]),             // mov [rsi+18],dl
    Buffer.from([0x48, 0x8b, 0x06]),             // mov rax,[rsi]
    Buffer.from([0x8b, 0x5e, 0x08]),             // mov ebx,[rsi+8]
    Buffer.from([0x0f, 0xb7, 0x4e, 0x10]),       // movzx ecx,word [rsi+16]
    Buffer.from([0x0f, 0xb6, 0x56, 0x12]),       // movzx edx,byte [rsi+18]
    Buffer.from([0xc3]),
  ]);
  const interp = await run(seeded, false);
  const jit = await run(seeded, true);
  assert.equal(jit.status, interp.status);
  for (const r of ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rflags']) assert.equal(jit.regs[r], interp.regs[r], r);
  assert.equal(jit.scratch, interp.scratch);
  assert.ok(jit.stats.executedInstructions > 5, JSON.stringify(jit.stats));
  assert.equal(jit.stats.compileErrors, 0);
  assert.equal(jit.stats.traps, 0);
});

test('native CALL/RET push/pop return addresses and preserve registers', async t => {
  const probe = await newCore();
  if (!probe || probe.emu.jit_context_slots() !== 64) { t.skip('core predates ABI v3'); return; }
  // entry: mov rax,5; call +2; add rax,1; ret; func: push rbx; mov rbx,rax; add rbx,3; mov rax,rbx; pop rbx; ret
  const code = Buffer.from([
    0x48, 0xc7, 0xc0, 0x05, 0x00, 0x00, 0x00, // mov rax,5
    0xe8, 0x05, 0x00, 0x00, 0x00,             // call func (skip add rax,1 + ret = 5 bytes)
    0x48, 0x83, 0xc0, 0x01,                   // add rax,1
    0xc3,                                     // ret
    0x53,                                     // push rbx
    0x48, 0x89, 0xc3,                         // mov rbx,rax
    0x48, 0x83, 0xc3, 0x03,                   // add rbx,3
    0x48, 0x89, 0xd8,                         // mov rax,rbx
    0x5b,                                     // pop rbx
    0xc3,                                     // ret
  ]);
  const interp = await run(code, false);
  const jit = await run(code, true);
  assert.equal(jit.status, interp.status);
  assert.equal(jit.regs.rax, interp.regs.rax);
  assert.equal(jit.regs.rbx, interp.regs.rbx);
  assert.equal(jit.regs.rsp, interp.regs.rsp);
  assert.equal(BigInt(jit.regs.rax), 9n);
  assert.ok(jit.stats.executedInstructions >= 10, JSON.stringify(jit.stats));
  assert.equal(jit.stats.traps, 0);
});

test('SSE2 movdqa/paddd/pxor/pmulld execute in v128 locals and store back', async t => {
  const probe = await newCore();
  if (!probe || probe.emu.jit_context_slots() !== 64) { t.skip('core predates ABI v3'); return; }
  const code = Buffer.concat([
    Buffer.from([0x48, 0x89, 0xe6, 0x48, 0x81, 0xee, 0x00, 0x01, 0x00, 0x00]), // rsi = rsp-0x100
    // seed 32 bytes of stack via two movq stores from rax
    movImm64(0, 0x0000000200000001n),
    Buffer.from([0x48, 0x89, 0x06]),             // mov [rsi],rax
    movImm64(0, 0x0000000400000003n),
    Buffer.from([0x48, 0x89, 0x46, 0x08]),       // mov [rsi+8],rax
    movImm64(0, 0x0000000600000005n),
    Buffer.from([0x48, 0x89, 0x46, 0x10]),       // mov [rsi+16],rax
    movImm64(0, 0x0000000800000007n),
    Buffer.from([0x48, 0x89, 0x46, 0x18]),       // mov [rsi+24],rax
    Buffer.from([0x66, 0x0f, 0x6f, 0x06]),       // movdqa xmm0,[rsi]
    Buffer.from([0x66, 0x0f, 0x6f, 0x4e, 0x10]), // movdqa xmm1,[rsi+16]
    Buffer.from([0x66, 0x0f, 0xfe, 0xc1]),       // paddd xmm0,xmm1
    Buffer.from([0x66, 0x0f, 0xef, 0xd2]),       // pxor xmm2,xmm2
    Buffer.from([0x66, 0x0f, 0x38, 0x40, 0xc1]), // pmulld xmm0,xmm1
    Buffer.from([0x66, 0x0f, 0x7f, 0x46, 0x20]), // movdqa [rsi+32],xmm0
    Buffer.from([0x66, 0x48, 0x0f, 0x7e, 0xc0]), // movq rax,xmm0
    Buffer.from([0xc3]),
  ]);
  const interp = await run(code, false);
  const jit = await run(code, true);
  assert.equal(jit.status, interp.status);
  assert.equal(jit.regs.rax, interp.regs.rax);
  assert.equal(jit.scratch, interp.scratch);
  assert.ok(jit.stats.executedInstructions > 10, JSON.stringify(jit.stats));
  assert.equal(jit.stats.compileErrors, 0);
  assert.equal(jit.stats.traps, 0);
});

test('native store to unmapped page traps safely and falls back without corrupting the core', async t => {
  const probe = await newCore();
  if (!probe || probe.emu.jit_context_slots() !== 64) { t.skip('core predates ABI v3'); return; }
  const code = Buffer.concat([
    movImm64(0, 0x1234n),
    movImm64(1, 0xdead0000n),
    Buffer.from([0x48, 0x89, 0x01]), // mov [rcx],rax
    Buffer.from([0xc3]),
  ]);
  const interp = await run(code, false);
  const jit = await run(code, true);
  assert.ok(jit.status.startsWith('fault:'), jit.status);
  assert.equal(jit.status, interp.status);
  assert.equal(jit.regs.rax, interp.regs.rax);
  assert.equal(jit.regs.rcx, interp.regs.rcx);
});
