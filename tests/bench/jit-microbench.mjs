#!/usr/bin/env node
// Reproducible authored x64 hot-loop A/B for the interpreter vs the Wasm JIT.
// This is NOT a compatibility suite; it isolates per-block JIT handoff cost.
// Usage: BENCH_N=20000000 node tests/bench/jit-microbench.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { X64JitHost } = require(path.join(root, 'js/x64-jit-host.js'));
const dir = path.join(root, 'vendor/porthole-x64-wasm');
const mod = await import(pathToFileURL(path.join(dir, 'porthole_x64_wasm.js')).href);
const core = await mod.default(fs.readFileSync(path.join(dir, 'porthole_x64_wasm_bg.wasm')));

function pe(code) {
  const b = Buffer.alloc(0x400);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80);
  const coff = 0x84;
  b.writeUInt16LE(0x8664, coff); b.writeUInt16LE(1, coff + 2);
  b.writeUInt16LE(240, coff + 16); b.writeUInt16LE(0x22, coff + 18);
  const opt = 0x98;
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 4);
  b.writeUInt32LE(0x1000, opt + 16); b.writeUInt32LE(0x1000, opt + 20);
  b.writeBigUInt64LE(0x140000000n, opt + 24);
  b.writeUInt32LE(0x1000, opt + 32); b.writeUInt32LE(0x200, opt + 36);
  b.writeUInt32LE(0x3000, opt + 56); b.writeUInt32LE(0x200, opt + 60);
  b.writeUInt16LE(3, opt + 68); b.writeUInt32LE(16, opt + 108);
  const sh = 0x188;
  b.write('.text', sh); b.writeUInt32LE(0x200, sh + 8); b.writeUInt32LE(0x1000, sh + 12);
  b.writeUInt32LE(0x200, sh + 16); b.writeUInt32LE(0x200, sh + 20);
  b.writeUInt32LE(0x60000020, sh + 36);
  code.copy(b, 0x200);
  return b;
}

const N = Math.max(1, Number(process.env.BENCH_N || 20_000_000));
// mov rcx,N ; sub rcx,1 ; jnz -6 ; ret  (the -6 displacement lands on the sub, not mid-instruction)
const code = Buffer.concat([Buffer.from([
  0x48, 0xc7, 0xc1, N & 255, (N >> 8) & 255, (N >> 16) & 255, (N >> 24) & 255,
  0x48, 0x83, 0xe9, 0x01, 0x75, 0xfa, 0xc3,
])]);

const results = [];
for (const mode of ['interpreter', 'jit-validate', 'jit-fast']) {
  const emu = new mod.BrowserX64Emulator(8192);
  emu.load_pe(pe(code));
  const jit = mode !== 'interpreter';
  emu.set_jit_enabled(jit);
  if (jit && typeof emu.set_jit_validate === 'function') emu.set_jit_validate(mode === 'jit-validate');
  const host = jit ? new X64JitHost(emu, {}, { memory: core.memory }) : null;
  const t = performance.now();
  let status;
  do { status = host ? await host.runSlice(1_000_000) : emu.run_slice(1_000_000); } while (status === 'next');
  const ms = performance.now() - t;
  const ins = Number(emu.instructions_executed());
  results.push({ mode, status, instructions: ins, ms: Math.round(ms), mips: +(ins / (ms / 1000) / 1e6).toFixed(3), stats: host?.stats ?? null });
}
const report = { kind: 'jit-microbench', loopIterations: N, date: new Date().toISOString(), results };
fs.mkdirSync(path.join(root, 'artifacts/torture'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts/torture/jit-microbench.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (results.some(r => r.status !== 'exit:0')) process.exitCode = 1;
