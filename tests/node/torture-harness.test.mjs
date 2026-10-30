import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseDetection, finalizeDetectionReport } from '../torture/run-detection.mjs';

const require = createRequire(import.meta.url);
const { X64JitHost } = require('../../js/x64-jit-host.js');

function section(id, payload) {
  const len = [];
  let n = payload.length;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; len.push(b); } while (n);
  return Buffer.from([id, ...len, ...payload]);
}
function incrementModule() {
  const type = section(1, [1, 0x60, 1, 0x7f, 1, 0x7e]);
  const imp = section(2, [1, 3, ...Buffer.from('env'), 3, ...Buffer.from('mem'), 2, 0, 1]);
  const func = section(3, [1, 0]);
  const exp = section(7, [1, 9, ...Buffer.from('run_block'), 0, 0]);
  const body = [0, 0x20, 0, 0x20, 0, 0x29, 3, 0, 0x42, 1, 0x7c, 0x37, 3, 0, 0x42, 1, 0x0b];
  const code = section(10, [1, body.length, ...body]);
  return new Uint8Array(Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), type, imp, func, exp, code]));
}
function fakeEmu({ trap = false, commitFault = false } = {}) {
  const bytes = incrementModule();
  const emu = {
    instructions: 0, aborted: false, invalidated: [], cleared: false,
    set_jit_enabled() {},
    instructions_executed() { return BigInt(this.instructions); },
    run_slice() { if (!this.returnedJit && !trap) { this.returnedJit = true; return 'jit'; } this.instructions += 1; return 'next'; },
    jit_enter_block() { return JSON.stringify({ entryRip: '4096', codeHash: '0000000000000001', ctx: 0, insnCount: 1 }); },
    jit_active_wasm() { return bytes; },
    jit_commit_block() { if (commitFault && !this.commitFaulted) { this.commitFaulted = true; return 'fault:jit-validation:0x140007cfa'; } this.instructions += 1; return 'next'; },
    jit_abort_block() { this.aborted = true; },
    jit_invalidate_entry(rip) { this.invalidated.push(String(rip)); },
    jit_pending_count() { return 0; },
    jit_clear_pending() { this.cleared = true; },
  };
  return emu;
}

test('JIT host executes a real Wasm block against the supplied core memory', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const emu = fakeEmu();
  const host = new X64JitHost(emu, {}, { memory });
  const status = await host.runSlice(10);
  assert.equal(status, 'next');
  assert.equal(host.stats.executedBlocks, 1);
  assert.equal(host.stats.executedInstructions, 1);
  assert.equal(new DataView(memory.buffer).getBigUint64(0, true), 1n);
});

test('JIT trap invalidates the active artifact and counts only fallback instructions', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const emu = fakeEmu();
  const host = new X64JitHost(emu, {}, {});
  const status = await host.runSlice(10);
  assert.equal(status, 'next');
  assert.equal(emu.aborted, true);
  assert.equal(host.stats.traps, 1);
  assert.equal(host.stats.fallbackInstructions, 1);
  assert.match(host.stats.lastTrap, /Wasm memory export unavailable|CompileError|missing/);
});

test('core JIT validation fault replays the block in the interpreter', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const emu = fakeEmu({ commitFault: true });
  const host = new X64JitHost(emu, {}, { memory });
  const status = await host.runSlice(10);
  assert.equal(status, 'next');
  assert.equal(emu.aborted, true);
  assert.equal(host.stats.traps, 1);
  assert.equal(host.stats.fallbackInstructions, 1);
  assert.match(host.stats.lastTrap, /jit-validation/);
});

test('stale pending metadata is discarded instead of parsed as empty JSON', async () => {
  const emu = {
    jit_pending_count: () => 1,
    jit_pending_meta: () => '',
    jit_pending_wasm: () => new Uint8Array(),
    jit_clear_pending() { this.cleared = true; },
  };
  const host = new X64JitHost(emu, {}, { enabled: false });
  await host.drainPending();
  assert.equal(host.stats.discarded, 1);
  assert.equal(emu.cleared, true);
});

test('pending compile failure invalidates the core artifact', async () => {
  const meta = JSON.stringify({ entryRip: '4096', codeHash: '0000000000000001' });
  const emu = {
    invalidated: [],
    jit_pending_count: () => 1,
    jit_pending_meta: () => meta,
    jit_pending_wasm: () => new Uint8Array([1, 2, 3]),
    jit_invalidate_entry(rip) { this.invalidated.push(String(rip)); },
    jit_clear_pending() {},
  };
  const host = new X64JitHost(emu, {}, { enabled: false });
  await host.drainPending();
  assert.equal(host.stats.compileErrors, 1);
  assert.deepEqual(emu.invalidated, ['4096']);
});

test('OPFS save failure is a cache error, not a guest trap', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const emu = fakeEmu();
  const host = new X64JitHost(emu, {}, { memory, cache: { saveJitModule: async () => { throw new Error('quota'); } } });
  assert.equal(await host.runSlice(10), 'next');
  assert.equal(host.stats.executedBlocks, 1);
  assert.equal(host.stats.cacheErrors, 1);
  assert.equal(host.stats.traps, 0);
});

test('detection parser records exact BAD and missing-API findings', () => {
  const text = '[*] Warning: API psapi.dll!EnumProcessModulesEx was expected to exist but was not found.\n[*] Checking trap flag [ BAD ]\n[*] Checking IsDebuggerPresent API [ GOOD ]\nAnalysis done';
  const r = parseDetection('al-khaser', text);
  assert.equal(r.completed, true);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].api, 'psapi.dll!EnumProcessModulesEx');
  assert.equal(r.findings[1].actual, 'BAD');
});

test('detection report finalizer is bounded and has no out-of-scope audit reference', () => {
  const report = { tests: [{ status: 'FAIL', apiAudit: new Array(500).fill({ kind: 'api' }) }], apiAudit: new Array(100000).fill({}) };
  finalizeDetectionReport(report);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.summary.failed, 1);
  assert.equal(report.apiAudit, undefined);
  assert.ok(JSON.stringify(report).length < 100000);
});

test('detection CLI writes a report for an empty manifest without ReferenceError', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-detection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = path.join(dir, 'manifest.json');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, binaries: [] }));
  const r = spawnSync(process.execPath, ['tests/torture/run-detection.mjs', '--manifest', manifest, '--report', report, '--suite', 'al-khaser'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /ReferenceError/);
  const j = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(j.status, 'NOT_RUN');
});
